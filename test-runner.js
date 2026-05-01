const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

// ─── Stealth & Cloudflare bypass ────────────────────────────────────
chromium.use(StealthPlugin());

/**
 * Detect if the current page is a Cloudflare challenge/verification page.
 */
async function isCloudflareChallenge(page) {
  // Narrow detector: matches only strings that appear on an actual CF
  // interstitial / "challenge running" page, never on a successfully
  // delivered Shopify page that happens to embed the Turnstile widget
  // for anti-fraud (cart, checkout, login, filtered collections).
  //
  // Previously we also matched 'cf-turnstile' and 'turnstile/v0/api.js',
  // but those ship in the static HTML of many non-challenge pages on
  // CF-protected sites and caused false positives — Bright Data was
  // delivering the real page, we were misreading it as a block, and
  // the retry loop would give up after 2 attempts.
  try {
    const content = await page.content();
    return (
      content.includes('cf-challenge') ||
      content.includes('cf_chl_opt') ||
      content.includes('Just a moment') ||
      content.includes('Verify you are human') ||
      content.includes('needs to be verified before you can proceed') ||
      content.includes('challenges.cloudflare.com') ||
      content.includes('cf-please-wait') ||
      content.includes('cf-spinner')
    );
  } catch {
    return false;
  }
}

/**
 * Attempt to solve a Cloudflare Turnstile challenge by clicking the checkbox
 * inside the Turnstile iframe, then wait for the page to proceed.
 */
async function trySolveTurnstile(page, timeout = 30000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      // Look for the Turnstile iframe
      const frames = page.frames();
      for (const frame of frames) {
        const url = frame.url();
        if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
          // Try to click the checkbox inside the iframe
          const checkbox = await frame.$('input[type="checkbox"], .cb-i, #challenge-stage');
          if (checkbox) {
            await checkbox.click().catch(() => {});
            await page.waitForTimeout(2000);
          }
          // Also try clicking in the center of the iframe element on the parent page
          const iframeHandle = await page.$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
          if (iframeHandle) {
            const box = await iframeHandle.boundingBox();
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              await page.waitForTimeout(2000);
            }
          }
        }
      }
    } catch {}

    // Check if the challenge has resolved
    if (!(await isCloudflareChallenge(page))) return true;
    await page.waitForTimeout(2000);
  }

  return !(await isCloudflareChallenge(page));
}


const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

// Ensure screenshots dir exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Get the clean origin URL for a store (strips query params and paths from current page URL)
function storeOrigin(storeInput) {
  try {
    const url = new URL(storeInput.startsWith('http') ? storeInput : `https://${storeInput}`);
    return url.origin; // e.g. https://bkstr-0300.myshopify.com
  } catch {
    return `https://${storeInput}`;
  }
}

function getQaState(page) {
  if (!page.__qaState) page.__qaState = {};
  return page.__qaState;
}

async function readCartData(page) {
  return page.evaluate(async () => {
    const res = await fetch('/cart.json', { headers: { Accept: 'application/json' } });
    return await res.json();
  }).catch(() => null);
}

async function clearCart(page, origin, emit) {
  emit({ step: 'Clearing cart...' });
  await page.evaluate(async (o) => {
    await fetch(o + '/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  }, origin).catch(() => {});
  await page.waitForTimeout(250);
}

async function hidePreviewBar(page) {
  await page.evaluate(() => {
    const bar = document.getElementById('preview-bar-iframe') || document.querySelector('[id*="preview-bar"]');
    if (bar) bar.style.display = 'none';
  }).catch(() => {});
}

async function closeCartDrawer(page) {
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.cart-drawer__close, [aria-label="Close cart"], button.close, .drawer__close');
    if (closeBtn) closeBtn.click();
    const dialog = document.querySelector('dialog[open].cart-drawer__dialog');
    if (dialog && dialog.close) dialog.close();
  }).catch(() => {});
  await page.waitForTimeout(250);
}

async function getVisibleProductLinks(page) {
  const hrefs = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/products/"]'));
    return links
      .filter((link) => {
        const rect = link.getBoundingClientRect();
        const style = window.getComputedStyle(link);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((link) => link.getAttribute('href'))
      .filter(Boolean);
  }).catch(() => []);
  const visibleLinks = [];
  const seenPaths = new Set();
  for (const href of hrefs) {
    const cleanPath = href.split('?')[0];
    if (seenPaths.has(cleanPath)) continue;
    seenPaths.add(cleanPath);
    visibleLinks.push(href);
  }
  return visibleLinks;
}

async function trySelectPurchaseOption(page) {
  // Run the search inside the browser — one CDP call instead of one per element.
  const result = await page.evaluate(() => {
    const candidates = document.querySelectorAll('label, input[type="checkbox"], input[type="radio"]');
    for (const el of candidates) {
      const upper = (el.textContent || '').toUpperCase().trim();
      if (
        !/^(BUY|RENT)(\s|$)/.test(upper) &&
        !upper.includes('BUY NEW') && !upper.includes('BUY USED') &&
        !upper.includes('RENT NEW') && !upper.includes('RENT USED')
      ) continue;
      if (el.offsetParent === null || el.offsetWidth === 0) continue;
      el.click();
      return upper.substring(0, 50);
    }
    return null;
  });
  if (result) await page.waitForTimeout(250);
  return result;
}

async function clickAddToCart(page) {
  return page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toUpperCase();
      if ((text.includes('ADD TO BAG') || text.includes('ADD TO CART'))
          && !text.includes('ADD COURSE')
          && btn.offsetParent !== null && btn.offsetWidth > 0 && !btn.disabled) {
        btn.click();
        return text.substring(0, 30);
      }
    }
    const form = document.querySelector('form[action*="/cart/add"]');
    if (form) {
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn && submitBtn.offsetParent !== null && !submitBtn.disabled) {
        submitBtn.click();
        return 'FORM SUBMIT';
      }
    }
    return null;
  }).catch(() => null);
}

async function addStandardItemToCart(page, store, emit, options = {}) {
  const origin = storeOrigin(store.newStore);
  const listUrl = options.listUrl || `${origin}/collections/all`;
  const maxProducts = options.maxProducts || 10;
  const screenshotPrefix = options.screenshotPrefix || 'cart-add';

  emit({ step: `Finding a product to add to cart from ${listUrl}...` });
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(750);
  await hidePreviewBar(page);

  for (let attempt = 0; attempt < maxProducts; attempt++) {
    if (attempt > 0) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(750);
      await hidePreviewBar(page);
    }

    const visibleLinks = await getVisibleProductLinks(page);
    if (attempt >= visibleLinks.length) {
      emit({ step: `Only ${visibleLinks.length} products available — no more to try` });
      break;
    }

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Trying: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(500);
    await hidePreviewBar(page);

    if (attempt === 0) {
      const pdpShot = screenshotPath(store.newStore, screenshotPrefix, '01_product');
      await page.screenshot({ path: pdpShot, fullPage: false });
      emit({ screenshot: screenshotUrl(pdpShot), label: 'Product page' });
    }

    await trySelectPurchaseOption(page);

    const addClicked = await clickAddToCart(page);
    if (!addClicked) {
      emit({ step: `[Product ${attempt + 1}] Add button not found or disabled — trying next...` });
      continue;
    }

    emit({ step: `[Product ${attempt + 1}] Clicked: "${addClicked}"` });

    let cartData = null;
    for (let poll = 0; poll < 3; poll++) {
      await page.waitForTimeout(800);
      await closeCartDrawer(page);
      cartData = await readCartData(page);
      if (cartData && cartData.item_count > 0) break;
    }

    if (cartData && cartData.item_count > 0) {
      emit({ step: `[Product ${attempt + 1}] Cart confirmed: ${cartData.item_count} item(s)` });
      const cartShot = screenshotPath(store.newStore, screenshotPrefix, '02_after_add');
      await page.screenshot({ path: cartShot, fullPage: false });
      emit({ screenshot: screenshotUrl(cartShot), label: 'After Add to Cart' });
      const qaState = getQaState(page);
      qaState.standardCartReady = true;
      qaState.standardCartSource = listUrl;
      qaState.standardCartProductUrl = productUrl;
      return { passed: true, itemCount: cartData.item_count, productUrl };
    }

    emit({ step: `[Product ${attempt + 1}] Cart still empty after add — trying next...` });
  }

  return { passed: false, message: `Tried ${maxProducts} products from ${listUrl} — none could be added to cart` };
}

// Available test definitions
const TEST_REGISTRY = {
  'storefront-login': {
    name: 'Storefront Login',
    description: 'Navigate to store and authenticate past the password page',
    run: testStorefrontLogin,
  },
  'storefront-loads': {
    name: 'Storefront Loads',
    description: 'Verify the storefront homepage loads correctly after login',
    run: testStorefrontLoads,
  },
  'collection-page': {
    name: 'Collection Page',
    description: 'Verify at least one collection page loads with products',
    run: testCollectionPage,
  },
  'cart-add': {
    name: 'Add to Cart',
    description: 'Add a product to cart and verify cart updates',
    run: testCartAdd,
  },
  'rental-collateral': {
    name: 'Rental Collateral',
    description: 'Search "rent new", select Rent New/Used, add to bag, verify bag count',
    run: testRentalCollateral,
  },
  'digital-delivery-fee': {
    name: 'Digital Delivery Fee',
    description: 'Search "digital buy", add to cart, verify Digital Delivery Fee in cart & checkout',
    run: testDigitalDeliveryFee,
  },
  'checkout-validation': {
    name: 'Checkout Validation',
    description: 'Financial Aid placement, field labels (First Name, Phone), Follett disclaimer — all in one checkout scan',
    run: testCheckoutValidation,
  },
  'page-content-migration': {
    name: 'Page and Content Migration',
    description: 'Verify 23 content checks: legacy content guard, logo, hours, address, pages, footer links, Terms/Privacy/Cookie/DNS, email signup compliance',
    run: testPageContentMigration,
  },
  'homepage-plp-pdp': {
    name: 'Homepage, PLP & PDP',
    description: '6 checks: banner links, ads (homepage + collection), filters, no Gift Cards in nav, color swatch names',
    run: testHomepagePlpPdp,
  },
  'course-materials': {
    name: 'Course Materials',
    description: 'Navigate to Textbooks, select Term/Dept/Course/Section, add courses, verify results, add to cart (5 attempts)',
    run: testCourseMaterials,
  },
  'inventory': {
    name: 'Inventory',
    description: 'Spot check for out-of-stock products across 5 categories (10 checks) + validate 10 navigation links',
    run: testInventory,
  },
  'empty-collections': {
    name: 'Empty Collections Scan',
    description: 'Discover nav collections and flag any with zero products (P1 bug pattern)',
    run: testEmptyCollections,
  },
  'sale-clearance-purity': {
    name: 'Sale & Clearance Purity',
    description: 'Verify sale/clearance collections actually contain sale items with badges',
    run: testSaleClearancePurity,
  },
  'footer-text-sanity': {
    name: 'Footer & Store Hours Text',
    description: 'Scan footer and store hours for literal \\n, &amp;, formatting issues',
    run: testFooterTextSanity,
  },
  'external-link-targets': {
    name: 'External Link Targets',
    description: 'Verify external links (Specialty Shops etc.) open in new tab and are reachable',
    run: testExternalLinkTargets,
  },
  'price-floor-scan': {
    name: 'Price Floor Scan',
    description: 'Flag products listed under $1.00 (likely misconfigured OOS variants)',
    run: testPriceFloorScan,
  },
  'search-functionality': {
    name: 'Search Functionality',
    description: 'Verify site search works for GM items and textbooks (ISBN search, GM search)',
    run: testSearchFunctionality,
  },
  'header-nav-integrity': {
    name: 'Header & Nav Integrity',
    description: 'Check for duplicate nav links, verify category pages have products, validate taxonomy',
    run: testHeaderNavIntegrity,
  },
  'checkout-shipping-payment': {
    name: 'Checkout Shipping & Payment',
    description: 'Verify shipping address, phone field, delivery methods, and payment acceptance on checkout',
    run: testCheckoutShippingPayment,
  },
  'mobile-responsiveness': {
    name: 'Mobile Responsiveness',
    description: 'Test homepage, collections, search, and cart at mobile viewport (375×812)',
    run: testMobileResponsiveness,
  },
  'rental-purchase-options': {
    name: 'Rental & Purchase Options',
    description: 'Verify Buy/Rent option selectors are present and functional on textbook product pages',
    run: testRentalPurchaseOptions,
  },
  'price-filter': {
    name: 'Price & Collection Filters',
    description: 'Verify filter checkboxes work on collection/search result pages',
    run: testPriceFilterFunctionality,
  },
};

// ─── Screenshot capture: memory-only, no filesystem ──────────────────
// Every call site uses the pattern:
//   const shot = screenshotPath(...);
//   await page.screenshot({ path: shot, fullPage: false });
//   emit({ screenshot: screenshotUrl(shot), ... });
//
// wrapPageForCapture() monkey-patches `page.screenshot` so it captures
// the buffer in a Map keyed by the pseudo-path. screenshotUrl() then
// returns the buffer as a base64 data URL. The browser renders data
// URLs natively so the frontend needs no changes.
//
// TODO — switching this to disk-backed screenshots would cut Redis
// memory usage by ~100x at 1000-store scale, but requires both Railway
// services (server + worker) to mount the SAME volume. Until that's
// verified, in-memory base64 is the only mode that doesn't risk 404s.

const screenshotBuffers = new Map(); // pseudo-path → Buffer

function screenshotPath(storeName, testId, suffix) {
  const safe = storeName.replace(/[^a-z0-9]/gi, '_');
  const unique = `${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // Synthetic path string used purely as the Map key — never written to disk.
  return path.join(SCREENSHOTS_DIR, `${safe}_${testId}_${suffix}_${unique}.png`);
}

function screenshotUrl(filePath) {
  const buf = screenshotBuffers.get(filePath);
  if (buf) {
    // One-time read: drop from cache so RAM doesn't grow unbounded.
    screenshotBuffers.delete(filePath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  // Fallback — shouldn't happen if page was wrapped, but keeps URLs
  // syntactically valid if someone forgets to wrap a page.
  return '/screenshots/' + path.basename(filePath);
}

// Wrap a Playwright Page so page.screenshot({ path, ... }) captures
// the buffer in-memory instead of writing to disk. Call this right
// after `await context.newPage()`.
function wrapPageForCapture(page) {
  const orig = page.screenshot.bind(page);
  page.screenshot = async (options = {}) => {
    const { path: storagePath, ...rest } = options || {};
    // Strip the `path` option so Playwright returns the buffer without
    // writing anything to disk.
    const buffer = await orig(rest);
    if (storagePath) {
      screenshotBuffers.set(storagePath, buffer);
    }
    return buffer;
  };
  return page;
}

// ─── Route-level bandwidth blocking ──────────────────────────────────
// When we pay for egress per GB (Bright Data, Browserless), every
// tracker pixel and Google Font is money. Block resource types we
// never look at + known third-party analytics/ads origins so the
// browser simply refuses to fetch them. Keeps pages visually coherent
// (images + stylesheets + JS still load) while cutting bandwidth by
// roughly 40–60% on a typical Shopify storefront.
const BLOCKED_URL_PATTERNS = [
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
  /amplitude\.com/i,
  /heap\.(io|com)/i,
  /optimizely\.com/i,
];
const BLOCKED_RESOURCE_TYPES = new Set(['font', 'media', 'websocket']);

async function installBandwidthBlocking(context) {
  // IMPORTANT: `context.route()` on a remote CDP browser makes every
  // single request round-trip back to this Node process (abort vs.
  // continue must be decided here). With Bright Data's residential
  // proxy adding ~500ms-2s per request on top, a page with 50 assets
  // can push past page.goto's 10-20s timeouts just in routing
  // overhead. Skip client-side blocking in remote mode — we'll add
  // browser-side `Network.setBlockedURLs` as a follow-up.
  if (process.env.REMOTE_BROWSER_ENABLED === '1' && process.env.BROWSER_WS_URL) return;
  try {
    await context.route('**/*', (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
        const url = req.url();
        for (const rx of BLOCKED_URL_PATTERNS) {
          if (rx.test(url)) return route.abort();
        }
        return route.continue();
      } catch (_) {
        // Route handler must never throw — fall through to continue
        // so a bad regex or disposed request doesn't deadlock tests.
        try { return route.continue(); } catch (_) {}
      }
    });
  } catch (err) {
    // If route attachment fails (very rare — usually happens when the
    // context is already closing), proceed without blocking. We'd
    // rather pay a little bandwidth than fail the whole store.
    console.warn('[test-runner] installBandwidthBlocking failed:', err.message);
  }
}

// ─── Test implementations ───────────────────────────────────────────

async function testStorefrontLogin(page, store, emit) {
  const url = store.newStore.startsWith('http')
    ? store.newStore
    : `https://${store.newStore}`;

  emit({ step: 'Navigating to store...' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Take screenshot of initial page
  const initialShot = screenshotPath(store.newStore, 'storefront-login', '01_initial');
  await page.screenshot({ path: initialShot, fullPage: false });
  emit({ screenshot: screenshotUrl(initialShot), label: 'Initial page load' });

  // Check if password page is present
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) {
    emit({ step: 'Password page detected — entering password...' });
    await passwordInput.fill(store.password);

    // Try clicking submit button
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passwordInput.press('Enter');
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

    const afterShot = screenshotPath(store.newStore, 'storefront-login', '02_after_login');
    await page.screenshot({ path: afterShot, fullPage: false });
    emit({ screenshot: screenshotUrl(afterShot), label: 'After password entry' });

    // Check if we're still on password page (wrong password)
    const stillPassword = await page.$('input[type="password"]');
    if (stillPassword) {
      return { passed: false, message: 'Password page still showing — likely incorrect password' };
    }

    return { passed: true, message: 'Successfully authenticated past password page' };
  }

  // No password page — store is open
  return { passed: true, message: 'Store loaded without password gate' };
}

async function testStorefrontLoads(page, store, emit) {
  emit({ step: 'Checking storefront content...' });

  // Check page title exists
  const title = await page.title();
  emit({ step: `Page title: "${title}"` });

  // Check for common storefront elements
  const bodyText = await page.textContent('body');
  const hasContent = bodyText && bodyText.trim().length > 100;

  const shot = screenshotPath(store.newStore, 'storefront-loads', '01_homepage');
  await page.screenshot({ path: shot, fullPage: false });
  emit({ screenshot: screenshotUrl(shot), label: 'Homepage' });

  if (!hasContent) {
    return { passed: false, message: 'Page appears empty or has very little content' };
  }

  return { passed: true, message: `Storefront loaded — title: "${title}"` };
}

async function testCollectionPage(page, store, emit) {
  emit({ step: 'Looking for collection links...' });

  const origin = storeOrigin(store.newStore);

  // Build a clean collection URL from a path like /collections/clothing-accessories?filter=...
  function buildCollectionUrl(href) {
    if (href.startsWith('http')) {
      // Absolute URL — extract just the path + query from it and put on our origin
      try {
        const parsed = new URL(href);
        return `${origin}${parsed.pathname}${parsed.search}`;
      } catch {
        return `${origin}${href}`;
      }
    }
    return `${origin}${href}`;
  }

  // Strategy: find collection links in the store's navigation, fall back to /collections/all
  let collectionUrl = null;

  const firstCollHref = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="/collections/"]')) {
      const href = a.getAttribute('href') || '';
      if (/\/collections\/[^/?]+/.test(href)) return href;
    }
    return null;
  });
  if (firstCollHref) {
    collectionUrl = buildCollectionUrl(firstCollHref);
    emit({ step: `Found collection in navigation: ${firstCollHref}` });
  }

  if (!collectionUrl) {
    collectionUrl = `${origin}/collections/all`;
    emit({ step: 'No nav collection links found, trying /collections/all' });
  }

  emit({ step: `Navigating to ${collectionUrl}` });
  await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Check if we got redirected away from collections entirely
  const currentUrl = page.url();
  if (!currentUrl.includes('/collections')) {
    emit({ step: `Redirected to ${currentUrl} — not a collection page` });

    // Last resort: go back to homepage and scrape any collection link
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const allLinks = await page.$$eval('a[href*="/collections/"]', els =>
      els.map(a => a.getAttribute('href')).filter(h => h && h.match(/\/collections\/[^/?]+/))
    );

    if (allLinks.length > 0) {
      const fallbackUrl = buildCollectionUrl(allLinks[0]);
      emit({ step: `Retrying with discovered collection: ${fallbackUrl}` });
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      const shot = screenshotPath(store.newStore, 'collection-page', '01_redirected');
      await page.screenshot({ path: shot, fullPage: false });
      emit({ screenshot: screenshotUrl(shot), label: 'No collection found' });
      return { passed: false, message: 'No collection pages found on this store' };
    }
  }

  // Check for product elements (common Shopify selectors)
  const products = await page.$$('[class*="product"], .product-card, .grid__item, [data-product-id]');
  const productLinks = await page.$$('a[href*="/products/"]');
  const productCount = Math.max(products.length, productLinks.length);

  // Scroll to first product element so the screenshot shows actual products, with timeout guard
  try {
    if (products.length > 0) {
      await products[0].scrollIntoViewIfNeeded({ timeout: 3000 });
    } else if (productLinks.length > 0) {
      await productLinks[0].scrollIntoViewIfNeeded({ timeout: 3000 });
    }
    await page.waitForTimeout(500);
  } catch {
    // Element not visible/scrollable — just screenshot from current position
  }

  const finalUrl = page.url();
  const shot = screenshotPath(store.newStore, 'collection-page', '01_collection');
  await page.screenshot({ path: shot, fullPage: false });
  emit({ screenshot: screenshotUrl(shot), label: `Collection page` });

  if (productCount > 0) {
    return { passed: true, message: `Found ${productCount} product elements on ${finalUrl}` };
  }

  return { passed: false, message: `No products found on ${finalUrl}` };
}

async function testCartAdd(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  await clearCart(page, origin, emit);
  const addResult = await addStandardItemToCart(page, store, emit, {
    listUrl: `${origin}/collections/all`,
    maxProducts: 10,
    screenshotPrefix: 'cart-add',
  });

  if (!addResult.passed) {
    const failShot = screenshotPath(store.newStore, 'cart-add', '02_no_add');
    await page.screenshot({ path: failShot, fullPage: false });
    emit({ screenshot: screenshotUrl(failShot), label: 'Could not add any item' });
    return { passed: false, message: addResult.message };
  }

  const cartData = await readCartData(page);
  const itemCount = cartData?.item_count || 0;

  return { passed: true, message: `Add to cart successful. Cart has ${itemCount} item(s).` };
}

