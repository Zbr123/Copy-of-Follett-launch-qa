const express = require('express');
const path = require('path');
const fs = require('fs');
const { runTests } = require('./test-runner');
const { runAccessibilityScan } = require('./accessibility-scanner');
const { chromium } = require('playwright');
const sweepWorker = require('./sweep-worker');
const {
  storeTestQueue,
  adaScanQueue,
  subscribeToRun,
  initRunStatus,
  getRunStatus,
  isRunFinished,
} = require('./lib/queue');

// BullMQ reserves `:` in custom job IDs for its internal Redis key
// scheme. Store URLs like "https://bkstr-0300.myshopify.com" contain
// colons (in the scheme and optionally a port), so we have to strip
// them — along with any other Redis-unfriendly characters — before
// passing the ID to BullMQ.
function safeJobId(...parts) {
  return parts
    .map(String)
    .join('-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 200);
}

const app = express();
const PORT = process.env.PORT || 3847;
const REMOTE_BROWSER_ENABLED = process.env.REMOTE_BROWSER_ENABLED === '1';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// All mutable state lives under DATA_DIR so a single Railway volume at
// /app/data can persist runs, screenshots, sweeps, and the chromium
// profile across redeploys. Defaults to __dirname for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// ── Run history persistence ──
const RUNS_DIR = path.join(DATA_DIR, 'runs');
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// ── SSE endpoint for real-time test results ──
// Flow:
//   1. Create a runId and initial run record (stored as JSON on disk).
//   2. Initialize per-run Redis counters (total, completed, failed).
//   3. Enqueue one BullMQ job per store. Workers pick them up and
//      publish progress events to `run:<runId>` in Redis.
//   4. Subscribe to that Redis channel and forward each event to this
//      SSE stream. Also update the on-disk JSON as `test-result`
//      events arrive, so run history survives server restarts.
//   5. When all stores have completed (success or failure), send a
//      `complete` event and close the stream.
//
// Because the work happens in worker processes, multiple users can hit
// this endpoint concurrently without blocking each other — the API
// process only does bookkeeping and streaming.
app.post('/api/run-tests', async (req, res) => {
  const { stores, tests, concurrency } = req.body;

  if (!stores || !stores.length) {
    return res.status(400).json({ error: 'No stores provided' });
  }
  if (!tests || !tests.length) {
    return res.status(400).json({ error: 'No tests selected' });
  }

  // Set up SSE — flushHeaders() forces Express/Node to send headers
  // immediately so the browser opens the stream and starts receiving
  // events as soon as we write them (instead of buffering until the
  // first ~16 KB of body accumulates).
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disables buffering in nginx/Railway proxies
  res.flushHeaders();

  // Send an initial heartbeat immediately so the client knows the
  // stream is alive — prevents the "stuck on Running…" symptom when
  // Redis or workers are down and the rest of this handler stalls.
  res.write(`data: ${JSON.stringify({ type: 'connecting' })}\n\n`);

  // Create a run record for persistence
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runFile = path.join(RUNS_DIR, `${runId}.json`);
  const runData = {
    id: runId,
    startedAt: new Date().toISOString(),
    stores: stores.map(s => s.newStore),
    tests,
    concurrency: concurrency || 3, // now a legacy hint only — real concurrency = worker count × WORKER_CONCURRENCY
    results: [],
    status: 'running',
  };
  fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));

  // Track screenshots per store+test as they arrive
  const screenshotTracker = {}; // key: "store|testId" → [{ src, label }]

  // Writes to the run JSON are debounced — on a big run we might see
  // hundreds of events per second and we don't want to thrash the disk.
  //
  // Status-field race: the worker process is now responsible for flipping
  // status → 'complete' (so the dashboard still updates when the browser
  // or server.js has disconnected). If the worker wins the race and marks
  // complete before the polling loop below, a late debounced write from
  // this function would otherwise clobber that. Read the current status
  // off disk and preserve it if the worker already finalized.
  let pendingWrite = null;
  const scheduleWrite = () => {
    if (pendingWrite) return;
    pendingWrite = setTimeout(() => {
      pendingWrite = null;
      try {
        let preservedStatus = null;
        let preservedCompletedAt = null;
        try {
          const existing = JSON.parse(fs.readFileSync(runFile, 'utf8'));
          if (existing.status === 'complete' || existing.status === 'error') {
            preservedStatus = existing.status;
            preservedCompletedAt = existing.completedAt;
          }
        } catch (_) {}
        const toWrite = preservedStatus
          ? { ...runData, status: preservedStatus, completedAt: preservedCompletedAt }
          : runData;
        fs.writeFileSync(runFile, JSON.stringify(toWrite, null, 2));
      } catch (_) {}
    }, 250);
  };

  const handleEvent = (data) => {
    // Forward to the SSE client (if still connected).
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}

    // Collect screenshots from progress events
    if (data.type === 'test-progress' && data.screenshot) {
      const key = `${data.store}|${data.testId}`;
      if (!screenshotTracker[key]) screenshotTracker[key] = [];
      screenshotTracker[key].push({ src: data.screenshot, label: data.label || '' });
    }

    // Persist test results with their screenshots
    if (data.type === 'test-result') {
      const key = `${data.store}|${data.testId}`;
      runData.results.push({
        store: data.store,
        testId: data.testId,
        passed: data.passed,
        message: data.message,
        checks: data.checks || [],
        screenshots: screenshotTracker[key] || [],
        timestamp: new Date().toISOString(),
      });
      scheduleWrite();
    }
  };

  // Disconnect detection — if the browser closes its SSE connection the
  // run keeps executing on the workers (that's the whole point of
  // decoupling via the queue).
  //
  // We intentionally do NOT unsubscribe from Redis on browser close.
  // Events arriving after the browser leaves still need to be persisted
  // to disk (runData.results), otherwise re-opening the run in the
  // dashboard shows a half-finished picture. The subscription is torn
  // down in the `finally` block when the run actually completes.
  let unsubscribe = null;
  let finished = false;

  try {
    await initRunStatus(runId, stores.length);

    // Subscribe BEFORE enqueuing so we can't miss the very first event.
    unsubscribe = await subscribeToRun(runId, handleEvent);

    // Enqueue one job per store. Priority = store index + 1 so runs
    // round-robin instead of one big run starving everyone else.
    // BullMQ processes lower priority numbers first and FIFO within
    // the same priority, so:
    //   User A submits [a1, a2, …, a50] at t=0
    //   User B submits [b1, b2, b3]     at t=1
    // Order:  a1 → b1 → a2 → b2 → a3 → b3 → a4 → a5 → … → a50
    // B's small run finishes after 3 slots even though A was first.
    const queue = storeTestQueue();
    await Promise.all(
      stores.map((store, idx) =>
        queue.add(
          'store-test',
          { runId, store, testIds: tests },
          {
            jobId: safeJobId(runId, idx, store.newStore),
            priority: idx + 1,
          }
        )
      )
    );

    // Send an initial summary event so the frontend can render the
    // per-store grid immediately. Include queue stats so the user can
    // see how busy the system is at submission time ("12 stores ahead
    // of you across 2 active workers").
    let queueSnapshot = {};
    try {
      const counts = await queue.getJobCounts('wait', 'active');
      const workers = await queue.getWorkers();
      // Subtract this run's own jobs from the `wait` count so the number
      // represents work ahead of *this* user, not their own submission.
      const othersWaiting = Math.max(0, counts.wait - stores.length);
      queueSnapshot = {
        othersWaiting,
        inFlight: counts.active,
        workers: workers.length,
      };
    } catch (_) {}
    handleEvent({
      type: 'run-start',
      runId,
      totalStores: stores.length,
      queue: queueSnapshot,
    });

    // Poll the run counter until all stores have completed (or failed).
    // This is a lightweight check — ~1 hit to Redis per second.
    await new Promise((resolve) => {
      const interval = setInterval(async () => {
        if (finished) return;
        const status = await getRunStatus(runId).catch(() => null);
        if (status && (status.completed + status.failed) >= status.total) {
          finished = true;
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });

    // Flush any pending disk write before we finalize.
    if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null; }
    runData.status = 'complete';
    runData.completedAt = new Date().toISOString();
    try { fs.writeFileSync(runFile, JSON.stringify(runData, null, 2)); } catch (_) {}

    handleEvent({ type: 'complete' });
  } catch (err) {
    console.error('[api/run-tests] error:', err);
    runData.status = 'error';
    runData.error = err.message;
    try { fs.writeFileSync(runFile, JSON.stringify(runData, null, 2)); } catch (_) {}
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); } catch (_) {}
  } finally {
    if (unsubscribe) { unsubscribe().catch(() => {}); unsubscribe = null; }
    try { res.end(); } catch (_) {}
  }
});

