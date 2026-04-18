const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function screenshotPath(store, page, suffix) {
  const clean = store.replace(/[^a-zA-Z0-9-]/g, '_');
  const dir = path.join(SCREENSHOTS_DIR, clean, 'accessibility');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Unique suffix so concurrent scans of the same store don't collide.
  const unique = `${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `${page}_${suffix}_${unique}.png`);
}

// Memory-only screenshot capture (see test-runner.js for rationale).
// Buffers are stashed by wrapPageForCapture and read back here as
// base64 data URLs so the filesystem is never involved.
const adaScreenshotBuffers = new Map();

function screenshotUrl(filePath) {
  const buf = adaScreenshotBuffers.get(filePath);
  if (buf) {
    adaScreenshotBuffers.delete(filePath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  // Fallback preserves the original URL shape if an unwrapped page
  // ever slips through — avoids crashes at the cost of a broken image.
  return '/' + path.relative(path.join(__dirname), filePath).replace(/\\/g, '/');
}

function wrapPageForCapture(page) {
  const orig = page.screenshot.bind(page);
  page.screenshot = async (options = {}) => {
    const { path: storagePath, ...rest } = options || {};
    const buffer = await orig(rest);
    if (storagePath) adaScreenshotBuffers.set(storagePath, buffer);
    return buffer;
  };
  return page;
}

// Same bandwidth-blocking strategy as test-runner.js. For a11y scans
// we're even more aggressive about blocking images is tempting, but
// axe-core needs them loaded to check alt text / contrast, so we
// leave images alone and only kill fonts/media/trackers.
const ADA_BLOCKED_URL_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /googletagservices\.com/i,
  /doubleclick\.net/i,
  /facebook\.(com|net)\/tr/i,
  /connect\.facebook\.net/i,
  /hotjar\.com/i,
  /fullstory\.com/i,
  /segment\.(io|com)/i,
  /mixpanel\.com/i,
  /intercom\.(io|com)/i,
  /criteo\.(com|net)/i,
  /taboola\.com/i,
  /outbrain\.com/i,
  /bing\.com\/bat/i,
  /snapchat\.com/i,
  /tiktok\.com\/i18n\/pixel/i,
  /pinterest\.com\/ct/i,
  /linkedin\.com\/insight/i,
  /clarity\.ms/i,
];
const ADA_BLOCKED_RESOURCE_TYPES = new Set(['font', 'media', 'websocket']);

async function installBandwidthBlocking(context) {
  // Skip in remote-CDP mode — see the matching rationale in
  // test-runner.js. Route interception round-trips add too much
  // latency on top of residential proxies and blow page.goto timeouts.
  if (process.env.BROWSER_WS_URL) return;
  try {
    await context.route('**/*', (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();
        if (ADA_BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
        const url = req.url();
        for (const rx of ADA_BLOCKED_URL_PATTERNS) {
          if (rx.test(url)) return route.abort();
        }
        return route.continue();
      } catch (_) {
        try { return route.continue(); } catch (_) {}
      }
    });
  } catch (err) {
    console.warn('[ada-scanner] installBandwidthBlocking failed:', err.message);
  }
}

function storeOrigin(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.origin;
  } catch (_) {
    return url.startsWith('http') ? url : `https://${url}`;
  }
}

