// ─── Sweep Worker ───────────────────────────────────────────────────
//
// Drains a list of preview URLs one-at-a-time with configurable pacing
// and jitter, so that batch QA runs (~50/day) stay under Cloudflare's
// rate-limit radar. Reuses runTests() from test-runner.js unchanged —
// the worker is purely a pacer + persistence layer.
//
// Data lives in sweeps/sweeps.json. Each completed sweep item also
// produces a standard runs/{id}.json so the existing dashboard, PDF
// export, and diff endpoints all work against sweep output with zero
// changes.

const fs = require('fs');
const path = require('path');
const { runTests } = require('./test-runner');

const SWEEPS_DIR = path.join(__dirname, 'sweeps');
const SWEEPS_FILE = path.join(SWEEPS_DIR, 'sweeps.json');
const RUNS_DIR = path.join(__dirname, 'runs');

const TICK_INTERVAL_MS = 30_000;   // check queue every 30s
const DEFAULT_STORES_PER_HOUR = 2;  // ~48/day
const DEFAULT_JITTER_PCT = 0.3;    // ±30%

// String the CF wrapper in test-runner.js emits when stealth + Turnstile
// fails after 3 attempts. Matching this in the progress stream is how we
// distinguish "blocked by Cloudflare" from other test failures.
const CF_BLOCKED_SIGNAL = 'Cloudflare challenge could not be resolved';

// Cloudflare retry policy: each item gets up to this many total attempts.
// Between attempts, the item is re-queued with a cooldown so its
// cf_clearance cookie (if any was harvested during the failed attempt)
// has time to stabilize and our per-IP challenge rate drops.
const MAX_CF_ATTEMPTS = 3;
const CF_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Browser strategy for sweeps — overridden by env vars so the user can
// point at Browserless/Bright Data without touching code.
const BROWSER_OPTIONS = {
  endpoint: process.env.SWEEP_BROWSER_ENDPOINT || null,
  persistent: process.env.SWEEP_BROWSER_ENDPOINT ? false : true,
  userDataDir: process.env.SWEEP_USER_DATA_DIR || path.join(__dirname, '.browser-data'),
  headful: process.env.SWEEP_BROWSER_HEADFUL === '1',
};

let state = { sweeps: [] };
let isRunning = false;   // only one sweep item processes globally at a time
let tickHandle = null;

// ─── Persistence ────────────────────────────────────────────────────

function ensureDirs() {
  if (!fs.existsSync(SWEEPS_DIR)) fs.mkdirSync(SWEEPS_DIR, { recursive: true });
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function loadSweeps() {
  ensureDirs();
  if (!fs.existsSync(SWEEPS_FILE)) {
    state.sweeps = [];
    return;
  }
  try {
    const raw = fs.readFileSync(SWEEPS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state.sweeps = Array.isArray(parsed) ? parsed : (parsed.sweeps || []);

    // Recovery: any item left `running` from a previous boot was
    // interrupted — reset it to pending so the next tick picks it up.
    for (const sweep of state.sweeps) {
      for (const item of sweep.items) {
        if (item.status === 'running') {
          item.status = 'pending';
          item.startedAt = null;
        }
      }
    }
    persist();
  } catch (err) {
    console.error('[sweep-worker] Failed to load sweeps.json:', err.message);
    state.sweeps = [];
  }
}

function persist() {
  ensureDirs();
  const tmp = SWEEPS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state.sweeps, null, 2));
  fs.renameSync(tmp, SWEEPS_FILE);
}

// ─── Public API (used by server.js endpoints) ───────────────────────

function listSweeps() {
  return state.sweeps.map(summarize);
}

function getSweep(id) {
  return state.sweeps.find(s => s.id === id) || null;
}

