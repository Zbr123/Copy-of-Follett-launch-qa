FROM mcr.microsoft.com/playwright:v1.58.1-noble

WORKDIR /app

# Xvfb ships in the playwright base image already; xvfb-run is the
# wrapper we need. Install dbus too — chrome complains without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

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
# SWEEP_BROWSER_HEADFUL=1 wraps node in xvfb-run for headful chromium.
ENV ROLE=api

CMD ["sh", "-c", "\
  SCRIPT=server.js; \
  if [ \"$ROLE\" = \"worker\" ]; then SCRIPT=worker.js; fi; \
  if [ \"$SWEEP_BROWSER_HEADFUL\" = \"1\" ]; then \
    exec xvfb-run -a --server-args='-screen 0 1920x1080x24' node $SCRIPT; \
  else \
    exec node $SCRIPT; \
  fi"]
