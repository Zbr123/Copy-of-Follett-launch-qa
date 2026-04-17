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
} = require('./lib/queue');

const { runStoreTests } = require('./test-runner');
const { scanStore } = require('./accessibility-scanner');

chromiumExtra.use(StealthPlugin());

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

// ─── Inline screenshot encoding ─────────────────────────────────────
// Workers used to upload screenshots to the API over HTTP. That path
// had too many moving parts (shared secret, disk sync, async timing)
// and was silently dropping files in production. We now base64-encode
// each screenshot synchronously in the sendEvent callback and embed
// the data URL directly in the SSE event. The browser renders data
// URLs identically to file URLs, so the frontend needs no changes.
//
// Encoding happens SYNCHRONOUSLY at the moment the test emits its
// screenshot — which is right after `await page.screenshot({ path })`
// resolves. This closes the timing gap that was making the file
// disappear before the old async upload chain could read it.

const WORKER_SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(WORKER_SCREENSHOTS_DIR)) {
  fs.mkdirSync(WORKER_SCREENSHOTS_DIR, { recursive: true });
}

console.log('[worker] screenshots: inline base64 mode (no upload)');

// Size cap on the image we're willing to embed. Anything over this is
// dropped with a warning — 5 MB of base64 (~3.7 MB raw) is generous
// for a typical Playwright viewport shot.
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

// Read one file and return a data URL, or null if the file is missing
// or oversized. Never throws.
function fileToDataUrl(localPath) {
  try {
    if (!fs.existsSync(localPath)) {
      console.warn(`[worker] inline skipped — file missing: ${localPath}`);
      return null;
    }
    const size = fs.statSync(localPath).size;
    if (size > MAX_INLINE_BYTES) {
      console.warn(`[worker] inline skipped — file too large (${size} bytes): ${localPath}`);
      return null;
    }
    const data = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const mime =
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'image/png';
    // Free the ephemeral copy immediately — the bytes now live in the
    // event and will flow through Redis to the browser. Keeping the
    // file wastes disk on long-running workers.
    try { fs.unlinkSync(localPath); } catch (_) {}
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch (err) {
    console.warn(`[worker] inline failed for ${localPath}: ${err.message}`);
    return null;
  }
}

// If a value looks like a /screenshots/... URL produced by test-runner
// or accessibility-scanner, resolve it to a disk path and replace with
// a data URL. Mutates the parent object in place.
function maybeInlineScreenshotField(obj, key) {
  const v = obj[key];
  if (typeof v !== 'string') return;
  if (!v.startsWith('/screenshots/')) return;
  const relPath = v.substring('/screenshots/'.length);
  if (!relPath || relPath.includes('..')) return;
  const localPath = path.join(WORKER_SCREENSHOTS_DIR, relPath);
  const dataUrl = fileToDataUrl(localPath);
  if (dataUrl) obj[key] = dataUrl;
}

// Walk an event object and inline every `screenshot` field we find,
// including nested ones inside accessibility violations + nodes.
function inlineScreenshotsDeep(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) inlineScreenshotsDeep(item);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key === 'screenshot') {
      maybeInlineScreenshotField(obj, key);
    } else if (obj[key] && typeof obj[key] === 'object') {
      inlineScreenshotsDeep(obj[key]);
    }
  }
}

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
      try { inlineScreenshotsDeep(event); } catch (err) {
        console.warn('[worker] inline encode failed:', err.message);
      }
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
      await runStoreTests(browser, store, testIds, sendEvent);
      // Drain the event chain so all screenshot uploads + publishes
      // finish before we mark the job complete.
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
      try { inlineScreenshotsDeep(event); } catch (err) {
        console.warn('[worker] inline encode failed:', err.message);
      }
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