async function testRentalCollateral(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  // Step 0: Clear the cart
  emit({ step: 'Clearing cart...' });
  await page.evaluate(async (o) => {
    await fetch(o + '/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  }, origin).catch(() => {});
  await page.waitForTimeout(500);

  // Step 1: Navigate directly to search results (more reliable than UI interaction)
  const searchUrl = `${origin}/search?q=${encodeURIComponent('print new')}`;
  emit({ step: `Navigating to search: ${searchUrl}` });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const resultsShot = screenshotPath(store.newStore, 'rental-collateral', '02_search_results');
  await page.screenshot({ path: resultsShot, fullPage: false });
  emit({ screenshot: screenshotUrl(resultsShot), label: 'Search results' });

  // Step 3: Try up to 5 products from search results by position
  const MAX_PRODUCTS = 5;
  let rentalSuccess = false;

  for (let attempt = 0; attempt < MAX_PRODUCTS; attempt++) {
    // Go back to search results page each time
    if (attempt > 0) {
      emit({ step: `Returning to search results for product #${attempt + 1}...` });
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    // Get all visible product links — run entirely in the browser (one CDP call).
    const rawLinks = await page.evaluate(() => {
      const seen = new Set();
      const result = [];
      for (const a of document.querySelectorAll('a[href*="/products/"]')) {
        if (a.offsetParent === null || a.offsetWidth === 0) continue;
        const href = a.getAttribute('href');
        if (!href) continue;
        const clean = href.split('?')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        result.push(href);
      }
      return result;
    }).catch(() => []);
    const visibleLinks = rawLinks;

    if (attempt === 0) {
      emit({ step: `Found ${visibleLinks.length} product(s) in search results` });
    }

    if (attempt >= visibleLinks.length) {
      emit({ step: `Only ${visibleLinks.length} products available — no more to try` });
      break;
    }

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Navigating to: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const pdpShot = screenshotPath(store.newStore, 'rental-collateral', `03_product_${attempt + 1}`);
    await page.screenshot({ path: pdpShot, fullPage: false });
    emit({ screenshot: screenshotUrl(pdpShot), label: `Product ${attempt + 1}` });

    // Step 4: Look for the Print tab (it's a tab[type="button"] element)
    emit({ step: `[Product ${attempt + 1}] Looking for Print tab...` });
    const printTab = await page.$('[role="tab"]:has-text("Print"), button[type="button"]:has-text("Print")');

    if (printTab) {
      const tabVisible = await printTab.isVisible().catch(() => false);
      if (tabVisible) {
        emit({ step: `[Product ${attempt + 1}] Found Print tab — clicking...` });
        await printTab.click();
        await page.waitForTimeout(1000);

        const printShot = screenshotPath(store.newStore, 'rental-collateral', `04_print_tab_${attempt + 1}`);
        await page.screenshot({ path: printShot, fullPage: false });
        emit({ screenshot: screenshotUrl(printShot), label: `Print tab (product ${attempt + 1})` });
      }
    } else {
      emit({ step: `[Product ${attempt + 1}] No Print tab — checking current view...` });
    }

    // Step 5: Look for Rent New / Rent Used
    // The rental options are checkboxes with labels like "RENT USED" or "RENT NEW" (all caps)
    emit({ step: `[Product ${attempt + 1}] Looking for Rent New / Rent Used...` });

    let rentOption = null;

    // Strategy 1: Find checkbox/label with RENT text (case-insensitive)
    const rentCheckbox = await page.$('input[type="checkbox"][name*="rent" i], input[type="checkbox"][id*="rent" i]');
    if (rentCheckbox) {
      rentOption = rentCheckbox;
    }

    // Strategy 2: Find by label text containing RENT — run entirely inside the
    // browser so we make ONE CDP call instead of one per element (a Shopify PDP
    // can have 1000+ matching nodes; iterating them via Playwright handles stalls
    // the event loop for minutes and triggers Railway OOM / timeout).
    if (!rentOption) {
      const rentSelector = await page.evaluate(() => {
        const candidates = document.querySelectorAll(
          'label, input[type="checkbox"], input[type="radio"], button, a, span, div[role="button"], [role="option"]'
        );
        for (const el of candidates) {
          const upper = (el.textContent || '').toUpperCase();
          if (!upper.includes('RENT NEW') && !upper.includes('RENT USED')) continue;
          if (el.offsetParent === null || el.offsetWidth === 0) continue;
          // Return a unique-enough CSS selector so Playwright can re-acquire it
          if (el.id) return `#${CSS.escape(el.id)}`;
          // Build a nth-of-type path as a reliable fallback
          let path = el.tagName.toLowerCase();
          let parent = el.parentElement;
          while (parent && parent !== document.body) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              path = `${parent.tagName.toLowerCase()} > ${path}:nth-of-type(${siblings.indexOf(el) + 1})`;
            }
            parent = parent.parentElement;
            break; // one level is enough to disambiguate
          }
          return path;
        }
        return null;
      });

      if (rentSelector) {
        rentOption = await page.$(rentSelector).catch(() => null);
        if (rentOption) {
          const foundText = await rentOption.textContent().catch(() => '');
          emit({ step: `[Product ${attempt + 1}] Found: "${foundText.trim().substring(0, 50)}"` });
        }
      }
    }

    if (!rentOption) {
      emit({ step: `[Product ${attempt + 1}] No rental option — trying next product...` });
      continue;
    }

    // Click rent option (use force:true since checkboxes can be visually hidden behind labels)
    emit({ step: `[Product ${attempt + 1}] Clicking rental option...` });
    try {
      await rentOption.click({ timeout: 5000 });
    } catch {
      // If click fails, try clicking the parent label
      const parent = await rentOption.$('xpath=..');
      if (parent) await parent.click({ timeout: 5000 });
    }
    await page.waitForTimeout(1000);

    const rentShot = screenshotPath(store.newStore, 'rental-collateral', `05_rent_selected_${attempt + 1}`);
    await page.screenshot({ path: rentShot, fullPage: false });
    emit({ screenshot: screenshotUrl(rentShot), label: `Rent selected (product ${attempt + 1})` });

    // Step 6: Find and click Add to Bag immediately (no stale references)
    emit({ step: `[Product ${attempt + 1}] Looking for Add to Bag...` });
    const addBtn = await page.$(
      'button[type="submit"]:has-text("Add to bag"), button[type="submit"]:has-text("Add to Bag"), ' +
      'button:has-text("Add to Bag"), button:has-text("Add to bag"), ' +
      'button:has-text("Add to Cart"), button:has-text("Add to cart"), ' +
      'button[name="add"], [data-action="add-to-cart"], ' +
      'form[action*="/cart/add"] button[type="submit"]'
    );

    if (!addBtn) {
      emit({ step: `[Product ${attempt + 1}] No Add to Bag button — trying next product...` });
      continue;
    }

    emit({ step: `[Product ${attempt + 1}] Clicking Add to Bag...` });
    await addBtn.click();
    rentalSuccess = true;
    break;
  }

  if (!rentalSuccess) {
    const failShot = screenshotPath(store.newStore, 'rental-collateral', '05_no_rent_all');
    await page.screenshot({ path: failShot, fullPage: false });
    emit({ screenshot: screenshotUrl(failShot), label: 'No rental found across products' });
    return { passed: false, message: `Tried up to ${MAX_PRODUCTS} products — none had Rent New/Used with Add to Bag` };
  }

  // Wait for cart to update — Rental Collateral item gets auto-added after a few seconds
  emit({ step: 'Waiting for Rental Collateral to be auto-added to cart...' });
  await page.waitForTimeout(5000);

  const addedShot = screenshotPath(store.newStore, 'rental-collateral', '06_added_to_bag');
  await page.screenshot({ path: addedShot, fullPage: false });
  emit({ screenshot: screenshotUrl(addedShot), label: 'After Add to Bag' });

  // Step 7: Check bag count via /cart.json — need 2 items (rental product + Rental Collateral)
  emit({ step: 'Checking cart contents via /cart.json...' });

  let cartData = null;
  // Poll a few times since Rental Collateral can take a moment
  for (let poll = 0; poll < 3; poll++) {
    try {
      cartData = await page.evaluate(async () => {
        const res = await fetch('/cart.json');
        return await res.json();
      });
      if (cartData && cartData.item_count >= 2) break;
    } catch {}
    await page.waitForTimeout(2000);
  }

  const bagCount = cartData ? cartData.item_count : 0;
  const cartItemNames = cartData ? cartData.items.map(i => i.title || i.product_title) : [];
  const hasRentalCollateral = cartItemNames.some(name =>
    (name || '').toUpperCase().includes('RENTAL COLLATERAL')
  );

  emit({ step: `Cart has ${bagCount} item(s): ${cartItemNames.join(', ')}` });

  // Navigate to cart page for screenshot
  await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(1500);

  const cartShot = screenshotPath(store.newStore, 'rental-collateral', '07_cart');
  await page.screenshot({ path: cartShot, fullPage: false });
  emit({ screenshot: screenshotUrl(cartShot), label: 'Cart page' });

  // Validate: must have 2+ items and Rental Collateral present
  const issues = [];
  if (bagCount < 2) {
    issues.push(`Expected 2+ items in cart, found ${bagCount}`);
  }
  if (!hasRentalCollateral) {
    issues.push('Rental Collateral product not found in cart');
  }

  if (issues.length > 0) {
    emit({ step: `Cart validation issues: ${issues.join('; ')}` });
    return { passed: false, message: `Cart check failed: ${issues.join('; ')}. Items: ${cartItemNames.join(', ')}` };
  }

  emit({ step: 'Cart validated — 2+ items with Rental Collateral present' });

  // Step 8: Proceed to checkout and verify "recurring subtotal" + Rental Collateral
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const checkoutShot = screenshotPath(store.newStore, 'rental-collateral', '08_checkout');
  await page.screenshot({ path: checkoutShot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutShot), label: 'Checkout page' });

  // Check for "recurring subtotal" text on checkout page
  emit({ step: 'Waiting for checkout content to fully render...' });
  // Wait up to 5s for the rental login message to appear
  try {
    await page.waitForFunction(
      () => (document.body.innerText || '').includes('You must be logged in'),
      { timeout: 5000 }
    );
  } catch (_) {
    // Continue anyway — we'll check below
  }
  emit({ step: 'Checking for "recurring subtotal" on checkout...' });
  const pageText = await page.textContent('body').catch(() => '');
  const upperPageText = pageText.toUpperCase();
  const hasRecurringSubtotal = upperPageText.includes('RECURRING SUBTOTAL');
  const hasCollateralOnCheckout = upperPageText.includes('RENTAL COLLATERAL');
  const hasRentalLoginMessage = pageText.includes('You must be logged in to purchase rental items. Please log in to continue.');

  emit({ step: `Recurring subtotal: ${hasRecurringSubtotal}, Rental Collateral: ${hasCollateralOnCheckout}, Rental login message: ${hasRentalLoginMessage}` });

  const rentalChecks = [
    { name: 'Recurring Subtotal', passed: hasRecurringSubtotal, detail: hasRecurringSubtotal ? 'Found on checkout page' : 'Not found on checkout page' },
    { name: 'Rental Collateral', passed: hasCollateralOnCheckout, detail: hasCollateralOnCheckout ? 'Found on checkout page' : 'Not found on checkout page' },
    { name: 'Rental Login Message', passed: hasRentalLoginMessage, detail: hasRentalLoginMessage ? 'Message displayed on checkout' : 'Message not found on checkout page' },
  ];

  const checkoutIssues = rentalChecks.filter(c => !c.passed).map(c => `"${c.name}" not found on checkout page`);

  if (checkoutIssues.length > 0) {
    // Scroll down and take another screenshot in case content is below fold
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);
    const checkoutShot2 = screenshotPath(store.newStore, 'rental-collateral', '08_checkout_scrolled');
    await page.screenshot({ path: checkoutShot2, fullPage: false });
    emit({ screenshot: screenshotUrl(checkoutShot2), label: 'Checkout page (scrolled)' });

    return { passed: false, message: `Checkout validation failed: ${checkoutIssues.join('; ')}`, checks: rentalChecks };
  }

  emit({ step: 'Checkout validated — recurring subtotal, Rental Collateral, and rental login message all present' });

  return {
    passed: true,
    message: `Rental flow complete. Cart: ${bagCount} items (${cartItemNames.join(', ')}). Checkout has recurring subtotal, Rental Collateral, and rental login message.`,
    checks: rentalChecks,
  };
}

async function testDigitalDeliveryFee(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  // Step 0: Clear the cart completely
  emit({ step: 'Clearing cart...' });
  await page.goto(`${origin}/cart.json`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  const existingCart = await page.evaluate(async () => {
    const res = await fetch('/cart.json');
    return await res.json();
  }).catch(() => null);

  if (existingCart && existingCart.items && existingCart.items.length > 0) {
    await page.evaluate(async () => {
      await fetch('/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    });
    await page.waitForTimeout(1000);
    emit({ step: `Cleared ${existingCart.items.length} item(s) from cart` });
  }

  // Step 1: Search for "digital buy"
  const searchUrl = `${origin}/search?q=${encodeURIComponent('digital buy')}`;
  emit({ step: `Navigating to search: ${searchUrl}` });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const resultsShot = screenshotPath(store.newStore, 'digital-delivery-fee', '01_search_results');
  await page.screenshot({ path: resultsShot, fullPage: false });
  emit({ screenshot: screenshotUrl(resultsShot), label: 'Search results' });

  // Step 2: Try up to 5 products until we find one with a Digital variant
  const MAX_PRODUCTS = 5;
  let addedSuccess = false;
  let addedProductName = '';

  for (let attempt = 0; attempt < MAX_PRODUCTS; attempt++) {
    if (attempt > 0) {
      emit({ step: `Returning to search results for product #${attempt + 1}...` });
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    // Get visible product links — single CDP call inside browser context.
    const visibleLinks = await page.evaluate(() => {
      const seen = new Set();
      const result = [];
      for (const a of document.querySelectorAll('a[href*="/products/"]')) {
        if (a.offsetParent === null || a.offsetWidth === 0) continue;
        const href = a.getAttribute('href');
        if (!href) continue;
        const clean = href.split('?')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        result.push(href);
      }
      return result;
    }).catch(() => []);

    if (attempt === 0) {
      emit({ step: `Found ${visibleLinks.length} product(s) in search results` });
    }

    if (attempt >= visibleLinks.length) {
      emit({ step: `Only ${visibleLinks.length} products available — no more to try` });
      break;
    }

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Navigating to: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Hide Shopify preview bar
    await page.evaluate(() => {
      const bar = document.getElementById('preview-bar-iframe') || document.querySelector('[id*="preview-bar"]');
      if (bar) bar.style.display = 'none';
    });

    // Grab the product title
    const titleEl = await page.$('h1');
    addedProductName = titleEl ? (await titleEl.textContent().catch(() => '')).trim() : '';

    const pdpShot = screenshotPath(store.newStore, 'digital-delivery-fee', `02_product_${attempt + 1}`);
    await page.screenshot({ path: pdpShot, fullPage: false });
    emit({ screenshot: screenshotUrl(pdpShot), label: `Product ${attempt + 1}: ${addedProductName}` });

    // Step A: Click Digital tab if present
    const digitalClicked = await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], button[type="button"]');
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim();
        if (/^Digital/i.test(text) && tab.offsetParent !== null && tab.offsetWidth > 0) {
          tab.click();
          return text;
        }
      }
      return null;
    });

    if (digitalClicked) {
      emit({ step: `[Product ${attempt + 1}] Clicked Digital tab: "${digitalClicked}"` });
      await page.waitForTimeout(1000);
    } else {
      emit({ step: `[Product ${attempt + 1}] No Digital tab found — trying next product...` });
      continue;
    }

    // Step B: Click a Buy option (BUY, BUY NEW, BUY USED, BUY DIGITAL)
    const buyClicked = await page.evaluate(() => {
      const els = document.querySelectorAll('label, input[type="checkbox"], input[type="radio"], button, span, div[role="button"]');
      for (const el of els) {
        const text = (el.textContent || '').toUpperCase().trim();
        if ((/^(BUY|RENT)(\s|$)/.test(text) || text.includes('BUY NEW') || text.includes('BUY USED') || text.includes('BUY DIGITAL'))
            && el.offsetParent !== null && el.offsetWidth > 0) {
          el.click();
          return text.substring(0, 30);
        }
      }
      return null;
    });

    if (buyClicked) {
      emit({ step: `[Product ${attempt + 1}] Clicked buy option: "${buyClicked}"` });
      await page.waitForTimeout(1000);
    } else {
      emit({ step: `[Product ${attempt + 1}] No buy option found — trying Add to Bag anyway...` });
    }

    const buyShot = screenshotPath(store.newStore, 'digital-delivery-fee', `02b_buy_selected_${attempt + 1}`);
    await page.screenshot({ path: buyShot, fullPage: false });
    emit({ screenshot: screenshotUrl(buyShot), label: `Buy selected (product ${attempt + 1})` });

    // Step C: Click Add to Bag
    const addClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toUpperCase();
        if ((text.includes('ADD TO BAG') || text.includes('ADD TO CART'))
            && !text.includes('ADD COURSE')
            && btn.offsetParent !== null && btn.offsetWidth > 0 && !btn.disabled) {
          btn.click();
          return text.substring(0, 30);
        }
      }
      return null;
    });

    if (!addClicked) {
      emit({ step: `[Product ${attempt + 1}] Add to Bag button not found or disabled — trying next product...` });
      continue;
    }

    emit({ step: `[Product ${attempt + 1}] Clicked: "${addClicked}"` });
    await page.waitForTimeout(2000);

    // Close cart drawer if it opened
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.cart-drawer__close, [aria-label="Close cart"], button.close, .drawer__close');
      if (closeBtn) closeBtn.click();
      const dialog = document.querySelector('dialog[open].cart-drawer__dialog');
      if (dialog && dialog.close) dialog.close();
    });
    await page.waitForTimeout(500);

    addedSuccess = true;

    const addShot = screenshotPath(store.newStore, 'digital-delivery-fee', `03_added_${attempt + 1}`);
    await page.screenshot({ path: addShot, fullPage: false });
    emit({ screenshot: screenshotUrl(addShot), label: `Added to bag (product ${attempt + 1})` });
    break;
  }

  if (!addedSuccess) {
    const failShot = screenshotPath(store.newStore, 'digital-delivery-fee', '03_no_add');
    await page.screenshot({ path: failShot, fullPage: false });
    emit({ screenshot: screenshotUrl(failShot), label: 'Could not add any product' });
    return { passed: false, message: `Tried ${MAX_PRODUCTS} products — none had a Digital variant that could be added to cart` };
  }

  // Step 3: Wait for Digital Delivery Fee to auto-add, then check cart
  // The fee is added asynchronously by Shopify scripts — poll until it appears
  emit({ step: 'Waiting for Digital Delivery Fee to be auto-added to cart...' });
  await page.waitForTimeout(3000);

  let cartData = null;
  const MAX_FEE_POLLS = 8;
  for (let poll = 0; poll < MAX_FEE_POLLS; poll++) {
    try {
      cartData = await page.evaluate(async () => {
        const res = await fetch('/cart.json');
        return await res.json();
      });
      // Specifically check for the delivery fee item, not just item count
      const hasFee = cartData && cartData.items && cartData.items.some(i =>
        ((i.title || i.product_title || '') + ' ' + (i.variant_title || '')).toUpperCase().includes('DIGITAL DELIVERY FEE')
      );
      if (hasFee) {
        emit({ step: `Digital Delivery Fee detected in cart (poll ${poll + 1}/${MAX_FEE_POLLS})` });
        break;
      }
      emit({ step: `Poll ${poll + 1}/${MAX_FEE_POLLS}: ${cartData ? cartData.item_count : 0} item(s) — fee not yet present, waiting...` });
    } catch {}
    await page.waitForTimeout(3000);
  }

  const bagCount = cartData ? cartData.item_count : 0;
  const cartItems = cartData ? cartData.items.map(i => ({
    name: i.title || i.product_title,
    price: (i.price / 100).toFixed(2),
  })) : [];

  // Exclude Rental Collateral and Digital Delivery Fee from counts
  const relevantItems = cartItems.filter(i => {
    const n = (i.name || '').toUpperCase();
    return !n.includes('RENTAL COLLATERAL') && !n.includes('DIGITAL DELIVERY FEE');
  });

  const deliveryFeeItem = cartItems.find(i =>
    (i.name || '').toUpperCase().includes('DIGITAL DELIVERY FEE')
  );
  const hasDeliveryFee = !!deliveryFeeItem;
  const deliveryFeePrice = deliveryFeeItem ? `$${deliveryFeeItem.price}` : 'N/A';

  emit({ step: `Cart has ${bagCount} item(s): ${cartItems.map(i => `${i.name} ($${i.price})`).join(', ')}` });

  if (hasDeliveryFee) {
    emit({ step: `Digital Delivery Fee found — price: ${deliveryFeePrice}` });
  }

  // Navigate to cart page for screenshot
  await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(1500);

  const cartShot = screenshotPath(store.newStore, 'digital-delivery-fee', '04_cart');
  await page.screenshot({ path: cartShot, fullPage: false });
  emit({ screenshot: screenshotUrl(cartShot), label: 'Cart page' });

  // Validate cart
  const cartIssues = [];
  if (!hasDeliveryFee) {
    cartIssues.push('Digital Delivery Fee not found in cart');
  }

  if (cartIssues.length > 0) {
    emit({ step: `Cart validation issues: ${cartIssues.join('; ')}` });
    return { passed: false, message: `Cart check failed: ${cartIssues.join('; ')}. Items: ${cartItems.map(i => `${i.name} ($${i.price})`).join(', ')}` };
  }

  emit({ step: `Cart validated — ${bagCount} items, Digital Delivery Fee: ${deliveryFeePrice}` });

  // Step 4: Proceed to checkout
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for checkout to fully render (same robust approach as pickup test)
  try {
    await page.waitForSelector(
      'input[type="email"], input[type="text"], [class*="checkout"], [class*="order-summary"]',
      { timeout: 20000 }
    );
  } catch {}
  await page.waitForTimeout(5000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}

  const checkoutShot = screenshotPath(store.newStore, 'digital-delivery-fee', '05_checkout');
  await page.screenshot({ path: checkoutShot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutShot), label: 'Checkout page' });

  // Verify Digital Delivery Fee and the product are present on checkout
  emit({ step: 'Validating checkout page...' });
  const pageText = await page.textContent('body').catch(() => '');
  const upperPageText = pageText.toUpperCase();
  const hasFeeOnCheckout = upperPageText.includes('DIGITAL DELIVERY FEE');
  // Normalize HTML entities and special chars for comparison
  const normalize = (s) => s.toUpperCase().replace(/&AMP;/g, '&').replace(/&/g, '&').replace(/\s+/g, ' ').trim();
  const normalizedPage = normalize(upperPageText);
  const normalizedProduct = normalize(addedProductName);
  // Use first 40 chars of product name to avoid partial mismatch on long titles
  const productSnippet = normalizedProduct.substring(0, 40);
  const hasProductOnCheckout = addedProductName
    ? normalizedPage.includes(productSnippet)
    : true;

  const digitalChecks = [
    { name: 'Digital Delivery Fee', passed: hasFeeOnCheckout, detail: hasFeeOnCheckout ? 'Found on checkout page' : 'Not found on checkout page' },
    { name: 'Product on Checkout', passed: hasProductOnCheckout, detail: hasProductOnCheckout ? `"${addedProductName}" found on checkout` : `"${addedProductName}" not found on checkout page` },
  ];

  const checkoutIssues = digitalChecks.filter(c => !c.passed).map(c => c.detail);

  if (checkoutIssues.length > 0) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);
    const checkoutShot2 = screenshotPath(store.newStore, 'digital-delivery-fee', '05_checkout_scrolled');
    await page.screenshot({ path: checkoutShot2, fullPage: false });
    emit({ screenshot: screenshotUrl(checkoutShot2), label: 'Checkout page (scrolled)' });

    return { passed: false, message: `Checkout validation failed: ${checkoutIssues.join('; ')}`, checks: digitalChecks };
  }

  emit({ step: 'Checkout validated — Digital Delivery Fee and product both present' });

  return {
    passed: true,
    message: `Digital delivery flow complete. Cart: ${bagCount} items. Digital Delivery Fee: ${deliveryFeePrice}. Both items confirmed on checkout.`,
    checks: digitalChecks,
  };
}

