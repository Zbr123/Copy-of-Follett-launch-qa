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

// When BROWSER_WS_URL is set (e.g. Browserless, Bright Data Scraping
// Browser, or any CDP-compatible remote Chromium), we connect to a
// managed browser pool instead of launching locally. The remote service
// handles stealth + residential-IP rotation server-side, which is the
// only reliable way to get past Shopify's Cloudflare at scale from a
// single datacenter egress IP.
//
// Leave BROWSER_WS_URL unset (or empty) for local development — the
// worker falls back to launching headless Chromium in-process.
//
// Typical values:
//   wss://production-sfo.browserless.io?token=XXX&stealth&blockAds
//   wss://production-sfo.browserless.io?token=XXX&stealth&proxy=residential
//   wss://USER:PASS@brd.superproxy.io:9222  (Bright Data)
const BROWSER_WS_URL = process.env.BROWSER_WS_URL || '';
const USE_REMOTE_BROWSER = Boolean(BROWSER_WS_URL);

if (USE_REMOTE_BROWSER) {
  // Don't leak the token into logs.
  const sanitized = BROWSER_WS_URL.replace(/token=[^&]+/i, 'token=***')
                                  .replace(/\/\/[^@]+@/, '//***:***@');
  console.log(`[worker] browser mode: remote CDP → ${sanitized}`);
} else {
  console.log('[worker] browser mode: local launch (playwright-extra + stealth)');
}

async function getStoreTestBrowser() {
  if (storeTestBrowser && storeTestBrowser.isConnected()) return storeTestBrowser;
  if (USE_REMOTE_BROWSER) {
    console.log('[worker] connecting store-test browser to remote CDP...');
    // Use vanilla playwright — the stealth plugin patches launch args,
    // which don't apply to an already-running remote browser. Stealth
    // is handled server-side by the remote provider.
    storeTestBrowser = await chromiumVanilla.connectOverCDP(BROWSER_WS_URL);
  } else {
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
  }
  // If the remote (or local) browser disconnects unexpectedly, clear the
  // cached handle so the next job triggers a fresh connect/launch
  // instead of reusing a dead reference.
  storeTestBrowser.on('disconnected', () => {
    console.warn('[worker] store-test browser disconnected');
    storeTestBrowser = null;
  });
  return storeTestBrowser;
}

async function getAdaScanBrowser() {
  if (adaScanBrowser && adaScanBrowser.isConnected()) return adaScanBrowser;
  if (USE_REMOTE_BROWSER) {
    console.log('[worker] connecting ada-scan browser to remote CDP...');
    adaScanBrowser = await chromiumVanilla.connectOverCDP(BROWSER_WS_URL);
  } else {
    console.log('[worker] launching ada-scan browser...');
    adaScanBrowser = await chromiumVanilla.launch({ headless: true });
  }
  adaScanBrowser.on('disconnected', () => {
    console.warn('[worker] ada-scan browser disconnected');
    adaScanBrowser = null;
  });
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
      // No hard per-store ceiling. Slow stores (rural bandwidth, heavy
      // themes, etc.) need to be allowed to finish. The real defense
      // against runaway hangs is in test-runner.js: the patched
      // page.goto throws on unresolvable Cloudflare challenges, so a
      // blocked store fails fast (~30-60s) instead of grinding on
      // nonexistent selectors for hours.
      await runStoreTests(browser, store, testIds, sendEvent);
      // Drain the event chain so screenshots + publishes finish before
      // we mark the job complete.
      await eventChain;
      await incrementRunCounter(runId, 'completed');
      await finalizeRunIfDone(runId);
      return { ok: true };
    } catch (err) {
      console.error(`[worker] store-test failed for ${store.newStore}:`, err);
      sendEvent({ type: 'error', store: store.newStore, message: err.message });
      try { await eventChain; } catch (_) {}
      await incrementRunCounter(runId, 'failed');
      await finalizeRunIfDone(runId);
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
      await finalizeRunIfDone(runId);
      return { ok: true };
    } catch (err) {
      console.error(`[worker] ada-scan failed for ${store.newStore}:`, err);
      sendEvent({ type: 'ada-error', store: store.newStore, message: err.message });
      try { await eventChain; } catch (_) {}
      await incrementRunCounter(runId, 'failed');
      await finalizeRunIfDone(runId);
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
