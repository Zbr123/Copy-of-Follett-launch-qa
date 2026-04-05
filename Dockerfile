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

# Persistent browser profile for sweeps — mount a volume here in
# production so cf_clearance cookies survive container rebuilds.
ENV SWEEP_USER_DATA_DIR=/app/.browser-data
VOLUME ["/app/.browser-data", "/app/runs", "/app/screenshots", "/app/sweeps"]

EXPOSE ${PORT:-3847}

# Launch with Xvfb so SWEEP_BROWSER_HEADFUL=1 actually works. Headful
# chromium has a meaningfully smaller CF fingerprint than headless, and
# runs fine under a virtual display with zero user-visible difference.
# Set SWEEP_BROWSER_HEADFUL=0 to skip Xvfb overhead if you prefer
# headless-only.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "node", "server.js"]
