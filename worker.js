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

// ─── Screenshot upload config ────────────────────────────────────────
// Workers don't have the API's persistent volume, so we upload each
// captured screenshot to the API over HTTP. The API writes it to its
// own SCREENSHOTS_DIR and serves it via the static route. If these
// env vars aren't set, uploads are skipped — the events still fire
// but the thumbnails will 404 in the browser.
const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const UPLOAD_DISABLED = !API_URL || !INTERNAL_SECRET;

// Both test-runner.js and accessibility-scanner.js write screenshots
// under `${__dirname}/screenshots`. Mirror that here so we can locate
// the file when we see its URL in a SSE event.
const WORKER_SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(WORKER_SCREENSHOTS_DIR)) {
  fs.mkdirSync(WORKER_SCREENSHOTS_DIR, { recursive: true });
}

if (UPLOAD_DISABLED) {
  console.warn('[worker] screenshot uploads disabled — set API_URL and INTERNAL_SECRET to enable. Thumbnails will 404 until this is fixed.');
} else {
  console.log(`[worker] screenshots will upload to ${API_URL}`);
}

// Upload a single screenshot file to the API. Returns true on success,
// false on failure (never throws). Best-effort — a missing screenshot
// does not fail the test.
async function uploadScreenshot(screenshotUrl) {
  if (UPLOAD_DISABLED) {
    console.warn(`[worker] upload skipped (disabled): ${screenshotUrl}`);
    return false;
  }
  if (!screenshotUrl || typeof screenshotUrl !== 'string') return false;
  if (!screenshotUrl.startsWith('/screenshots/')) {
    console.warn(`[worker] upload skipped (unexpected URL): ${screenshotUrl}`);
    return false;
  }

  const relPath = screenshotUrl.substring('/screenshots/'.length);
  if (!relPath || relPath.includes('..')) {
    console.warn(`[worker] upload skipped (bad relPath): ${relPath}`);
    return false;
  }

  const localPath = path.join(WORKER_SCREENSHOTS_DIR, relPath);
  if (!fs.existsSync(localPath)) {
    console.warn(`[worker] upload skipped — file not found on disk: ${localPath} (url=${screenshotUrl})`);
    return false;
  }

  const size = fs.statSync(localPath).size;
  const data = fs.readFileSync(localPath);
  const uploadUrl = `${API_URL}/api/internal/screenshots/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  console.log(`[worker] upload start — ${size} bytes → ${uploadUrl}`);

  // One retry on transient failure. Keep timeout tight — screenshots
  // are small and the internal network is fast.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: data,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        console.log(`[worker] upload ok — ${uploadUrl}`);
        // Free the ephemeral copy — keeps worker RAM/disk from bloating
        // over long-running sessions.
        try { fs.unlinkSync(localPath); } catch (_) {}
        return true;
      }
      const body = await resp.text().catch(() => '');
      console.warn(`[worker] screenshot upload ${uploadUrl} returned HTTP ${resp.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[worker] screenshot upload ${uploadUrl} failed (attempt ${attempt + 1}): ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
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

    // Serialize events through a promise chain so (a) screenshot
    // uploads complete before their event is published, and (b) events
    // are delivered in the order they were emitted.
    let eventChain = Promise.resolve();
    const sendEvent = (event) => {
      eventChain = eventChain.then(async () => {
        try {
          if (event && event.screenshot) {
            await uploadScreenshot(event.screenshot);
          }
          await publishEvent(runId, event);
        } catch (err) {
          console.warn('[worker] event processing error:', err.message);
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

    // Same serialized upload-then-publish pattern as the store-test worker.
    let eventChain = Promise.resolve();
    const sendEvent = (event) => {
      eventChain = eventChain.then(async () => {
        try {
          if (event && event.screenshot) {
            await uploadScreenshot(event.screenshot);
          }
          // Accessibility violations also carry per-node screenshots
          // nested inside `violations[].nodes[].screenshot`.
          if (event && Array.isArray(event.violations)) {
            for (const v of event.violations) {
              if (v && Array.isArray(v.nodes)) {
                for (const n of v.nodes) {
                  if (n && n.screenshot) await uploadScreenshot(n.screenshot);
                }
              }
            }
          }
          // Page-level screenshot field on ada-page-result.
          if (event && event.pages && Array.isArray(event.pages)) {
            for (const p of event.pages) {
              if (p && p.screenshot) await uploadScreenshot(p.screenshot);
              if (p && Array.isArray(p.violations)) {
                for (const v of p.violations) {
                  if (v && Array.isArray(v.nodes)) {
                    for (const n of v.nodes) {
                      if (n && n.screenshot) await uploadScreenshot(n.screenshot);
                    }
                  }
                }
              }
            }
          }
          await publishEvent(runId, event);
        } catch (err) {
          console.warn('[worker] ada event processing error:', err.message);
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