function createSweep({ urls, tests, storesPerHour, jitterPct }) {
  const cleanUrls = (urls || [])
    .map(u => String(u || '').trim())
    .filter(Boolean);

  if (!cleanUrls.length) throw new Error('No URLs provided');
  if (!tests || !tests.length) throw new Error('No tests selected');

  const id = `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const sweep = {
    id,
    createdAt: new Date().toISOString(),
    tests: tests.slice(),
    pacing: {
      storesPerHour: storesPerHour || DEFAULT_STORES_PER_HOUR,
      jitterPct: jitterPct == null ? DEFAULT_JITTER_PCT : jitterPct,
    },
    status: 'running',
    nextEligibleAt: new Date().toISOString(), // first item runs immediately
    items: cleanUrls.map(url => ({
      url,
      status: 'pending',
      runId: null,
      startedAt: null,
      completedAt: null,
      passed: 0,
      failed: 0,
      message: null,
      cfAttempts: 0,      // incremented each time this item hits a CF wall
      retryAfter: null,   // ISO timestamp; worker skips item until now > retryAfter
    })),
  };
  state.sweeps.unshift(sweep);
  persist();

  // Kick the loop immediately so the first item starts without waiting
  // for the next tick boundary.
  setImmediate(tick);
  return sweep;
}

function pauseSweep(id) {
  const sweep = getSweep(id);
  if (!sweep) return null;
  if (sweep.status === 'complete') return sweep;
  sweep.status = 'paused';
  persist();
  return sweep;
}

function resumeSweep(id) {
  const sweep = getSweep(id);
  if (!sweep) return null;
  if (sweep.status === 'complete') return sweep;
  sweep.status = 'running';
  persist();
  setImmediate(tick);
  return sweep;
}

function deleteSweep(id) {
  const idx = state.sweeps.findIndex(s => s.id === id);
  if (idx === -1) return false;
  const sweep = state.sweeps[idx];
  // Refuse to delete a sweep whose item is currently running.
  if (sweep.items.some(i => i.status === 'running')) return false;
  state.sweeps.splice(idx, 1);
  persist();
  return true;
}

// ─── Worker loop ────────────────────────────────────────────────────

function start() {
  loadSweeps();
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(tick, TICK_INTERVAL_MS);
  setImmediate(tick);
}

async function tick() {
  if (isRunning) return;

  const now = Date.now();
  // An item is eligible if it's pending AND either has no retryAfter
  // set or its retryAfter has passed. CF-blocked items being re-queued
  // use retryAfter to enforce a cooldown before the next attempt.
  const isEligibleItem = i =>
    i.status === 'pending' &&
    (!i.retryAfter || new Date(i.retryAfter).getTime() <= now);

  const sweep = state.sweeps.find(s =>
    s.status === 'running' &&
    new Date(s.nextEligibleAt).getTime() <= now &&
    s.items.some(isEligibleItem)
  );
  if (!sweep) return;

  const item = sweep.items.find(isEligibleItem);
  if (!item) return;

  isRunning = true;
  try {
    await processItem(sweep, item);
  } catch (err) {
    console.error('[sweep-worker] Unhandled error processing item:', err);
    item.status = 'error';
    item.message = String(err.message || err);
    item.completedAt = new Date().toISOString();
    persist();
  } finally {
    // Compute next eligibility based on pacing, independent of item success.
    scheduleNext(sweep);
    finalizeIfDone(sweep);
    persist();
    isRunning = false;
    // If the sweep has more items AND nextEligibleAt is already past,
    // the setInterval will pick it up on its own. No recursive kick.
  }
}

async function processItem(sweep, item) {
  item.status = 'running';
  item.startedAt = new Date().toISOString();
  persist();

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runFile = path.join(RUNS_DIR, `${runId}.json`);
  const runData = {
    id: runId,
    startedAt: item.startedAt,
    stores: [item.url],
    tests: sweep.tests,
    concurrency: 1,
    results: [],
    status: 'running',
    sweepId: sweep.id,
  };
  fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));
  item.runId = runId;
  persist();

  // Track CF-blocked signal + screenshots across test-result events,
  // matching the shape server.js uses for /api/run-tests.
  const screenshotTracker = {};
  let cfBlocked = false;

  const sendEvent = (data) => {
    if (data.type === 'test-progress') {
      if (data.screenshot) {
        const key = `${data.store}|${data.testId}`;
        if (!screenshotTracker[key]) screenshotTracker[key] = [];
        screenshotTracker[key].push({ src: data.screenshot, label: data.label || '' });
      }
      if (typeof data.step === 'string' && data.step.includes(CF_BLOCKED_SIGNAL)) {
        cfBlocked = true;
      }
    }
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
      try { fs.writeFileSync(runFile, JSON.stringify(runData, null, 2)); } catch (_) {}
    }
  };

  const stores = [{ originalStore: '', newStore: item.url, password: '' }];

  try {
    await runTests(stores, sweep.tests, sendEvent, {
      concurrency: 1,
      endpoint: BROWSER_OPTIONS.endpoint,
      persistent: BROWSER_OPTIONS.persistent,
      userDataDir: BROWSER_OPTIONS.userDataDir,
      headful: BROWSER_OPTIONS.headful,
    });
    runData.status = 'complete';
    runData.completedAt = new Date().toISOString();
    fs.writeFileSync(runFile, JSON.stringify(runData, null, 2));

    item.passed = runData.results.filter(r => r.passed).length;
    item.failed = runData.results.filter(r => !r.passed).length;
    item.completedAt = runData.completedAt;

    if (cfBlocked) {
      applyCfOutcome(item);
    } else {
      item.status = 'complete';
      item.message = `${item.passed} passed, ${item.failed} failed`;
    }
  } catch (err) {
    runData.status = 'error';
    runData.error = err.message;
    runData.completedAt = new Date().toISOString();
    try { fs.writeFileSync(runFile, JSON.stringify(runData, null, 2)); } catch (_) {}

    if (cfBlocked) {
      applyCfOutcome(item);
    } else {
      item.status = 'error';
      item.message = err.message;
      item.completedAt = runData.completedAt;
    }
  }
}

// CF-blocked items get up to MAX_CF_ATTEMPTS total tries. On the first
// N-1 failures we re-queue the item with a cooldown; only the final
// failure pins the item as permanently cf-blocked. This buys us time
// for cf_clearance cookies to naturalize and per-IP challenge rates
// to decay between attempts.
function applyCfOutcome(item) {
  item.cfAttempts = (item.cfAttempts || 0) + 1;
  if (item.cfAttempts < MAX_CF_ATTEMPTS) {
    item.status = 'pending';
    item.retryAfter = new Date(Date.now() + CF_COOLDOWN_MS).toISOString();
    item.message = `CF challenge (attempt ${item.cfAttempts}/${MAX_CF_ATTEMPTS}) — retrying after cooldown`;
    // Don't set completedAt — the item isn't done
  } else {
    item.status = 'cf-blocked';
    item.message = `Cloudflare challenge could not be bypassed after ${MAX_CF_ATTEMPTS} attempts`;
    item.completedAt = new Date().toISOString();
  }
}

function scheduleNext(sweep) {
  const base = 3_600_000 / Math.max(0.1, sweep.pacing.storesPerHour);
  const jitter = sweep.pacing.jitterPct || 0;
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  const delay = Math.max(5_000, Math.floor(base * factor));
  sweep.nextEligibleAt = new Date(Date.now() + delay).toISOString();
}

function finalizeIfDone(sweep) {
  const allDone = sweep.items.every(i =>
    i.status === 'complete' ||
    i.status === 'cf-blocked' ||
    i.status === 'error'
  );
  if (allDone) {
    sweep.status = 'complete';
    sweep.completedAt = new Date().toISOString();
  }
}

// ─── Summary helper for list endpoint ───────────────────────────────

function summarize(sweep) {
  const counts = { pending: 0, running: 0, complete: 0, 'cf-blocked': 0, error: 0 };
  for (const i of sweep.items) counts[i.status] = (counts[i.status] || 0) + 1;
  const remaining = counts.pending + counts.running;
  const ratePerMs = sweep.pacing.storesPerHour / 3_600_000;
  const etaMs = ratePerMs > 0 ? remaining / ratePerMs : 0;

  return {
    id: sweep.id,
    createdAt: sweep.createdAt,
    completedAt: sweep.completedAt || null,
    status: sweep.status,
    nextEligibleAt: sweep.nextEligibleAt,
    pacing: sweep.pacing,
    tests: sweep.tests,
    total: sweep.items.length,
    counts,
    etaMs,
  };
}

module.exports = {
  start,
  listSweeps,
  getSweep,
  createSweep,
  pauseSweep,
  resumeSweep,
  deleteSweep,
};
