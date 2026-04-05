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

# Conditionally wrap node in xvfb-run only when headful mode is requested.
# Headful chromium has a smaller CF fingerprint but needs a virtual
# display; in headless mode (the default) xvfb is unnecessary and has
# caused container boot failures on some hosts.
CMD ["sh", "-c", "if [ \"$SWEEP_BROWSER_HEADFUL\" = \"1\" ]; then exec xvfb-run -a --server-args='-screen 0 1920x1080x24' node server.js; else exec node server.js; fi"]