async function testCheckoutValidation(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const qaState = getQaState(page);
  let cartData = await readCartData(page);
  if (qaState.standardCartReady && cartData && cartData.item_count > 0) {
    emit({ step: `Reusing existing cart from earlier test (${cartData.item_count} item(s))` });
  } else {
    emit({ step: 'No reusable cart found — adding a standard item for checkout validation...' });
    await clearCart(page, origin, emit);
    const addResult = await addStandardItemToCart(page, store, emit, {
      listUrl: `${origin}/search?q=${encodeURIComponent('textbook')}`,
      maxProducts: 5,
      screenshotPrefix: 'checkout-validation',
    });
    if (!addResult.passed) {
      const failShot = screenshotPath(store.newStore, 'checkout-validation', '01_no_add');
      await page.screenshot({ path: failShot, fullPage: false });
      emit({ screenshot: screenshotUrl(failShot), label: 'Could not add any item' });
      return { passed: false, message: addResult.message || 'Could not add any item to cart' };
    }
    cartData = await readCartData(page);
  }

  // Step 2: Navigate to checkout
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  emit({ step: 'Waiting for checkout to fully load...' });
  try {
    await page.waitForSelector(
      'input[type="email"], input[type="text"], [data-delivery-group], label:has-text("Ship"), [class*="checkout"]',
      { timeout: 20000 }
    );
  } catch {}
  await page.waitForTimeout(5000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}

  const checkoutShot = screenshotPath(store.newStore, 'checkout-validation', '02_checkout');
  await page.screenshot({ path: checkoutShot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutShot), label: 'Checkout page (top)' });

  const issues = [];

  // ── CHECK A: Financial Aid Placement ──
  emit({ step: 'Analyzing section order on checkout page...' });

  const sectionOrder = await page.evaluate(() => {
    const body = document.body.innerText;
    const sections = [];
    const patterns = [
      { name: 'Contact', regex: /contact\s*(info|information)?/i },
      { name: 'Delivery / Shipping Address', regex: /delivery|shipping\s*address/i },
      { name: 'Shipping Method', regex: /shipping\s*method/i },
      { name: 'Student Billing / Financial Aid', regex: /student\s*billing|financial\s*aid/i },
      { name: 'Payment', regex: /^payment$/im },
    ];
    for (const p of patterns) {
      const match = body.match(p.regex);
      if (match) sections.push({ name: p.name, position: match.index });
    }
    sections.sort((a, b) => a.position - b.position);
    return sections;
  });

  emit({ step: `Sections found (in order): ${sectionOrder.map(s => s.name).join(' → ')}` });

  // Scroll through checkout for screenshots
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(1000);
  const checkoutMid = screenshotPath(store.newStore, 'checkout-validation', '02b_checkout_mid');
  await page.screenshot({ path: checkoutMid, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutMid), label: 'Checkout (middle)' });

  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(1000);
  const checkoutBot = screenshotPath(store.newStore, 'checkout-validation', '02c_checkout_bottom');
  await page.screenshot({ path: checkoutBot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutBot), label: 'Checkout (bottom)' });

  // Validate Financial Aid placement
  const financialAid = sectionOrder.find(s => s.name === 'Student Billing / Financial Aid');
  const contact = sectionOrder.find(s => s.name === 'Contact');
  const shippingMethod = sectionOrder.find(s => s.name === 'Shipping Method');

  if (!financialAid) {
    issues.push('Student Billing / Financial Aid section NOT found on checkout');
  } else {
    if (contact && financialAid.position < contact.position) {
      issues.push('Financial Aid appears BEFORE Contact — should be after');
    }
    if (shippingMethod && financialAid.position < shippingMethod.position) {
      issues.push('Financial Aid appears BEFORE Shipping Method — should be after');
    }
    if (!issues.some(i => i.includes('Financial Aid'))) {
      emit({ step: '✅ Financial Aid correctly placed after Contact & Shipping Method' });
    }
  }

  // Scroll back to top for field validation
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  // ── CHECK B: Field labels ──
  emit({ step: 'Analyzing checkout field labels...' });

  const fieldAnalysis = await page.evaluate(() => {
    const results = {
      firstNameLabel: null,
      firstNameHasOptional: false,
      phoneLabel: null,
      phoneIsRequired: false,
      allLabels: [],
    };

    // Get all labels and field placeholders on the page
    const labels = document.querySelectorAll('label, .field__label');
    for (const label of labels) {
      const text = label.textContent.trim();
      results.allLabels.push(text);

      const upperText = text.toUpperCase();

      // Check First Name field
      if (upperText.includes('FIRST NAME') || upperText === 'FIRST') {
        results.firstNameLabel = text;
        results.firstNameHasOptional = upperText.includes('OPTIONAL');
      }

      // Check Phone field
      if (upperText.includes('PHONE')) {
        results.phoneLabel = text;
        // Phone is required if label does NOT say "optional" or if it says "required"
        // Shopify marks optional fields with "(optional)" in the label
        results.phoneIsRequired = !upperText.includes('OPTIONAL');
      }
    }

    // Also check input placeholders as fallback
    const inputs = document.querySelectorAll('input, [data-trekkie-id]');
    for (const input of inputs) {
      const placeholder = (input.placeholder || '').trim();
      const ariaLabel = (input.getAttribute('aria-label') || '').trim();
      const name = (input.getAttribute('name') || '').trim();
      const autocomplete = (input.getAttribute('autocomplete') || '').trim();
      const fieldText = placeholder || ariaLabel;
      const upperField = fieldText.toUpperCase();

      if (!results.firstNameLabel && (upperField.includes('FIRST NAME') || autocomplete === 'given-name')) {
        results.firstNameLabel = fieldText;
        results.firstNameHasOptional = upperField.includes('OPTIONAL');
      }

      if (!results.phoneLabel && (upperField.includes('PHONE') || autocomplete === 'tel')) {
        results.phoneLabel = fieldText;
        results.phoneIsRequired = !upperField.includes('OPTIONAL');
      }
    }

    return results;
  });

  emit({ step: `First Name label: "${fieldAnalysis.firstNameLabel || 'NOT FOUND'}" — Optional: ${fieldAnalysis.firstNameHasOptional}` });
  emit({ step: `Phone label: "${fieldAnalysis.phoneLabel || 'NOT FOUND'}" — Required: ${fieldAnalysis.phoneIsRequired}` });

  // Scroll to show the form fields and screenshot
  await page.evaluate(() => {
    const firstNameField = document.querySelector('input[autocomplete="given-name"], input[name*="first"], input[placeholder*="First"]');
    if (firstNameField) firstNameField.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);

  const fieldsShot = screenshotPath(store.newStore, 'checkout-validation', '03_fields');
  await page.screenshot({ path: fieldsShot, fullPage: false });
  emit({ screenshot: screenshotUrl(fieldsShot), label: 'Checkout fields' });

  // Validate field labels
  if (!fieldAnalysis.firstNameLabel) {
    issues.push('First Name field not found on checkout');
  } else if (fieldAnalysis.firstNameHasOptional) {
    issues.push(`First Name has "(optional)" label — should be required. Label: "${fieldAnalysis.firstNameLabel}"`);
  }

  if (!fieldAnalysis.phoneLabel) {
    issues.push('Phone Number field not found on checkout');
  } else if (!fieldAnalysis.phoneIsRequired) {
    issues.push(`Phone Number is not required (has "optional" label). Label: "${fieldAnalysis.phoneLabel}"`);
  }

  // Step 5: Verify Follett legal disclaimer above Pay Now button
  emit({ step: 'Checking for Follett legal disclaimer above Pay Now...' });

  const disclaimerCheck = await page.evaluate(() => {
    const bodyText = document.body.innerText;

    // Check for the required text components
    const hasAgreement = /by proceeding,?\s*i agree to follett/i.test(bodyText);
    const hasTermsOfUse = /terms of use/i.test(bodyText);
    const hasPrivacyPolicy = /privacy policy/i.test(bodyText);
    const hasCookiePolicy = /cookie preference policy/i.test(bodyText);

    // Check that Terms of Use, Privacy Policy, and Cookie Preference Policy are links
    const termsLink = document.querySelector('a[href*="follett.com/terms"]');
    const privacyLink = document.querySelector('a[href*="follett.com/polic"]');
    const cookieLink = document.querySelector('a[href*="follett.com/cookie"]');

    // Check placement: disclaimer should be above Pay Now button
    // Use innerText position in the page's text flow (more reliable than getBoundingClientRect
    // since parent containers can match the regex too)
    let disclaimerAbovePayNow = false;
    let disclaimerPos = -1;
    let payNowPos = -1;

    // Use text position in body.innerText as a proxy for visual order
    const disclaimerIdx = bodyText.search(/by proceeding,?\s*i agree to follett/i);
    const payNowIdx = bodyText.search(/pay now/i);

    if (disclaimerIdx >= 0 && payNowIdx >= 0) {
      disclaimerPos = disclaimerIdx;
      payNowPos = payNowIdx;
      disclaimerAbovePayNow = disclaimerIdx < payNowIdx;
    }

    return {
      hasAgreement,
      hasTermsOfUse,
      hasPrivacyPolicy,
      hasCookiePolicy,
      hasTermsLink: !!termsLink,
      hasPrivacyLink: !!privacyLink,
      hasCookieLink: !!cookieLink,
      disclaimerAbovePayNow,
      disclaimerPos,
      payNowPos,
    };
  });

  emit({ step: `Disclaimer check — Agreement text: ${disclaimerCheck.hasAgreement}, Terms: ${disclaimerCheck.hasTermsOfUse} (link: ${disclaimerCheck.hasTermsLink}), Privacy: ${disclaimerCheck.hasPrivacyPolicy} (link: ${disclaimerCheck.hasPrivacyLink}), Cookie: ${disclaimerCheck.hasCookiePolicy} (link: ${disclaimerCheck.hasCookieLink}), Above Pay Now: ${disclaimerCheck.disclaimerAbovePayNow}` });

  // Scroll to Pay Now area and screenshot
  await page.evaluate(() => {
    const payBtn = document.querySelector('button:has(> *:first-child)');
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      if (/pay now/i.test(btn.textContent)) {
        btn.scrollIntoView({ block: 'center' });
        break;
      }
    }
  });
  await page.waitForTimeout(500);

  const disclaimerShot = screenshotPath(store.newStore, 'checkout-validation', '04_disclaimer');
  await page.screenshot({ path: disclaimerShot, fullPage: false });
  emit({ screenshot: screenshotUrl(disclaimerShot), label: 'Pay Now / Disclaimer area' });

  if (!disclaimerCheck.hasAgreement) {
    issues.push('Missing disclaimer: "By proceeding, I agree to Follett\'s..." not found');
  }
  if (!disclaimerCheck.hasTermsOfUse) {
    issues.push('Missing "Terms of Use" in disclaimer');
  } else if (!disclaimerCheck.hasTermsLink) {
    issues.push('"Terms of Use" is not a link');
  }
  if (!disclaimerCheck.hasPrivacyPolicy) {
    issues.push('Missing "Privacy Policy" in disclaimer');
  } else if (!disclaimerCheck.hasPrivacyLink) {
    issues.push('"Privacy Policy" is not a link');
  }
  if (!disclaimerCheck.hasCookiePolicy) {
    issues.push('Missing "Cookie Preference Policy" in disclaimer');
  } else if (!disclaimerCheck.hasCookieLink) {
    issues.push('"Cookie Preference Policy" is not a link');
  }
  if (disclaimerCheck.hasAgreement && !disclaimerCheck.disclaimerAbovePayNow) {
    issues.push('Disclaimer is not positioned above the "Pay Now" button');
  }

  // ── CHECK D: Email Marketing Checkbox (US vs Canada compliance) ──
  emit({ step: 'Checking email marketing checkbox compliance...' });

  // Determine if store is US or Canada by checking footer address
  const storeCountry = await page.evaluate((storeOrigin) => {
    // First try to find address in footer from the main page (we may be on checkout now)
    // Check the checkout page itself for location clues
    const bodyText = document.body.innerText;

    // Canadian provinces
    const canadianPatterns = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT|Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland|Nova Scotia|Northwest Territories|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon)\b/;
    // Canadian postal code pattern
    const canadianPostal = /[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/;
    // Check for "Canada" explicitly
    const hasCanada = /\bCanada\b/i.test(bodyText);

    return (hasCanada || canadianPostal.test(bodyText)) ? 'CA' : 'US';
  }, origin);

  // Also check the homepage footer for more reliable country detection
  let footerCountry = null;
  try {
    const newPage = await page.context().newPage();
    await newPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await newPage.waitForTimeout(2000);
    footerCountry = await newPage.evaluate(() => {
      const footer = document.querySelector('footer');
      if (!footer) return null;
      const footerText = footer.innerText;
      const canadianPostal = /[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/;
      const hasCanada = /\bCanada\b/i.test(footerText);
      const canadianProvinces = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/;
      if (hasCanada || canadianPostal.test(footerText)) return 'CA';
      // US zip code pattern (5 digits or 5+4)
      if (/\b\d{5}(-\d{4})?\b/.test(footerText)) return 'US';
      return null;
    });
    await newPage.close();
  } catch (_) {}

  const country = footerCountry || storeCountry;
  emit({ step: `Store detected as: ${country === 'CA' ? 'Canada' : 'US'} (footer: ${footerCountry || 'unknown'}, checkout: ${storeCountry})` });

  // Now check the email marketing checkbox on checkout
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const emailCheckboxState = await page.evaluate(() => {
    // Look for the "Email me with news and offers" checkbox
    const allLabels = document.querySelectorAll('label');
    for (const label of allLabels) {
      const text = (label.textContent || '').trim();
      if (/email\s*me\s*with\s*news/i.test(text)) {
        const checkbox = label.querySelector('input[type="checkbox"]') ||
          document.getElementById(label.getAttribute('for'));
        return {
          exists: true,
          checked: checkbox ? checkbox.checked : null,
          text: text,
        };
      }
    }
    // Also check by input attributes
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const id = cb.id || '';
      const name = cb.name || '';
      const ariaLabel = cb.getAttribute('aria-label') || '';
      if (/marketing|newsletter|email.*news/i.test(id + name + ariaLabel)) {
        const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
        return {
          exists: true,
          checked: cb.checked,
          text: label ? label.textContent.trim() : ariaLabel || name,
        };
      }
    }
    return { exists: false, checked: null, text: null };
  });

  const emailShot = screenshotPath(store.newStore, 'checkout-validation', '05_email_marketing');
  await page.screenshot({ path: emailShot, fullPage: false });
  emit({ screenshot: screenshotUrl(emailShot), label: 'Email marketing checkbox area' });

  let emailCheckPassed = false;
  let emailCheckDetail = '';

  if (country === 'US') {
    // US: checkbox should NOT exist (CAN-SPAM compliance)
    if (!emailCheckboxState.exists) {
      emailCheckPassed = true;
      emailCheckDetail = 'US store: "Email me with news and offers" checkbox correctly absent';
    } else {
      emailCheckPassed = false;
      emailCheckDetail = `US store: "Email me with news and offers" checkbox should NOT exist (found: "${emailCheckboxState.text}", checked: ${emailCheckboxState.checked})`;
      issues.push(emailCheckDetail);
    }
  } else {
    // Canada: checkbox should exist but be UNCHECKED (CASL compliance)
    if (!emailCheckboxState.exists) {
      emailCheckPassed = false;
      emailCheckDetail = 'Canada store: "Email me with news and offers" checkbox NOT found — should exist but be unchecked (CASL)';
      issues.push(emailCheckDetail);
    } else if (emailCheckboxState.checked) {
      emailCheckPassed = false;
      emailCheckDetail = `Canada store: "Email me with news and offers" checkbox is checked — must be unchecked by default (CASL). Text: "${emailCheckboxState.text}"`;
      issues.push(emailCheckDetail);
    } else {
      emailCheckPassed = true;
      emailCheckDetail = `Canada store: "Email me with news and offers" checkbox exists and is unchecked — correct (CASL). Text: "${emailCheckboxState.text}"`;
    }
  }

  emit({ step: `✅ Email marketing check: ${emailCheckDetail}` });

  // Build structured checks for export
  const checkoutChecks = [
    { name: 'Financial Aid Placement', passed: !issues.some(i => i.includes('Financial Aid')), detail: financialAid ? `Found — position correct after Contact & Shipping` : 'Section NOT found on checkout' },
    { name: 'First Name Required', passed: !issues.some(i => i.includes('First Name')), detail: fieldAnalysis.firstNameLabel ? (fieldAnalysis.firstNameHasOptional ? `Has "(optional)" — should be required` : `Label: "${fieldAnalysis.firstNameLabel}" — required`) : 'Field not found' },
    { name: 'Phone Required', passed: !issues.some(i => i.includes('Phone')), detail: fieldAnalysis.phoneLabel ? (fieldAnalysis.phoneIsRequired ? `Label: "${fieldAnalysis.phoneLabel}" — required` : `Has "optional" label — should be required`) : 'Field not found' },
    { name: 'Disclaimer Text', passed: disclaimerCheck.hasAgreement, detail: disclaimerCheck.hasAgreement ? 'Agreement text found' : 'Missing "By proceeding, I agree to Follett\'s..." text' },
    { name: 'Terms of Use Link', passed: disclaimerCheck.hasTermsOfUse && disclaimerCheck.hasTermsLink, detail: disclaimerCheck.hasTermsOfUse ? (disclaimerCheck.hasTermsLink ? 'Linked correctly' : 'Text found but not a link') : 'Not found in disclaimer' },
    { name: 'Privacy Policy Link', passed: disclaimerCheck.hasPrivacyPolicy && disclaimerCheck.hasPrivacyLink, detail: disclaimerCheck.hasPrivacyPolicy ? (disclaimerCheck.hasPrivacyLink ? 'Linked correctly' : 'Text found but not a link') : 'Not found in disclaimer' },
    { name: 'Cookie Policy Link', passed: disclaimerCheck.hasCookiePolicy && disclaimerCheck.hasCookieLink, detail: disclaimerCheck.hasCookiePolicy ? (disclaimerCheck.hasCookieLink ? 'Linked correctly' : 'Text found but not a link') : 'Not found in disclaimer' },
    { name: 'Disclaimer Position', passed: !disclaimerCheck.hasAgreement || disclaimerCheck.disclaimerAbovePayNow, detail: disclaimerCheck.disclaimerAbovePayNow ? 'Above Pay Now button' : 'Not positioned above Pay Now button' },
    { name: 'Email Marketing Compliance', passed: emailCheckPassed, detail: emailCheckDetail },
  ];

  if (issues.length > 0) {
    emit({ step: `Validation failed: ${issues.join('; ')}` });
    return { passed: false, message: issues.join('; '), checks: checkoutChecks };
  }

  emit({ step: 'All checkout validations passed' });
  return {
    passed: true,
    message: `Financial Aid placement correct ✓. First Name: not optional ✓. Phone: required ✓. Follett disclaimer with linked Terms/Privacy/Cookie above Pay Now ✓. Email marketing compliance (${country === 'CA' ? 'Canada/CASL' : 'US/CAN-SPAM'}) ✓. Section order: ${sectionOrder.map(s => s.name).join(' → ')}`,
    checks: checkoutChecks,
  };
}

