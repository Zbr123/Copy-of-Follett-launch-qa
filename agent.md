# Follett Launch QA — Status Report for Cross-Verification

_Generated 2026-04-18 for review by an independent AI / engineer. Written to be readable without access to the prior conversation. Describes the current state of the project, what was tried today, what is broken, and what options remain._

---

## 1. What this project is

**Follett Launch QA** is a web-based QA automation tool that runs Playwright-driven tests against Shopify storefronts owned by Follett (and related bookstore brands like BKSTR). It is used to verify that newly launched / migrated storefronts pass a suite of ~19 functional checks (login, homepage load, add-to-cart, checkout field validation, rental collateral, course materials, accessibility scan, etc.).

- **Owner / primary user:** one person (the human party of this session).
- **Deployment:** Railway (railway.com), three services — `server`, `worker`, `redis`.
- **Tech stack:** Node.js, Express, Playwright (+ `playwright-extra` with stealth plugin for local), BullMQ, Redis, Server-Sent Events for live UI.
- **Frontend:** single-page dashboard served from `server.js`, rendering live progress per store via SSE.

### Repo layout (relevant files)

| File | Purpose |
|---|---|
| `server.js` | Express app — dashboard, SSE stream, run submission, exports, orphan reconciliation. |
| `worker.js` | BullMQ worker — pulls `store-test` and `ada-scan` jobs from Redis and executes them. |
| `test-runner.js` | ~4800 lines. All test definitions (`TEST_REGISTRY`) + per-store orchestration (`runStoreTests`) + stealth/CF handling. |
| `accessibility-scanner.js` | Axe-core accessibility scan per store. |
| `lib/queue.js` | BullMQ queue definitions + Redis pub/sub helpers. |
| `sweep-worker.js` | Legacy unattended sweep runner (not actively used in this flow). |

---

## 2. The stated goal

The human stated the target explicitly during this session:

> **Test 1000 stores per week, at 2 minutes or less per store, reliably, under $500/month total infrastructure cost.**

Derived requirements:
- Wall-clock time per run should be under ~3 hours at reasonable concurrency.
- Tests must not be blocked by Cloudflare (which fronts all Shopify stores).
- Screenshots must be captured for each test step (evidence for QA reports).
- The tool must be usable from the dashboard by non-engineers.

---

## 3. Architecture (how it works today)

```
User → server.js (HTTP, SSE) → enqueues jobs → Redis (BullMQ) → worker.js
                                                                    ↓
                                                            Playwright
                                                                    ↓
                                                     (Chromium browser, local or remote CDP)
                                                                    ↓
                                                              Shopify store
                                                                    ↓
                                                        events → Redis pub/sub → SSE → browser UI
```

Key design points:
- **One browser instance per worker process**, reused across jobs in local mode.
- **New BrowserContext per store** so cookies don't leak.
- **Run file persistence** — each run has a JSON file in `$DATA_DIR/runs/<runId>.json` with status, results, screenshots.
- **Events** go through a Redis pub/sub channel (`run:<runId>`) AND a bounded Redis list (`run:<runId>:events`) so a late-joining client can replay history then tail live.
- **Run status tracking** via a Redis hash (`run:<runId>:status`) with `total / completed / failed` counters. Worker writes `status=complete` to the run file when `completed + failed === total`.
- **Screenshots** are captured inside `test-runner.js` via a monkey-patched `page.screenshot` that stores buffers in an in-memory `Map`, then converts to `data:image/png;base64,…` URLs embedded directly in SSE events. No file I/O.

---

## 4. Current state of the code on disk

### Files that were edited today (`git status` will confirm — user should verify)

