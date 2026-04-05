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

# Launch with Xvfb so SWEEP_BROWSER_HEADFUL=1 actually works. Headful
# chromium has a meaningfully smaller CF fingerprint than headless, and
# runs fine under a virtual display with zero user-visible difference.
# Set SWEEP_BROWSER_HEADFUL=0 to skip Xvfb overhead if you prefer
# headless-only.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "node", "server.js"]