async function testPageContentMigration(page, store, emit) {
  const newOrigin = storeOrigin(store.newStore);
  const originalOrigin = store.originalStore
    ? storeOrigin(store.originalStore)
    : null;

  const checks = [];
  let checkNum = 0;

  function record(name, passed, detail) {
    checkNum++;
    const status = passed ? '✅' : '❌';
    const msg = `[${checkNum}] ${status} ${name}: ${detail}`;
    emit({ step: msg });
    checks.push({ num: checkNum, name, passed, detail });
  }

  // ── Helper: get page text safely ──
  async function getBodyText(pg) {
    return (await pg.textContent('body').catch(() => '')).trim();
  }

  // ── Helper: check if a page exists (not 404) ──
  async function pageExists(pg, url, label) {
    try {
      const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await pg.waitForTimeout(2000);
      const status = resp ? resp.status() : 0;
      if (status === 404) return false;
      const bodyText = await getBodyText(pg);
      // Only flag as 404 if the page title or a prominent heading says so — not random body text
      const title = await pg.title().catch(() => '');
      const h1 = await pg.$eval('h1', el => el.textContent).catch(() => '');
      const is404 = /404|page not found/i.test(title) || /404|page not found/i.test(h1);
      return !is404 && bodyText.length > 100;
    } catch {
      return false;
    }
  }

  // ── Step 0: Determine country (US vs Canada) by checking footer address ──
  emit({ step: 'Determining store country from footer...' });
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Hide Shopify preview bar throughout this test — it overlaps footer content
  await hidePreviewBar();

  const footerText = await page.evaluate(() => {
    const footer = document.querySelector('footer');
    return footer ? footer.innerText : document.body.innerText.slice(-2000);
  });
  const upperFooter = footerText.toUpperCase();
  const isCanada = upperFooter.includes('CANADA') || upperFooter.includes(' ON ') || upperFooter.includes(' AB ') || upperFooter.includes(' BC ') || upperFooter.includes(' QC ') || upperFooter.includes(' MB ') || upperFooter.includes(' SK ') || upperFooter.includes(' NS ');
  const country = isCanada ? 'Canada' : 'US';
  emit({ step: `Detected store country: ${country}` });

  // ── GUARD: Fail immediately if old bkstr.com content is detected ──
  emit({ step: 'Guard check: Verifying no legacy bkstr.com content...' });
  const hasBkstrFooter = footerText.toLowerCase().includes('tcu@bkstr.com');
  let hasBkstrHoursPage = false;
  try {
    const hoursResp = await page.goto(`${newOrigin}/pages/view-store-hours`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const hoursBodyText = await getBodyText(page);
    hasBkstrHoursPage = hoursBodyText.toLowerCase().includes('tcu@bkstr.com');
  } catch { /* page may not exist — that's fine */ }

  if (hasBkstrFooter || hasBkstrHoursPage) {
    const locations = [hasBkstrFooter && 'footer', hasBkstrHoursPage && '/pages/view-store-hours'].filter(Boolean).join(' and ');
    record('No Legacy bkstr.com Content', false, `Found "tcu@bkstr.com" in ${locations} — wrong store content detected`);
  } else {
    record('No Legacy bkstr.com Content', true, 'No legacy tcu@bkstr.com content found in footer or store hours page');
  }

  // ── Check 1: Correct store logo displayed ──
  emit({ step: 'Check 1: Verifying store logo...' });
  // Get new store logo
  const newLogo = await page.evaluate(() => {
    const img = document.querySelector('header img[src*="logo"], header img[alt*="logo" i], .header img, header svg, .logo img, a[href="/"] img');
    if (img) return { src: img.src || '', alt: img.alt || '' };
    return null;
  });

  // For Check 1, just verify logo exists on new store (original store behind Akamai CDN blocks headless browsers)
  const newLogoShot = screenshotPath(store.newStore, 'page-content-migration', '01_new_logo');
  await page.screenshot({ path: newLogoShot, fullPage: false });
  emit({ screenshot: screenshotUrl(newLogoShot), label: 'New store header' });

  if (newLogo) {
    record('Store Logo', true, `Logo found on new store: "${newLogo.alt || 'image'}" (original store skipped — CDN blocks headless browsers)`);
  } else {
    record('Store Logo', false, 'No logo/image found in header of new store');
  }

  // ── Check 2: Store hours displayed correctly ──
  emit({ step: 'Check 2: Verifying store hours...' });
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await hidePreviewBar();

  // Scroll to footer to find store hours
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  const bodyText = await getBodyText(page);
  const hasHours = /\d{1,2}(:\d{2})?\s*(am|pm|AM|PM)\s*(-|–|to)\s*\d{1,2}(:\d{2})?\s*(am|pm|AM|PM)/i.test(bodyText) ||
    bodyText.toUpperCase().includes('STORE HOURS') ||
    bodyText.toUpperCase().includes('HOURS OF OPERATION') ||
    /MON|TUE|WED|THU|FRI|SAT|SUN/i.test(bodyText) && /\d{1,2}(:\d{2})?\s*(am|pm)/i.test(bodyText);

  const hoursShot = screenshotPath(store.newStore, 'page-content-migration', '02_hours');
  await page.screenshot({ path: hoursShot, fullPage: false });
  emit({ screenshot: screenshotUrl(hoursShot), label: 'Store hours area (footer)' });

  record('Store Hours', hasHours, hasHours ? 'Store hours information found on page' : 'No store hours information found');

  // ── Check 3: Store address formatted correctly ──
  emit({ step: 'Check 3: Verifying store address...' });
  const hasAddress = /\d{1,5}\s+[A-Za-z]/.test(footerText) || /[A-Z]{2}\s+\d{5}/.test(footerText) || /[A-Z]\d[A-Z]\s*\d[A-Z]\d/.test(footerText);

  record('Store Address', hasAddress, hasAddress ? 'Store address found in footer' : 'No properly formatted store address found in footer');

  // ── Check 4: Shop with Purpose / correct school name ──
  emit({ step: 'Check 4: Checking Shop with Purpose banner...' });
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const fullBodyText = await getBodyText(page);
  const hasShopWithPurpose = fullBodyText.toUpperCase().includes('SHOP WITH PURPOSE');

  if (hasShopWithPurpose) {
    // If original store exists, compare the school name
    if (originalOrigin) {
      // We already have the logos/info from check 1 — just verify the banner exists
      record('Shop with Purpose', true, 'Shop with Purpose banner found on new store');
    } else {
      record('Shop with Purpose', true, 'Shop with Purpose banner found (no original store to compare school name)');
    }
  } else {
    // No banner — this is not a failure per the requirements
    record('Shop with Purpose', true, 'Shop with Purpose banner not present (not required — PASS)');
  }

  const purposeShot = screenshotPath(store.newStore, 'page-content-migration', '04_shop_purpose');
  await page.screenshot({ path: purposeShot, fullPage: false });
  emit({ screenshot: screenshotUrl(purposeShot), label: 'Homepage (Shop with Purpose check)' });

  // ── Helper: hide Shopify preview bar so it doesn't overlap footer elements ──
  async function hidePreviewBar() {
    await page.evaluate(() => {
      const selectors = [
        '#preview-bar-iframe', '[id*="preview-bar"]', '#shopify-preview-bar',
        '[id*="shopify-preview"]', 'iframe[src*="preview-bar"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      }
    });
  }

  // ── Helper: go to homepage footer and gather all footer link info ──
  async function getFooterLinks() {
    await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Hide the preview bar so it doesn't cover footer elements
    await hidePreviewBar();

    // Scroll all the way to the absolute bottom to ensure lazy-loaded footer content appears
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    // Scroll again — some footers render extra content after the first scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const links = [];
      const seen = new Set();

      // Collect from <footer> element
      const footer = document.querySelector('footer');
      if (footer) {
        for (const a of footer.querySelectorAll('a')) {
          const text = (a.textContent || '').trim();
          const href = a.getAttribute('href') || '';
          const key = `${text}|${href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({
            text,
            href,
            visible: a.offsetParent !== null && a.offsetWidth > 0 && a.offsetHeight > 0,
          });
        }
      }

      // Also scan the bottom 25% of the page for links outside <footer>
      // (OneTrust banners, cookie links, etc. are often outside the footer tag)
      const allLinks = document.querySelectorAll('a, button');
      const pageHeight = document.body.scrollHeight;
      for (const el of allLinks) {
        const rect = el.getBoundingClientRect();
        const absTop = rect.top + window.scrollY;
        // Only consider elements in the bottom quarter of the page
        if (absTop < pageHeight * 0.75) continue;
        const text = (el.textContent || '').trim();
        const href = el.getAttribute('href') || el.getAttribute('onclick') || '';
        const key = `${text}|${href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          text,
          href,
          visible: el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0,
        });
      }

      return links;
    });
  }

  // Get all footer links once
  emit({ step: 'Scanning footer for all links...' });
  const footerLinks = await getFooterLinks();

  const footerShot = screenshotPath(store.newStore, 'page-content-migration', '05_footer');
  await page.screenshot({ path: footerShot, fullPage: false });
  emit({ screenshot: screenshotUrl(footerShot), label: 'Footer links' });
  emit({ step: `Found ${footerLinks.length} links in footer` });

  // Helper: check if a link with matching text/href is visible in footer
  // Matches if (text AND href both match) OR (href matches alone — covers icon-only links)
  function footerLinkExists(textPattern, hrefPattern) {
    return footerLinks.some(l => {
      const textMatch = textPattern ? textPattern.test(l.text) : true;
      const hrefMatch = hrefPattern ? hrefPattern.test(l.href) : true;
      // Primary: both text and href match and visible
      if (l.visible && textMatch && hrefMatch) return true;
      // Fallback: href matches even if text doesn't (icon-only links, or text rendered differently)
      if (hrefMatch && hrefPattern && l.visible) return true;
      return false;
    });
  }

  // Helper: combined footer + page check — wrapped in try/catch so one failure doesn't kill the whole test
  async function checkFooterAndPage(checkNumber, name, footerTextRegex, footerHrefRegex, pagePath, shotId) {
    emit({ step: `Check ${checkNumber}: Verifying ${name}...` });

    try {
      const inFooter = footerLinkExists(footerTextRegex, footerHrefRegex);
      const fullUrl = `${newOrigin}${pagePath}`;
      let exists = false;
      try {
        exists = await pageExists(page, fullUrl, name);
      } catch (navErr) {
        emit({ step: `Check ${checkNumber}: Navigation to ${fullUrl} failed: ${navErr.message}` });
      }

      if (exists) {
        try {
          const shot = screenshotPath(store.newStore, 'page-content-migration', shotId);
          await page.screenshot({ path: shot, fullPage: false });
          emit({ screenshot: screenshotUrl(shot), label: `${name} page` });
        } catch {}
      }

      const passed = inFooter && exists;
      record(name, passed,
        `Footer link: ${inFooter ? 'visible' : 'NOT found'}, Page at ${fullUrl}: ${exists ? 'loads' : 'NOT found'}`
      );
    } catch (err) {
      record(name, false, `Error during check: ${err.message}`);
    }
  }

  // ── Check 5: Price Match Guarantee ──
  await checkFooterAndPage(5, 'Price Match Guarantee',
    /price\s*match/i, /price-match/i,
    '/pages/price-match-guarantee', '05_price_match');

  // ── Check 6: Accessibility / Browser Support ──
  await checkFooterAndPage(6, 'Accessibility / Browser Support',
    /accessib|browser\s*support/i, /faq-accessibility/i,
    '/pages/faq-accessibility-browser-support', '06_accessibility');

  // ── Check 7: New Students & Parents ──
  await checkFooterAndPage(7, 'New Students & Parents',
    /new\s*students|incoming/i, /incoming-students/i,
    '/pages/incoming-students', '07_incoming_students');

  // ── Check 8: Delivery Options FAQ ──
  await checkFooterAndPage(8, 'Delivery Options FAQ',
    /deliver|shipping/i, /faq-shipping|shipping-delivery/i,
    '/pages/faq-shipping-delivery', '08_delivery_faq');

  // ── Check 9: Payments Accepted FAQ ──
  await checkFooterAndPage(9, 'Payments Accepted FAQ',
    /payment|order/i, /faq-orders/i,
    '/pages/faq-orders', '09_payments_faq');

  // ── Check 10: Returns ──
  await checkFooterAndPage(10, 'Returns',
    /return/i, /return/i,
    '/pages/faq-online-return-policy', '10_returns');

  // ── Check 11: Help/FAQ ──
  await checkFooterAndPage(11, 'Help/FAQ',
    /help|faq/i, /\/pages\/faq/i,
    '/pages/faq', '11_faq');

  // ── Check 12: Sell Your Textbooks ──
  await checkFooterAndPage(12, 'Sell Your Textbooks',
    /sell.*textbook/i, /faq-sell/i,
    '/pages/faq-sell-your-textbooks', '12_sell_textbooks');

  // ── Check 13: Textbook FAQs ──
  await checkFooterAndPage(13, 'Textbook FAQs',
    /textbook\s*faq/i, /faq-textbooks/i,
    '/pages/faq-textbooks', '13_textbook_faq');

  // ── Check 14: Rentals FAQ ──
  await checkFooterAndPage(14, 'Rentals FAQ',
    /rental/i, /faq-rental/i,
    '/pages/faq-rentals', '14_rentals_faq');

  // ── Check 15: Digital Materials FAQ ──
  await checkFooterAndPage(15, 'Digital Materials FAQ',
    /digital/i, /faq-digital/i,
    '/pages/faq-digital-books', '15_digital_faq');

  // ── Check 16: Terms of Use link → follett.com/terms-of-use/ ──
  emit({ step: 'Check 16: Verifying Terms of Use footer link...' });
  const touLink = footerLinks.find(l => /terms\s*of\s*use/i.test(l.text) && l.visible);
  if (touLink) {
    const linksToFollett = /follett\.com\/terms/i.test(touLink.href);
    if (linksToFollett) {
      record('Terms of Use', true, `Footer link found: "${touLink.text}" → ${touLink.href}`);
    } else {
      record('Terms of Use', false, `Footer link found but does not link to follett.com/terms-of-use/. Actual href: ${touLink.href}`);
    }
  } else {
    record('Terms of Use', false, 'Terms of Use link NOT found in footer');
  }

  // ── Check 17: Privacy Policy link → follett.com/policies/ ──
  emit({ step: 'Check 17: Verifying Privacy Policy footer link...' });
  const ppLink = footerLinks.find(l => /privacy\s*policy/i.test(l.text) && l.visible);
  if (ppLink) {
    const linksToFollett = /follett\.com\/polic/i.test(ppLink.href);
    if (linksToFollett) {
      record('Privacy Policy', true, `Footer link found: "${ppLink.text}" → ${ppLink.href}`);
    } else {
      record('Privacy Policy', false, `Footer link found but does not link to follett.com/policies/. Actual href: ${ppLink.href}`);
    }
  } else {
    record('Privacy Policy', false, 'Privacy Policy link NOT found in footer');
  }

  // ── Check 18: Cookie Preference Policy → opens OneTrust modal ──
  emit({ step: 'Check 18: Verifying Cookie Preference Policy footer link...' });
  // Navigate to homepage footer to click the link
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await hidePreviewBar();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  // Search both inside and outside <footer> — OneTrust links are often outside
  const cookieLink = await page.$('footer a:has-text("Cookie"), footer button:has-text("Cookie"), a:has-text("Cookie Preference"), button:has-text("Cookie Preference"), .ot-sdk-show-settings, #ot-sdk-btn, [class*="onetrust"] a, [class*="onetrust"] button');
  const cookieVisible = cookieLink ? await cookieLink.isVisible().catch(() => false) : false;

  if (cookieVisible) {
    // Check if it has an onclick for OneTrust or a # href (modal trigger)
    const cookieAttrs = await page.evaluate(el => {
      return {
        href: el.getAttribute('href') || '',
        onclick: el.getAttribute('onclick') || '',
        className: el.className || '',
        id: el.id || '',
      };
    }, cookieLink);
    const isOneTrust = /onetrust|optanon|cookie/i.test(cookieAttrs.onclick + cookieAttrs.className + cookieAttrs.id + cookieAttrs.href);
    // Try clicking to see if a modal opens
    try {
      await cookieLink.click({ timeout: 3000 });
      await page.waitForTimeout(2000);
      const modalVisible = await page.$('#onetrust-pc-sdk, .onetrust-pc-dark-filter, [id*="onetrust"], [class*="onetrust"], .ot-sdk-container');
      const cookieShot = screenshotPath(store.newStore, 'page-content-migration', '18_cookie_modal');
      await page.screenshot({ path: cookieShot, fullPage: false });
      emit({ screenshot: screenshotUrl(cookieShot), label: 'Cookie Preference modal' });

      if (modalVisible || isOneTrust) {
        record('Cookie Preference Policy', true, 'Footer link found — OneTrust modal triggered');
      } else {
        record('Cookie Preference Policy', false, 'Footer link clicked but no OneTrust modal appeared');
      }
    } catch {
      record('Cookie Preference Policy', isOneTrust, isOneTrust ? 'Link has OneTrust attributes' : 'Could not click cookie link or verify modal');
    }
  } else {
    record('Cookie Preference Policy', false, 'Cookie Preference Policy link NOT found in footer');
  }

  // ── Check 19: Do Not Sell link → opens OneTrust form ──
  emit({ step: 'Check 19: Verifying Do Not Sell footer link...' });
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await hidePreviewBar();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  // Search everywhere on page — not just inside <footer>
  const dnsLink = await page.$('footer a:has-text("Do Not Sell"), footer button:has-text("Do Not Sell"), footer a:has-text("Do not sell"), a:has-text("Do Not Sell"), button:has-text("Do Not Sell"), a:has-text("Do not sell")');
  const dnsVisible = dnsLink ? await dnsLink.isVisible().catch(() => false) : false;

  if (dnsVisible) {
    const dnsAttrs = await page.evaluate(el => {
      return {
        href: el.getAttribute('href') || '',
        onclick: el.getAttribute('onclick') || '',
        className: el.className || '',
        id: el.id || '',
      };
    }, dnsLink);
    const isOneTrust = /onetrust|optanon/i.test(dnsAttrs.onclick + dnsAttrs.className + dnsAttrs.id + dnsAttrs.href);
    try {
      await dnsLink.click({ timeout: 3000 });
      await page.waitForTimeout(2000);
      const dnsModal = await page.$('#onetrust-pc-sdk, .onetrust-pc-dark-filter, [id*="onetrust"], [class*="onetrust"], .ot-sdk-container, #ot-sdk-btn');
      const dnsShot = screenshotPath(store.newStore, 'page-content-migration', '19_dns_modal');
      await page.screenshot({ path: dnsShot, fullPage: false });
      emit({ screenshot: screenshotUrl(dnsShot), label: 'Do Not Sell form' });

      if (dnsModal || isOneTrust) {
        record('Do Not Sell', true, 'Footer link found — OneTrust form triggered');
      } else {
        record('Do Not Sell', false, 'Footer link clicked but no OneTrust form appeared');
      }
    } catch {
      record('Do Not Sell', isOneTrust, isOneTrust ? 'Link has OneTrust attributes' : 'Could not click Do Not Sell link or verify form');
    }
  } else {
    record('Do Not Sell', false, 'Do Not Sell link NOT found in footer');
  }

  // ── Check 20: Find Your Textbooks link → navigates to valid page ──
  emit({ step: 'Check 20: Verifying Find Your Textbooks link...' });
  const fytLink = footerLinks.find(l => /find\s*(your)?\s*textbook/i.test(l.text) && l.visible);

  if (fytLink) {
    const fytHref = fytLink.href.startsWith('http') ? fytLink.href : `${newOrigin}${fytLink.href}`;
    const fytExists = await pageExists(page, fytHref, 'Find Your Textbooks');

    if (fytExists) {
      const fytShot = screenshotPath(store.newStore, 'page-content-migration', '20_find_textbooks');
      await page.screenshot({ path: fytShot, fullPage: false });
      emit({ screenshot: screenshotUrl(fytShot), label: 'Find Your Textbooks page' });
      record('Find Your Textbooks', true, `Footer link found and page loads: ${fytHref}`);
    } else {
      record('Find Your Textbooks', false, `Footer link found but page is 404: ${fytHref}`);
    }
  } else {
    // Also check nav/header — "Find Your Textbooks" might be in the header nav
    await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const headerFyt = await page.$('a:has-text("Find Your Textbooks")');
    const headerFytVisible = headerFyt ? await headerFyt.isVisible().catch(() => false) : false;

    if (headerFytVisible) {
      const href = await headerFyt.getAttribute('href');
      const fullHref = href.startsWith('http') ? href : `${newOrigin}${href}`;
      const exists = await pageExists(page, fullHref, 'Find Your Textbooks');
      if (exists) {
        const fytShot = screenshotPath(store.newStore, 'page-content-migration', '20_find_textbooks');
        await page.screenshot({ path: fytShot, fullPage: false });
        emit({ screenshot: screenshotUrl(fytShot), label: 'Find Your Textbooks page' });
      }
      record('Find Your Textbooks', exists, exists ? `Header link found and page loads: ${fullHref}` : `Header link found but page is 404: ${fullHref}`);
    } else {
      record('Find Your Textbooks', false, 'Find Your Textbooks link NOT found in footer or header');
    }
  }

  // ── Check 21: Store Hours page exists ──
  emit({ step: 'Check 21: Verifying Store Hours page...' });
  // Try common store hours page paths
  const hoursPages = ['/pages/store-hours', '/pages/hours', '/pages/store-info'];
  let hoursPageFound = false;
  let hoursPageUrl = '';

  for (const path of hoursPages) {
    const url = `${newOrigin}${path}`;
    const exists = await pageExists(page, url, 'Store Hours');
    if (exists) {
      hoursPageFound = true;
      hoursPageUrl = url;
      const hoursPageShot = screenshotPath(store.newStore, 'page-content-migration', '21_store_hours_page');
      await page.screenshot({ path: hoursPageShot, fullPage: false });
      emit({ screenshot: screenshotUrl(hoursPageShot), label: 'Store Hours page' });
      break;
    }
  }

  // Also check for a footer link to store hours
  if (!hoursPageFound) {
    const hoursLink = footerLinks.find(l => /store\s*hours|hours.*operation/i.test(l.text) && l.visible);
    if (hoursLink) {
      const hoursHref = hoursLink.href.startsWith('http') ? hoursLink.href : `${newOrigin}${hoursLink.href}`;
      const exists = await pageExists(page, hoursHref, 'Store Hours');
      if (exists) {
        hoursPageFound = true;
        hoursPageUrl = hoursHref;
        const hoursPageShot = screenshotPath(store.newStore, 'page-content-migration', '21_store_hours_page');
        await page.screenshot({ path: hoursPageShot, fullPage: false });
        emit({ screenshot: screenshotUrl(hoursPageShot), label: 'Store Hours page' });
      }
    }
  }

  record('Store Hours Page', hoursPageFound,
    hoursPageFound ? `Store Hours page found at ${hoursPageUrl}` : 'Store Hours page not found (tried /pages/store-hours, /pages/hours, /pages/store-info, and footer links)'
  );

  // ── Check: Footer Email Signup Compliance Message ──
  emit({ step: `Check ${checks.length + 1}: Checking footer email signup compliance message...` });

  // Navigate back to homepage to find the footer signup
  await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Scroll to footer to ensure it loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  const emailSignupCheck = await page.evaluate(() => {
    const body = document.body.innerText;
    const html = document.body.innerHTML;

    const results = {
      hasComplianceText: false,
      complianceText: '',
      termsOfUseLink: { found: false, href: '', opensNewTab: false, correctUrl: false },
      privacyPolicyLink: { found: false, href: '', opensNewTab: false, correctUrl: false },
      cookiePrefLink: { found: false, href: '', isOneTrust: false },
      issues: [],
    };

    // Look for the compliance message text
    const compliancePattern = /by providing my email.*accept.*terms of use.*privacy policy.*cookie preference/i;
    results.hasComplianceText = compliancePattern.test(body);

    if (!results.hasComplianceText) {
      // Try broader search
      const altPattern = /providing.*email.*terms.*privacy.*cookie/i;
      results.hasComplianceText = altPattern.test(body);
    }

    if (!results.hasComplianceText) {
      results.issues.push('Compliance message "By providing my email, I accept the Terms of Use, Privacy Policy, and Cookie Preference Policy." not found');
      return results;
    }

    // Find the compliance area — look for links near the compliance text
    const allLinks = document.querySelectorAll('a');
    for (const link of allLinks) {
      const text = (link.textContent || '').trim();
      const href = link.getAttribute('href') || '';
      const target = link.getAttribute('target') || '';
      const opensNew = target === '_blank';

      // Terms of Use
      if (/terms of use/i.test(text)) {
        results.termsOfUseLink.found = true;
        results.termsOfUseLink.href = href;
        results.termsOfUseLink.opensNewTab = opensNew;
        results.termsOfUseLink.correctUrl = href.includes('follett.com/terms-of-use');
        if (!results.termsOfUseLink.correctUrl) {
          results.issues.push(`Terms of Use link points to "${href}" instead of follett.com/terms-of-use/`);
        }
        if (!results.termsOfUseLink.opensNewTab) {
          results.issues.push('Terms of Use link does not open in a new tab (missing target="_blank")');
        }
      }

      // Privacy Policy
      if (/privacy policy/i.test(text) && !/cookie/i.test(text)) {
        results.privacyPolicyLink.found = true;
        results.privacyPolicyLink.href = href;
        results.privacyPolicyLink.opensNewTab = opensNew;
        results.privacyPolicyLink.correctUrl = href.includes('follett.com/policies');
        if (!results.privacyPolicyLink.correctUrl) {
          results.issues.push(`Privacy Policy link points to "${href}" instead of follett.com/policies/`);
        }
        if (!results.privacyPolicyLink.opensNewTab) {
          results.issues.push('Privacy Policy link does not open in a new tab (missing target="_blank")');
        }
      }

      // Cookie Preference Policy
      if (/cookie preference/i.test(text)) {
        results.cookiePrefLink.found = true;
        results.cookiePrefLink.href = href;
        // Check if it triggers OneTrust modal (href contains onetrust or javascript or # for modal trigger)
        results.cookiePrefLink.isOneTrust = /onetrust|optanon|cookie-settings|javascript:|ot-sdk/i.test(href) ||
          link.classList.contains('ot-sdk-show-settings') ||
          link.getAttribute('onclick')?.includes('OneTrust') ||
          link.getAttribute('onclick')?.includes('Optanon') ||
          link.id?.includes('ot-') ||
          href === '#' || href === '';
        if (!results.cookiePrefLink.isOneTrust) {
          results.issues.push(`Cookie Preference Policy link does not appear to trigger OneTrust modal (href: "${href}")`);
        }
      }
    }

    if (!results.termsOfUseLink.found) results.issues.push('Terms of Use link not found in compliance message');
    if (!results.privacyPolicyLink.found) results.issues.push('Privacy Policy link not found in compliance message');
    if (!results.cookiePrefLink.found) results.issues.push('Cookie Preference Policy link not found in compliance message');

    return results;
  });

  const emailSignupShot = screenshotPath(store.newStore, 'page-content-migration', '22_email_signup_compliance');
  await page.screenshot({ path: emailSignupShot, fullPage: false });
  emit({ screenshot: screenshotUrl(emailSignupShot), label: 'Email signup compliance' });

  if (emailSignupCheck.issues.length === 0) {
    record('Email Signup Compliance', true,
      `Compliance message found with correct links: Terms of Use → follett.com (new tab), Privacy Policy → follett.com (new tab), Cookie Preference → OneTrust modal`);
  } else {
    record('Email Signup Compliance', false, emailSignupCheck.issues.join('; '));
  }

  // ── Summary ──
  const TOTAL_CHECKS = checks.length;
  const passedCount = checks.filter(c => c.passed).length;
  const failedCount = checks.filter(c => !c.passed).length;
  const failedNames = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`);
  const allPassed = failedCount === 0;

  emit({ step: `\n═══ SUMMARY: ${passedCount}/${TOTAL_CHECKS} passed, ${failedCount}/${TOTAL_CHECKS} failed ═══` });
  if (!allPassed) {
    emit({ step: `Failed checks:\n${failedNames.map(f => `  • ${f}`).join('\n')}` });
  }

  return {
    passed: allPassed,
    message: allPassed
      ? `All ${TOTAL_CHECKS} content migration checks passed (${country} store).`
      : `${failedCount}/${TOTAL_CHECKS} checks failed: ${failedNames.join('; ')}`,
    checks,
  };
}

async function testHomepagePlpPdp(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];
  let checkNum = 0;

  function record(name, passed, detail) {
    checkNum++;
    const status = passed ? '✅' : '❌';
    emit({ step: `[${checkNum}] ${status} ${name}: ${detail}` });
    checks.push({ num: checkNum, name, passed, detail });
  }

  // ── Check 1: Homepage banner links to internal URL ──
  emit({ step: 'Check 1: Verifying homepage banner links...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait longer for banners, hero images, and ad scripts to fully load
  await page.waitForTimeout(5000);

  const bannerShot = screenshotPath(store.newStore, 'homepage-plp-pdp', '01_homepage');
  await page.screenshot({ path: bannerShot, fullPage: false });
  emit({ screenshot: screenshotUrl(bannerShot), label: 'Homepage' });

  const bannerAnalysis = await page.evaluate((storeOrigin) => {
    // Look for banner/hero links — typically large clickable areas at top of page
    const bannerSelectors = [
      '.hero a', '.banner a', '.slideshow a', '[class*="hero"] a', '[class*="banner"] a',
      '[class*="slide"] a', '.carousel a', '[class*="carousel"] a',
      '[class*="image-banner"] a', '[class*="image_banner"] a',
      '.shopify-section a[href] img', // sections with linked images
      'section:first-of-type a[href]', '.shopify-section:first-of-type a[href]',
      '.shopify-section:nth-of-type(2) a[href]', '.shopify-section:nth-of-type(3) a[href]',
      'a[href*="/collections/"]', 'a[href*="/products/"]', 'a[href*="/pages/"]',
    ];

    const results = { bannerLinks: [], hasInternalBanner: false, hasExternalBanner: false };

    for (const sel of bannerSelectors) {
      const elements = document.querySelectorAll(sel);
      for (let el of elements) {
        // If we matched an img inside an <a>, walk up to the <a>
        const a = el.tagName === 'A' ? el : el.closest('a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const rect = a.getBoundingClientRect();
        // Only consider links that are in the visible hero area (top 800px, reasonably wide)
        if (rect.top < 800 && rect.width > 100 && rect.height > 30) {
          const isInternal = href.startsWith('/') || href.includes(storeOrigin) ||
            href.includes('/collections/') || href.includes('/products/') || href.includes('/pages/');
          const isExternal = href.startsWith('http') && !href.includes(storeOrigin) && !href.startsWith('/');

          if (!results.bannerLinks.some(b => b.href === href)) {
            results.bannerLinks.push({ href, isInternal: isInternal && !isExternal, text: a.textContent.trim().substring(0, 50) });
          }
          if (isInternal && !isExternal) results.hasInternalBanner = true;
          if (isExternal) results.hasExternalBanner = true;
        }
      }
      if (results.bannerLinks.length > 0) break; // Found banner links
    }

    return results;
  }, origin);

  if (bannerAnalysis.bannerLinks.length === 0) {
    record('Homepage Banner Links', false, 'No banner links found in hero/banner area');
  } else if (bannerAnalysis.hasInternalBanner) {
    const internalLinks = bannerAnalysis.bannerLinks.filter(l => l.isInternal).map(l => l.href).join(', ');
    record('Homepage Banner Links', true, `Banner links to internal URLs: ${internalLinks}`);
  } else {
    const externalLinks = bannerAnalysis.bannerLinks.map(l => l.href).join(', ');
    record('Homepage Banner Links', false, `Banner links are external (not internal store URLs): ${externalLinks}`);
  }

  // ── Check 2: Freestar ad on homepage ──
  emit({ step: 'Check 2: Checking for ads on homepage...' });
  // Extra wait for ad scripts (Freestar/GPT load asynchronously)
  await page.waitForTimeout(3000);

  const homepageAdCheck = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hasFreestar = /freestar|pubfig|googletag|gpt\.js|adsbygoogle|google_ad/i.test(html);
    const adElements = document.querySelectorAll(
      '[id*="freestar"], [class*="freestar"], [id*="ad-"], [class*="ad-slot"], ' +
      '[id*="google_ads"], [data-freestar], iframe[src*="freestar"], iframe[src*="googlesyndication"], ' +
      '[id*="div-gpt-ad"], [class*="pubfig"], [data-ad], .ad-container, [id*="advertisement"]'
    );
    return {
      hasFreestar,
      adElementCount: adElements.length,
      adIds: Array.from(adElements).slice(0, 5).map(el => el.id || el.className).filter(Boolean),
    };
  });

  if (homepageAdCheck.hasFreestar || homepageAdCheck.adElementCount > 0) {
    record('Homepage Ad (Freestar)', true,
      `Ad infrastructure found. Elements: ${homepageAdCheck.adElementCount}, IDs: ${homepageAdCheck.adIds.join(', ') || 'script-only'}`);
  } else {
    record('Homepage Ad (Freestar)', false, 'No Freestar/ad elements or scripts found on homepage');
  }

  // ── Navigate to a collection page for checks 3-4 ──
  emit({ step: 'Finding a collection page...' });

  // Find a collection link from navigation — single CDP call.
  let collectionUrl = null;
  const firstCollHref2 = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="/collections/"]')) {
      const href = a.getAttribute('href') || '';
      if (/\/collections\/[^/?]+/.test(href)) return href;
    }
    return null;
  });
  if (firstCollHref2) {
    collectionUrl = firstCollHref2.startsWith('http') ? firstCollHref2 : `${origin}${firstCollHref2.split('?')[0]}`;
  }
  if (!collectionUrl) collectionUrl = `${origin}/collections/all`;

  emit({ step: `Navigating to collection: ${collectionUrl}` });
  await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // If redirected away from collections, try fallback
  if (!page.url().includes('/collections')) {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const allColLinks = await page.$$eval('a[href*="/collections/"]', els =>
      els.map(a => a.getAttribute('href')).filter(h => h && h.match(/\/collections\/[^/?]+/))
    );
    if (allColLinks.length > 0) {
      const fallback = allColLinks[0].startsWith('http') ? allColLinks[0] : `${origin}${allColLinks[0].split('?')[0]}`;
      await page.goto(fallback, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }
  }

  const collectionShot = screenshotPath(store.newStore, 'homepage-plp-pdp', '02_collection');
  await page.screenshot({ path: collectionShot, fullPage: false });
  emit({ screenshot: screenshotUrl(collectionShot), label: 'Collection page' });

  // ── Check 3: Freestar ad on collection page ──
  emit({ step: 'Check 3: Checking for ads on collection page...' });

  const collectionAdCheck = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hasFreestar = /freestar|pubfig|googletag|gpt\.js|adsbygoogle|google_ad/i.test(html);
    const adElements = document.querySelectorAll(
      '[id*="freestar"], [class*="freestar"], [id*="ad-"], [class*="ad-slot"], ' +
      '[id*="google_ads"], [data-freestar], iframe[src*="freestar"], iframe[src*="googlesyndication"], ' +
      '[id*="div-gpt-ad"], [class*="pubfig"], [data-ad], .ad-container, [id*="advertisement"]'
    );
    return {
      hasFreestar,
      adElementCount: adElements.length,
      adIds: Array.from(adElements).slice(0, 5).map(el => el.id || el.className).filter(Boolean),
    };
  });

  if (collectionAdCheck.hasFreestar || collectionAdCheck.adElementCount > 0) {
    record('Collection Ad (Freestar)', true,
      `Ad infrastructure found. Elements: ${collectionAdCheck.adElementCount}, IDs: ${collectionAdCheck.adIds.join(', ') || 'script-only'}`);
  } else {
    record('Collection Ad (Freestar)', false, 'No Freestar/ad elements or scripts found on collection page');
  }

  // ── Check 4: Filters on left panel of collection page ──
  emit({ step: 'Check 4: Checking for filters on collection page...' });

  const filterCheck = await page.evaluate(() => {
    // Look for filter/facet elements
    const filterSelectors = [
      '[class*="filter"]', '[class*="facet"]', '[id*="filter"]', '[id*="facet"]',
      'aside [class*="filter"]', '.sidebar', '[data-filter]',
      'form[class*="filter"]', 'details summary', '[class*="refine"]',
    ];

    let filterElements = [];
    for (const sel of filterSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent.trim().substring(0, 100);
        const visible = el.offsetParent !== null && el.offsetWidth > 0;
        if (visible && text.length > 2) {
          filterElements.push({ text, tag: el.tagName, class: el.className.substring(0, 80) });
        }
      }
      if (filterElements.length > 3) break;
    }

    // Also check for common filter labels
    const bodyText = document.body.innerText;
    const hasFilterLabels = /price|size|color|brand|availability|in stock|sort by|filter/i.test(bodyText);

    return {
      filterCount: filterElements.length,
      filters: filterElements.slice(0, 10),
      hasFilterLabels,
    };
  });

  const filterShot = screenshotPath(store.newStore, 'homepage-plp-pdp', '03_filters');
  // Scroll to show filters if possible
  try {
    const filterEl = await page.$('[class*="filter"], [class*="facet"], aside, .sidebar');
    if (filterEl) {
      await filterEl.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(500);
    }
  } catch {}
  await page.screenshot({ path: filterShot, fullPage: false });
  emit({ screenshot: screenshotUrl(filterShot), label: 'Collection filters' });

  if (filterCheck.filterCount > 0 || filterCheck.hasFilterLabels) {
    record('Collection Filters', true,
      `Filters found: ${filterCheck.filterCount} filter elements. Labels present: ${filterCheck.hasFilterLabels}`);
  } else {
    record('Collection Filters', false, 'No filter/facet elements found on collection page');
  }

  // ── Check 5: Navigation does NOT have 'Gift Cards' ──
  emit({ step: 'Check 5: Checking navigation for Gift Cards...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const giftCardCheck = await page.evaluate(() => {
    // Check main nav / header for "Gift Cards" text
    const nav = document.querySelector('header, nav, [role="navigation"]');
    if (!nav) return { found: false, navText: '' };

    const navText = nav.innerText || '';
    const links = nav.querySelectorAll('a');
    let giftCardLink = null;

    for (const a of links) {
      const text = (a.textContent || '').trim();
      if (/gift\s*cards?/i.test(text)) {
        // Check visibility
        if (a.offsetParent !== null && a.offsetWidth > 0) {
          giftCardLink = { text, href: a.getAttribute('href') || '' };
          break;
        }
      }
    }

    return {
      found: !!giftCardLink,
      giftCardLink,
      navText: navText.substring(0, 200),
    };
  });

  const navShot = screenshotPath(store.newStore, 'homepage-plp-pdp', '04_navigation');
  await page.screenshot({ path: navShot, fullPage: false });
  emit({ screenshot: screenshotUrl(navShot), label: 'Navigation' });

  if (giftCardCheck.found) {
    record('No Gift Cards in Nav', false,
      `"Gift Cards" found in navigation: "${giftCardCheck.giftCardLink.text}" → ${giftCardCheck.giftCardLink.href}`);
  } else {
    record('No Gift Cards in Nav', true, 'Gift Cards NOT found in navigation — correct');
  }

  // ── Check 6: Color swatches show names, not just bubbles ──
  emit({ step: 'Check 6: Checking product color swatches...' });

  // Search for products with multiple colors
  const searchUrl = `${origin}/search?q=${encodeURIComponent('shirt jersey')}`;
  emit({ step: `Searching for products with colors: ${searchUrl}` });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  let swatchResult = null;

  // Try up to 5 products
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    const visibleLinks = await page.evaluate(() => {
      const seen = new Set();
      const result = [];
      for (const a of document.querySelectorAll('a[href*="/products/"]')) {
        if (a.offsetParent === null || a.offsetWidth === 0) continue;
        const href = a.getAttribute('href');
        if (!href) continue;
        const clean = href.split('?')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        result.push(href);
      }
      return result;
    }).catch(() => []);

    if (attempt >= visibleLinks.length) {
      emit({ step: `Only ${visibleLinks.length} products available` });
      break;
    }

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Checking: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Check for color options on this product
    const colorAnalysis = await page.evaluate(() => {
      const body = document.body.innerText;
      const html = document.documentElement.innerHTML;

      // Look for color-related elements
      const colorLabels = [];
      const swatchBubbles = [];

      // Find elements with color names
      const allElements = document.querySelectorAll(
        '[class*="color"], [class*="swatch"], [class*="option"], [data-option-name*="color" i], ' +
        'label[for*="color" i], fieldset, [class*="variant"]'
      );

      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        const visible = el.offsetParent !== null && el.offsetWidth > 0;
        if (!visible) continue;

        // Check if it has color name text (not just a colored circle)
        const hasColorName = /\b(red|blue|green|black|white|navy|grey|gray|maroon|purple|pink|orange|yellow|heather|royal|charcoal|crimson|cardinal|scarlet|gold|silver|teal|forest|burgundy|brown|khaki|cream|ivory|coral|slate)\b/i.test(text);
        if (hasColorName && text.length < 200) {
          colorLabels.push(text.substring(0, 80));
        }

        // Check for swatch bubbles (small colored circles without text labels)
        if (el.matches('[class*="swatch"]') && el.offsetWidth < 50 && el.offsetHeight < 50) {
          const bg = window.getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)') {
            swatchBubbles.push({ bg, text: text.substring(0, 30) });
          }
        }
      }

      return {
        hasColorOptions: colorLabels.length > 0 || swatchBubbles.length > 0,
        colorLabels,
        swatchBubbles,
        hasColorNames: colorLabels.length > 0,
        multipleColors: colorLabels.length > 1 || swatchBubbles.length > 1,
      };
    });

    if (colorAnalysis.hasColorOptions && colorAnalysis.multipleColors) {
      const pdpShot = screenshotPath(store.newStore, 'homepage-plp-pdp', `05_swatch_product_${attempt + 1}`);
      await page.screenshot({ path: pdpShot, fullPage: false });
      emit({ screenshot: screenshotUrl(pdpShot), label: `Product with colors (#${attempt + 1})` });

      swatchResult = colorAnalysis;
      break;
    }

    emit({ step: `[Product ${attempt + 1}] No multiple color options — trying next...` });
  }

  if (!swatchResult) {
    record('Color Swatches (Names)', false, 'Could not find a product with multiple color options across 5 products');
  } else if (swatchResult.hasColorNames) {
    record('Color Swatches (Names)', true,
      `Color names found: ${swatchResult.colorLabels.join(', ')}. Swatch bubbles: ${swatchResult.swatchBubbles.length}`);
  } else {
    record('Color Swatches (Names)', false,
      `Only swatch bubbles found (${swatchResult.swatchBubbles.length}) without color name labels. Colors should display names (Red, Blue, etc.) not just circles.`);
  }

  // ── Summary ──
  const TOTAL_CHECKS = checks.length;
  const passedCount = checks.filter(c => c.passed).length;
  const failedCount = checks.filter(c => !c.passed).length;
  const failedNames = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`);
  const allPassed = failedCount === 0;

  emit({ step: `\n═══ SUMMARY: ${passedCount}/${TOTAL_CHECKS} passed, ${failedCount}/${TOTAL_CHECKS} failed ═══` });
  if (!allPassed) {
    emit({ step: `Failed checks:\n${failedNames.map(f => `  • ${f}`).join('\n')}` });
  }

  return {
    passed: allPassed,
    message: allPassed
      ? `All ${TOTAL_CHECKS} Homepage/PLP/PDP checks passed.`
      : `${failedCount}/${TOTAL_CHECKS} checks failed: ${failedNames.join('; ')}`,
    checks,
  };
}

async function testCourseMaterials(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  // Step 1: Go to homepage
  emit({ step: 'Navigating to homepage...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Step 2: Find "Textbooks" link in header nav and verify it exists
  emit({ step: 'Checking for Textbooks link in header...' });
  const textbooksLink = await page.$('header a:has-text("Textbooks"), nav a:has-text("Textbooks"), a[href*="courses-materials"]');
  const hasTextbooksNav = textbooksLink ? await textbooksLink.isVisible().catch(() => false) : false;

  if (hasTextbooksNav) {
    emit({ step: 'Textbooks link found in header navigation ✓' });
  } else {
    emit({ step: 'Textbooks link not directly visible in header (may be in dropdown)' });
  }

  // Navigate directly to course materials page (more reliable than clicking through nav dropdowns)
  emit({ step: 'Navigating to Course Materials page...' });
  await page.goto(`${origin}/pages/courses-materials-results`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  const cmPageShot = screenshotPath(store.newStore, 'course-materials', '02_course_materials_page');
  await page.screenshot({ path: cmPageShot, fullPage: false });
  emit({ screenshot: screenshotUrl(cmPageShot), label: 'Course Materials page' });

  // Verify we're on the course materials page
  const currentUrl = page.url();
  const bodyText = await page.textContent('body').catch(() => '');
  if (!bodyText.toUpperCase().includes('COURSE') && !currentUrl.includes('course')) {
    return { passed: false, message: `Course Materials page did not load. URL: ${currentUrl}` };
  }

  emit({ step: 'Course Materials page loaded successfully' });

  // Hide Shopify preview bar globally so it doesn't obscure elements
  await page.evaluate(() => {
    document.querySelectorAll('[id*="preview-bar"], [class*="preview-bar"], #admin-bar-iframe').forEach(el => {
      el.style.display = 'none';
    });
    document.querySelectorAll('iframe').forEach(iframe => {
      if (iframe.src && iframe.src.includes('preview_bar')) {
        iframe.style.display = 'none';
      }
    });
  });

  // Step 3: Select Campus (if present) then Term
  // Some stores have Campus + Term layout, others have Term only.
  emit({ step: 'Waiting for dropdowns to load...' });
  await page.waitForTimeout(3000);

  // Check for Campus dropdown (variant 1: Campus + Term)
  const hasCampus = await page.evaluate(() => {
    const selects = document.querySelectorAll('select');
    return Array.from(selects).some(s =>
      (s.id === 'campus' || s.id === 'division' || (s.name || '').toLowerCase().includes('campus') || (s.name || '').toLowerCase().includes('division'))
      && !s.className.includes('mobile')
    );
  });

  if (hasCampus) {
    emit({ step: 'Campus dropdown detected — selecting campus first...' });
    const campusSelected = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      const campusSelect = Array.from(selects).find(s =>
        (s.id === 'campus' || s.id === 'division' || (s.name || '').toLowerCase().includes('campus') || (s.name || '').toLowerCase().includes('division'))
        && !s.className.includes('mobile')
      );
      if (!campusSelect) return null;
      // Pick first non-placeholder option
      const opts = Array.from(campusSelect.options).filter(o =>
        o.value !== '' && o.value.toLowerCase() !== 'campus' && o.value.toLowerCase() !== 'division'
        && o.text.toLowerCase() !== 'campus' && o.text.toLowerCase() !== 'division'
      );
      if (opts.length === 0) return null;
      campusSelect.value = opts[0].value;
      campusSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return opts[0].text;
    });

    if (campusSelected) {
      emit({ step: `Selected campus: ${campusSelected}` });
      // Wait for Term dropdown to populate after campus selection
      await page.waitForTimeout(3000);
    } else {
      emit({ step: 'Campus dropdown found but no selectable options' });
    }
  } else {
    emit({ step: 'No Campus dropdown — Term-only layout' });
  }

  emit({ step: 'Selecting Term...' });

  // Wait for term options to load (may take extra time after campus selection)
  let termSelected = null;
  for (let termWait = 0; termWait < 3 && !termSelected; termWait++) {
    termSelected = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      const termSelect = Array.from(selects).find(s =>
        (s.id === 'term' || (s.name || '').toLowerCase().includes('term'))
        && s.options.length > 1 && !s.className.includes('mobile')
      );
      if (!termSelect || termSelect.options.length < 2) return null;
      // Pick first non-placeholder option
      const opts = Array.from(termSelect.options).filter(o =>
        o.value !== '' && o.value.toLowerCase() !== 'term' && o.text.toLowerCase() !== 'term'
      );
      if (opts.length === 0) return null;
      termSelect.value = opts[0].value;
      termSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return opts[0].text;
    });
    if (!termSelected) {
      emit({ step: `Term options not yet loaded, waiting... (attempt ${termWait + 1}/3)` });
      await page.waitForTimeout(2000);
    }
  }

  if (!termSelected) {
    const shot = screenshotPath(store.newStore, 'course-materials', '02b_no_term');
    await page.screenshot({ path: shot, fullPage: false });
    emit({ screenshot: screenshotUrl(shot), label: 'No Term options available' });
    return { passed: false, message: `Could not select a Term — no options available${hasCampus ? ' (Campus+Term layout)' : ' (Term-only layout)'}` };
  }

  emit({ step: `Selected term: ${termSelected}` });
  await page.waitForTimeout(2000);

  // Track successful course additions and cart adds
  let coursesAdded = 0;
  let textbooksFound = 0;
  let cartAdds = 0;
  const courseResults = [];

  // Step 4-6: Repeat up to 5 times with different departments
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    emit({ step: `\n── Attempt ${attempt + 1}/${MAX_ATTEMPTS} ──` });

    // Wait for departments to be available
    await page.waitForTimeout(2000);

    // Get available departments (some stores use #department, others may
    // have a "Division" select that gates the department list)
    const departments = await page.evaluate(() => {
      // Try #department first, fall back to any select whose id/name contains 'department' or 'dept'
      let dept = document.querySelector('select#department');
      if (!dept) {
        const selects = Array.from(document.querySelectorAll('select'));
        dept = selects.find(s =>
          (s.id || '').toLowerCase().includes('department') ||
          (s.name || '').toLowerCase().includes('department') ||
          (s.id || '').toLowerCase().includes('dept')
        );
      }
      if (!dept) return [];
      return Array.from(dept.options)
        .filter(o => o.value !== '' && o.value.toLowerCase() !== 'department'
          && o.text.toLowerCase() !== 'department'
          && o.value.toLowerCase() !== 'n/a' && o.text.trim().toLowerCase() !== 'n/a')
        .map(o => ({ text: o.text, value: o.value }));
    });

    if (departments.length === 0) {
      emit({ step: `[Attempt ${attempt + 1}] No departments available (or only N/A)` });
      continue;
    }

    // Pick a random department (different each time)
    const deptIndex = Math.floor(Math.random() * departments.length);
    const dept = departments[deptIndex];
    emit({ step: `[Attempt ${attempt + 1}] Selecting department: ${dept.text}` });

    await page.evaluate((deptValue) => {
      const deptSelect = document.querySelector('select#department');
      deptSelect.value = deptValue;
      deptSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }, dept.value);

    await page.waitForTimeout(2000);

    // Get available courses
    const courses = await page.evaluate(() => {
      const course = document.querySelector('select#course');
      if (!course) return [];
      return Array.from(course.options)
        .filter(o => o.value !== '' && o.value !== 'Course')
        .map(o => ({ text: o.text, value: o.value }));
    });

    if (courses.length === 0) {
      emit({ step: `[Attempt ${attempt + 1}] No courses for ${dept.text} — trying next department` });
      continue;
    }

    // Pick a random course
    const courseIndex = Math.floor(Math.random() * courses.length);
    const course = courses[courseIndex];
    emit({ step: `[Attempt ${attempt + 1}] Selecting course: ${course.text}` });

    await page.evaluate((courseValue) => {
      const courseSelect = document.querySelector('select#course');
      courseSelect.value = courseValue;
      courseSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }, course.value);

    await page.waitForTimeout(2000);

    // Get available sections
    const sections = await page.evaluate(() => {
      const section = document.querySelector('select#section');
      if (!section) return [];
      return Array.from(section.options)
        .filter(o => o.value !== '' && o.value !== 'Section')
        .map(o => ({ text: o.text, value: o.value }));
    });

    if (sections.length === 0) {
      emit({ step: `[Attempt ${attempt + 1}] No sections for ${dept.text} ${course.text} — trying next` });
      continue;
    }

    // Pick a random section
    const sectionIndex = Math.floor(Math.random() * sections.length);
    const section = sections[sectionIndex];
    emit({ step: `[Attempt ${attempt + 1}] Selecting section: ${section.text}` });

    await page.evaluate((sectionValue) => {
      const sectionSelect = document.querySelector('select#section');
      sectionSelect.value = sectionValue;
      sectionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }, section.value);

    await page.waitForTimeout(1000);

    // Click ADD COURSE
    emit({ step: `[Attempt ${attempt + 1}] Clicking ADD COURSE...` });
    const addCourseClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toUpperCase();
        if (text.includes('ADD COURSE') && btn.offsetParent !== null && btn.offsetWidth > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (addCourseClicked) {
      await page.waitForTimeout(5000);
      coursesAdded++;

      const courseShot = screenshotPath(store.newStore, 'course-materials', `03_course_${attempt + 1}`);
      await page.screenshot({ path: courseShot, fullPage: false });
      emit({ screenshot: screenshotUrl(courseShot), label: `Course added: ${dept.text} ${course.text} §${section.text}` });

      // Check if results appeared on the right side
      const resultsCheck = await page.evaluate(({ deptName, courseName }) => {
        const body = document.body.innerText;
        const hasResults = body.includes(deptName + ' ' + courseName);

        // Look for textbook indicators: REQUIRED badge, ISBN, "Choose a format", prices, book images
        const hasPrices = /\$\d+\.\d{2}/.test(body);
        const hasRequired = /REQUIRED/i.test(body) && /ISBN|edition|instructor/i.test(body);
        const hasChooseFormat = /choose a format/i.test(body);
        const hasTextbookContent = hasPrices || hasRequired || hasChooseFormat;

        // Check for "no materials" type messages
        const noMaterials = /no\s*(required\s*)?materials|open educational resources|no textbooks/i.test(body) && !hasTextbookContent;

        return {
          hasResults,
          hasTextbookContent,
          hasPrices,
          hasRequired,
          hasChooseFormat,
          noMaterials,
        };
      }, { deptName: dept.text, courseName: course.text });

      const courseInfo = `${dept.text} ${course.text} §${section.text}`;

      if (resultsCheck.hasTextbookContent) {
        textbooksFound++;
        emit({ step: `[Attempt ${attempt + 1}] ✅ Textbooks found! (prices: ${resultsCheck.hasPrices}, required: ${resultsCheck.hasRequired}, choose format: ${resultsCheck.hasChooseFormat}). Adding to cart...` });

        let addedToCart = false;

        // Hide Shopify preview bar so it doesn't obscure buttons
        await page.evaluate(() => {
          const iframe = document.getElementById('preview-bar-iframe');
          if (iframe) iframe.style.display = 'none';
          const bar = document.getElementById('preview-bar');
          if (bar) bar.style.display = 'none';
          // Also hide any element with shopify-preview class or similar
          document.querySelectorAll('[id*="preview-bar"], [class*="preview-bar"], #admin-bar-iframe, [id*="shopify-section-header-bar"]').forEach(el => {
            el.style.display = 'none';
          });
          // Remove any fixed-position top bar that might be the preview bar
          document.querySelectorAll('iframe').forEach(iframe => {
            if (iframe.src && iframe.src.includes('preview_bar')) {
              iframe.style.display = 'none';
            }
          });
        });

        // Step A: Click a format tab (Print or Digital) if present
        // Use evaluate to find and click visible format tabs safely
        const formatClicked = await page.evaluate(() => {
          const tabs = document.querySelectorAll('[role="tab"], button[type="button"]');
          for (const tab of tabs) {
            const text = (tab.textContent || '').trim();
            if (/^(Print|Digital)/i.test(text) && tab.offsetParent !== null && tab.offsetWidth > 0) {
              tab.click();
              return text;
            }
          }
          return null;
        });

        if (formatClicked) {
          emit({ step: `[Attempt ${attempt + 1}] Clicked format tab: ${formatClicked}` });
          await page.waitForTimeout(2000);
        }

        // Step B: Click a buy option (BUY NEW, BUY USED, BUY, RENT NEW, RENT USED)
        const buyClicked = await page.evaluate(() => {
          const els = document.querySelectorAll('label, input[type="checkbox"], input[type="radio"], button, span, div[role="button"]');
          for (const el of els) {
            const text = (el.textContent || '').toUpperCase().trim();
            if ((/^(BUY|RENT)(\s|$)/.test(text) || text.includes('BUY NEW') || text.includes('BUY USED') || text.includes('RENT NEW') || text.includes('RENT USED'))
                && el.offsetParent !== null && el.offsetWidth > 0) {
              el.click();
              return text.substring(0, 30);
            }
          }
          return null;
        });

        if (buyClicked) {
          emit({ step: `[Attempt ${attempt + 1}] Selected: ${buyClicked}` });
          await page.waitForTimeout(2000);
        }

        // Step C: Click Add to Bag
        // First, get the cart count before adding
        let cartBefore = 0;
        try {
          const beforeData = await page.evaluate(async () => {
            const res = await fetch('/cart.json');
            return await res.json();
          });
          cartBefore = beforeData ? beforeData.item_count : 0;
        } catch {}

        // Find the Add to Bag button and click it using Playwright (needed for Shopify event handlers)
        const addBagBtn = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toUpperCase();
            if ((text.includes('ADD TO BAG') || text.includes('ADD TO CART'))
                && !text.includes('ADD COURSE')
                && btn.offsetParent !== null && btn.offsetWidth > 0 && !btn.disabled) {
              // Scroll button into view and return a selector we can use
              btn.scrollIntoView({ block: 'center' });
              // Add a temp attribute so we can find it with Playwright
              btn.setAttribute('data-qa-add-bag', 'true');
              return text.substring(0, 30);
            }
          }
          return null;
        });

        let addClicked = null;
        if (addBagBtn) {
          try {
            // Use Playwright's click which properly triggers Shopify's event handlers
            await page.click('[data-qa-add-bag="true"]', { timeout: 5000 });
            addClicked = addBagBtn;
          } catch {
            // Fallback: use evaluate click
            addClicked = await page.evaluate(() => {
              const btn = document.querySelector('[data-qa-add-bag="true"]');
              if (btn) { btn.click(); return btn.textContent.trim().substring(0, 30); }
              return null;
            });
          }
          // Clean up temp attribute
          await page.evaluate(() => {
            const btn = document.querySelector('[data-qa-add-bag="true"]');
            if (btn) btn.removeAttribute('data-qa-add-bag');
          });
        }

        if (addClicked) {
          emit({ step: `[Attempt ${attempt + 1}] Clicked: ${addClicked}` });
          await page.waitForTimeout(3000);

          // Verify the cart actually increased
          let cartAfter = cartBefore;
          try {
            const afterData = await page.evaluate(async () => {
              const res = await fetch('/cart.json');
              return await res.json();
            });
            cartAfter = afterData ? afterData.item_count : 0;
          } catch {}

          if (cartAfter > cartBefore) {
            addedToCart = true;
            cartAdds++;
            emit({ step: `[Attempt ${attempt + 1}] ✅ Item added to cart (${cartBefore} → ${cartAfter})` });
          } else {
            emit({ step: `[Attempt ${attempt + 1}] ⚠️ Clicked Add to Bag but cart count didn't increase (${cartBefore} → ${cartAfter})` });
          }

          const cartShot = screenshotPath(store.newStore, 'course-materials', `04_cart_add_${attempt + 1}`);
          await page.screenshot({ path: cartShot, fullPage: false });
          emit({ screenshot: screenshotUrl(cartShot), label: `Cart add: ${courseInfo}` });

          // Close the cart drawer if it opened (it blocks subsequent clicks)
          await page.evaluate(() => {
            // Close any open dialog/drawer
            const dialogs = document.querySelectorAll('dialog[open], .cart-drawer__dialog, [class*="cart-drawer"]');
            dialogs.forEach(d => {
              if (d.close) d.close();
              d.removeAttribute('open');
              d.style.display = 'none';
            });
            // Click any close/continue shopping buttons
            const closeBtns = document.querySelectorAll('[aria-label="Close"], .cart-drawer__close, button[class*="close"]');
            closeBtns.forEach(btn => btn.click());
            // Remove scroll lock
            document.body.classList.remove('scroll-lock');
            document.body.style.overflow = '';
          });
          await page.waitForTimeout(1000);
        } else {
          emit({ step: `[Attempt ${attempt + 1}] Add to Bag not found or disabled after selecting options` });
        }

        courseResults.push({ course: courseInfo, hasTextbooks: true, addedToCart });
      } else if (resultsCheck.noMaterials) {
        emit({ step: `[Attempt ${attempt + 1}] No required materials for this course (OER or no materials)` });
        courseResults.push({ course: courseInfo, hasTextbooks: false, addedToCart: false, reason: 'No materials required' });
      } else {
        emit({ step: `[Attempt ${attempt + 1}] Course added but no textbooks with prices found` });
        courseResults.push({ course: courseInfo, hasTextbooks: false, addedToCart: false, reason: 'No priced textbooks' });
      }
    } else {
      emit({ step: `[Attempt ${attempt + 1}] ADD COURSE button not found` });
    }
  }

  // Summary
  const summaryShot = screenshotPath(store.newStore, 'course-materials', '05_summary');
  await page.screenshot({ path: summaryShot, fullPage: false });
  emit({ screenshot: screenshotUrl(summaryShot), label: 'Final state' });

  emit({ step: `\n═══ SUMMARY ═══` });
  emit({ step: `Courses added: ${coursesAdded}/${MAX_ATTEMPTS}` });
  emit({ step: `Courses with textbooks: ${textbooksFound}` });
  emit({ step: `Items added to cart: ${cartAdds}` });

  for (const r of courseResults) {
    emit({ step: `  • ${r.course}: ${r.hasTextbooks ? 'Has textbooks' : r.reason || 'No textbooks'}${r.addedToCart ? ' — added to cart ✅' : ''}` });
  }

  // Pass if we successfully added at least 1 course and the page worked
  if (coursesAdded === 0) {
    return { passed: false, message: 'Could not add any courses — dropdowns may not be working' };
  }

  return {
    passed: true,
    message: `Course Materials flow works. Added ${coursesAdded} courses, found textbooks in ${textbooksFound}, added ${cartAdds} to cart.`,
  };
}