// WCAG rule to human-readable fix guidance
const FIX_GUIDANCE = {
  'color-contrast': 'Increase the contrast ratio between text and background colors. Use a contrast checker tool to ensure a minimum ratio of 4.5:1 for normal text and 3:1 for large text.',
  'image-alt': 'Add a descriptive alt attribute to the <img> tag. If the image is decorative, use alt="".',
  'label': 'Associate a <label> element with this form input using the "for" attribute, or wrap the input inside a <label> tag.',
  'link-name': 'Add descriptive text content to the link, or use aria-label to describe the link\'s purpose. Avoid generic text like "click here".',
  'button-name': 'Add text content to the button, or use aria-label to describe its purpose.',
  'html-has-lang': 'Add a lang attribute to the <html> element (e.g., <html lang="en">).',
  'document-title': 'Add a <title> element inside the <head> of the page.',
  'heading-order': 'Ensure heading levels increase by one (h1 → h2 → h3). Don\'t skip levels.',
  'list': 'Ensure <li> elements are direct children of <ul> or <ol> elements.',
  'listitem': 'Ensure this <li> is contained within a <ul> or <ol> parent.',
  'region': 'Wrap page content in landmark regions (<main>, <nav>, <header>, <footer>) so screen readers can navigate by region.',
  'aria-allowed-attr': 'Remove invalid ARIA attributes from this element, or replace with valid ones.',
  'aria-required-attr': 'Add the required ARIA attributes for this role.',
  'aria-valid-attr-value': 'Correct the ARIA attribute value. Check the WAI-ARIA specification for valid values.',
  'aria-hidden-focus': 'Elements with aria-hidden="true" should not be focusable. Remove tabindex or the aria-hidden attribute.',
  'duplicate-id': 'Ensure every id attribute on the page is unique.',
  'frame-title': 'Add a title attribute to this <iframe> element describing its content.',
  'meta-viewport': 'Ensure the meta viewport tag does not disable user scaling (remove maximum-scale=1.0 or user-scalable=no).',
  'tabindex': 'Avoid tabindex values greater than 0. Use tabindex="0" to add to natural tab order, or tabindex="-1" to make programmatically focusable.',
  'bypass': 'Add a "Skip to main content" link at the top of the page so keyboard users can bypass navigation.',
};