| File | Change today |
|---|---|
| `lib/queue.js` | Bumped `attempts: 1 → 2` with 5s exponential backoff on both BullMQ queues. |
| `worker.js` | Added `finalizeRunIfDone()` to write `status=complete` from worker side (fixes stuck-runs bug). Added Bright Data-aware per-job CDP connection + `finally` close. Added `withBrowserlessTimeout()` helper to inject `timeout=60000` if the user's URL is a browserless.io URL without one. |
| `server.js` | Added `reconcileOrphanedRuns()` called on startup to fix runs left at `status=running` after a crash. Modified `scheduleWrite()` to preserve `status=complete`/`error` if the worker wrote it first. Removed `req.on('close')` unsubscribe that was terminating event flow when a browser disconnected. Swapped three `path.join(__dirname, s.src...)` calls to `path.join(DATA_DIR, s.src...)` (latent bug fix). Routed `/api/validate-stores` and scheduled runs through `connectOverCDP` when `BROWSER_WS_URL` is set. |
| `test-runner.js` | Added `installBandwidthBlocking()` helper (route interception for fonts/media/tracker URLs). **Short-circuits when `BROWSER_WS_URL` is set** (see "What went wrong" §5.3). Called `installBandwidthBlocking` from the non-shared context path in `runStoreTests` and from the persistent-context path in `runTests`. The switch to disk-backed screenshots was **reverted** — still on in-memory base64. |
| `accessibility-scanner.js` | Same bandwidth blocking helper (with BROWSER_WS_URL short-circuit). Screenshot change also reverted. |

### Known-good state (before today's session)

Prior to today the code was in the state left by commits `d02eb09` through `f3afa10` (the human described these as introducing a "Multi Worker" architecture — moving test execution from an in-process flow inside `server.js` to a BullMQ worker. The session started because those commits left a latent bug where completion-marking was still in `server.js` and never moved to `worker.js`, causing runs to appear stuck at `running` indefinitely even after work finished).

**We have NOT verified via `git log` what the exact last-working-commit SHA is.** This is one of the open items.

---

## 5. What was tried today (chronological log, honest)

### 5.1 Diagnosed and fixed stuck-runs

**Symptom:** Runs showing `RUNNING` in the dashboard for hours even though the worker had finished the actual work.

**Root cause:** The Multi-Worker rewrite moved test execution to `worker.js` but left run-file finalization (`status=complete`) inside `server.js`'s SSE handler. If the browser disconnected, the server restarted, or the user closed the tab, the run file never got flipped to `complete`.

**Fix applied (still in code):**
- New `finalizeRunIfDone(runId)` in `worker.js` — worker writes `status=complete` directly after each job if `isRunFinished()` returns true.
- `reconcileOrphanedRuns()` in `server.js` — on boot, find any `status=running` run files where the Redis status hash says the work is finished, and flip them to `complete`.
- Modified `scheduleWrite()` to preserve `complete`/`error` so a late debounced server write can't overwrite the worker's finalization.

**Status:** This fix is sound and should stay.

### 5.2 Removed per-store 10-minute timeout

The human explicitly requested: _"The store MUST finish each test in less than 10 minutes. Do not force a time out."_ A `Promise.race` timeout I'd added earlier was removed. The `test-runner.js` CF-throw (after 3 Turnstile retries, ~30-60s) remains as the fail-fast mechanism.

**Status:** Done, matches the stated requirement.

### 5.3 Chased Cloudflare blocks → Browserless → Bright Data (the main rabbit hole)

Once the tool was running reliably, Shopify/Cloudflare started hard-blocking the Railway egress IPs. This is a known pattern: datacenter IPs (AWS/GCP, which Railway sits on) are fingerprinted by Cloudflare's bot filter and scored as "likely bot."

**First attempt: Browserless.io (managed browser pool).**
- Set `BROWSER_WS_URL=wss://production-sfo.browserless.io?token=***&stealth&blockAds` on Railway for both services.
- Code path switched to `chromium.connectOverCDP()` when the var is set.
- **Outcome:** The browser connection opened successfully but Browserless killed the session after exactly 60 seconds, mid-test. Every test failed with `Error: page.goto: Target page, context or browser has been closed`.
- **Root cause:** The human's Browserless plan (free tier or low tier) caps session timeout at 60,000 ms. My injection of `timeout=600000` caused a 400 Bad Request ("Timeout must be an integer between 1 and 60,000 ... based on the limit for your plan"). After reducing to `timeout=60000`, the cap itself killed sessions.
- **Dead end** without upgrading to Browserless Starter ($50/mo) or Scale ($200/mo), which the human did not want to commit to before verifying the tool works.