// ─── CSV-driven bug-pattern tests ───────────────────────────────────
// These tests are derived from the Follett QA team's most frequently
// reported bug patterns (April 2026 CSV) and designed to run across
// any Shopify preview store without per-store configuration.

// Helper: extract all collection hrefs from the Shop By / main nav
async function discoverNavCollections(page, origin) {
  return page.$$eval('nav a[href*="/collections/"], [class*="menu"] a[href*="/collections/"], header a[href*="/collections/"]', (links, orig) => {
    const seen = new Set();
    const results = [];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href) continue;
      // Normalise to pathname
      let pathname;
      try { pathname = new URL(href, orig).pathname; } catch { continue; }
      if (seen.has(pathname)) continue;
      seen.add(pathname);
      const label = (a.textContent || '').trim().substring(0, 60);
      results.push({ pathname, label });
    }
    return results;
  }, origin);
}

// ── 1. Empty Collections Scan ───────────────────────────────────────
// Discovers collection links from the nav and flags any that return
// zero products.  Catches CSV rows: #6, 8, 29, 30, 32, 39, 40
async function testEmptyCollections(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  emit({ step: 'Discovering collection links from navigation...' });

  // Make sure we're on the homepage first
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const collections = await discoverNavCollections(page, origin);
  emit({ step: `Found ${collections.length} unique collection links in nav` });

  if (collections.length === 0) {
    return { passed: true, message: 'No collection links found in nav — nothing to scan' };
  }

  // Cap at 40 to keep runtime reasonable
  const toCheck = collections.slice(0, 40);
  const emptyOnes = [];
  let checked = 0;

  for (const col of toCheck) {
    checked++;
    const url = `${origin}${col.pathname}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);

      // Count product cards
      const productCount = await page.$$eval(
        '[class*="product"], .product-card, .grid__item, [data-product-id], a[href*="/products/"]',
        els => {
          const seen = new Set();
          return els.filter(el => {
            const href = el.getAttribute('href') || el.dataset.productId || el.className;
            if (seen.has(href)) return false;
            seen.add(href);
            return true;
          }).length;
        }
      );

      // Also check for "No products found" text
      const bodyText = await page.textContent('body').catch(() => '');
      const hasNoProducts = /no products found/i.test(bodyText);

      if (productCount === 0 || hasNoProducts) {
        emptyOnes.push({ label: col.label, pathname: col.pathname });
        emit({ step: `❌ EMPTY: "${col.label}" → ${col.pathname}` });

        // Screenshot first 3 empty ones
        if (emptyOnes.length <= 3) {
          const shot = screenshotPath(store.newStore, 'empty-collections', `empty_${emptyOnes.length}`);
          await page.screenshot({ path: shot, fullPage: false });
          emit({ screenshot: screenshotUrl(shot), label: `Empty: ${col.label}` });
        }
      }
    } catch (err) {
      emit({ step: `⚠ Error loading ${col.pathname}: ${err.message}` });
    }
  }

  if (emptyOnes.length > 0) {
    const list = emptyOnes.map(e => `"${e.label}" (${e.pathname})`).join(', ');
    return {
      passed: false,
      message: `${emptyOnes.length} of ${checked} collections are empty: ${list}`,
    };
  }

  return { passed: true, message: `All ${checked} nav collections have products` };
}

// ── 3. Sale & Clearance Purity ──────────────────────────────────────
// Visits Sale & Clearance collections and checks that items actually
// show sale indicators.  Catches CSV: #10, 13, 42, 54, 56
async function testSaleClearancePurity(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  emit({ step: 'Looking for Sale & Clearance collections...' });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Find sale/clearance collection links from nav
  const saleLinks = await page.$$eval(
    'a[href*="/collections/"]',
    (links, orig) => {
      const results = [];
      const seen = new Set();
      for (const a of links) {
        const text = (a.textContent || '').trim().toLowerCase();
        const href = a.getAttribute('href') || '';
        if (!text.includes('sale') && !text.includes('clearance') && !href.includes('sale') && !href.includes('clearance')) continue;
        let pathname;
        try { pathname = new URL(href, orig).pathname; } catch { continue; }
        if (seen.has(pathname)) continue;
        seen.add(pathname);
        results.push({ pathname, label: (a.textContent || '').trim().substring(0, 60) });
      }
      return results;
    },
    origin
  );

  if (saleLinks.length === 0) {
    return { passed: true, message: 'No Sale & Clearance collections found in nav' };
  }

  emit({ step: `Found ${saleLinks.length} sale/clearance collection(s)` });

  const issues = [];
  const toCheck = saleLinks.slice(0, 8);

  for (const col of toCheck) {
    const url = `${origin}${col.pathname}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      // Check if price filters are pre-applied (bug #54)
      const preCheckedFilters = await page.$$eval(
        'input[type="checkbox"][checked], input[type="checkbox"]:checked',
        els => els.map(e => {
          const label = e.closest('label')?.textContent?.trim() || e.name || e.value || 'unknown';
          return label;
        }).filter(l => /\$|price/i.test(l))
      );

      if (preCheckedFilters.length > 0) {
        issues.push({ label: col.label, problem: `Pre-checked price filter: ${preCheckedFilters.join(', ')}` });
        emit({ step: `⚠ "${col.label}": has pre-checked price filters: ${preCheckedFilters.join(', ')}` });
      }

      // Count product cards and check how many have sale indicators
      const saleStats = await page.$$eval(
        '[class*="product"], .product-card, .grid__item',
        cards => {
          let total = 0;
          let withSale = 0;
          for (const card of cards) {
            const text = card.textContent || '';
            const html = card.innerHTML || '';
            // Look for sale badge, compare-at price, strikethrough
            const hasSaleIndicator =
              /sale|clearance/i.test(html) ||
              card.querySelector('[class*="sale"], [class*="badge"], [class*="compare"], s, del, strike, [class*="was-price"], [class*="original-price"]') !== null ||
              (html.match(/<s\b|<del\b|<strike\b|class="[^"]*compare/i) !== null);
            total++;
            if (hasSaleIndicator) withSale++;
          }
          return { total, withSale };
        }
      );

      if (saleStats.total > 0 && saleStats.withSale === 0) {
        issues.push({ label: col.label, problem: `${saleStats.total} products, none have sale badges/strikethrough` });
        emit({ step: `❌ "${col.label}": ${saleStats.total} products but 0 have sale indicators` });

        if (issues.length <= 3) {
          const shot = screenshotPath(store.newStore, 'sale-clearance', `nosale_${issues.length}`);
          await page.screenshot({ path: shot, fullPage: false });
          emit({ screenshot: screenshotUrl(shot), label: `No sale indicators: ${col.label}` });
        }
      } else if (saleStats.total > 0) {
        const pct = Math.round((saleStats.withSale / saleStats.total) * 100);
        emit({ step: `✓ "${col.label}": ${saleStats.withSale}/${saleStats.total} (${pct}%) have sale indicators` });
      }
    } catch (err) {
      emit({ step: `⚠ Error checking "${col.label}": ${err.message}` });
    }
  }

  if (issues.length > 0) {
    const list = issues.map(i => `"${i.label}": ${i.problem}`).join('; ');
    return { passed: false, message: `${issues.length} sale/clearance issue(s): ${list}` };
  }

  return { passed: true, message: `All ${toCheck.length} sale/clearance collections look correct` };
}

