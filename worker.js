// ─── Worker process ───────────────────────────────────────────────────
// Pulls `store-test` and `ada-scan` jobs from Redis and executes them.
//
// Horizontal scaling:
//   • Run multiple copies (docker-compose up --scale worker=N).
//   • BullMQ distributes jobs across all connected workers.
//
// Vertical scaling:
//   • WORKER_CONCURRENCY env var controls how many jobs a single worker
//     processes in parallel. Each concurrent job gets its own browser
//     context (but shares the browser instance).

const { Worker } = require('bullmq');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { chromium: chromiumVanilla } = require('playwright');
const path = require('path');
const fs = require('fs');

const {
  STORE_TEST_QUEUE,
  ADA_SCAN_QUEUE,
  connectionOptions,
  REDIS_URL,
  publishEvent,
  incrementRunCounter,
  isRunFinished,
} = require('./lib/queue');

// ─── Run file finalization ────────────────────────────────────────────
// Background note on why the worker finalizes the run file (and not just
// server.js): completion marking used to live inside the SSE handler in
// server.js. If the browser closed, the API process restarted, or the
// container got recycled mid-run, the status file was orphaned at
// "running" forever — even though the worker had actually finished the
// work. Having the worker write the final status removes that dependency
// on a live HTTP request.
//
// Runs dir matches server.js: $DATA_DIR/runs. When deployed on Railway
// both processes mount the same volume, so the worker sees the run file
// server.js created at submission time.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const RUNS_DIR = path.join(DATA_DIR, 'runs');

async function finalizeRunIfDone(runId) {
  try {
    if (!(await isRunFinished(runId))) return;
  } catch (err) {
    console.warn('[worker] isRunFinished check failed:', err.message);
    return;
  }
  const runFile = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(runFile)) return; // ada-scan runs don't have a file
  try {
    const runData = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    // Only flip 'running' → 'complete'. Never overwrite 'error' or an
    // existing 'complete' (could happen if another worker raced us).
    if (runData.status !== 'running') return;
    runData.status = 'complete';
    runData.completedAt = new Date().toISOString();
    fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));
    // Let any connected SSE clients know the run wrapped up.
    try { await publishEvent(runId, { type: 'complete' }); } catch (_) {}
    console.log(`[worker] run finalized — run=${runId}`);
  } catch (err) {
    console.warn('[worker] finalize run failed:', err.message);
  }
}

const { runStoreTests } = require('./test-runner');
const { scanStore } = require('./accessibility-scanner');

chromiumExtra.use(StealthPlugin());

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

// Screenshots are captured & base64-encoded inside test-runner.js
// via a monkey-patched page.screenshot — events arrive here already
// containing `data:image/png;base64,...` URLs. The worker no longer
// reads or writes any image files.
console.log('[worker] screenshots: in-memory data URLs (no disk)');

// Launch a single browser per worker process — reused across all jobs
// this worker handles. Each job creates its own BrowserContext inside
// this browser, so cookies, localStorage, etc. don't leak between stores.

let storeTestBrowser = null;
let adaScanBrowser = null;

async function getStoreTestBrowser() {
  if (storeTestBrowser && storeTestBrowser.isConnected()) return storeTestBrowser;
  console.log('[worker] launching store-test browser (playwright-extra + stealth)...');
  storeTestBrowser = await chromiumExtra.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
    ],
  });
  return storeTestBrowser;
}

async function getAdaScanBrowser() {
  if (adaScanBrowser && adaScanBrowser.isConnected()) return adaScanBrowser;
  console.log('[worker] launching ada-scan browser...');
  adaScanBrowser = await chromiumVanilla.launch({ headless: true });
  return adaScanBrowser;
}

// ─── Store test worker ────────────────────────────────────────────────