**Second attempt: Bright Data Scraping Browser / Browser API.**
- Recommendation was based on their strong CF bypass reputation, residential IP pool (72M+), no session timeouts, and pay-as-you-go pricing (~$8.40/GB egress).
- Human signed up, created a "Browser API" zone named `follettqa`, generated credentials.
- Set `BROWSER_WS_URL=wss://brd-customer-hl_cc4d824a-zone-follettqa:<password>@brd.superproxy.io:9222` on Railway.
- **Outcome part 1 (connection):** Connection succeeded. CDP session stayed alive.
- **Outcome part 2 (tests):** Tests started timing out on `page.goto` with `Timeout 10000ms exceeded` and `Timeout 20000ms exceeded` on simple navigations (e.g. `/search?q=rent%20new`, `/cart.json`). Most likely cause: residential proxy latency (~500ms–2s per request) compounded by Playwright route interception I'd added for bandwidth blocking — every single request had to round-trip from the remote browser back to the Node process for an abort/continue decision.
- **Fix attempted:** Short-circuited `installBandwidthBlocking` when `BROWSER_WS_URL` is set (commit on disk, not yet pushed by the human).
- **Outcome part 3 (after the fix was written but not pushed):** Tests now fail with a different error:

  > `Login error: page.goto: Protocol error (Page.navigate): Requested URL (https://bkstr-0039.myshopify.com/?_ab=0&_fd=0&_sc=1&key=...) is restricted in accordance with robots.txt. Ask your account manager to get full access for targeting this site (brob)`

  This is **Bright Data's compliance filter blocking the request at their end**. Trial / unverified Bright Data accounts have a default policy that blocks certain categories of domains (especially e-commerce, specifically Shopify) until the account passes KYC (Know Your Customer) verification. This is a Bright Data policy issue, not a code issue.

- **Dead end** for this session without either (a) completing Bright Data KYC (user-side process, typically 1–24 hours response), or (b) switching to a different provider.

### 5.4 Bandwidth optimization attempts (two separate, both problematic)

**5.4.a — Disk-backed screenshots.** I replaced the in-memory `Map` + base64 data URLs with direct `page.screenshot({ path })` writes to `$DATA_DIR/screenshots/`, returning `/screenshots/<file>.png` HTTP URLs served by Express static.

- **Rationale:** At 1000 stores × ~10 screenshots × ~400KB base64 per screenshot = ~4 GB of data inlined into Redis events and into the single run JSON file. That would OOM Redis on a starter/small plan and make run files impractically large.
- **Why it broke:** I assumed the Railway volume was shared between `server` and `worker` services (the code comments in `worker.js` say so). The human reported "all the screenshots are broken" after deploying. Either the volume is not actually shared, or there's a filesystem sync race, or I have a bug in URL construction that I missed.
- **Status:** Reverted on disk. Not yet pushed. The disk approach remains a viable option for 1000-store scale but requires confirming Railway volume sharing end-to-end.

**5.4.b — Route-based bandwidth blocking.** Added `context.route('**/*', …)` with a list of ~23 tracker URL regexes and resource types (font, media, websocket) to abort before the request goes out.

- **Rationale:** 40–60% bandwidth savings on a typical Shopify page; at $8.40/GB on Bright Data that's real money at 1000 stores/week.
- **Why it broke:** Client-side route interception over a remote CDP connection makes every request round-trip back to the Node process for a decision. On a residential-proxy path that already has 500ms–2s baseline latency, this added enough overhead to push `page.goto` past its 10–20s timeouts.
- **Status:** Code short-circuits when `BROWSER_WS_URL` is set. Local-dev behavior unchanged.

### 5.5 Net effect of today's code changes if the human pushes right now

**Kept and working (would stay in a forward-push):**
- Retry bump in `lib/queue.js` (2 attempts w/ exponential backoff).
- Worker-side run finalization (fixes the original stuck-runs bug).
- Server-side orphan reconciliation on boot.
- `DATA_DIR` fix in `server.js` export paths.
- Bright Data / Browserless per-job connection + `finally` close in `worker.js`.
- Bandwidth blocking helper — currently a no-op in remote-CDP mode, still useful for local dev.

**Broken (introduced today, need care):**
- Nothing currently in the on-disk code is actively broken, assuming the human pushes the latest revert. But a full verification has not been done.