// ── 4. Footer & Store Hours Text Sanity ────────────────────────────
// Scans footer and /pages/view-store-hours for literal "\n", "&amp;",
// address formatting issues.  Catches CSV: #1, 43, 62
async function testFooterTextSanity(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const issues = [];

  emit({ step: 'Checking footer and store hours for text issues...' });

  // Check homepage footer
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const footerIssues = await page.$$eval('footer, [class*="footer"]', els => {
    const problems = [];
    for (const el of els) {
      const text = el.textContent || '';
      const html = el.innerHTML || '';
      // Literal \n in rendered text (not actual newlines — the literal backslash-n)
      if (text.includes('\\n') || text.includes('/n')) {
        problems.push('Literal "\\n" or "/n" found in footer text');
      }
      // HTML entity rendered as text
      if (text.includes('&amp;')) {
        problems.push('"&amp;" rendered as literal text in footer');
      }
    }
    return [...new Set(problems)];
  });

  if (footerIssues.length > 0) {
    issues.push(...footerIssues.map(p => ({ page: 'Homepage footer', problem: p })));
    footerIssues.forEach(p => emit({ step: `❌ Footer: ${p}` }));
    const shot = screenshotPath(store.newStore, 'footer-text', '01_footer');
    await page.screenshot({ path: shot, fullPage: true });
    emit({ screenshot: screenshotUrl(shot), label: 'Footer issues' });
  }

  // Check store hours page
  try {
    await page.goto(`${origin}/pages/view-store-hours`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    const storeHoursIssues = [];

    if ((bodyText.match(/\\n|\/n/g) || []).length >= 2) {
      storeHoursIssues.push('Literal "\\n" or "/n" in store hours page');
    }
    if ((bodyText.match(/&amp;/g) || []).length >= 2) {
      storeHoursIssues.push('"&amp;" rendered as literal text');
    }

    // Check for addresses without spaces (e.g., "123MainSt" — no space)
    const addressBlock = await page.$('[class*="address"], [class*="location"], [class*="store-info"]');
    if (addressBlock) {
      const addrText = await addressBlock.textContent();
      // Look for "Get Directions" link with concatenated address
      if (/\d{5}[A-Z]/.test(addrText) || /[a-z]\d{5}/.test(addrText)) {
        storeHoursIssues.push('Address may have missing spaces (zip code touching letters)');
      }
    }

    if (storeHoursIssues.length > 0) {
      issues.push(...storeHoursIssues.map(p => ({ page: 'Store Hours', problem: p })));
      storeHoursIssues.forEach(p => emit({ step: `❌ Store Hours: ${p}` }));
      const shot = screenshotPath(store.newStore, 'footer-text', '02_store_hours');
      await page.screenshot({ path: shot, fullPage: false });
      emit({ screenshot: screenshotUrl(shot), label: 'Store Hours text issues' });
    }
  } catch (err) {
    emit({ step: `⚠ Could not load store hours page: ${err.message}` });
  }

  if (issues.length > 0) {
    const list = issues.map(i => `${i.page}: ${i.problem}`).join('; ');
    return { passed: false, message: `${issues.length} text formatting issue(s): ${list}` };
  }

  return { passed: true, message: 'Footer and store hours text looks clean' };
}

// ── 5. External Link Targets ────────────────────────────────────────
// Enumerates Specialty Shops and other external links, verifies they
// open in a new tab and aren't dead.  Catches CSV: #26, 28, 35
async function testExternalLinkTargets(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const storeDomain = new URL(origin).hostname;

  emit({ step: 'Scanning for external links in navigation...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Find all links that go to external domains
  const externalLinks = await page.$$eval('nav a, header a, [class*="menu"] a', (links, domain) => {
    const results = [];
    const seen = new Set();
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('http')) continue;
      try {
        const url = new URL(href);
        if (url.hostname === domain || url.hostname.endsWith('.myshopify.com')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        results.push({
          href,
          target: a.getAttribute('target') || '',
          label: (a.textContent || '').trim().substring(0, 50),
        });
      } catch {}
    }
    return results;
  }, storeDomain);

  if (externalLinks.length === 0) {
    return { passed: true, message: 'No external links found in navigation' };
  }

  emit({ step: `Found ${externalLinks.length} external link(s)` });

  const issues = [];

  for (const link of externalLinks) {
    // Check target="_blank"
    if (link.target !== '_blank') {
      issues.push({ href: link.href, label: link.label, problem: 'Opens in same tab (missing target="_blank")' });
      emit({ step: `❌ "${link.label}" (${link.href}) — opens in same tab` });
    }

    // Quick HEAD request to check if link is dead
    try {
      const resp = await page.request.head(link.href, { timeout: 10000 }).catch(() =>
        page.request.get(link.href, { timeout: 10000 })
      );
      if (resp && (resp.status() >= 400)) {
        issues.push({ href: link.href, label: link.label, problem: `Dead link (HTTP ${resp.status()})` });
        emit({ step: `❌ "${link.label}" (${link.href}) — HTTP ${resp.status()}` });
      }
    } catch (err) {
      issues.push({ href: link.href, label: link.label, problem: `Unreachable: ${err.message}` });
      emit({ step: `❌ "${link.label}" (${link.href}) — unreachable` });
    }
  }

  if (issues.length > 0) {
    if (issues.length <= 3) {
      const shot = screenshotPath(store.newStore, 'external-links', '01_nav');
      await page.screenshot({ path: shot, fullPage: false });
      emit({ screenshot: screenshotUrl(shot), label: 'External links in nav' });
    }
    const list = issues.map(i => `"${i.label}" ${i.href}: ${i.problem}`).join('; ');
    return { passed: false, message: `${issues.length} external link issue(s): ${list}` };
  }

  return { passed: true, message: `All ${externalLinks.length} external links open in new tab and are reachable` };
}

// ── 7. Price Floor Scan ─────────────────────────────────────────────
// ─── Search Functionality ──────────────────────────────────────────
// Catches TMTST-4368 (ISBN search broken), TMTST-3484 (GM search broken)
async function testSearchFunctionality(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];

  // Test 1: General merchandise search
  emit({ step: 'Testing general merchandise search...' });
  const gmSearchUrl = `${origin}/search?q=${encodeURIComponent('backpack')}`;
  await page.goto(gmSearchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const gmShot = screenshotPath(store.newStore, 'search-functionality', '01_gm_search');
  await page.screenshot({ path: gmShot, fullPage: false });
  emit({ screenshot: screenshotUrl(gmShot), label: 'GM search: "backpack"' });

  const gmResults = await page.evaluate(() => {
    const products = document.querySelectorAll('a[href*="/products/"]');
    const visible = Array.from(products).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const noResults = /no results|no products|nothing found|0 results/i.test(document.body.innerText);
    return { count: visible.length, noResults };
  });

  if (gmResults.noResults || gmResults.count === 0) {
    checks.push({ name: 'GM Search ("backpack")', ok: false, detail: 'No products returned for general merchandise search' });
  } else {
    checks.push({ name: 'GM Search ("backpack")', ok: true, detail: `${gmResults.count} product(s) found` });
  }

  // Test 2: Textbook / ISBN-style search
  emit({ step: 'Testing textbook search...' });
  const tbSearchUrl = `${origin}/search?q=${encodeURIComponent('textbook')}`;
  await page.goto(tbSearchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const tbShot = screenshotPath(store.newStore, 'search-functionality', '02_textbook_search');
  await page.screenshot({ path: tbShot, fullPage: false });
  emit({ screenshot: screenshotUrl(tbShot), label: 'Textbook search' });

  const tbResults = await page.evaluate(() => {
    const products = document.querySelectorAll('a[href*="/products/"]');
    const visible = Array.from(products).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const noResults = /no results|no products|nothing found|0 results/i.test(document.body.innerText);
    return { count: visible.length, noResults };
  });

  if (tbResults.noResults || tbResults.count === 0) {
    checks.push({ name: 'Textbook Search', ok: false, detail: 'No products returned for textbook search' });
  } else {
    checks.push({ name: 'Textbook Search', ok: true, detail: `${tbResults.count} product(s) found` });
  }

  // Test 3: Verify search bar is accessible from homepage
  emit({ step: 'Checking search bar accessibility from homepage...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const searchBarExists = await page.evaluate(() => {
    // Look for search input or search icon/button
    const searchInput = document.querySelector(
      'input[type="search"], input[name="q"], input[placeholder*="search" i], input[aria-label*="search" i]'
    );
    const searchIcon = document.querySelector(
      'a[href*="/search"], button[aria-label*="search" i], [data-action*="search"], .search-icon, .icon-search'
    );
    return { hasInput: !!searchInput, hasIcon: !!searchIcon };
  });

  if (!searchBarExists.hasInput && !searchBarExists.hasIcon) {
    checks.push({ name: 'Search Bar Present', ok: false, detail: 'No search input or search icon found on homepage' });
  } else {
    checks.push({ name: 'Search Bar Present', ok: true, detail: searchBarExists.hasInput ? 'Search input found' : 'Search icon found' });
  }

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    emit({ step: `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}` });
  }

  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? `All ${checks.length} search checks passed`
      : `${failed.length}/${checks.length} failed: ${failed.map(f => f.name).join(', ')}`,
    checks,
  };
}

// ─── Header & Nav Integrity ───────────────────────────────────────
// Catches TMTST-4168 (duplicate textbook link), TMTST-4228 (shop-by
// duplicates header), TMTST-4290/4098/3597 (taxonomy data missing)
async function testHeaderNavIntegrity(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];

  emit({ step: 'Analyzing header navigation links...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const headerShot = screenshotPath(store.newStore, 'header-nav-integrity', '01_header');
  await page.screenshot({ path: headerShot, fullPage: false });
  emit({ screenshot: screenshotUrl(headerShot), label: 'Header navigation' });

  // Check 1: Duplicate links in header nav
  const navAnalysis = await page.evaluate(() => {
    // Find the main navigation — usually <header>, <nav>, or role="navigation"
    const headerEl = document.querySelector('header') || document.querySelector('nav') || document.querySelector('[role="navigation"]');
    if (!headerEl) return { links: [], duplicates: [], hasNav: false };

    const links = Array.from(headerEl.querySelectorAll('a'));
    const linkTexts = links
      .filter(a => {
        const rect = a.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(a => ({
        text: a.textContent.trim().replace(/\s+/g, ' '),
        href: a.getAttribute('href') || '',
      }))
      .filter(l => l.text.length > 0 && l.text.length < 50);

    // Find duplicate link text (same text appearing multiple times)
    const textCounts = {};
    for (const l of linkTexts) {
      const key = l.text.toUpperCase();
      if (!textCounts[key]) textCounts[key] = [];
      textCounts[key].push(l.href);
    }

    const duplicates = Object.entries(textCounts)
      .filter(([, hrefs]) => hrefs.length > 1)
      .map(([text, hrefs]) => ({ text, count: hrefs.length, hrefs }));

    return { links: linkTexts.slice(0, 30), duplicates, hasNav: true };
  });

  if (!navAnalysis.hasNav) {
    checks.push({ name: 'Header Navigation', ok: false, detail: 'No header/nav element found' });
  } else {
    emit({ step: `Found ${navAnalysis.links.length} visible nav links` });

    if (navAnalysis.duplicates.length > 0) {
      const dupList = navAnalysis.duplicates.map(d => `"${d.text}" (×${d.count})`).join(', ');
      checks.push({ name: 'No Duplicate Nav Links', ok: false, detail: `Duplicate links: ${dupList}` });
      emit({ step: `❌ Duplicate nav links found: ${dupList}` });
    } else {
      checks.push({ name: 'No Duplicate Nav Links', ok: true, detail: 'No duplicate link text in header' });
    }
  }

  // Check 2: Verify top-level category links lead to pages with products
  emit({ step: 'Checking category links for content...' });

  const categoryLinks = await page.evaluate(() => {
    const headerEl = document.querySelector('header') || document.querySelector('nav');
    if (!headerEl) return [];
    const links = Array.from(headerEl.querySelectorAll('a'));
    return links
      .filter(a => {
        const href = a.getAttribute('href') || '';
        const rect = a.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && href.includes('/collections/');
      })
      .map(a => ({
        text: a.textContent.trim().replace(/\s+/g, ' '),
        href: a.getAttribute('href'),
      }))
      .slice(0, 5); // check up to 5 category links
  });

  let emptyCategories = 0;
  for (const cat of categoryLinks) {
    const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
    emit({ step: `Visiting category: "${cat.text}" → ${cat.href}` });

    try {
      await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      const hasProducts = await page.evaluate(() => {
        const products = document.querySelectorAll('a[href*="/products/"]');
        const visible = Array.from(products).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return visible.length > 0;
      });

      if (!hasProducts) {
        emptyCategories++;
        emit({ step: `❌ Category "${cat.text}" has no visible products` });
      } else {
        emit({ step: `✅ Category "${cat.text}" has products` });
      }
    } catch (err) {
      emptyCategories++;
      emit({ step: `❌ Category "${cat.text}" failed to load: ${err.message}` });
    }
  }

  if (categoryLinks.length === 0) {
    checks.push({ name: 'Category Links', ok: true, detail: 'No /collections/ links in header (may use different URL structure)' });
  } else if (emptyCategories > 0) {
    checks.push({ name: 'Category Links Have Products', ok: false, detail: `${emptyCategories}/${categoryLinks.length} categories are empty` });
  } else {
    checks.push({ name: 'Category Links Have Products', ok: true, detail: `All ${categoryLinks.length} checked categories have products` });
  }

  // Check 3: Verify "Shop By" / taxonomy menu exists and has content
  emit({ step: 'Checking Shop By / taxonomy menu...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const taxonomyCheck = await page.evaluate(() => {
    const headerEl = document.querySelector('header') || document.querySelector('nav');
    if (!headerEl) return { found: false };

    const allLinks = Array.from(headerEl.querySelectorAll('a'));
    const shopByLink = allLinks.find(a =>
      /shop\s*by|categories|departments/i.test(a.textContent.trim())
    );

    // Check for mega-menu / dropdown items
    const menuItems = headerEl.querySelectorAll('li > ul a, [class*="mega"] a, [class*="dropdown"] a, [class*="submenu"] a');
    const visibleMenuItems = Array.from(menuItems).filter(el => {
      // Include items that might be in dropdowns (hidden until hover)
      return el.getAttribute('href') && el.textContent.trim().length > 0;
    });

    return {
      found: !!shopByLink || visibleMenuItems.length > 0,
      shopByText: shopByLink ? shopByLink.textContent.trim() : null,
      subItemCount: visibleMenuItems.length,
    };
  });

  if (taxonomyCheck.found) {
    checks.push({ name: 'Taxonomy / Shop By', ok: true, detail: `Found${taxonomyCheck.shopByText ? ` "${taxonomyCheck.shopByText}"` : ''} with ${taxonomyCheck.subItemCount} sub-items` });
  } else {
    checks.push({ name: 'Taxonomy / Shop By', ok: false, detail: 'No Shop By / taxonomy menu structure found in header' });
  }

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    emit({ step: `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}` });
  }

  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? `All ${checks.length} nav integrity checks passed`
      : `${failed.length}/${checks.length} failed: ${failed.map(f => f.name).join(', ')}`,
    checks,
  };
}

// ─── Checkout Shipping & Payment ──────────────────────────────────
// Catches TMTST-4367 (ship-to address missing), TMTST-3599 (payment
// failure message), TMTST-3439 (country dropdown), TMTST-4171 (pickup missing)
async function testCheckoutShippingPayment(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const qaState = getQaState(page);
  const checks = [];

  // Step 1: Ensure cart has items
  let cartData = await readCartData(page);
  if (qaState.standardCartReady && cartData && cartData.item_count > 0) {
    emit({ step: `Reusing cart (${cartData.item_count} item(s))` });
  } else {
    emit({ step: 'Adding item to cart for checkout inspection...' });
    await clearCart(page, origin, emit);
    const addResult = await addStandardItemToCart(page, store, emit, {
      listUrl: `${origin}/collections/all`,
      maxProducts: 5,
      screenshotPrefix: 'checkout-shipping',
    });
    if (!addResult.passed) {
      return { passed: false, message: 'Could not add item to cart for checkout inspection' };
    }
  }

  // Step 2: Navigate to checkout
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForSelector(
      'input[type="email"], input[type="text"], [data-delivery-group], [class*="checkout"]',
      { timeout: 20000 }
    );
  } catch {}
  await page.waitForTimeout(5000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  const checkoutShot = screenshotPath(store.newStore, 'checkout-shipping', '01_checkout');
  await page.screenshot({ path: checkoutShot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutShot), label: 'Checkout page' });

  // Check 1: Payment acceptance error
  emit({ step: 'Checking for payment failure messages...' });
  const paymentError = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const patterns = [
      /store can'?t accept payments/i,
      /payment.*not.*available/i,
      /unable to process payments/i,
      /payments.*disabled/i,
    ];
    for (const p of patterns) {
      const match = bodyText.match(p);
      if (match) return match[0];
    }
    return null;
  });

  if (paymentError) {
    checks.push({ name: 'Payment Acceptance', ok: false, detail: `Error found: "${paymentError}"` });
  } else {
    checks.push({ name: 'Payment Acceptance', ok: true, detail: 'No payment error messages found' });
  }

  // Check 2: Shipping address section exists
  emit({ step: 'Checking for shipping address section...' });
  const shippingSection = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const hasShipping = /ship(ping)?\s*(to|address)|delivery\s*address/i.test(bodyText);
    const hasAddressFields = !!document.querySelector(
      'input[autocomplete="address-line1"], input[name*="address"], input[placeholder*="address" i]'
    );
    return { hasShipping, hasAddressFields };
  });

  if (shippingSection.hasShipping || shippingSection.hasAddressFields) {
    checks.push({ name: 'Shipping Address Section', ok: true, detail: 'Shipping/delivery address section found' });
  } else {
    checks.push({ name: 'Shipping Address Section', ok: false, detail: 'Shipping address section not found on checkout' });
  }

  // Check 3: Phone number field exists
  emit({ step: 'Checking for phone number field...' });
  const phoneField = await page.evaluate(() => {
    const phone = document.querySelector(
      'input[autocomplete="tel"], input[type="tel"], input[name*="phone"], input[placeholder*="phone" i]'
    );
    const label = document.querySelector('label');
    const labels = Array.from(document.querySelectorAll('label, .field__label'));
    const phoneLabel = labels.find(l => /phone/i.test(l.textContent));
    return { hasField: !!phone, hasLabel: !!phoneLabel };
  });

  if (phoneField.hasField || phoneField.hasLabel) {
    checks.push({ name: 'Phone Number Field', ok: true, detail: 'Phone number field present' });
  } else {
    checks.push({ name: 'Phone Number Field', ok: false, detail: 'Phone number field missing from checkout' });
  }

  // Check 4: Country dropdown (TMTST-3439 — country restricted to USA only)
  emit({ step: 'Checking country dropdown options...' });
  const countryCheck = await page.evaluate(() => {
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      const name = (select.getAttribute('name') || '').toLowerCase();
      const id = (select.getAttribute('id') || '').toLowerCase();
      const autocomplete = (select.getAttribute('autocomplete') || '').toLowerCase();
      if (name.includes('country') || id.includes('country') || autocomplete.includes('country')) {
        const options = Array.from(select.querySelectorAll('option'));
        return {
          found: true,
          optionCount: options.length,
          values: options.slice(0, 5).map(o => o.textContent.trim()),
        };
      }
    }
    return { found: false };
  });

  if (countryCheck.found) {
    if (countryCheck.optionCount <= 1) {
      checks.push({ name: 'Country Dropdown', ok: false, detail: `Only ${countryCheck.optionCount} option(s) — may be restricted to USA only` });
    } else {
      checks.push({ name: 'Country Dropdown', ok: true, detail: `${countryCheck.optionCount} countries available` });
    }
  } else {
    // Country dropdown might not be visible yet (Shopify progressive disclosure)
    checks.push({ name: 'Country Dropdown', ok: true, detail: 'Country select not found (may load after address entry)' });
  }

  // Check 5: Delivery method options (pickup, ship)
  emit({ step: 'Checking delivery method options...' });

  // Scroll down to find delivery methods
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(1000);

  const deliveryMethods = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const hasShip = /ship(ping)?|deliver(y)?/i.test(bodyText);
    const hasPickup = /pick\s*up|in[- ]?store/i.test(bodyText);
    // Look for delivery method radio buttons / sections
    const deliveryGroup = document.querySelector('[data-delivery-group], [class*="delivery-method"], [class*="shipping-method"]');
    return { hasShip, hasPickup, hasDeliveryGroup: !!deliveryGroup };
  });

  const deliveryShot = screenshotPath(store.newStore, 'checkout-shipping', '02_delivery');
  await page.screenshot({ path: deliveryShot, fullPage: false });
  emit({ screenshot: screenshotUrl(deliveryShot), label: 'Delivery methods area' });

  // We note pickup status but don't fail — not all stores have pickup
  emit({ step: `Delivery: Ship=${deliveryMethods.hasShip}, Pickup=${deliveryMethods.hasPickup}` });
  if (!deliveryMethods.hasShip && !deliveryMethods.hasPickup) {
    checks.push({ name: 'Delivery Methods', ok: false, detail: 'No delivery method options found (no Ship or Pickup)' });
  } else {
    const methods = [];
    if (deliveryMethods.hasShip) methods.push('Ship');
    if (deliveryMethods.hasPickup) methods.push('Pickup');
    checks.push({ name: 'Delivery Methods', ok: true, detail: `Available: ${methods.join(', ')}` });
  }

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    emit({ step: `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}` });
  }

  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? `All ${checks.length} checkout shipping/payment checks passed`
      : `${failed.length}/${checks.length} failed: ${failed.map(f => f.name).join(', ')}`,
    checks,
  };
}

