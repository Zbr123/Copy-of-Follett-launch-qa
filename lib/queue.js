// ─── Queue infrastructure ─────────────────────────────────────────────
// BullMQ (Redis-backed) queue + pub/sub for test execution.
//
// Architecture:
//   • API server enqueues one job per (runId, store) pair.
//   • Worker processes pull jobs and execute tests.
//   • Workers publish progress events to a Redis pub/sub channel keyed
//     by runId.
//   • API server subscribes to that channel and forwards events to the
//     SSE stream for any client tailing the run.
//   • Every published event is also LPUSHed into a bounded Redis list
//     so a client that connects late (or reloads the page) can replay
//     the history before subscribing to the live stream.
//
// This decouples the API process from the workers so:
//   1. Multiple users can start runs concurrently.
//   2. Workers can scale horizontally (docker compose up --scale worker=N).
//   3. If the API restarts, in-flight runs keep executing on the workers.

const { Queue, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// BullMQ requires its blocking clients (Workers, QueueEvents) to use
// `maxRetriesPerRequest: null` — commands must queue rather than fail
// while waiting on `BRPOPLPUSH`. We use this ONLY for BullMQ internals.
const connectionOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// API-layer client options: fail fast when Redis is unreachable so the
// HTTP request doesn't hang silently. Commands time out after 5s; the
// retry strategy gives up after ~5 attempts (~3s total backoff).
const apiClientOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  commandTimeout: 5000,
  retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
};

// Attach a throttled error handler so ioredis doesn't spam the logs
// on every reconnect attempt when Redis is unreachable. We log the
// first failure per client and then stay quiet until the client
// reconnects, at which point we log the recovery.
function attachErrorLogger(client, label) {
  let lastState = null; // 'error' | 'ok' | null
  client.on('error', (err) => {
    if (lastState !== 'error') {
      console.error(`[redis:${label}] connection error: ${err.message} (suppressing further duplicates until reconnect)`);
      lastState = 'error';
    }
  });
  client.on('ready', () => {
    if (lastState !== 'ok') {
      console.log(`[redis:${label}] connected`);
      lastState = 'ok';
    }
  });
  return client;
}

// Factory for BullMQ's blocking clients — never use this on the API
// hot path or you'll hang requests when Redis is down.
function makeRedisClient() {
  return attachErrorLogger(new Redis(REDIS_URL, connectionOptions), 'bullmq');
}

// Factory for API-side clients (publish, lists, counters, subscribe).
// These fail fast when Redis is unreachable.
function makeApiClient() {
  return attachErrorLogger(new Redis(REDIS_URL, apiClientOptions), 'api');
}

// Shared client for non-blocking operations (pub, list writes, run state).
let _sharedClient = null;
function sharedRedis() {
  if (!_sharedClient) _sharedClient = makeApiClient();
  return _sharedClient;
}

// Queue names
const STORE_TEST_QUEUE = 'store-test';
const ADA_SCAN_QUEUE = 'ada-scan';

// Construct queues lazily so importing this module doesn't connect to
// Redis until something actually needs the queue (keeps tests / CLI
// commands fast).
let _storeTestQueue = null;
function storeTestQueue() {
  if (!_storeTestQueue) {
    _storeTestQueue = new Queue(STORE_TEST_QUEUE, {
      connection: { ...connectionOptions, url: REDIS_URL },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    });
  }
  return _storeTestQueue;
}

let _adaScanQueue = null;
function adaScanQueue() {
  if (!_adaScanQueue) {
    _adaScanQueue = new Queue(ADA_SCAN_QUEUE, {
      connection: { ...connectionOptions, url: REDIS_URL },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    });
  }
  return _adaScanQueue;
}

// ─── Event streaming ───────────────────────────────────────────────────
// Events are published to channel `run:<runId>` AND appended to list
// `run:<runId>:events` (capped at MAX_REPLAY_EVENTS). Subscribers first
// read the list to replay history, then tap the channel for live events.