// ── Accessibility scan SSE endpoint ──
// Same queue-based pattern as /api/run-tests: enqueue one ada-scan job
// per store, subscribe to Redis, forward events to SSE.
app.post('/api/accessibility-scan', async (req, res) => {
  const { stores } = req.body;
  if (!stores || !stores.length) return res.status(400).json({ error: 'No stores provided' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connecting' })}\n\n`);

  const runId = `ada-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const handleEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  let unsubscribe = null;
  let finished = false;
  req.on('close', () => {
    if (unsubscribe) { unsubscribe().catch(() => {}); unsubscribe = null; }
  });

  try {
    await initRunStatus(runId, stores.length);
    unsubscribe = await subscribeToRun(runId, handleEvent);

    const queue = adaScanQueue();
    await Promise.all(
      stores.map((store, idx) =>
        queue.add(
          'ada-scan',
          { runId, store },
          {
            jobId: safeJobId(runId, idx, store.newStore),
            priority: idx + 1, // fair-share across concurrent scans
          }
        )
      )
    );

    await new Promise((resolve) => {
      const interval = setInterval(async () => {
        if (finished) return;
        const status = await getRunStatus(runId).catch(() => null);
        if (status && (status.completed + status.failed) >= status.total) {
          finished = true;
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });

    handleEvent({ type: 'ada-complete' });
  } catch (err) {
    console.error('[api/accessibility-scan] error:', err);
    try { res.write(`data: ${JSON.stringify({ type: 'ada-error', message: err.message })}\n\n`); } catch (_) {}
  } finally {
    if (unsubscribe) { unsubscribe().catch(() => {}); unsubscribe = null; }
    try { res.end(); } catch (_) {}
  }
});

// NOTE: The /api/internal/screenshots/* upload endpoint was removed.
// Workers now base64-encode screenshots directly into the SSE event
// payload (see worker.js). No shared volume, no shared secret, no
// network round-trip per screenshot — the bytes travel with the event.

// ── Health + capacity monitoring ──
// These two endpoints make multi-user ops easy to debug:
//   GET /api/health       — is Redis reachable? are workers online?
//   GET /api/queue/stats  — queue depth, in-flight jobs, worker counts
// Point a dashboard (or just curl) at them when the system feels slow.

app.get('/api/health', async (req, res) => {
  const { sharedRedis } = require('./lib/queue');

  // Every Redis-touching call is wrapped in Promise.race against a 3s
  // timeout so the health endpoint can't hang, even if the BullMQ
  // client is configured for infinite retries.
  const withTimeout = (p, ms, label) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);

  const health = {
    status: 'ok',
    redis: 'unknown',
    workers: 0,
    redisUrl: (process.env.REDIS_URL || 'redis://localhost:6379').replace(/\/\/[^@]*@/, '//***@'),
    timestamp: new Date().toISOString(),
  };

  try {
    const pong = await withTimeout(sharedRedis().ping(), 3000, 'redis ping');
    health.redis = pong === 'PONG' ? 'ok' : 'degraded';
  } catch (err) {
    health.status = 'degraded';
    health.redis = `error: ${err.message}`;
  }

  try {
    const q = storeTestQueue();
    const workers = await withTimeout(q.getWorkers(), 3000, 'getWorkers');
    health.workers = workers.length;
    if (health.workers === 0) health.status = 'degraded';
  } catch (err) {
    health.status = 'degraded';
    health.workersError = err.message;
  }

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.get('/api/queue/stats', async (req, res) => {
  const withTimeout = (p, ms, label) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  try {
    const storeQ = storeTestQueue();
    const adaQ = adaScanQueue();
    const [storeCounts, adaCounts, storeWorkers, adaWorkers] = await withTimeout(
      Promise.all([
        storeQ.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed'),
        adaQ.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed'),
        storeQ.getWorkers(),
        adaQ.getWorkers(),
      ]),
      5000,
      'queue stats'
    );
    // Total parallel capacity = count of online workers × their configured concurrency.
    // BullMQ doesn't expose per-worker concurrency directly, but workers
    // register with a `name` that typically includes it — we just report
    // the worker count and let ops know to multiply by WORKER_CONCURRENCY.
    res.json({
      storeTest: {
        queued: storeCounts.wait + storeCounts.delayed,
        inFlight: storeCounts.active,
        completed: storeCounts.completed,
        failed: storeCounts.failed,
        workers: storeWorkers.length,
      },
      adaScan: {
        queued: adaCounts.wait + adaCounts.delayed,
        inFlight: adaCounts.active,
        completed: adaCounts.completed,
        failed: adaCounts.failed,
        workers: adaWorkers.length,
      },
      note: 'Total parallel store-tests = workers × WORKER_CONCURRENCY env var',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Accessibility PDF Report ──
app.post('/api/accessibility-pdf', async (req, res) => {
  const { results } = req.body;
  if (!results || !Object.keys(results).length) return res.status(400).json({ error: 'No results' });

  let logoBase64 = '';
  try {
    const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'p3-logo.png'));
    logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;
  } catch (_) {}

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const truncateUrl = s => {
    try { return new URL(s.startsWith('http') ? s : `https://${s}`).hostname; } catch (_) { return s; }
  };

  // Aggregate stats
  let totalViolations = 0, totalCritical = 0, totalSerious = 0, totalModerate = 0, totalMinor = 0, totalPasses = 0;
  const storeCount = Object.keys(results).length;

  for (const [store, data] of Object.entries(results)) {
    for (const page of (data.pages || [])) {
      const s = page.summary || {};
      totalViolations += s.total || 0;
      totalCritical += s.critical || 0;
      totalSerious += s.serious || 0;
      totalModerate += s.moderate || 0;
      totalMinor += s.minor || 0;
      totalPasses += s.passes || 0;
    }
  }

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif; color: #1d1d1f; font-size: 10px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .cover { width: 210mm; height: 297mm; display: flex; flex-direction: column; justify-content: center; align-items: center; background: #000; color: #fff; page-break-after: always; position: relative; }
  .cover-logo { width: 72px; height: 72px; margin-bottom: 40px; border-radius: 16px; filter: invert(1); }
  .cover-title { font-size: 42px; font-weight: 800; letter-spacing: -1.5px; margin-bottom: 8px; }
  .cover-subtitle { font-size: 16px; font-weight: 400; color: rgba(255,255,255,0.5); margin-bottom: 60px; }
  .cover-meta { font-size: 13px; color: rgba(255,255,255,0.35); }
  .cover-stats { display: flex; gap: 36px; margin-bottom: 48px; }
  .cover-stat { text-align: center; }
  .cover-stat .val { font-size: 48px; font-weight: 800; letter-spacing: -2px; }
  .cover-stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.4); margin-top: 4px; }

  .page { width: 210mm; min-height: 297mm; padding: 24mm 20mm 20mm 20mm; page-break-after: always; position: relative; }
  .page:last-child { page-break-after: auto; }
  .page-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; margin-bottom: 20px; border-bottom: 0.5px solid #d2d2d7; }
  .page-header-left { display: flex; align-items: center; gap: 8px; }
  .page-header-logo { width: 18px; height: 18px; border-radius: 4px; }
  .page-header-text { font-size: 9px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 1px; }
  .page-header-date { font-size: 9px; color: #86868b; }

  .section-title { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 24px; }

  .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 28px; }
  .summary-card { background: #f5f5f7; border-radius: 12px; padding: 16px; text-align: center; }
  .summary-card .num { font-size: 28px; font-weight: 800; letter-spacing: -1px; }
  .summary-card .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #86868b; font-weight: 700; margin-top: 2px; }
  .critical { color: #ff3b30; } .serious { color: #ff9f0a; } .moderate { color: #ffd60a; } .minor-c { color: #007aff; } .green { color: #34c759; }

  .store-title { font-size: 20px; font-weight: 800; padding-bottom: 8px; border-bottom: 2px solid #1d1d1f; margin-bottom: 16px; }
  .page-title { font-size: 14px; font-weight: 700; margin-bottom: 12px; background: #f5f5f7; padding: 10px 14px; border-radius: 8px; }

  .violation { border: 0.5px solid #d2d2d7; border-radius: 8px; margin-bottom: 10px; overflow: hidden; page-break-inside: avoid; }
  .violation-header { padding: 10px 14px; display: flex; align-items: flex-start; gap: 10px; background: #fafafa; border-bottom: 0.5px solid #e5e5ea; }
  .impact-badge { font-size: 8px; font-weight: 800; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .impact-badge.critical { background: #ff3b30; color: #fff; }
  .impact-badge.serious { background: #ff9f0a; color: #000; }
  .impact-badge.moderate { background: #ffd60a; color: #000; }
  .impact-badge.minor { background: #007aff; color: #fff; }
  .v-title { font-size: 11px; font-weight: 700; }
  .v-desc { font-size: 10px; color: #86868b; margin-top: 2px; }
  .v-count { font-size: 10px; color: #86868b; flex-shrink: 0; }

  .violation-body { padding: 12px 14px; }
  .fix-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; }
  .fix-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #16a34a; margin-bottom: 4px; }
  .fix-text { font-size: 10px; color: #166534; line-height: 1.6; }

  .element-box { background: #fafafa; border: 0.5px solid #e5e5ea; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; font-size: 9px; }
  .el-label { font-size: 8px; font-weight: 700; text-transform: uppercase; color: #86868b; margin-bottom: 2px; }
  .el-html { font-family: 'SF Mono', Monaco, monospace; color: #c2410c; word-break: break-all; font-size: 9px; }
  .el-selector { font-family: 'SF Mono', Monaco, monospace; color: #2563eb; word-break: break-all; font-size: 9px; }

  .wcag-tags { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
  .wcag-tag { font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 3px; background: #e5e5ea; color: #86868b; text-transform: uppercase; }

  .page-footer { position: absolute; bottom: 12mm; left: 20mm; right: 20mm; display: flex; justify-content: space-between; font-size: 8px; color: #c7c7cc; border-top: 0.5px solid #e5e5ea; padding-top: 8px; }

  .disclaimer { background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 8px 8px 0; padding: 12px 16px; margin-bottom: 24px; font-size: 10px; color: #78570a; line-height: 1.6; }
</style></head><body>`;

  // Cover page
  html += `
  <div class="cover">
    ${logoBase64 ? `<img class="cover-logo" src="${logoBase64}" />` : ''}
    <div class="cover-title">Accessibility Audit</div>
    <div class="cover-subtitle">WCAG 2.1 AA Compliance Report</div>
    <div class="cover-stats">
      <div class="cover-stat"><div class="val" style="color:#ff453a">${totalCritical}</div><div class="lbl">Critical</div></div>
      <div class="cover-stat"><div class="val" style="color:#ff9f0a">${totalSerious}</div><div class="lbl">Serious</div></div>
      <div class="cover-stat"><div class="val" style="color:#ffd60a">${totalModerate}</div><div class="lbl">Moderate</div></div>
      <div class="cover-stat"><div class="val" style="color:#64d2ff">${totalMinor}</div><div class="lbl">Minor</div></div>
      <div class="cover-stat"><div class="val" style="color:#30d158">${totalPasses}</div><div class="lbl">Passed</div></div>
    </div>
    <div class="cover-meta">${dateStr} at ${timeStr} &middot; P3 Media</div>
  </div>`;

  // Summary page
  html += `
  <div class="page">
    <div class="page-header">
      <div class="page-header-left">${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}<span class="page-header-text">Accessibility Audit</span></div>
      <span class="page-header-date">${dateStr}</span>
    </div>
    <div class="section-title">Executive Summary</div>
    <div class="summary-grid">
      <div class="summary-card"><div class="num">${storeCount}</div><div class="lbl">Stores</div></div>
      <div class="summary-card"><div class="num critical">${totalCritical}</div><div class="lbl">Critical</div></div>
      <div class="summary-card"><div class="num serious">${totalSerious}</div><div class="lbl">Serious</div></div>
      <div class="summary-card"><div class="num moderate">${totalModerate}</div><div class="lbl">Moderate</div></div>
      <div class="summary-card"><div class="num green">${totalPasses}</div><div class="lbl">Rules Passed</div></div>
    </div>
    <div class="disclaimer">
      <strong>Action Required:</strong> Critical and serious violations must be fixed before launch. Each violation includes the affected HTML element, CSS selector for locating it, and specific remediation guidance. Moderate and minor issues should be addressed in subsequent sprints.
    </div>
    <div class="page-footer"><span>P3 Media &middot; Confidential</span><span>WCAG 2.1 AA Accessibility Audit</span></div>
  </div>`;

  // Per-store pages
  for (const [store, data] of Object.entries(results)) {
    for (const page of (data.pages || [])) {
      if (!page.violations || !page.violations.length) continue;

      html += `
      <div class="page">
        <div class="page-header">
          <div class="page-header-left">${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}<span class="page-header-text">Accessibility Audit</span></div>
          <span class="page-header-date">${dateStr}</span>
        </div>
        <div class="store-title">${esc(truncateUrl(store))} — ${esc(page.page)}</div>`;

      page.violations.forEach(v => {
        const wcagTags = (v.wcagTags || []).map(t => `<span class="wcag-tag">${t}</span>`).join('');
        const nodesHtml = (v.nodes || []).slice(0, 5).map(n => `
          <div class="element-box">
            <div class="el-label">HTML</div>
            <div class="el-html">${esc(n.html)}</div>
            <div class="el-label" style="margin-top:4px">Selector</div>
            <div class="el-selector">${esc(n.target)}</div>
          </div>
        `).join('');

        html += `
        <div class="violation">
          <div class="violation-header">
            <span class="impact-badge ${v.impact}">${v.impact}</span>
            <div style="flex:1">
              <div class="v-title">${esc(v.help)}</div>
              <div class="v-desc">${esc(v.description)}</div>
            </div>
            <span class="v-count">${(v.nodes || []).length} instances</span>
          </div>
          <div class="violation-body">
            <div class="fix-box">
              <div class="fix-label">How to Fix</div>
              <div class="fix-text">${esc(v.fixGuidance)}</div>
            </div>
            <div class="wcag-tags">${wcagTags}</div>
            ${nodesHtml}
          </div>
        </div>`;
      });

      html += `
        <div class="page-footer"><span>P3 Media &middot; Confidential</span><span>WCAG 2.1 AA Accessibility Audit</span></div>
      </div>`;
    }
  }

  html += '</body></html>';

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const pg = await browser.newPage();
    await pg.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await pg.pdf({ format: 'A4', margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }, printBackground: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Accessibility-Audit-${now.toISOString().slice(0,10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Scheduled runs ──
const scheduledRuns = [];

app.post('/api/schedule-run', (req, res) => {
  const { stores, tests, scheduledFor, concurrency } = req.body;
  if (!stores || !stores.length || !tests || !tests.length || !scheduledFor) {
    return res.status(400).json({ error: 'Missing stores, tests, or scheduledFor' });
  }

  const runTime = new Date(scheduledFor);
  const now = new Date();
  const delay = runTime.getTime() - now.getTime();

  if (delay < 0) {
    return res.status(400).json({ error: 'Scheduled time is in the past' });
  }

  const scheduleId = `sched-${Date.now()}`;
  const entry = {
    id: scheduleId,
    stores,
    tests,
    concurrency: concurrency || 3,
    scheduledFor: runTime.toISOString(),
    status: 'scheduled',
    runId: null,
  };

  const timer = setTimeout(async () => {
    entry.status = 'running';
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runFile = path.join(RUNS_DIR, `${runId}.json`);
    const runData = {
      id: runId,
      startedAt: new Date().toISOString(),
      stores: stores.map(s => s.newStore),
      tests,
      concurrency: entry.concurrency,
      results: [],
      status: 'running',
      scheduled: true,
    };
    fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));
    entry.runId = runId;

    const sendEvent = (data) => {
      if (data.type === 'test-result') {
        runData.results.push({
          store: data.store, testId: data.testId,
          passed: data.passed, message: data.message,
          checks: data.checks || [],
          timestamp: new Date().toISOString(),
        });
        try { fs.writeFileSync(runFile, JSON.stringify(runData, null, 2)); } catch (_) {}
      }
    };

    try {
      // Route through Browserless/remote CDP if configured, same as the
      // worker process. Keeps scheduled runs from hitting Cloudflare
      // from the datacenter IP.
      const runOpts = { concurrency: entry.concurrency };
      if (REMOTE_BROWSER_ENABLED && process.env.BROWSER_WS_URL) {
        runOpts.endpoint = process.env.BROWSER_WS_URL;
      }
      await runTests(stores, tests, sendEvent, runOpts);
      runData.status = 'complete';
      runData.completedAt = new Date().toISOString();
      entry.status = 'complete';
    } catch (err) {
      runData.status = 'error';
      runData.error = err.message;
      entry.status = 'error';
    }
    fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));
  }, delay);

  entry._timer = timer;
  scheduledRuns.push(entry);

  res.json({ id: scheduleId, scheduledFor: runTime.toISOString() });
});

app.get('/api/scheduled-runs', (req, res) => {
  res.json(scheduledRuns.map(({ _timer, ...rest }) => rest));
});

app.delete('/api/scheduled-runs/:id', (req, res) => {
  const idx = scheduledRuns.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  clearTimeout(scheduledRuns[idx]._timer);
  scheduledRuns.splice(idx, 1);
  res.json({ ok: true });
});

// ── Store validation API ──
app.post('/api/validate-stores', async (req, res) => {
  const { stores } = req.body;
  if (!stores || !stores.length) return res.status(400).json({ error: 'No stores' });

  const results = [];
  // Route validation through the same remote browser the workers use
  // when configured — otherwise validate-stores hits Cloudflare from
  // the datacenter IP and reports spurious failures.
  const browser = REMOTE_BROWSER_ENABLED && process.env.BROWSER_WS_URL
    ? await chromium.connectOverCDP(process.env.BROWSER_WS_URL)
    : await chromium.launch({ headless: true });

  for (const store of stores) {
    const result = { store: store.newStore, reachable: false, passwordWorks: null, error: null };
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      const url = store.newStore.startsWith('http') ? store.newStore : `https://${store.newStore}`;
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      result.reachable = resp && resp.status() < 500;

      // Check if password gate exists and if password works
      const hasPasswordGate = await page.evaluate(() => {
        return !!document.querySelector('form[action*="password"]') || document.body.innerText.includes('Enter store password');
      });

      if (hasPasswordGate && store.password) {
        const pwInput = await page.$('input[type="password"]');
        if (pwInput) {
          await pwInput.fill(store.password);
          await page.click('button[type="submit"]');
          await page.waitForTimeout(3000);
          const stillOnPassword = await page.evaluate(() => {
            return !!document.querySelector('form[action*="password"]') || document.body.innerText.includes('Enter store password');
          });
          result.passwordWorks = !stillOnPassword;
        }
      } else if (!hasPasswordGate) {
        result.passwordWorks = true; // No gate, no password needed
      }

      await context.close();
    } catch (err) {
      result.error = err.message;
    }
    results.push(result);
  }

  await browser.close();
  res.json(results);
});

// ── Run history API ──

// List all runs
app.get('/api/runs', (req, res) => {
  try {
    const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const runs = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
      return {
        id: data.id,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        status: data.status,
        storeCount: data.stores.length,
        passed: data.results.filter(r => r.passed).length,
        failed: data.results.filter(r => !r.passed).length,
      };
    });
    res.json(runs);
  } catch (err) {
    res.json([]);
  }
});

// Get a specific run
app.get('/api/runs/:id', (req, res) => {
  const runFile = path.join(RUNS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(runFile)) return res.status(404).json({ error: 'Run not found' });
  res.json(JSON.parse(fs.readFileSync(runFile, 'utf8')));
});

// Generate PDF from a saved run
app.get('/api/runs/:id/pdf', async (req, res) => {
  const runFile = path.join(RUNS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(runFile)) return res.status(404).json({ error: 'Run not found' });

  const runData = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const totalTests = runData.results.length;
  const passedTests = runData.results.filter(r => r.passed).length;
  const failedTests = runData.results.filter(r => !r.passed).length;

  // Convert saved screenshots to base64
  const screenshotCache = {};
  for (const r of runData.results) {
    for (const s of (r.screenshots || [])) {
      if (s.src && !screenshotCache[s.src]) {
        try {
          const filePath = path.join(DATA_DIR, s.src.replace(/^\//, ''));
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            screenshotCache[s.src] = `data:image/png;base64,${buf.toString('base64')}`;
          }
        } catch (_) {}
      }
    }
  }

  // Build results in the format buildPdfHtml expects
  const results = runData.results.map(r => ({
    store: r.store,
    testId: r.testId,
    testName: r.testId,
    passed: r.passed,
    message: r.message,
    checks: r.checks || [],
    screenshots: r.screenshots || [],
    steps: [],
  }));

  // Read logo
  let logoBase64 = '';
  try {
    const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'p3-logo.png'));
    logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;
  } catch (_) {}

  const now = new Date(runData.startedAt);
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const groups = {};
  results.forEach(r => { (groups[r.store] = groups[r.store] || []).push(r); });
  const storeCount = Object.keys(groups).length;

  const html = buildPdfHtml({
    logoBase64, results, groups, totalTests, passedTests, failedTests,
    storeCount, dateStr, timeStr, screenshotCache,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
      preferCSSPageSize: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Follett-QA-Report-${req.params.id.slice(0,10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Diff two runs
app.get('/api/runs/diff/:id1/:id2', (req, res) => {
  const file1 = path.join(RUNS_DIR, `${req.params.id1}.json`);
  const file2 = path.join(RUNS_DIR, `${req.params.id2}.json`);
  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    return res.status(404).json({ error: 'One or both runs not found' });
  }
  const run1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
  const run2 = JSON.parse(fs.readFileSync(file2, 'utf8'));

  // Build lookup: store+testId → passed
  const map1 = {};
  run1.results.forEach(r => { map1[`${r.store}|${r.testId}`] = r.passed; });
  const map2 = {};
  run2.results.forEach(r => { map2[`${r.store}|${r.testId}`] = r.passed; });

  const allKeys = new Set([...Object.keys(map1), ...Object.keys(map2)]);
  const changes = [];
  for (const key of allKeys) {
    const [store, testId] = key.split('|');
    const was = map1[key];
    const now = map2[key];
    if (was !== now) {
      changes.push({
        store, testId,
        was: was === undefined ? 'not run' : was ? 'PASS' : 'FAIL',
        now: now === undefined ? 'not run' : now ? 'PASS' : 'FAIL',
      });
    }
  }

  res.json({
    run1: { id: run1.id, startedAt: run1.startedAt },
    run2: { id: run2.id, startedAt: run2.startedAt },
    changes,
    summary: {
      fixed: changes.filter(c => c.was === 'FAIL' && c.now === 'PASS').length,
      regressed: changes.filter(c => c.was === 'PASS' && c.now === 'FAIL').length,
      newTests: changes.filter(c => c.was === 'not run').length,
      removed: changes.filter(c => c.now === 'not run').length,
    },
  });
});

// PDF report generation endpoint
app.post('/api/generate-pdf', async (req, res) => {
  const { results, totalTests, passedTests, failedTests } = req.body;
  if (!results || !results.length) {
    return res.status(400).json({ error: 'No results provided' });
  }

  // Read logo as base64
  let logoBase64 = '';
  try {
    const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'p3-logo.png'));
    logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;
  } catch (_) {}

  // Convert screenshot paths to base64
  const screenshotCache = {};
  for (const r of results) {
    for (const s of (r.screenshots || [])) {
      if (s.src && !screenshotCache[s.src]) {
        try {
          const filePath = path.join(DATA_DIR, s.src.replace(/^\//, ''));
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            screenshotCache[s.src] = `data:image/png;base64,${buf.toString('base64')}`;
          }
        } catch (_) {}
      }
    }
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Group by store
  const groups = {};
  results.forEach(r => { (groups[r.store] = groups[r.store] || []).push(r); });
  const storeCount = Object.keys(groups).length;

  const html = buildPdfHtml({
    logoBase64, results, groups, totalTests, passedTests, failedTests,
    storeCount, dateStr, timeStr, screenshotCache,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
      preferCSSPageSize: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Follett-QA-Report-${now.toISOString().slice(0,10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

function buildPdfHtml({ logoBase64, results, groups, totalTests, passedTests, failedTests, storeCount, dateStr, timeStr, screenshotCache, cfBlockedStores, reportTitle }) {
  const cfSet = cfBlockedStores instanceof Set ? cfBlockedStores : new Set(cfBlockedStores || []);
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const truncateUrl = s => {
    try { return new URL(s.startsWith('http') ? s : `https://${s}`).hostname; } catch (_) { return s.replace(/[?#].*$/, '').replace(/\/.*$/, ''); }
  };
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #1d1d1f;
    font-size: 10px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Cover Page ── */
  .cover {
    width: 210mm; height: 297mm;
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    background: #000;
    color: #fff;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover::before {
    content: '';
    position: absolute;
    top: -50%; left: -50%;
    width: 200%; height: 200%;
    background: radial-gradient(ellipse at 30% 50%, rgba(255,255,255,0.03) 0%, transparent 70%);
  }
  .cover-logo { width: 72px; height: 72px; margin-bottom: 40px; border-radius: 16px; position: relative; z-index: 1; filter: invert(1); }
  .cover-title { font-size: 42px; font-weight: 800; letter-spacing: -1.5px; margin-bottom: 8px; position: relative; z-index: 1; }
  .cover-subtitle { font-size: 16px; font-weight: 400; color: rgba(255,255,255,0.5); letter-spacing: 0.5px; margin-bottom: 60px; position: relative; z-index: 1; }
  .cover-meta { font-size: 13px; color: rgba(255,255,255,0.35); position: relative; z-index: 1; }
  .cover-stats {
    display: flex; gap: 48px; margin-bottom: 48px; position: relative; z-index: 1;
  }
  .cover-stat { text-align: center; }
  .cover-stat .val { font-size: 48px; font-weight: 800; letter-spacing: -2px; }
  .cover-stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.4); margin-top: 4px; }
  .cover-stat .val.green { color: #30d158; }
  .cover-stat .val.red { color: #ff453a; }
  .cover-stat .val.white { color: #fff; }

  /* ── Content Pages ── */
  .page {
    width: 210mm;
    min-height: 297mm;
    padding: 24mm 20mm 20mm 20mm;
    page-break-after: always;
    position: relative;
  }
  .page:last-child { page-break-after: auto; }

  .page-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; margin-bottom: 20px;
    border-bottom: 0.5px solid #d2d2d7;
  }
  .page-header-left { display: flex; align-items: center; gap: 8px; }
  .page-header-logo { width: 18px; height: 18px; border-radius: 4px; }
  .page-header-text { font-size: 9px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 1px; }
  .page-header-date { font-size: 9px; color: #86868b; }

  /* ── Executive Summary ── */
  .exec-title { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 24px; }
  .exec-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px; margin-bottom: 28px;
  }
  .exec-card {
    background: #f5f5f7; border-radius: 12px; padding: 20px; text-align: center;
  }
  .exec-card .num { font-size: 32px; font-weight: 800; letter-spacing: -1px; }
  .exec-card .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #86868b; font-weight: 700; margin-top: 4px; }
  .exec-card .num.green { color: #34c759; }
  .exec-card .num.red { color: #ff3b30; }

  .pass-rate-bar {
    background: #f5f5f7; border-radius: 12px; padding: 16px 20px; margin-bottom: 28px;
    display: flex; align-items: center; gap: 16px;
  }
  .pass-rate-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; white-space: nowrap; }
  .pass-rate-track { flex: 1; height: 8px; background: #e5e5ea; border-radius: 4px; overflow: hidden; }
  .pass-rate-fill { height: 100%; border-radius: 4px; background: #34c759; }
  .pass-rate-pct { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }

  /* ── Store Overview Table ── */
  .overview-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin-bottom: 12px; }
  .overview-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  .overview-table th {
    text-align: left; padding: 10px 12px; font-size: 9px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #86868b;
    border-bottom: 1px solid #d2d2d7; background: #fafafa;
  }
  .overview-table td { padding: 10px 12px; font-size: 11px; border-bottom: 0.5px solid #e5e5ea; }
  .overview-table .store-name { font-weight: 600; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.pass { background: #34c759; }
  .dot.fail { background: #ff3b30; }
  .dot.warn { background: #ff9f0a; }
  .dot.cf   { background: #ff9f0a; }
  .cf-badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:8px; font-weight:800; letter-spacing:0.3px; background:#ff9f0a; color:#000; text-transform:uppercase; margin-left:8px; }

  /* ── Store Detail Sections ── */
  .store-section { margin-bottom: 28px; }
  .store-title {
    font-size: 20px; font-weight: 800; letter-spacing: -0.3px;
    padding-bottom: 8px; border-bottom: 2px solid #1d1d1f; margin-bottom: 16px;
    display: flex; align-items: center; gap: 10px;
  }
  .store-title .dot { width: 10px; height: 10px; }

  .test-card {
    border: 0.5px solid #d2d2d7; border-radius: 10px; margin-bottom: 12px;
    overflow: hidden; page-break-inside: avoid;
  }
  .test-card-header {
    padding: 12px 16px; display: flex; align-items: center; gap: 10px;
    background: #fafafa; border-bottom: 0.5px solid #e5e5ea;
  }
  .test-card-name { font-size: 13px; font-weight: 700; flex: 1; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 5px; font-size: 9px; font-weight: 800; letter-spacing: 0.3px; }
  .badge.pass { background: #d1fae5; color: #065f46; }
  .badge.fail { background: #fee2e2; color: #991b1b; }

  .test-card-body { padding: 14px 16px; }
  .test-message { font-size: 11px; color: #1d1d1f; line-height: 1.6; margin-bottom: 10px; }

  /* ── Sub-checks Table ── */
  .checks-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin-bottom: 8px; }
  .checks-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .checks-table th {
    text-align: left; padding: 6px 10px; font-size: 8px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #86868b;
    border-bottom: 0.5px solid #d2d2d7; background: #fafafa;
  }
  .checks-table td { padding: 7px 10px; font-size: 10px; border-bottom: 0.5px solid #f0f0f0; }
  .checks-table tr.fail td { background: #fff5f5; }
  .check-name { font-weight: 600; }
  .check-status { font-weight: 700; font-size: 9px; }
  .check-status.pass { color: #34c759; }
  .check-status.fail { color: #ff3b30; }

  /* ── Screenshots ── */
  .screenshots-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin: 12px 0 8px; }
  .screenshot-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .screenshot-item { width: 48%; }
  .screenshot-item img { width: 100%; border-radius: 6px; border: 0.5px solid #d2d2d7; display: block; }
  .screenshot-caption { font-size: 8px; color: #86868b; margin-top: 4px; font-weight: 500; }

  /* ── Footer ── */
  .page-footer {
    position: absolute; bottom: 12mm; left: 20mm; right: 20mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 8px; color: #c7c7cc;
    border-top: 0.5px solid #e5e5ea; padding-top: 8px;
  }

  /* ── Disclaimer ── */
  .disclaimer {
    background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 8px 8px 0;
    padding: 12px 16px; margin-bottom: 24px; font-size: 10px; color: #78570a; line-height: 1.6;
  }
  .disclaimer strong { color: #92400e; }
</style></head><body>`;

  // ── Cover Page ──
  html += `
<div class="cover">
  ${logoBase64 ? `<img class="cover-logo" src="${logoBase64}" />` : ''}
  <div class="cover-title">${reportTitle || 'Go Live Report'}</div>
  <div class="cover-subtitle">Follett Shopify Store Launch Validation</div>
  <div class="cover-stats">
    <div class="cover-stat"><div class="val white">${totalTests}</div><div class="lbl">Tests Run</div></div>
    <div class="cover-stat"><div class="val green">${passedTests}</div><div class="lbl">Passed</div></div>
    <div class="cover-stat"><div class="val red">${failedTests}</div><div class="lbl">Failed</div></div>
    <div class="cover-stat"><div class="val white">${storeCount}</div><div class="lbl">Stores</div></div>
  </div>
  <div class="cover-meta">${dateStr} at ${timeStr} &middot; P3 Media</div>
</div>`;

  // ── Executive Summary Page ──
  html += `
<div class="page">
  <div class="page-header">
    <div class="page-header-left">
      ${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}
      <span class="page-header-text">Follett QA Report</span>
    </div>
    <span class="page-header-date">${dateStr}</span>
  </div>

  <div class="exec-title">Executive Summary</div>

  <div class="exec-grid">
    <div class="exec-card"><div class="num">${storeCount}</div><div class="lbl">Stores Tested</div></div>
    <div class="exec-card"><div class="num">${totalTests}</div><div class="lbl">Total Tests</div></div>
    <div class="exec-card"><div class="num green">${passedTests}</div><div class="lbl">Passed</div></div>
    <div class="exec-card"><div class="num red">${failedTests}</div><div class="lbl">Failed</div></div>
  </div>

  <div class="pass-rate-bar">
    <div class="pass-rate-label">Pass Rate</div>
    <div class="pass-rate-track"><div class="pass-rate-fill" style="width:${passRate}%"></div></div>
    <div class="pass-rate-pct">${passRate}%</div>
  </div>

  <div class="disclaimer">
    <strong>Important:</strong> Automated tests validate element presence, visibility, and basic functionality.
    Each passed check should be manually verified by a QA reviewer before production sign-off.
    This report should be archived for auditing and compliance purposes.
  </div>

  <div class="overview-title">Store Results Overview</div>
  <table class="overview-table">
    <thead><tr><th>Store</th><th>Passed</th><th>Failed</th><th>Status</th></tr></thead>
    <tbody>`;

  for (const [store, tests] of Object.entries(groups)) {
    const sp = tests.filter(t => t.passed).length;
    const sf = tests.filter(t => !t.passed).length;
    const isCf = cfSet.has(store);
    const status = isCf ? 'cf' : (sf > 0 ? 'fail' : 'pass');
    const statusLabel = isCf ? 'CF-blocked' : (sf > 0 ? 'Needs Attention' : 'All Passed');
    html += `
      <tr>
        <td class="store-name">${esc(truncateUrl(store))}</td>
        <td>${sp}</td>
        <td>${sf}</td>
        <td><span class="dot ${status}"></span>${statusLabel}</td>
      </tr>`;
  }

  html += `</tbody></table>
  <div class="page-footer">
    <span>P3 Media &middot; Confidential</span>
    <span>Follett Launch QA Report</span>
  </div>
</div>`;

  // ── Store Detail Pages ──
  for (const [store, tests] of Object.entries(groups)) {
    const sf = tests.filter(t => !t.passed).length;
    const isCf = cfSet.has(store);
    const storeStatus = isCf ? 'cf' : (sf > 0 ? 'fail' : 'pass');

    html += `
<div class="page">
  <div class="page-header">
    <div class="page-header-left">
      ${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}
      <span class="page-header-text">Follett QA Report</span>
    </div>
    <span class="page-header-date">${dateStr}</span>
  </div>

  <div class="store-section">
    <div class="store-title">
      <span class="dot ${storeStatus}"></span>
      ${esc(truncateUrl(store))}
      ${isCf ? '<span class="cf-badge">CF-blocked</span>' : ''}
    </div>`;

    tests.forEach(t => {
      const status = t.passed ? 'pass' : 'fail';
      html += `
    <div class="test-card">
      <div class="test-card-header">
        <span class="dot ${status}"></span>
        <div class="test-card-name">${esc(t.testName)}</div>
        <span class="badge ${status}">${t.passed ? 'PASS' : 'FAIL'}</span>
      </div>
      <div class="test-card-body">
        <div class="test-message">${esc(t.message)}</div>`;

      // Sub-checks
      if (t.checks && t.checks.length > 0) {
        const cp = t.checks.filter(c => c.passed).length;
        const cf = t.checks.filter(c => !c.passed).length;
        html += `
        <div class="checks-title">Sub-Checks &mdash; ${cp} passed, ${cf} failed</div>
        <table class="checks-table">
          <thead><tr><th style="width:60px">Status</th><th style="width:160px">Check</th><th>Detail</th></tr></thead>
          <tbody>`;
        t.checks.forEach(c => {
          const cs = c.passed ? 'pass' : 'fail';
          html += `
            <tr class="${cs}">
              <td><span class="check-status ${cs}">${c.passed ? 'PASS' : 'FAIL'}</span></td>
              <td class="check-name">${esc(c.name)}</td>
              <td>${esc(c.detail)}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
      }

      // Screenshots
      if (t.screenshots && t.screenshots.length > 0) {
        html += `<div class="screenshots-title">Evidence Screenshots</div><div class="screenshot-grid">`;
        t.screenshots.forEach(s => {
          const imgSrc = screenshotCache[s.src] || s.src;
          html += `
          <div class="screenshot-item">
            <img src="${imgSrc}" />
            <div class="screenshot-caption">${esc(s.label)}</div>
          </div>`;
        });
        html += `</div>`;
      }

      html += `</div></div>`;
    });

    html += `
  </div>
  <div class="page-footer">
    <span>P3 Media &middot; Confidential</span>
    <span>Follett Launch QA Report</span>
  </div>
</div>`;
  }

  html += `</body></html>`;
  return html;
}

// ── Sweep queue API ──
//
// A "sweep" is a self-pacing batch run: paste many preview URLs and
// a background worker drains them one-at-a-time with jitter, so we
// stay under Cloudflare's rate-limit radar. Each completed sweep
// item produces a standard runs/{id}.json so it shows up in the
// normal dashboard with zero extra work.

app.post('/api/sweeps', (req, res) => {
  const { urls, tests, storesPerHour, jitterPct } = req.body || {};
  try {
    const sweep = sweepWorker.createSweep({ urls, tests, storesPerHour, jitterPct });
    res.json(sweep);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sweeps', (req, res) => {
  res.json(sweepWorker.listSweeps());
});

app.get('/api/sweeps/:id', (req, res) => {
  const sweep = sweepWorker.getSweep(req.params.id);
  if (!sweep) return res.status(404).json({ error: 'Sweep not found' });
  res.json(sweep);
});

app.post('/api/sweeps/:id/pause', (req, res) => {
  const sweep = sweepWorker.pauseSweep(req.params.id);
  if (!sweep) return res.status(404).json({ error: 'Sweep not found' });
  res.json(sweep);
});

app.post('/api/sweeps/:id/resume', (req, res) => {
  const sweep = sweepWorker.resumeSweep(req.params.id);
  if (!sweep) return res.status(404).json({ error: 'Sweep not found' });
  res.json(sweep);
});

// Aggregate PDF for an entire sweep — only available when status === 'complete'.
// Rolls up every item's individual runs/{runId}.json into a single report
// via the existing buildPdfHtml helper.
app.get('/api/sweeps/:id/pdf', async (req, res) => {
  const sweep = sweepWorker.getSweep(req.params.id);
  if (!sweep) return res.status(404).json({ error: 'Sweep not found' });
  if (sweep.status !== 'complete') {
    return res.status(409).json({ error: 'Sweep is not complete yet' });
  }

  // Gather results from every item's run file
  const results = [];
  const cfBlockedStores = new Set();
  const screenshotCache = {};

  for (const item of sweep.items) {
    if (item.status === 'cf-blocked') cfBlockedStores.add(item.url);
    if (!item.runId) continue;

    const runFile = path.join(RUNS_DIR, `${item.runId}.json`);
    if (!fs.existsSync(runFile)) continue;
    let runData;
    try {
      runData = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch (_) { continue; }

    for (const r of (runData.results || [])) {
      results.push({
        store: r.store,
        testId: r.testId,
        testName: r.testId,
        passed: r.passed,
        message: r.message,
        checks: r.checks || [],
        screenshots: r.screenshots || [],
        steps: [],
      });

      // Inline screenshots as base64
      for (const s of (r.screenshots || [])) {
        if (s.src && !screenshotCache[s.src]) {
          try {
            const filePath = path.join(DATA_DIR, s.src.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
              const buf = fs.readFileSync(filePath);
              screenshotCache[s.src] = `data:image/png;base64,${buf.toString('base64')}`;
            }
          } catch (_) {}
        }
      }
    }
  }

  // Ensure CF-blocked stores with no results still appear in the report
  // (their items never wrote a runs file, or did so before being marked blocked).
  for (const url of cfBlockedStores) {
    if (!results.some(r => r.store === url)) {
      results.push({
        store: url,
        testId: 'storefront-login',
        testName: 'Storefront Login',
        passed: false,
        message: 'Cloudflare challenge could not be bypassed — store was not tested.',
        checks: [],
        screenshots: [],
        steps: [],
      });
    }
  }

  const totalTests = results.length;
  const passedTests = results.filter(r => r.passed).length;
  const failedTests = totalTests - passedTests;

  let logoBase64 = '';
  try {
    const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'p3-logo.png'));
    logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;
  } catch (_) {}

  const started = new Date(sweep.createdAt);
  const dateStr = started.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = started.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const groups = {};
  results.forEach(r => { (groups[r.store] = groups[r.store] || []).push(r); });
  const storeCount = Object.keys(groups).length;

  const html = buildPdfHtml({
    logoBase64, results, groups, totalTests, passedTests, failedTests,
    storeCount, dateStr, timeStr, screenshotCache,
    cfBlockedStores,
    reportTitle: 'Sweep Report',
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Follett-Sweep-Report-${sweep.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.delete('/api/sweeps/:id', (req, res) => {
  const ok = sweepWorker.deleteSweep(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Cannot delete: sweep not found or an item is currently running' });
  res.json({ ok: true });
});

// ── Disk cleanup ──
//
// Unattended sweeps produce a lot of screenshots and run JSON files.
// Without pruning, daily sweeps fill the disk within weeks. This walks
// runs/ and screenshots/ recursively on boot and every 24h, deleting
// anything whose mtime is older than RETENTION_DAYS (default 30).
//
// Simple mtime-based policy — anything old is gone. Screenshots
// referenced only by deleted run files become unreachable anyway, so
// pruning them together is consistent.

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function walkAndDeleteOld(dir, cutoffMs, stats) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndDeleteOld(full, cutoffMs, stats);
      // Remove the directory if it's now empty
      try {
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
          stats.dirs++;
        }
      } catch (_) {}
      continue;
    }
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoffMs) {
        fs.unlinkSync(full);
        stats.files++;
        stats.bytes += st.size;
      }
    } catch (_) {}
  }
}

function runCleanup() {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stats = { files: 0, dirs: 0, bytes: 0 };
  walkAndDeleteOld(RUNS_DIR, cutoffMs, stats);
  walkAndDeleteOld(SCREENSHOTS_DIR, cutoffMs, stats);
  if (stats.files > 0 || stats.dirs > 0) {
    const mb = (stats.bytes / 1024 / 1024).toFixed(1);
    console.log(`[cleanup] Deleted ${stats.files} files (${mb} MB) and ${stats.dirs} empty dirs older than ${RETENTION_DAYS} days.`);
  }
}

// Runs whose `status` is still 'running' on disk but whose Redis counter
// already says done are orphans — left over from a previous process that
// crashed or got redeployed before its polling loop could finalize them.
// Sweep them on boot so the dashboard shows COMPLETE for runs that did
// in fact finish. (Redis TTLs the counter after RUN_TTL_SECONDS, so runs
// older than that just stay as-is — nothing we can recover.)
async function reconcileOrphanedRuns() {
  let files = [];
  try { files = fs.readdirSync(RUNS_DIR); } catch (_) { return; }
  let fixed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const runFile = path.join(RUNS_DIR, f);
    let runData;
    try { runData = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (_) { continue; }
    if (runData.status !== 'running') continue;
    let done = false;
    try { done = await isRunFinished(runData.id); } catch (_) {}
    if (!done) continue;
    runData.status = 'complete';
    runData.completedAt = runData.completedAt || new Date().toISOString();
    try {
      fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));
      fixed++;
    } catch (_) {}
  }
  if (fixed > 0) console.log(`[server] reconciled ${fixed} orphaned run(s) on boot`);
}

app.listen(PORT, () => {
  console.log(`QA Automation running at http://localhost:${PORT}`);
  sweepWorker.start();
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  reconcileOrphanedRuns().catch((e) => console.warn('[server] reconcile failed:', e.message));
});