// ─── Mobile Responsiveness ────────────────────────────────────────
// Tests critical pages at mobile viewport (375×812, iPhone-class).
// Catches TMTST-3447 and general mobile layout regressions.
async function testMobileResponsiveness(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];

  // Switch to mobile viewport
  emit({ step: 'Switching to mobile viewport (375×812)...' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);

  // ── CHECK 1: Homepage loads and hamburger menu works ──
  emit({ step: 'Loading homepage at mobile viewport...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const mobileHomeShot = screenshotPath(store.newStore, 'mobile-responsiveness', '01_mobile_home');
  await page.screenshot({ path: mobileHomeShot, fullPage: false });
  emit({ screenshot: screenshotUrl(mobileHomeShot), label: 'Mobile homepage' });

  // Check horizontal overflow
  const overflowCheck = await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const hasHorizontalScroll = body.scrollWidth > window.innerWidth + 5 ||
                                 html.scrollWidth > window.innerWidth + 5;
    return { hasHorizontalScroll, bodyWidth: body.scrollWidth, viewportWidth: window.innerWidth };
  });

  if (overflowCheck.hasHorizontalScroll) {
    checks.push({ name: 'No Horizontal Overflow (Homepage)', ok: false, detail: `Body width ${overflowCheck.bodyWidth}px exceeds viewport ${overflowCheck.viewportWidth}px` });
  } else {
    checks.push({ name: 'No Horizontal Overflow (Homepage)', ok: true, detail: 'No horizontal scrollbar' });
  }

  // Check hamburger / mobile menu button
  const menuButton = await page.evaluate(() => {
    const selectors = [
      'button[aria-label*="menu" i]',
      'button[aria-label*="nav" i]',
      '[class*="hamburger"]',
      '[class*="menu-toggle"]',
      '[class*="mobile-nav"]',
      'button.menu',
      'details[class*="menu"]',
      'header button svg',
      '[data-action*="menu"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { found: true, selector: sel, text: el.textContent.trim().substring(0, 20) };
        }
      }
    }
    return { found: false };
  });

  if (menuButton.found) {
    checks.push({ name: 'Mobile Menu Button', ok: true, detail: `Found via ${menuButton.selector}` });

    // Try clicking it to verify it opens
    emit({ step: 'Testing mobile menu open...' });
    try {
      await page.click(menuButton.selector, { timeout: 3000 });
      await page.waitForTimeout(1000);

      const menuOpenShot = screenshotPath(store.newStore, 'mobile-responsiveness', '02_menu_open');
      await page.screenshot({ path: menuOpenShot, fullPage: false });
      emit({ screenshot: screenshotUrl(menuOpenShot), label: 'Mobile menu opened' });

      // Check if menu content appeared
      const menuContent = await page.evaluate(() => {
        const navLinks = document.querySelectorAll('nav a, [class*="mobile-nav"] a, [class*="drawer"] a, [class*="menu-drawer"] a');
        const visible = Array.from(navLinks).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return visible.length;
      });

      if (menuContent > 0) {
        checks.push({ name: 'Mobile Menu Opens', ok: true, detail: `Menu opened with ${menuContent} visible links` });
      } else {
        checks.push({ name: 'Mobile Menu Opens', ok: false, detail: 'Menu button clicked but no nav links became visible' });
      }

      // Close it (click again or press Escape)
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    } catch {
      checks.push({ name: 'Mobile Menu Opens', ok: false, detail: 'Could not click menu button' });
    }
  } else {
    checks.push({ name: 'Mobile Menu Button', ok: false, detail: 'No hamburger/menu button found at mobile viewport' });
  }

  // ── CHECK 2: Collection page at mobile ──
  emit({ step: 'Loading collection page at mobile viewport...' });
  await page.goto(`${origin}/collections/all`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const mobileCollShot = screenshotPath(store.newStore, 'mobile-responsiveness', '03_mobile_collection');
  await page.screenshot({ path: mobileCollShot, fullPage: false });
  emit({ screenshot: screenshotUrl(mobileCollShot), label: 'Mobile collection page' });

  // Check product grid isn't overflowing
  const collOverflow = await page.evaluate(() => {
    return document.body.scrollWidth > window.innerWidth + 5;
  });
  if (collOverflow) {
    checks.push({ name: 'No Horizontal Overflow (Collections)', ok: false, detail: 'Collection page overflows horizontally on mobile' });
  } else {
    checks.push({ name: 'No Horizontal Overflow (Collections)', ok: true, detail: 'Collection page fits mobile viewport' });
  }

  // Check that product cards are visible and reasonably sized
  const mobileProducts = await page.evaluate(() => {
    const cards = document.querySelectorAll('a[href*="/products/"]');
    let tooSmall = 0;
    let visible = 0;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        visible++;
        // Tap target too small (WCAG recommends 44×44px minimum)
        if (rect.width < 44 || rect.height < 44) tooSmall++;
      }
    }
    return { visible, tooSmall };
  });

  if (mobileProducts.visible === 0) {
    checks.push({ name: 'Mobile Product Cards', ok: false, detail: 'No product cards visible on mobile collection page' });
  } else if (mobileProducts.tooSmall > 0) {
    checks.push({ name: 'Mobile Tap Targets', ok: false, detail: `${mobileProducts.tooSmall}/${mobileProducts.visible} product links are smaller than 44×44px tap target` });
  } else {
    checks.push({ name: 'Mobile Product Cards', ok: true, detail: `${mobileProducts.visible} products visible with proper tap targets` });
  }

  // ── CHECK 3: Search at mobile ──
  emit({ step: 'Testing search at mobile viewport...' });
  const searchUrl = `${origin}/search?q=${encodeURIComponent('textbook')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const mobileSearchShot = screenshotPath(store.newStore, 'mobile-responsiveness', '04_mobile_search');
  await page.screenshot({ path: mobileSearchShot, fullPage: false });
  emit({ screenshot: screenshotUrl(mobileSearchShot), label: 'Mobile search results' });

  const searchOverflow = await page.evaluate(() => {
    return document.body.scrollWidth > window.innerWidth + 5;
  });
  if (searchOverflow) {
    checks.push({ name: 'No Horizontal Overflow (Search)', ok: false, detail: 'Search results page overflows on mobile' });
  } else {
    checks.push({ name: 'No Horizontal Overflow (Search)', ok: true, detail: 'Search page fits mobile viewport' });
  }

  // ── CHECK 4: Cart page at mobile ──
  emit({ step: 'Checking cart page at mobile viewport...' });
  await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const mobileCartShot = screenshotPath(store.newStore, 'mobile-responsiveness', '05_mobile_cart');
  await page.screenshot({ path: mobileCartShot, fullPage: false });
  emit({ screenshot: screenshotUrl(mobileCartShot), label: 'Mobile cart page' });

  const cartOverflow = await page.evaluate(() => {
    return document.body.scrollWidth > window.innerWidth + 5;
  });
  if (cartOverflow) {
    checks.push({ name: 'No Horizontal Overflow (Cart)', ok: false, detail: 'Cart page overflows on mobile' });
  } else {
    checks.push({ name: 'No Horizontal Overflow (Cart)', ok: true, detail: 'Cart page fits mobile viewport' });
  }

  // Restore desktop viewport for any subsequent tests
  await page.setViewportSize({ width: 1920, height: 1080 });

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    emit({ step: `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}` });
  }

  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? `All ${checks.length} mobile checks passed`
      : `${failed.length}/${checks.length} failed: ${failed.map(f => f.name).join(', ')}`,
    checks,
  };
}

// ─── Rental & Purchase Options ────────────────────────────────────
// Catches TMTST-4118 (rental selection not available), TMTST-3419
// (rental agreement prompt issues)
async function testRentalPurchaseOptions(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];

  emit({ step: 'Searching for textbooks to check purchase/rental options...' });
  const searchUrl = `${origin}/search?q=${encodeURIComponent('print new')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const productLinks = await getVisibleProductLinks(page);
  emit({ step: `Found ${productLinks.length} products in search results` });

  if (productLinks.length === 0) {
    return { passed: false, message: 'No products found in search — cannot check rental/purchase options' };
  }

  // Visit up to 3 products looking for purchase option selectors
  let productsWithOptions = 0;
  let productsWithRental = 0;
  let productsChecked = 0;

  for (let i = 0; i < Math.min(3, productLinks.length); i++) {
    const href = productLinks[i];
    const productUrl = href.startsWith('http') ? href : `${origin}${href}`;
    emit({ step: `Checking product ${i + 1}: ${href.split('/').pop()}` });

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    productsChecked++;

    if (i === 0) {
      const pdpShot = screenshotPath(store.newStore, 'rental-purchase-options', `01_product_${i}`);
      await page.screenshot({ path: pdpShot, fullPage: false });
      emit({ screenshot: screenshotUrl(pdpShot), label: `Product ${i + 1} - purchase options` });
    }

    const optionsAnalysis = await page.evaluate(() => {
      const allText = document.body.innerText.toUpperCase();
      const options = {
        buyNew: false,
        buyUsed: false,
        rentNew: false,
        rentUsed: false,
        hasAnyOption: false,
      };

      // Look for option labels, radio buttons, or buttons
      const elements = document.querySelectorAll('label, input[type="radio"], input[type="checkbox"], button, [class*="option"], [class*="variant"]');
      for (const el of elements) {
        const text = (el.textContent || el.value || '').toUpperCase().trim();
        if (/BUY\s*NEW/i.test(text)) options.buyNew = true;
        if (/BUY\s*USED/i.test(text)) options.buyUsed = true;
        if (/RENT\s*NEW/i.test(text)) options.rentNew = true;
        if (/RENT\s*USED/i.test(text)) options.rentUsed = true;
      }

      options.hasAnyOption = options.buyNew || options.buyUsed || options.rentNew || options.rentUsed;

      // Also check if "Add to Bag" / "Add to Cart" button exists and is not disabled
      const addBtn = document.querySelector('button:not([disabled])');
      const addBtnText = addBtn ? (addBtn.textContent || '').toUpperCase() : '';
      const hasAddButton = addBtnText.includes('ADD TO BAG') || addBtnText.includes('ADD TO CART');

      return { ...options, hasAddButton };
    });

    if (optionsAnalysis.hasAnyOption) productsWithOptions++;
    if (optionsAnalysis.rentNew || optionsAnalysis.rentUsed) productsWithRental++;

    const optionList = [];
    if (optionsAnalysis.buyNew) optionList.push('Buy New');
    if (optionsAnalysis.buyUsed) optionList.push('Buy Used');
    if (optionsAnalysis.rentNew) optionList.push('Rent New');
    if (optionsAnalysis.rentUsed) optionList.push('Rent Used');
    emit({ step: `  Options: ${optionList.length > 0 ? optionList.join(', ') : 'None detected'}` });
  }

  if (productsChecked === 0) {
    checks.push({ name: 'Purchase Options', ok: false, detail: 'Could not check any products' });
  } else if (productsWithOptions === 0) {
    checks.push({ name: 'Purchase Options', ok: false, detail: `No Buy/Rent options found on ${productsChecked} textbook product(s)` });
  } else {
    checks.push({ name: 'Purchase Options', ok: true, detail: `${productsWithOptions}/${productsChecked} products have purchase options` });
  }

  if (productsWithRental > 0) {
    checks.push({ name: 'Rental Available', ok: true, detail: `Rental option found on ${productsWithRental} product(s)` });
  } else {
    // Not a hard fail — some stores may not have rental
    checks.push({ name: 'Rental Available', ok: true, detail: 'No rental options found (may not be enabled for this store)' });
  }

  const failed = checks.filter(c => !c.ok);
  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? `Purchase options verified on ${productsChecked} product(s)`
      : `${failed.length} issue(s): ${failed.map(f => f.detail).join('; ')}`,
    checks,
  };
}

// ─── Price Filter Functionality ───────────────────────────────────
// Catches TMTST-3415 (price filter checkbox not working on PLP/SRP)
async function testPriceFilterFunctionality(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];

  emit({ step: 'Navigating to collection page to test filters...' });
  await page.goto(`${origin}/collections/all`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const filterShot = screenshotPath(store.newStore, 'price-filter', '01_collection');
  await page.screenshot({ path: filterShot, fullPage: false });
  emit({ screenshot: screenshotUrl(filterShot), label: 'Collection page (pre-filter)' });

  // Look for price filter elements
  const filterAnalysis = await page.evaluate(() => {
    // Common filter selectors in Shopify themes
    const filterSelectors = [
      'input[type="checkbox"][name*="price"], input[type="checkbox"][value*="price"]',
      '[class*="filter"] input[type="checkbox"]',
      '[data-filter] input[type="checkbox"]',
      'details[class*="filter"] input',
      '[class*="price-filter"] input',
      '[class*="facet"] input[type="checkbox"]',
    ];

    let filterInputs = [];
    for (const sel of filterSelectors) {
      const inputs = document.querySelectorAll(sel);
      if (inputs.length > 0) {
        filterInputs = Array.from(inputs);
        break;
      }
    }

    // Also check for price range slider
    const priceRange = document.querySelector(
      'input[type="range"][name*="price"], [class*="price-range"], [class*="price-slider"]'
    );

    // Check for filter sidebar / drawer
    const filterContainer = document.querySelector(
      '[class*="filter"], [class*="facet"], [data-filter], aside'
    );

    return {
      filterInputCount: filterInputs.length,
      hasPriceRange: !!priceRange,
      hasFilterContainer: !!filterContainer,
      firstFilterText: filterInputs.length > 0
        ? (filterInputs[0].closest('label') || filterInputs[0].parentElement)?.textContent?.trim().substring(0, 40)
        : null,
    };
  });

  emit({ step: `Filters: ${filterAnalysis.filterInputCount} checkbox inputs, price range: ${filterAnalysis.hasPriceRange}, filter container: ${filterAnalysis.hasFilterContainer}` });

  if (filterAnalysis.filterInputCount > 0) {
    // Try clicking the first filter checkbox
    emit({ step: 'Testing filter checkbox interaction...' });

    // Count products before filter
    const productsBefore = await page.evaluate(() => {
      return document.querySelectorAll('a[href*="/products/"]').length;
    });

    try {
      // Click the first available filter checkbox
      const clicked = await page.evaluate(() => {
        const selectors = [
          '[class*="filter"] input[type="checkbox"]',
          '[data-filter] input[type="checkbox"]',
          'details[class*="filter"] input[type="checkbox"]',
          '[class*="facet"] input[type="checkbox"]',
        ];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) {
            input.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        await page.waitForTimeout(3000); // Wait for filter to apply

        const afterShot = screenshotPath(store.newStore, 'price-filter', '02_filtered');
        await page.screenshot({ path: afterShot, fullPage: false });
        emit({ screenshot: screenshotUrl(afterShot), label: 'After filter applied' });

        const productsAfter = await page.evaluate(() => {
          return document.querySelectorAll('a[href*="/products/"]').length;
        });

        // Check URL changed (Shopify filters update URL)
        const currentUrl = page.url();
        const urlChanged = currentUrl.includes('filter') || currentUrl.includes('constraint');

        if (productsAfter !== productsBefore || urlChanged) {
          checks.push({ name: 'Filter Checkbox Works', ok: true, detail: `Products changed from ${productsBefore} to ${productsAfter}` });
        } else {
          checks.push({ name: 'Filter Checkbox Works', ok: false, detail: `Filter clicked but product count unchanged (${productsBefore})` });
        }
      } else {
        checks.push({ name: 'Filter Checkbox Works', ok: false, detail: 'Could not click any filter checkbox' });
      }
    } catch (err) {
      checks.push({ name: 'Filter Checkbox Works', ok: false, detail: `Filter interaction failed: ${err.message}` });
    }
  } else if (filterAnalysis.hasPriceRange) {
    checks.push({ name: 'Price Filter Present', ok: true, detail: 'Price range slider found (checkbox test skipped)' });
  } else if (filterAnalysis.hasFilterContainer) {
    checks.push({ name: 'Filter Container', ok: true, detail: 'Filter container found but no checkbox/range inputs detected' });
  } else {
    checks.push({ name: 'Filters Present', ok: false, detail: 'No filter UI found on collection page' });
  }

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    emit({ step: `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}` });
  }

  return {
    passed: failed.length === 0,
    message: failed.length === 0
      ? 'Price/collection filters working'
      : `Filter issue: ${failed.map(f => f.detail).join('; ')}`,
    checks,
  };
}

// Sorts collection by price ascending and flags any product under $1
// (almost always a misconfigured OOS variant).  Catches CSV: #46
async function testPriceFloorScan(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  emit({ step: 'Checking for suspiciously low-priced products...' });

  // Try New Arrivals first, fall back to /collections/all
  let collectionUrl = `${origin}/collections/new-arrivals?sort_by=price-ascending`;
  await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  let bodyText = await page.textContent('body').catch(() => '');
  if (/no products found|page not found|404/i.test(bodyText)) {
    collectionUrl = `${origin}/collections/all?sort_by=price-ascending`;
    await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
  }

  // Extract prices from visible product cards
  const suspectProducts = await page.$$eval(
    '[class*="product"], .product-card, .grid__item',
    cards => {
      const suspects = [];
      for (const card of cards) {
        const priceEls = card.querySelectorAll('[class*="price"], .money, [data-price]');
        const link = card.querySelector('a[href*="/products/"]');
        const title = (card.querySelector('[class*="title"], h2, h3, h4') || {}).textContent || '';

        for (const priceEl of priceEls) {
          const text = (priceEl.textContent || '').trim();
          // Extract numeric price
          const match = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
          if (match) {
            const price = parseFloat(match[1]);
            if (price > 0 && price < 1.00) {
              suspects.push({
                title: title.trim().substring(0, 60),
                price: `$${match[1]}`,
                href: link ? link.getAttribute('href') : '',
              });
              break; // one per card
            }
          }
        }
        if (suspects.length >= 5) break;
      }
      return suspects;
    }
  );

  if (suspectProducts.length > 0) {
    for (const p of suspectProducts) {
      emit({ step: `❌ ${p.price} — "${p.title}" ${p.href}` });
    }
    const shot = screenshotPath(store.newStore, 'price-floor', '01_low_prices');
    await page.screenshot({ path: shot, fullPage: false });
    emit({ screenshot: screenshotUrl(shot), label: 'Suspiciously low prices' });

    const list = suspectProducts.map(p => `${p.price} "${p.title}"`).join('; ');
    return { passed: false, message: `${suspectProducts.length} product(s) under $1.00: ${list}` };
  }

  return { passed: true, message: 'No products found under $1.00' };
}

// ─── Run a single store (all its tests) ─────────────────────────────

