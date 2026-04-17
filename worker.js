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

const {
  STORE_TEST_QUEUE,
  ADA_SCAN_QUEUE,
  connectionOptions,
  REDIS_URL,
  publishEvent,
  incrementRunCounter,
} = require('./lib/queue');

const { runStoreTests } = require('./test-runner');
const { scanStore } = require('./accessibility-scanner');

chromiumExtra.use(StealthPlugin());

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

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

    const sendEvent = (event) => {
      // Forward every event to the run's Redis channel so the API's SSE
      // subscriber can relay it to connected browsers.
      publishEvent(runId, event).catch((err) => {
        console.warn('[worker] publishEvent failed:', err.message);
      });
    };

    try {
      const browser = await getStoreTestBrowser();
      await runStoreTests(browser, store, testIds, sendEvent);
      await incrementRunCounter(runId, 'completed');
      return { ok: true };
    } catch (err) {
      console.error(`[worker] store-test failed for ${store.newStore}:`, err);
      sendEvent({ type: 'error', store: store.newStore, message: err.message });
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

    const sendEvent = (event) => {
      publishEvent(runId, event).catch((err) => {
        console.warn('[worker] publishEvent failed:', err.message);
      });
    };

    try {
      const browser = await getAdaScanBrowser();
      await scanStore(browser, store, sendEvent);
      await incrementRunCounter(runId, 'completed');
      return { ok: true };
    } catch (err) {
      console.error(`[worker] ada-scan failed for ${store.newStore}:`, err);
      sendEvent({ type: 'ada-error', store: store.newStore, message: err.message });
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