const storeTestWorker = new Worker(
  STORE_TEST_QUEUE,
  async (job) => {
    const { runId, store, testIds } = job.data;

    console.log(`[worker] store-test start — run=${runId} store=${store.newStore}`);

    // Inline any screenshot files SYNCHRONOUSLY before the event is
    // queued for publish — this guarantees we read the file while it's
    // fresh on disk (right after page.screenshot resolved) rather than
    // racing an async chain that might run long after the file is gone.
    let eventChain = Promise.resolve();
    const sendEvent = (event) => {
      eventChain = eventChain.then(async () => {
        try {
          await publishEvent(runId, event);
        } catch (err) {
          console.warn('[worker] publish failed:', err.message);
        }
      });
    };

    try {
      const browser = await getStoreTestBrowser();
      // Hard per-store ceiling. If a store can't finish in 10 minutes
      // (usually because of Cloudflare lock-outs), we abort and let the
      // rest of the queue keep moving. Without this cap a single bad
      // store can monopolize a worker slot indefinitely.
      const STORE_TIMEOUT_MS = 10 * 60 * 1000;
      await Promise.race([
        runStoreTests(browser, store, testIds, sendEvent),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`store timeout after ${STORE_TIMEOUT_MS / 1000}s`)),
            STORE_TIMEOUT_MS
          )
        ),
      ]);
      // Drain the event chain so screenshots + publishes finish before
      // we mark the job complete.
      await eventChain;
      await incrementRunCounter(runId, 'completed');
      return { ok: true };
    } catch (err) {
      console.error(`[worker] store-test failed for ${store.newStore}:`, err);
      sendEvent({ type: 'error', store: store.newStore, message: err.message });
      try { await eventChain; } catch (_) {}
      await incrementRunCounter(runId, 'failed');
      throw err; // let BullMQ mark the job as failed
    }
  },
  {
    connection: { ...connectionOptions, url: REDIS_URL },
    concurrency: WORKER_CONCURRENCY,
  }
);

storeTestWorker.on('completed', (job) => {
  console.log(`[worker] store-test done — job=${job.id} store=${job.data.store.newStore}`);
});
storeTestWorker.on('failed', (job, err) => {
  console.warn(`[worker] store-test failed — job=${job?.id} err=${err?.message}`);
});

// ─── Accessibility scan worker ─────────────────────────────────────────

const adaScanWorker = new Worker(
  ADA_SCAN_QUEUE,
  async (job) => {
    const { runId, store } = job.data;

    console.log(`[worker] ada-scan start — run=${runId} store=${store.newStore}`);

    // Same synchronous-inline pattern as the store-test worker.
    // `inlineScreenshotsDeep` walks the entire event tree and handles
    // the nested screenshots inside accessibility violations & nodes.
    let eventChain = Promise.resolve();
    const sendEvent = (event) => {
      eventChain = eventChain.then(async () => {
        try {
          await publishEvent(runId, event);
        } catch (err) {
          console.warn('[worker] publish failed:', err.message);
        }
      });
    };

    try {
      const browser = await getAdaScanBrowser();
      await scanStore(browser, store, sendEvent);
      await eventChain;
      await incrementRunCounter(runId, 'completed');
      return { ok: true };
    } catch (err) {
      console.error(`[worker] ada-scan failed for ${store.newStore}:`, err);
      sendEvent({ type: 'ada-error', store: store.newStore, message: err.message });
      try { await eventChain; } catch (_) {}
      await incrementRunCounter(runId, 'failed');
      throw err;
    }
  },
  {
    connection: { ...connectionOptions, url: REDIS_URL },
    concurrency: WORKER_CONCURRENCY,
  }
);

adaScanWorker.on('completed', (job) => {
  console.log(`[worker] ada-scan done — job=${job.id} store=${job.data.store.newStore}`);
});
adaScanWorker.on('failed', (job, err) => {
  console.warn(`[worker] ada-scan failed — job=${job?.id} err=${err?.message}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[worker] ${signal} received — shutting down...`);
  try { await storeTestWorker.close(); } catch (_) {}
  try { await adaScanWorker.close(); } catch (_) {}
  try { if (storeTestBrowser) await storeTestBrowser.close(); } catch (_) {}
  try { if (adaScanBrowser) await adaScanBrowser.close(); } catch (_) {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`[worker] ready — concurrency=${WORKER_CONCURRENCY} redis=${REDIS_URL}`);