async function runStoreTests(browserOrCtx, store, testIds, sendEvent, opts = {}) {
  const storeStartedAt = Date.now();
  sendEvent({ type: 'store-start', store: store.newStore, startedAt: new Date(storeStartedAt).toISOString() });

  // Two modes:
  //   - Ephemeral: given a Browser, create a fresh context per store
  //     (the regular Run Tests path — preserves existing behavior).
  //   - Shared persistent: given a BrowserContext directly, reuse it
  //     across stores so cookies (including cf_clearance) persist.
  //     Used by sweeps for Cloudflare resilience.
  // When the worker is in remote-browser mode (Bright Data Browser API
  // or similar), the provider owns the whole fingerprint — UA, viewport,
  // TLS signature, timezone, residential IP — end to end. Overriding any
  // of those client-side (e.g. passing a `userAgent` here) makes
  // `navigator.userAgent` in JS disagree with the HTTP-header UA the
  // provider actually sends upstream, and anti-bot systems flag that
  // mismatch as a bot signature and challenge the request. Bright Data's
  // own reference script uses plain `browser.newPage()` with no context
  // options for this exact reason — we match that shape in remote mode.
  // Local mode keeps the overrides because there is no server-side
  // fingerprint manager underneath us.
  //
  // Gate matches worker.js + installBandwidthBlocking: require BOTH env
  // vars so remote behavior is enabled only when the worker is actually
  // connecting to a remote browser. Prevents a half-activated state
  // where fingerprint overrides are stripped but we're still on local
  // Chromium (which would leave us with a bare browser on Railway's
  // datacenter IP — a guaranteed CF block).
  // ─── Remote-browser detection (Bright Data Scraping Browser) ────────
  // NEW helper: also honors `browser.__isRemoteBrowser`, which we tag
  // wherever `chromium.connectOverCDP(...)` is called (see runTests
  // below + worker.js). This way a caller that already connected to
  // Bright Data and passes the browser in still gets remote-friendly
  // behavior, even if env vars were not re-checked here.
  const isRemoteBrowser =
    (browserOrCtx && browserOrCtx.__isRemoteBrowser === true) ||
    (process.env.REMOTE_BROWSER_ENABLED === '1' && !!process.env.BROWSER_WS_URL);

  /* ── OLD context-creation logic (commented out for easy revert) ──
  const useRemoteBrowser =
    process.env.REMOTE_BROWSER_ENABLED === '1' && !!process.env.BROWSER_WS_URL;
  let context;
  let ownsContext = false;
  if (opts.sharedContext) {
    context = browserOrCtx; // already a BrowserContext
  } else {
    context = await browserOrCtx.newContext(
      useRemoteBrowser
        ? {}
        : {
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 2,
            userAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
          }
    );
    ownsContext = true;
    await installBandwidthBlocking(context);
  }
  const page = wrapPageForCapture(await context.newPage());
  ──────────────────────────────────────────────────────────────────── */

  // ─── NEW context-creation logic ─────────────────────────────────────
  // Remote mode (Bright Data): REUSE the default context the provider
  // already opened on the CDP connection. Calling `newContext()` here
  // throws away Bright Data's session — including any cf_clearance
  // cookies it has earned — and forces it to re-solve Cloudflare on
  // the very next navigation. We also pass NO context options in
  // remote mode (no userAgent, no viewport, no extraHTTPHeaders, no
  // locale, no timezone) because the provider owns the full
  // fingerprint server-side; overriding any of those creates UA/header
  // mismatches anti-bot systems flag as bots.
  //
  // Local mode: keep the original ephemeral newContext() with the same
  // viewport/userAgent we shipped before. (Rule: don't change local
  // behavior.)
  let context;
  let ownsContext = false;
  if (opts.sharedContext) {
    context = browserOrCtx; // already a BrowserContext
    ownsContext = false;
  } else if (isRemoteBrowser) {
    const contexts = browserOrCtx.contexts ? browserOrCtx.contexts() : [];
    context = contexts[0] || browserOrCtx;
    ownsContext = false;
  } else {
    context = await browserOrCtx.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    });
    ownsContext = true;
    // Attach bandwidth blocking before any page is created so the very
    // first navigation already benefits. (installBandwidthBlocking
    // already short-circuits in remote mode, so this stays local-only.)
    await installBandwidthBlocking(context);
  }

  const page = wrapPageForCapture(await context.newPage());

  // Bright Data's residential proxy + server-side CF solving can take
  // 30–90s on a hard challenge. Give every Playwright wait/navigation
  // 120s by default in remote mode so we don't kill the unlocker
  // mid-solve. Local mode keeps Playwright's 30s default to preserve
  // existing test timing.
  if (isRemoteBrowser) {
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);
  }
  let activeTestId = '';
  let activeTestName = '';

  const emitActiveProgress = (step, extra = {}) => {
    sendEvent({
      type: 'test-progress',
      store: store.newStore,
      testId: activeTestId,
      testName: activeTestName,
      step,
      ...extra,
    });
  };

  // Patch page.goto:
  //   • Remote mode (Bright Data / managed browser): trust the provider
  //     to solve CF server-side. Our DOM-based detector false-positives
  //     on pages that embed Turnstile as an anti-fraud widget (cart,
  //     checkout, filtered collections, login) because the script tags
  //     and iframe hosts ship in the static HTML even when there is no
  //     active challenge. Running the retry loop on top of a working
  //     provider only adds latency and spurious failures. The 3-minute
  //     timeout matches Bright Data's reference script — hard CF
  //     challenges behind residential proxies can legitimately take
  //     30–90s to resolve.
  //   • Local mode: keep the full retry loop — local Chromium has no
  //     server-side unlocker, so we have to detect and retry ourselves.
  const originalGoto = page.goto.bind(page);
  if (isRemoteBrowser) {
    // Force 120s timeout in remote mode. Many page.goto calls in test
    // bodies pass a hardcoded `timeout: 10000-30000` that was tuned for
    // local headless Chromium; on Bright Data's residential + CF-solving
    // path those values are far too tight and cause spurious navigation
    // timeouts. Spread `options` first so our 120s timeout wins, but
    // preserve everything else the caller passes (waitUntil, referer,
    // etc.).
    //
    // NOTE: manual Cloudflare detection (isCloudflareChallenge),
    // Turnstile click-solving (trySolveTurnstile), and the goto retry
    // loop are intentionally NOT invoked in this branch — Bright Data
    // resolves CF/Turnstile server-side, and our DOM-based detector
    // false-positives on pages that just embed Turnstile as a fraud
    // widget (cart/checkout/login/filtered collections).
    page.goto = async function (url, options = {}) {
      return originalGoto(url, { ...options, timeout: 120000 });
    };
  } else {
    const MAX_CF_RETRIES = 2;
    page.goto = async function (url, options = {}) {
      const urlString = typeof url === 'string' ? url : String(url);
      let response = await originalGoto(url, options);

      for (let attempt = 0; attempt < MAX_CF_RETRIES; attempt++) {
        if (!(await isCloudflareChallenge(page))) return response;

        emitActiveProgress(`Cloudflare challenge detected (attempt ${attempt + 1}/${MAX_CF_RETRIES})`, {
          url: urlString,
          challenge: true,
        });

        // Step 1: Try clicking the Turnstile checkbox if present
        const solved = await trySolveTurnstile(page, 6000);
        if (solved) {
          emitActiveProgress('Cloudflare challenge resolved via Turnstile.', {
            url: urlString,
            challenge: true,
          });
          await page.waitForTimeout(750);
          return response;
        }

        // Step 2: Wait for auto-resolve (some challenges resolve without interaction)
        try {
          await page.waitForFunction(
            () => !document.body.innerText.includes('Verify you are human') &&
                  !document.body.innerText.includes('Just a moment') &&
                  !document.body.innerText.includes('needs to be verified') &&
                  !document.body.innerText.includes('Checking your browser'),
            { timeout: 8000 }
          );
          await page.waitForTimeout(750);
          if (!(await isCloudflareChallenge(page))) return response;
        } catch {}

        // Step 3: Retry the full navigation with a backoff delay
        const backoff = 1500 * (attempt + 1);
        emitActiveProgress(`Challenge persisted — retrying in ${(backoff / 1000).toFixed(1)}s`, {
          url: urlString,
          challenge: true,
        });
        await page.waitForTimeout(backoff);
        response = await originalGoto(url, options);
      }

      // Final check — if still stuck, throw. Letting the test proceed
      // against a CF challenge page just wastes another ~5 min on
      // selector waits that will never succeed. Throwing here fails the
      // current test fast; the outer retry logic in runStoreTests will
      // attempt it once more, and if that also fails, login is marked
      // failed and every remaining test for this store is skipped.
      if (await isCloudflareChallenge(page)) {
        const err = new Error(`Cloudflare blocked navigation to ${urlString} after ${MAX_CF_RETRIES} attempts`);
        err.cloudflareBlocked = true;
        err.blockedUrl = urlString;
        throw err;
      }

      return response;
    };
  }

  let loginDone = false;

  // Wrap the whole test loop in try/finally so the browser context is
  // always released — even if a test throws uncaught. Without this,
  // contexts leaked on every CF failure and RAM crept toward the
  // Railway container limit, eventually triggering SIGTERM.
  try {
  for (const testId of testIds) {
    const test = TEST_REGISTRY[testId];
    if (!test) continue;

    // Ensure login happens before other tests
    if (!loginDone && testId !== 'storefront-login') {
      const loginTest = TEST_REGISTRY['storefront-login'];
      activeTestId = 'storefront-login';
      activeTestName = loginTest.name;
      const loginStartedAt = Date.now();
      sendEvent({
        type: 'test-start',
        store: store.newStore,
        testId: 'storefront-login',
        testName: loginTest.name,
        startedAt: new Date(loginStartedAt).toISOString(),
      });
      try {
        const loginResult = await loginTest.run(page, store, (data) =>
          sendEvent({ type: 'test-progress', store: store.newStore, testId: 'storefront-login', ...data })
        );
        const loginDurationMs = Date.now() - loginStartedAt;
        sendEvent({
          type: 'test-result',
          store: store.newStore,
          testId: 'storefront-login',
          durationMs: loginDurationMs,
          durationSec: Number((loginDurationMs / 1000).toFixed(1)),
          ...loginResult,
        });
        loginDone = true;
        if (!loginResult.passed) {
          // Skip all remaining tests for this store
          for (const remainingId of testIds.slice(testIds.indexOf(testId))) {
            if (remainingId === 'storefront-login') continue;
            sendEvent({
              type: 'test-result',
              store: store.newStore,
              testId: remainingId,
              passed: false,
              message: 'Skipped — login failed',
            });
          }
          break;
        }
      } catch (err) {
        const loginDurationMs = Date.now() - loginStartedAt;
        sendEvent({
          type: 'test-result',
          store: store.newStore,
          testId: 'storefront-login',
          durationMs: loginDurationMs,
          durationSec: Number((loginDurationMs / 1000).toFixed(1)),
          passed: false,
          message: `Login error: ${err.message}`,
        });
        for (const remainingId of testIds.slice(testIds.indexOf(testId))) {
          if (remainingId === 'storefront-login') continue;
          sendEvent({
            type: 'test-result',
            store: store.newStore,
            testId: remainingId,
            passed: false,
            message: 'Skipped — login failed',
          });
        }
        break;
      }
    }

    if (testId === 'storefront-login' && loginDone) continue;

    activeTestId = testId;
    activeTestName = test.name;
    const testStartedAt = Date.now();
    sendEvent({
      type: 'test-start',
      store: store.newStore,
      testId,
      testName: test.name,
      startedAt: new Date(testStartedAt).toISOString(),
    });

    // Run test with 1 retry on failure
    let result;
    let retried = false;
    try {
      result = await test.run(page, store, (data) =>
        sendEvent({ type: 'test-progress', store: store.newStore, testId, ...data })
      );

      // Retry once if failed
      if (!result.passed) {
        if (result.cloudflareBlocked) {
          sendEvent({
            type: 'test-progress',
            store: store.newStore,
            testId,
            step: `Cloudflare blocked this test at ${result.blockedUrl || 'an unknown URL'} — failing fast.`,
            url: result.blockedUrl || '',
            challenge: true,
          });
        } else {
          retried = true;
          sendEvent({ type: 'test-progress', store: store.newStore, testId, step: '⟳ Test failed — retrying once...' });
          try {
            result = await test.run(page, store, (data) =>
              sendEvent({ type: 'test-progress', store: store.newStore, testId, ...data })
            );
            if (result.passed) {
              result.message = `[Passed on retry] ${result.message}`;
            }
          } catch (retryErr) {
            // Keep original failure
            result = { passed: false, message: `Error on retry: ${retryErr.message}` };
          }
        }
      }

      const durationMs = Date.now() - testStartedAt;
      sendEvent({
        type: 'test-result',
        store: store.newStore,
        testId,
        durationMs,
        durationSec: Number((durationMs / 1000).toFixed(1)),
        ...result,
      });
      if (testId === 'storefront-login') loginDone = true;
    } catch (err) {
      if (err.cloudflareBlocked) {
        sendEvent({
          type: 'test-progress',
          store: store.newStore,
          testId,
          step: `Cloudflare blocked this test at ${err.blockedUrl || 'an unknown URL'} — failing fast.`,
          url: err.blockedUrl || '',
          challenge: true,
        });
      } else {
        // First attempt threw — retry once
        sendEvent({ type: 'test-progress', store: store.newStore, testId, step: '⟳ Test errored — retrying once...' });
      }
      try {
        if (err.cloudflareBlocked) throw err;
        result = await test.run(page, store, (data) =>
          sendEvent({ type: 'test-progress', store: store.newStore, testId, ...data })
        );
        if (result.passed) {
          result.message = `[Passed on retry] ${result.message}`;
        }
        const durationMs = Date.now() - testStartedAt;
        sendEvent({
          type: 'test-result',
          store: store.newStore,
          testId,
          durationMs,
          durationSec: Number((durationMs / 1000).toFixed(1)),
          ...result,
        });
      } catch (retryErr) {
        const errShot = screenshotPath(store.newStore, testId, 'error');
        try {
          await page.screenshot({ path: errShot, fullPage: false });
          sendEvent({
            type: 'test-progress',
            store: store.newStore,
            testId,
            screenshot: screenshotUrl(errShot),
            label: 'Error state',
          });
        } catch (_) {}
        sendEvent({
          type: 'test-result',
          store: store.newStore,
          testId,
          durationMs: Date.now() - testStartedAt,
          durationSec: Number(((Date.now() - testStartedAt) / 1000).toFixed(1)),
          passed: false,
          message: `Error: ${retryErr.message}`,
          blockedUrl: retryErr.blockedUrl || null,
          cloudflareBlocked: Boolean(retryErr.cloudflareBlocked),
        });
      }
    }
  }

  } finally {
    if (ownsContext && context) {
      try { await context.close(); } catch (_) {}
    } else if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
  const storeDurationMs = Date.now() - storeStartedAt;
  sendEvent({
    type: 'store-complete',
    store: store.newStore,
    durationMs: storeDurationMs,
    durationSec: Number((storeDurationMs / 1000).toFixed(1)),
  });
}

// ─── Inventory test ─────────────────────────────────────────────────

async function testInventory(page, store, emit) {
  const origin = storeOrigin(store.newStore);
  const checks = [];
  let checkNum = 0;

  function record(name, passed, detail) {
    checkNum++;
    checks.push({ name, passed, detail });
    emit({ step: `[${checkNum}] ${passed ? '✅' : '❌'} ${name}: ${detail}` });
  }

  // ── CHECK 1: Out-of-stock spot check across 5 random categories ──
  emit({ step: 'Finding collection/category pages from navigation...' });

  // Get all collection links from nav (exclude textbooks)
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const collectionLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    const allLinks = document.querySelectorAll('a[href*="/collections/"]');

    for (const a of allLinks) {
      const href = (a.getAttribute('href') || '').split('?')[0];
      const text = (a.textContent || '').trim();

      // Skip textbooks, course materials, and duplicates
      if (/textbook|course\s*material/i.test(text)) continue;
      if (/textbook|course-material/i.test(href)) continue;
      if (href.includes('/collections/all')) continue;
      if (seen.has(href)) continue;

      // Must be visible
      if (a.offsetParent === null || a.offsetWidth === 0) continue;

      seen.add(href);
      links.push({ href, text: text.substring(0, 50) });
    }

    return links;
  });

  emit({ step: `Found ${collectionLinks.length} category links (excluding textbooks)` });

  // Pick up to 5 random categories
  const shuffled = collectionLinks.sort(() => Math.random() - 0.5);
  const categoriesToCheck = shuffled.slice(0, 5);
  let outOfStockIssues = 0;
  let productsChecked = 0;

  for (let i = 0; i < categoriesToCheck.length; i++) {
    const cat = categoriesToCheck[i];
    const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
    emit({ step: `Checking category ${i + 1}/5: "${cat.text}" → ${cat.href}` });

    try {
      await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      const catShot = screenshotPath(store.newStore, 'inventory', `01_cat_${i + 1}`);
      await page.screenshot({ path: catShot, fullPage: false });
      emit({ screenshot: screenshotUrl(catShot), label: `Category: ${cat.text}` });

      // Check products on this page for out-of-stock indicators
      const productStatus = await page.evaluate(() => {
        const products = [];
        // Look for product cards/items
        const productCards = document.querySelectorAll(
          '[class*="product-card"], [class*="product-item"], [class*="grid-item"], ' +
          '[class*="ProductCard"], [class*="product_card"], .product, .grid__item'
        );

        for (const card of productCards) {
          const text = (card.textContent || '').trim();
          const title = card.querySelector('a[href*="/products/"]');
          const titleText = title ? (title.textContent || '').trim() : '';

          // Check for out-of-stock indicators
          const isOutOfStock =
            /sold\s*out/i.test(text) ||
            /out\s*of\s*stock/i.test(text) ||
            /unavailable/i.test(text) ||
            card.querySelector('[class*="sold-out"], [class*="soldout"], [class*="out-of-stock"]') !== null;

          if (titleText || text.length > 5) {
            products.push({
              title: titleText.substring(0, 80) || text.substring(0, 80),
              outOfStock: isOutOfStock,
            });
          }
        }

        return products;
      });

      const outOfStock = productStatus.filter(p => p.outOfStock);
      const checkedCount = Math.min(productStatus.length, 2); // Count 2 checks per category
      productsChecked += checkedCount;

      if (outOfStock.length > 0) {
        outOfStockIssues += outOfStock.length;
        record(
          `Category "${cat.text}" Stock`,
          false,
          `${outOfStock.length} out-of-stock product(s) displaying: ${outOfStock.map(p => `"${p.title}"`).join(', ')}`
        );
      } else if (productStatus.length === 0) {
        record(
          `Category "${cat.text}" Stock`,
          true,
          `No product cards found on this page (may be a landing page)`
        );
      } else {
        record(
          `Category "${cat.text}" Stock`,
          true,
          `${productStatus.length} products displayed — none out of stock`
        );
      }
    } catch (err) {
      record(`Category "${cat.text}" Stock`, false, `Failed to load category page: ${err.message}`);
    }
  }

  // If we didn't find 5 categories, fill in with direct collection checks
  if (categoriesToCheck.length < 5) {
    const fallbackCollections = ['new-arrivals', 'men', 'women', 'gifts', 'headwear', 'accessories', 'drinkware', 'sale'];
    const remaining = 5 - categoriesToCheck.length;
    const usedPaths = new Set(categoriesToCheck.map(c => c.href));
    let fallbackCount = 0;

    for (const coll of fallbackCollections) {
      if (fallbackCount >= remaining) break;
      const collPath = `/collections/${coll}`;
      if (usedPaths.has(collPath)) continue;

      emit({ step: `Trying fallback category: ${coll}` });
      try {
        const response = await page.goto(`${origin}${collPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (response && response.status() < 400) {
          await page.waitForTimeout(1500);

          const productStatus = await page.evaluate(() => {
            const products = [];
            const productCards = document.querySelectorAll(
              '[class*="product-card"], [class*="product-item"], [class*="grid-item"], ' +
              '[class*="ProductCard"], [class*="product_card"], .product, .grid__item'
            );
            for (const card of productCards) {
              const text = (card.textContent || '').trim();
              const title = card.querySelector('a[href*="/products/"]');
              const titleText = title ? (title.textContent || '').trim() : '';
              const isOutOfStock =
                /sold\s*out/i.test(text) || /out\s*of\s*stock/i.test(text) || /unavailable/i.test(text) ||
                card.querySelector('[class*="sold-out"], [class*="soldout"], [class*="out-of-stock"]') !== null;
              if (titleText || text.length > 5) {
                products.push({ title: titleText.substring(0, 80) || text.substring(0, 80), outOfStock: isOutOfStock });
              }
            }
            return products;
          });

          const outOfStock = productStatus.filter(p => p.outOfStock);
          if (outOfStock.length > 0) {
            outOfStockIssues += outOfStock.length;
            record(`Category "${coll}" Stock`, false, `${outOfStock.length} out-of-stock product(s) found`);
          } else {
            record(`Category "${coll}" Stock`, true, `${productStatus.length} products — none out of stock`);
          }
          fallbackCount++;
        }
      } catch (_) {}
    }
  }

  // Summary for stock check
  const stockSummary = outOfStockIssues === 0
    ? `Spot checked ${categoriesToCheck.length} categories — no out-of-stock products found displaying`
    : `Found ${outOfStockIssues} out-of-stock product(s) across ${categoriesToCheck.length} categories`;
  emit({ step: stockSummary });

  // ── CHECK 2: Navigation links validity (10 checks) ──
  emit({ step: 'Checking navigation links for valid pages...' });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const navLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();

    // Get links from main navigation areas
    const navAreas = document.querySelectorAll('nav, header, [class*="nav"], [class*="menu"], [role="navigation"]');
    for (const nav of navAreas) {
      const anchors = nav.querySelectorAll('a[href]');
      for (const a of anchors) {
        const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
        const text = (a.textContent || '').trim();

        // Skip external links, empty links, anchors, javascript
        if (!href || href === '/' || href === '#' || href.startsWith('javascript:')) continue;
        if (href.startsWith('http') && !href.includes(location.hostname)) continue;
        if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
        if (seen.has(href)) continue;
        if (!text || text.length < 2) continue;

        // Must be visible
        if (a.offsetParent === null || a.offsetWidth === 0) continue;

        seen.add(href);
        links.push({ href, text: text.substring(0, 50) });
      }
    }

    return links;
  });

  emit({ step: `Found ${navLinks.length} unique navigation links` });

  // Shuffle and pick up to 10
  const navToCheck = navLinks.sort(() => Math.random() - 0.5).slice(0, 10);
  let brokenLinks = 0;

  for (let i = 0; i < navToCheck.length; i++) {
    const link = navToCheck[i];
    const fullUrl = link.href.startsWith('http') ? link.href : `${origin}${link.href}`;
    emit({ step: `Nav link ${i + 1}/10: "${link.text}" → ${link.href}` });

    try {
      const response = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);

      const status = response ? response.status() : 0;

      // Check for 404 or error pages
      const pageCheck = await page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        const h1 = document.querySelector('h1');
        const h1Text = h1 ? (h1.textContent || '').toLowerCase() : '';
        const bodyText = (document.body.innerText || '').substring(0, 500).toLowerCase();

        const is404 =
          title.includes('404') || title.includes('not found') ||
          h1Text.includes('404') || h1Text.includes('not found') ||
          h1Text.includes('page not found');

        const isEmpty = bodyText.trim().length < 50;

        return { is404, isEmpty, title: document.title, h1: h1Text.substring(0, 80) };
      });

      if (status >= 400 || pageCheck.is404) {
        brokenLinks++;
        const shotPath = screenshotPath(store.newStore, 'inventory', `02_nav_broken_${i + 1}`);
        await page.screenshot({ path: shotPath, fullPage: false });
        emit({ screenshot: screenshotUrl(shotPath), label: `Broken: ${link.text}` });
        record(
          `Nav Link "${link.text}"`,
          false,
          `Broken page (status: ${status}): ${fullUrl} — Title: "${pageCheck.title}"`
        );
      } else if (pageCheck.isEmpty) {
        const shotPath = screenshotPath(store.newStore, 'inventory', `02_nav_empty_${i + 1}`);
        await page.screenshot({ path: shotPath, fullPage: false });
        emit({ screenshot: screenshotUrl(shotPath), label: `Empty: ${link.text}` });
        record(
          `Nav Link "${link.text}"`,
          false,
          `Page loads but appears empty: ${fullUrl}`
        );
        brokenLinks++;
      } else {
        record(
          `Nav Link "${link.text}"`,
          true,
          `Page loads (status: ${status}): ${fullUrl}`
        );
      }
    } catch (err) {
      brokenLinks++;
      record(`Nav Link "${link.text}"`, false, `Failed to load: ${err.message.substring(0, 100)}`);
    }
  }

  // Final summary screenshot
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1000);
  const finalShot = screenshotPath(store.newStore, 'inventory', '03_summary');
  await page.screenshot({ path: finalShot, fullPage: false });
  emit({ screenshot: screenshotUrl(finalShot), label: 'Store homepage (summary)' });

  const allPassed = checks.every(c => c.passed);
  const passCount = checks.filter(c => c.passed).length;

  return {
    passed: allPassed,
    message: `Inventory check: ${passCount}/${checks.length} passed. Stock: ${outOfStockIssues === 0 ? 'No out-of-stock items found' : `${outOfStockIssues} out-of-stock issues`}. Nav: ${brokenLinks === 0 ? 'All links valid' : `${brokenLinks} broken link(s)`}.`,
    checks,
  };
}

// ─── Main runner (parallel) ─────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;

async function runTests(stores, testIds, sendEvent, options = {}) {
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  // Browser launch strategy:
  //   1. options.endpoint  → chromium.connect(endpoint)
  //        Paid services (Browserless, Bright Data Scraping Browser) that
  //        handle Cloudflare under the hood. No local browser.
  //   2. options.persistent → chromium.launchPersistentContext(dataDir, ...)
  //        A single shared BrowserContext reused across every store in the
  //        batch. Cookies (including cf_clearance) persist across stores
  //        AND across process restarts. Used by sweeps.
  //   3. default → chromium.launch(...) + per-store ephemeral contexts
  //        The original behavior. Preserved for the regular Run Tests path.

  const headful = !!options.headful;
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-setuid-sandbox',
    '--window-size=1920,1080',
  ];

  let browser = null;
  let sharedContext = null;

  if (options.endpoint) {
    // CDP connection (Browserless, Bright Data Scraping Browser, etc.)
    // — same protocol the worker uses, so a single BROWSER_WS_URL env
    // var works for both code paths.
    console.log(`[runTests] Connecting to remote browser: ${options.endpoint.replace(/:[^:@]*@/, ':***@')}`);
    browser = await chromium.connectOverCDP(options.endpoint);
    // Tag the remote browser so `runStoreTests` can detect remote mode
    // even when env vars aren't visible / the helper is called from a
    // worker that didn't set them. Safe no-op on the local-launch and
    // persistent-context paths below (we never tag those).
    browser.__isRemoteBrowser = true;
    sendEvent({ type: 'browser-info', message: `Connected to remote browser: ${options.endpoint.replace(/\?.*$/, '')}` });
  } else if (options.persistent) {
    const dataDir = options.userDataDir || path.join(DATA_DIR, '.browser-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    sharedContext = await chromium.launchPersistentContext(dataDir, {
      headless: !headful,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      args: launchArgs,
    });
    // Apply blocking once on the shared context — runStoreTests skips
    // it in shared mode to avoid piling on handlers per-store.
    await installBandwidthBlocking(sharedContext);
    sendEvent({ type: 'browser-info', message: `Persistent ${headful ? 'headful' : 'headless'} context @ ${dataDir}` });
  } else {
    console.log('[runTests] Launching local browser');
    browser = await chromium.launch({ headless: !headful, args: launchArgs });
  }

  // Process stores in parallel with limited concurrency.
  // Shared persistent mode forces concurrency = 1 because one context
  // cannot serve multiple stores simultaneously without races.
  const effectiveConcurrency = sharedContext ? 1 : concurrency;
  const queue = [...stores];
  const running = new Set();

  await new Promise((resolve) => {
    function startNext() {
      while (running.size < effectiveConcurrency && queue.length > 0) {
        const store = queue.shift();
        const target = sharedContext || browser;
        const promise = runStoreTests(target, store, testIds, sendEvent, { sharedContext: !!sharedContext })
          .catch(err => sendEvent({ type: 'error', message: `Store ${store.newStore} failed: ${err.message}` }))
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

  if (sharedContext) try { await sharedContext.close(); } catch (_) {}
  if (browser) try { await browser.close(); } catch (_) {}
}

module.exports = { runTests, runStoreTests, TEST_REGISTRY };