---

## 6. Current blocker

**The tool is not running successful tests end-to-end today.**

Three distinct reasons the tool has not completed a test today:

1. **With `BROWSER_WS_URL` pointing at Browserless:** session ends at 60s, every test fails. Requires Browserless plan upgrade (≥$50/mo).
2. **With `BROWSER_WS_URL` pointing at Bright Data:** connection works, but Bright Data's compliance filter rejects Shopify URLs with a robots.txt / `brob` error. Requires KYC completion or a conversation with Bright Data support.
3. **With `BROWSER_WS_URL` unset (local browsers on Railway):** Cloudflare challenges block most stores — the original issue that started this rabbit hole. The tool _does_ work for a subset of stores that CF doesn't fingerprint as bots, but the pass rate was unacceptable (exact percentage not measured — this is an open item).

All three paths are currently closed. The human's frustration is legitimate and well-founded.

---

## 7. Options forward (honest, no prescribed answer)

### Option A — Full revert + local browsers, accept CF failures

**Action:** `git reset --hard <last-good-commit>` (SHA not yet identified), remove `BROWSER_WS_URL` from Railway.

**Result:** Back to the state of yesterday's code. Worker finalization bug returns unless the revert carefully keeps the `worker.js` + `server.js` fixes from §5.1 (recommended — those are clean wins).

**Pros:** Zero new infrastructure cost. Fastest path to "usable for the stores CF doesn't block."

**Cons:** CF block rate unknown — could be 10% of stores or 90%. Doesn't solve the original reason Bright Data was pursued.

**Cost:** $0 extra.

### Option B — Wait for Bright Data KYC, then retry

**Action:** Human files a ticket with Bright Data support requesting compliance access for Shopify/follett.com domains. Meanwhile, do Option A to stay usable. After Bright Data unblocks (typically <24h for business accounts), re-enable `BROWSER_WS_URL` on Railway and retest.

**Pros:** If it works, this is the cleanest path to "tests 1000 stores/week under $500". Bright Data's residential proxies should bypass CF entirely.

**Cons:** Depends on Bright Data's KYC timeline. Costs ~$175–$350/mo at the 1000 stores/week target (bandwidth billed per GB). Residential latency may still push per-store time beyond 2 minutes — has not been measured because tests haven't completed end-to-end.

**Cost:** ~$175–$350/mo.

### Option C — Try a different CF-bypass provider

Candidates not yet evaluated:
- **Oxylabs Scraper API / Web Unblocker** — similar model to Bright Data but possibly different compliance policies.
- **Zyte API** (formerly Scrapinghub) — AI-powered unblocking, subscription from $99/mo.
- **ScraperAPI** — simpler per-request pricing (~$149/mo for 1M requests, each "request" is a whole page render).
- **Apify** — proxy + crawler platform, flexible but more setup.
- **Browserless Scale plan** — $200/mo, 15-min session cap, built-in CF solver. Lacks residential IPs but uses anti-fingerprint profiles. Might work; might not.

**Pros:** Different providers may have different compliance stances. Some may be faster or more reliable than Bright Data.