const MAX_REPLAY_EVENTS = 10000; // more than enough for a 200-store run
const RUN_TTL_SECONDS = 24 * 60 * 60; // keep event history for 24h

function channelForRun(runId) {
  return `run:${runId}`;
}
function listForRun(runId) {
  return `run:${runId}:events`;
}
function statusKeyForRun(runId) {
  return `run:${runId}:status`;
}

async function publishEvent(runId, event) {
  const client = sharedRedis();
  const payload = JSON.stringify(event);
  // Fire-and-forget — we want the event to reach subscribers AND be
  // persisted for replay. Pipeline both ops so they hit Redis together.
  const pipeline = client.pipeline();
  pipeline.rpush(listForRun(runId), payload);
  pipeline.ltrim(listForRun(runId), -MAX_REPLAY_EVENTS, -1);
  pipeline.expire(listForRun(runId), RUN_TTL_SECONDS);
  pipeline.publish(channelForRun(runId), payload);
  await pipeline.exec();
}

// Subscribe to a run's event stream. Replays historical events from the
// list first, then delivers live events as they arrive. Returns an
// unsubscribe function.
async function subscribeToRun(runId, onEvent) {
  const shared = sharedRedis();

  // Replay existing events synchronously before tapping the live channel
  // so the client sees the complete history in order.
  const historical = await shared.lrange(listForRun(runId), 0, -1);
  for (const raw of historical) {
    try { onEvent(JSON.parse(raw)); } catch (_) {}
  }

  // Subscriber clients need to be dedicated (IORedis forbids mixing
  // pub/sub with regular commands on the same connection). Use the
  // fail-fast profile so a broken Redis doesn't leave us hanging.
  const sub = makeApiClient();
  await sub.subscribe(channelForRun(runId));
  sub.on('message', (_channel, message) => {
    try { onEvent(JSON.parse(message)); } catch (_) {}
  });

  return async () => {
    try { await sub.unsubscribe(); } catch (_) {}
    try { sub.disconnect(); } catch (_) {}
  };
}

// ─── Run state tracking ────────────────────────────────────────────────
// Lightweight counter so the API knows when all stores in a run have
// completed (and can emit a final `complete` event + close the SSE
// stream). Implemented as two Redis keys per run:
//   run:<id>:status  → hash { total, completed, failed, startedAt }

async function initRunStatus(runId, total) {
  const client = sharedRedis();
  await client.hset(statusKeyForRun(runId), {
    total: total,
    completed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
  });
  await client.expire(statusKeyForRun(runId), RUN_TTL_SECONDS);
}

async function incrementRunCounter(runId, field /* 'completed' | 'failed' */) {
  const client = sharedRedis();
  return client.hincrby(statusKeyForRun(runId), field, 1);
}

async function getRunStatus(runId) {
  const client = sharedRedis();
  const raw = await client.hgetall(statusKeyForRun(runId));
  if (!raw || !raw.total) return null;
  return {
    total: Number(raw.total),
    completed: Number(raw.completed || 0),
    failed: Number(raw.failed || 0),
    startedAt: raw.startedAt,
  };
}

async function isRunFinished(runId) {
  const status = await getRunStatus(runId);
  if (!status) return false;
  return (status.completed + status.failed) >= status.total;
}

// ─── QueueEvents helpers ───────────────────────────────────────────────
// BullMQ exposes per-queue "completed"/"failed" events via a QueueEvents
// listener; handy if we want to react to job lifecycle (not currently
// used by the API, but available for monitoring).

function makeStoreTestQueueEvents() {
  return new QueueEvents(STORE_TEST_QUEUE, {
    connection: { ...connectionOptions, url: REDIS_URL },
  });
}

module.exports = {
  REDIS_URL,
  STORE_TEST_QUEUE,
  ADA_SCAN_QUEUE,
  storeTestQueue,
  adaScanQueue,
  publishEvent,
  subscribeToRun,
  initRunStatus,
  incrementRunCounter,
  getRunStatus,
  isRunFinished,
  makeStoreTestQueueEvents,
  makeRedisClient,
  connectionOptions,
  sharedRedis,
};