function getFixGuidance(ruleId, helpUrl) {
  if (FIX_GUIDANCE[ruleId]) return FIX_GUIDANCE[ruleId];
  return `Review the WCAG guidelines for this rule. See: ${helpUrl}`;
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

async function runAccessibilityScan(stores, sendEvent, options = {}) {
  const concurrency = options.concurrency || 3;
  const browser = await chromium.launch({ headless: true });

  const queue = [...stores];
  const running = new Set();

  await new Promise((resolve) => {
    function startNext() {
      while (running.size < concurrency && queue.length > 0) {
        const store = queue.shift();
        const promise = scanStore(browser, store, sendEvent)
          .catch(err => {
            sendEvent({ type: 'ada-error', store: store.newStore, message: err.message });
          })
          .finally(() => {
            running.delete(promise);
            if (queue.length > 0) startNext();
            else if (running.size === 0) resolve();
          });
        running.add(promise);
      }
      if (running.size === 0 && queue.length === 0) resolve();
    }
    startNext();
  });

  await browser.close();
}

async function scanStore(browser, store, sendEvent) {
  const origin = storeOrigin(store.newStore);
  const storeName = store.newStore;

  sendEvent({ type: 'ada-store-start', store: storeName });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  await installBandwidthBlocking(context);
  const page = wrapPageForCapture(await context.newPage());

  // Login if needed
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const hasPasswordGate = await page.evaluate(() => {
      return !!document.querySelector('form[action*="password"]');
    });

    if (hasPasswordGate && store.password) {
      const pwInput = await page.$('input[type="password"]');
      if (pwInput) {
        await pwInput.fill(store.password);
        await page.click('button[type="submit"]');
        await page.waitForTimeout(3000);
      }
    }
  } catch (err) {
    sendEvent({ type: 'ada-store-result', store: storeName, error: `Login failed: ${err.message}`, pages: [] });
    await context.close();
    return;
  }

  // Dismiss cookie/OneTrust modals
  try {
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) {
        const t = (b.textContent || '').trim().toUpperCase();
        if (t === 'ACCEPT ALL' || t === 'ACCEPT' || t === 'ACCEPT COOKIES' || t === 'CLOSE') {
          b.click();
          break;
        }
      }
    });
    await page.waitForTimeout(1000);
  } catch (_) {}

  // Pages to scan
  const pagesToScan = [
    { name: 'Homepage', url: origin },
  ];

  // Find a collection page
  try {
    const collectionLink = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/collections/"]');
      for (const l of links) {
        const href = l.getAttribute('href');
        if (href && !href.includes('/collections/all') && l.offsetParent !== null) {
          return href;
        }
      }
      return '/collections/all';
    });
    const collUrl = collectionLink.startsWith('http') ? collectionLink : `${origin}${collectionLink}`;
    pagesToScan.push({ name: 'Collection Page', url: collUrl });
  } catch (_) {
    pagesToScan.push({ name: 'Collection Page', url: `${origin}/collections/all` });
  }

  // Find a product page
  try {
    const productLink = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/products/"]');
      for (const l of links) {
        if (l.offsetParent !== null && l.offsetWidth > 0) {
          return l.getAttribute('href');
        }
      }
      return null;
    });
    if (productLink) {
      const prodUrl = productLink.startsWith('http') ? productLink : `${origin}${productLink}`;
      pagesToScan.push({ name: 'Product Page', url: prodUrl });
    }
  } catch (_) {}

  const pageResults = [];

  for (const pageInfo of pagesToScan) {
    sendEvent({ type: 'ada-page-start', store: storeName, page: pageInfo.name });

    try {
      await page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // Take screenshot
      const shot = screenshotPath(storeName, pageInfo.name.toLowerCase().replace(/\s+/g, '-'), 'full');
      await page.screenshot({ path: shot, fullPage: false });

      // Run axe-core
      const axeResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();

      // Process violations and capture screenshots of affected elements
      const violations = [];
      let shotIndex = 0;

      for (const v of axeResults.violations) {
        const nodes = [];
        // Screenshot the first 3 nodes of critical/serious, first 1 of others
        const maxScreenshots = (v.impact === 'critical' || v.impact === 'serious') ? 3 : 1;

        for (let i = 0; i < Math.min(v.nodes.length, 10); i++) {
          const n = v.nodes[i];
          let nodeScreenshot = null;

          if (i < maxScreenshots) {
            try {
              const selector = n.target[0];
              const el = await page.$(selector);
              if (el) {
                // Scroll element into view
                await el.scrollIntoViewIfNeeded();
                await page.waitForTimeout(300);

                // Take a screenshot of the viewport with the element visible
                shotIndex++;
                const elShot = screenshotPath(storeName, pageInfo.name.toLowerCase().replace(/\s+/g, '-'), `violation-${shotIndex}`);
                await page.screenshot({ path: elShot, fullPage: false });

                // Highlight the element with a red border briefly for the screenshot
                await page.evaluate((sel) => {
                  const el = document.querySelector(sel);
                  if (el) {
                    el.style.outline = '3px solid #ff3b30';
                    el.style.outlineOffset = '2px';
                  }
                }, selector);
                await page.waitForTimeout(200);

                const highlightShot = screenshotPath(storeName, pageInfo.name.toLowerCase().replace(/\s+/g, '-'), `violation-${shotIndex}-highlight`);
                await page.screenshot({ path: highlightShot, fullPage: false });

                // Remove highlight
                await page.evaluate((sel) => {
                  const el = document.querySelector(sel);
                  if (el) {
                    el.style.outline = '';
                    el.style.outlineOffset = '';
                  }
                }, selector);

                nodeScreenshot = screenshotUrl(highlightShot);
              }
            } catch (_) {
              // Element not found or not screenshottable — continue
            }
          }

          nodes.push({
            html: n.html.substring(0, 300),
            target: n.target.join(', '),
            failureSummary: n.failureSummary,
            screenshot: nodeScreenshot,
          });
        }

        violations.push({
          ruleId: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          wcagTags: v.tags.filter(t => t.startsWith('wcag')),
          fixGuidance: getFixGuidance(v.id, v.helpUrl),
          nodes,
        });
      }

      // Sort by impact severity
      violations.sort((a, b) => (IMPACT_ORDER[a.impact] || 4) - (IMPACT_ORDER[b.impact] || 4));

      const summary = {
        critical: violations.filter(v => v.impact === 'critical').length,
        serious: violations.filter(v => v.impact === 'serious').length,
        moderate: violations.filter(v => v.impact === 'moderate').length,
        minor: violations.filter(v => v.impact === 'minor').length,
        total: violations.length,
        passes: axeResults.passes.length,
      };

      sendEvent({
        type: 'ada-page-result',
        store: storeName,
        page: pageInfo.name,
        url: pageInfo.url,
        screenshot: screenshotUrl(shot),
        summary,
        violations,
      });

      pageResults.push({
        page: pageInfo.name,
        url: pageInfo.url,
        screenshot: screenshotUrl(shot),
        summary,
        violations,
      });

    } catch (err) {
      sendEvent({
        type: 'ada-page-result',
        store: storeName,
        page: pageInfo.name,
        url: pageInfo.url,
        summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, passes: 0 },
        violations: [],
        error: err.message,
      });
      pageResults.push({ page: pageInfo.name, url: pageInfo.url, summary: { total: 0 }, violations: [], error: err.message });
    }
  }

  await context.close();
  sendEvent({ type: 'ada-store-complete', store: storeName, pages: pageResults });
}

module.exports = { runAccessibilityScan, scanStore };