**Cons:** More trial accounts to set up. Each has its own quirks (see today's Browserless 60s surprise). Real possibility of a second wasted day.

**Cost:** $99–$200/mo depending on provider.

### Option D — Self-hosted Playwright + residential proxy

Run a browser pool on Railway (or a VPS) with residential proxy routing (Oxylabs, Bright Data's plain proxy product, or NetNut). The browser runs in-process; proxies are injected at the network layer.

**Pros:** Full control. Can be cheaper at high volume.

**Cons:** Much more ops work. Residential proxy products often have the same compliance gates as their scraping-browser cousins. Not a quick win.

**Cost:** $50 (compute) + $150–$300 (proxies) = $200–$350/mo.

### Option E — Talk to Follett about allowlisting the Railway egress IP

The human mentioned earlier this was not viable. Worth re-confirming — if Follett controls the CF config for these Shopify stores, they could add Railway's egress IP range to an allowlist, and the tool would work directly with no proxy provider.

**Pros:** Permanent, cheap, fast.

**Cons:** Requires coordination with Follett's IT. Railway's egress IPs can change (would need static IP product, ~$5/mo extra).

**Cost:** $0–$5/mo.

---

## 8. Specific questions I want a reviewer to cross-check

1. **Is the Bright Data compliance block a KYC issue or a policy issue?** i.e. will Bright Data actually unblock Shopify testing even with completed KYC, or is their policy to refuse this use case outright? Their ToS language is ambiguous to me.
2. **Is there a way to configure a Bright Data zone to bypass the robots.txt check?** I believe this is a zone-level setting (`respect_robots_txt=false` or equivalent) but have not verified.
3. **Railway volume sharing — is my understanding correct** that a single Railway volume can be mounted at the same path on multiple services, and writes from one service are visible to the other in real time? If so, the disk-backed screenshot approach would have worked and the failure I saw was something else (URL encoding? file permission? timing?). If not, that approach is off the table entirely.
4. **Is `context.route` on a CDP-connected remote browser really slow enough to blow a 20s `page.goto` timeout?** I inferred this from symptoms. Worth verifying with a small benchmark before discarding client-side blocking as an option.
5. **`Network.setBlockedURLs` via CDP session** — does Playwright expose this cleanly, and does it work against a remote CDP connection (where the browser is the other side)? I proposed this as a follow-up but have not prototyped it.
6. **Is `test-runner.js` (~4800 lines with 19 tests and extensive CF handling) salvageable as-is** or does the architecture need a rewrite for this scale? I did not look at it hard enough to answer.
7. **Is there a path that doesn't require any anti-bot bypass?** e.g. running from a residential ISP line that Follett's CF doesn't block (physical machine in a colocation or a home office), with a VPN-style tunnel from Railway.

---

## 9. What I want the reviewer to tell me

- Which option (A–E) has the best cost/reliability/time trade-off for the stated goal.
- Whether any of today's code changes should be reverted on principle rather than kept.
- What I missed or got wrong above.
- Any provider, technique, or architecture I didn't consider.

---

## 10. Appendix — key error messages

**Browserless 60s disconnect:**
```
Apr 18 00:25:54 [worker] connecting store-test browser to remote CDP...
Apr 18 00:26:55 [worker] store-test browser disconnected
Apr 18 00:26:55 Error: page.goto: Target page, context or browser has been closed
```

**Browserless 400 on timeout parameter:**
```
Error: browserType.connectOverCDP: WebSocket error: wss://production-sfo.browserless.io/ 400 Bad Request
Timeout must be an integer between 1 and 60,000 seconds based on the limit for your plan
```

**Bright Data timeouts (before disabling bandwidth blocking on remote CDP):**
```
Error: page.goto: Timeout 20000ms exceeded. Call log:
  - navigating to "https://bkstr-0039.myshopify.com/search?q=rent%20new", waiting until "domcontentloaded"

Error: page.goto: Timeout 10000ms exceeded. Call log:
  - navigating to "https://bkstr-0039.myshopify.com/cart.json", waiting until "domcontentloaded"
```

**Bright Data compliance block (current blocker):**
```
Login error: page.goto: Protocol error (Page.navigate): Requested URL
(https://bkstr-0039.myshopify.com/?_ab=0&_fd=0&_sc=1&key=1ee6d309e734324eaa3b83c4df613444b3b8e24654afdb25abfaba29c7eb4c...)
is restricted in accordance with robots.txt. Ask your account manager to get full access
for targeting this site (brob)
```

---

## 11. Suggested reviewer prompt

> You are reviewing a status document written by another AI. A human has been working all day with that AI to fix a Shopify testing automation tool. The tool is currently blocked on Cloudflare bot detection for every path tried today (datacenter IPs blocked; Browserless plan cap hit; Bright Data compliance filter refusing Shopify domains). The human's goal is 1000 stores/week at 2 min/store under $500/mo. Read the full document and answer:
>
> 1. Which of options A–E should they pursue first, and why?
> 2. Are there viable approaches the original AI missed?
> 3. What specific questions about the code, the infrastructure, or the provider landscape should they investigate before committing to a direction?
>
> Be critical. Be specific. Assume the original AI was tired and may have misdiagnosed things.
