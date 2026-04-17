FROM mcr.microsoft.com/playwright:v1.58.1-noble

WORKDIR /app

# NOTE: We used to `apt-get install xvfb dbus-x11` here for optional
# headful Chrome support, but Railway's build network can intermittently
# fail to reach archive.ubuntu.com which breaks the build for everyone.
# The queue-based worker runs Chromium headless by default (plenty of
# stealth from playwright-extra's StealthPlugin), so these system
# packages are no longer required. If you ever need headful mode again:
#
#   RUN apt-get update \
#    && apt-get install -y --no-install-recommends \
#         --option=Acquire::Retries=5 \
#         --option=Acquire::ForceIPv4=true \
#         xvfb dbus-x11 \
#    && rm -rf /var/lib/apt/lists/*
#
# and re-enable the `xvfb-run` branch in the CMD below.

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

# All mutable state (runs, screenshots, sweeps, chromium profile) lives
# under DATA_DIR so a single Railway volume mounted at /app/data persists
# everything across redeploys. Railway bans the Dockerfile VOLUME keyword
# and manages persistence via the dashboard instead.
ENV DATA_DIR=/app/data

EXPOSE ${PORT:-3847}

# Same image runs either the Express API or a queue worker — $ROLE
# selects between them. Defaults to `api` so existing deployments
# (Railway) keep working unchanged.
#
# ROLE=api     → node server.js  (Express, SSE, enqueues jobs)
# ROLE=worker  → node worker.js  (BullMQ consumer, runs Playwright)
#
# SWEEP_BROWSER_HEADFUL=1 wraps node in xvfb-run for headful chromium
# — only works if xvfb-run is installed (see commented apt-get block
# above). Falls back to headless node if xvfb-run is missing.
ENV ROLE=api

CMD ["sh", "-c", "\
  SCRIPT=server.js; \
  if [ \"$ROLE\" = \"worker\" ]; then SCRIPT=worker.js; fi; \
  if [ \"$SWEEP_BROWSER_HEADFUL\" = \"1\" ] && command -v xvfb-run >/dev/null 2>&1; then \
    exec xvfb-run -a --server-args='-screen 0 1920x1080x24' node $SCRIPT; \
  else \
    if [ \"$SWEEP_BROWSER_HEADFUL\" = \"1\" ]; then \
      echo '[entrypoint] SWEEP_BROWSER_HEADFUL=1 but xvfb-run not installed — starting headless instead.'; \
    fi; \
    exec node $SCRIPT; \
  fi"]
