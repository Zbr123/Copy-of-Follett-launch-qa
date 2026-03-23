const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

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
    description: 'Search "print rental", select Rent New/Used, add to bag, verify bag count',
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
  'pickup-name-validation': {
    name: 'Pickup Name Validation',
    description: 'Verify pickup location name does not contain a numerical store ID',
    run: testPickupNameValidation,
  },
  'page-content-migration': {
    name: 'Page and Content Migration',
    description: 'Verify 21 content checks: logo, hours, address, pages, footer links, Terms/Privacy/Cookie/DNS',
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
};

function screenshotPath(storeName, testId, suffix) {
  const safe = storeName.replace(/[^a-z0-9]/gi, '_');
  return path.join(SCREENSHOTS_DIR, `${safe}_${testId}_${suffix}.png`);
}

function screenshotUrl(filePath) {
  return '/screenshots/' + path.basename(filePath);
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

  const navCollectionLinks = await page.$$('a[href*="/collections/"]');
  if (navCollectionLinks.length > 0) {
    for (const link of navCollectionLinks) {
      const href = await link.getAttribute('href');
      if (href && href.match(/\/collections\/[^/?]+/)) {
        collectionUrl = buildCollectionUrl(href);
        emit({ step: `Found collection in navigation: ${href}` });
        break;
      }
    }
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
  emit({ step: 'Finding a product to add to cart...' });

  const origin = storeOrigin(store.newStore);

  // Navigate to collections/all to find a product
  await page.goto(`${origin}/collections/all`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Find first visible product link
  const productLinks = await page.$$('a[href*="/products/"]');
  let href = null;
  for (const link of productLinks) {
    const visible = await link.isVisible().catch(() => false);
    if (!visible) continue;
    href = await link.getAttribute('href');
    if (href) break;
  }

  if (!href) {
    return { passed: false, message: 'No visible product found to test add-to-cart' };
  }

  emit({ step: `Navigating to product: ${href}` });
  await page.goto(href.startsWith('http') ? href : `${origin}${href}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  const pdpShot = screenshotPath(store.newStore, 'cart-add', '01_product');
  await page.screenshot({ path: pdpShot, fullPage: false });
  emit({ screenshot: screenshotUrl(pdpShot), label: 'Product page' });

  // Hide Shopify preview bar if present
  await page.evaluate(() => {
    const bar = document.getElementById('preview-bar-iframe') || document.querySelector('[id*="preview-bar"]');
    if (bar) bar.style.display = 'none';
    // Also hide any sticky bottom bars
    const shopifyBar = document.querySelector('#shopify-section-header-group, .preview-bar');
    if (shopifyBar) shopifyBar.style.position = 'relative';
  });

  // Click add to cart/bag using page.evaluate to avoid interception
  emit({ step: 'Clicking Add to Cart/Bag...' });
  const addClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toUpperCase();
      if ((text.includes('ADD TO BAG') || text.includes('ADD TO CART'))
          && btn.offsetParent !== null && btn.offsetWidth > 0 && !btn.disabled) {
        btn.click();
        return text.substring(0, 30);
      }
    }
    // Fallback: try form submit button
    const form = document.querySelector('form[action*="/cart/add"]');
    if (form) {
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn && submitBtn.offsetParent !== null) {
        submitBtn.click();
        return 'FORM SUBMIT';
      }
    }
    return null;
  });

  if (!addClicked) {
    return { passed: false, message: 'Could not find Add to Cart/Bag button' };
  }

  emit({ step: `Clicked: "${addClicked}"` });
  await page.waitForTimeout(2000);

  // Close cart drawer if it opened
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.cart-drawer__close, [aria-label="Close cart"], button.close, .drawer__close');
    if (closeBtn) closeBtn.click();
    const dialog = document.querySelector('dialog[open].cart-drawer__dialog');
    if (dialog && dialog.close) dialog.close();
  });

  const cartShot = screenshotPath(store.newStore, 'cart-add', '02_after_add');
  await page.screenshot({ path: cartShot, fullPage: false });
  emit({ screenshot: screenshotUrl(cartShot), label: 'After Add to Cart' });

  // Verify cart has items
  const cartRes = await page.goto(`${storeOrigin(store.newStore)}/cart.json`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  const cartData = await cartRes.json().catch(() => null);
  const itemCount = cartData?.item_count || 0;

  if (itemCount > 0) {
    return { passed: true, message: `Add to cart successful. Cart has ${itemCount} item(s).` };
  }
  return { passed: false, message: 'Add to cart clicked but cart is empty' };
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
  const searchUrl = `${origin}/search?q=${encodeURIComponent('print rental')}`;
  emit({ step: `Navigating to search: ${searchUrl}` });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const resultsShot = screenshotPath(store.newStore, 'rental-collateral', '02_search_results');
  await page.screenshot({ path: resultsShot, fullPage: false });
  emit({ screenshot: screenshotUrl(resultsShot), label: 'Search results' });

  // Step 3: Try up to 5 products from search results by position
  const MAX_PRODUCTS = 10;
  let rentalSuccess = false;

  for (let attempt = 0; attempt < MAX_PRODUCTS; attempt++) {
    // Go back to search results page each time
    if (attempt > 0) {
      emit({ step: `Returning to search results for product #${attempt + 1}...` });
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    // Get all visible product links on the search page right now
    const productLinks = await page.$$('a[href*="/products/"]');
    const visibleLinks = [];
    const seenPaths = new Set();

    for (const link of productLinks) {
      const visible = await link.isVisible().catch(() => false);
      if (!visible) continue;
      const href = await link.getAttribute('href');
      const cleanPath = href.split('?')[0];
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      visibleLinks.push(href);
    }

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

    // Strategy 2: Find by label text containing RENT (case-insensitive search)
    if (!rentOption) {
      const allElements = await page.$$('label, input[type="checkbox"], input[type="radio"], button, a, span, div[role="button"], [role="option"]');
      for (const el of allElements) {
        const text = await el.textContent().catch(() => '');
        const upperText = (text || '').toUpperCase();
        if (upperText.includes('RENT NEW') || upperText.includes('RENT USED')) {
          const vis = await el.isVisible().catch(() => false);
          if (vis) {
            rentOption = el;
            emit({ step: `[Product ${attempt + 1}] Found: "${text.trim().substring(0, 50)}"` });
            break;
          }
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

  const checkoutIssues = [];
  if (!hasRecurringSubtotal) {
    checkoutIssues.push('"Recurring subtotal" not found on checkout page');
  }
  if (!hasCollateralOnCheckout) {
    checkoutIssues.push('"Rental Collateral" not found on checkout page');
  }
  if (!hasRentalLoginMessage) {
    checkoutIssues.push('"You must be logged in to purchase rental items. Please log in to continue." message not found on checkout page');
  }

  if (checkoutIssues.length > 0) {
    // Scroll down and take another screenshot in case content is below fold
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);
    const checkoutShot2 = screenshotPath(store.newStore, 'rental-collateral', '08_checkout_scrolled');
    await page.screenshot({ path: checkoutShot2, fullPage: false });
    emit({ screenshot: screenshotUrl(checkoutShot2), label: 'Checkout page (scrolled)' });

    return { passed: false, message: `Checkout validation failed: ${checkoutIssues.join('; ')}` };
  }

  emit({ step: 'Checkout validated — recurring subtotal, Rental Collateral, and rental login message all present' });

  return {
    passed: true,
    message: `Rental flow complete. Cart: ${bagCount} items (${cartItemNames.join(', ')}). Checkout has recurring subtotal, Rental Collateral, and rental login message.`,
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
  const MAX_PRODUCTS = 10;
  let addedSuccess = false;
  let addedProductName = '';

  for (let attempt = 0; attempt < MAX_PRODUCTS; attempt++) {
    if (attempt > 0) {
      emit({ step: `Returning to search results for product #${attempt + 1}...` });
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    // Get visible product links
    const productLinks = await page.$$('a[href*="/products/"]');
    const visibleLinks = [];
    const seenPaths = new Set();

    for (const link of productLinks) {
      const visible = await link.isVisible().catch(() => false);
      if (!visible) continue;
      const href = await link.getAttribute('href');
      const cleanPath = href.split('?')[0];
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      visibleLinks.push(href);
    }

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
  emit({ step: 'Waiting for Digital Delivery Fee to be auto-added to cart...' });
  await page.waitForTimeout(5000);

  let cartData = null;
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
  await page.waitForTimeout(3000);

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

  const checkoutIssues = [];
  if (!hasFeeOnCheckout) {
    checkoutIssues.push('"Digital Delivery Fee" not found on checkout page');
  }
  if (!hasProductOnCheckout) {
    checkoutIssues.push(`Product "${addedProductName}" not found on checkout page`);
  }

  if (checkoutIssues.length > 0) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);
    const checkoutShot2 = screenshotPath(store.newStore, 'digital-delivery-fee', '05_checkout_scrolled');
    await page.screenshot({ path: checkoutShot2, fullPage: false });
    emit({ screenshot: screenshotUrl(checkoutShot2), label: 'Checkout page (scrolled)' });

    return { passed: false, message: `Checkout validation failed: ${checkoutIssues.join('; ')}` };
  }

  emit({ step: 'Checkout validated — Digital Delivery Fee and product both present' });

  return {
    passed: true,
    message: `Digital delivery flow complete. Cart: ${bagCount} items. Digital Delivery Fee: ${deliveryFeePrice}. Both items confirmed on checkout.`,
  };
}

async function testCheckoutValidation(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  // Step 1: Add any item to cart
  emit({ step: 'Finding a product to add to cart...' });
  const searchUrl = `${origin}/search?q=${encodeURIComponent('textbook')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  let addedToCart = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    const productLinks = await page.$$('a[href*="/products/"]');
    const visibleLinks = [];
    const seenPaths = new Set();

    for (const link of productLinks) {
      const visible = await link.isVisible().catch(() => false);
      if (!visible) continue;
      const href = await link.getAttribute('href');
      const cleanPath = href.split('?')[0];
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      visibleLinks.push(href);
    }

    if (attempt >= visibleLinks.length) break;

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Trying: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const allElements = await page.$$('label, input[type="checkbox"], input[type="radio"]');
    for (const el of allElements) {
      const text = await el.textContent().catch(() => '');
      const upperText = (text || '').toUpperCase().trim();
      if (/^(BUY|RENT)(\s|$)/.test(upperText) || upperText.includes('BUY NEW') || upperText.includes('BUY USED') || upperText.includes('RENT NEW') || upperText.includes('RENT USED')) {
        const vis = await el.isVisible().catch(() => false);
        if (vis) {
          try { await el.click({ timeout: 3000 }); } catch {}
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    const addBtn = await page.$(
      'button[type="submit"]:has-text("Add to bag"), button[type="submit"]:has-text("Add to Bag"), ' +
      'button:has-text("Add to Bag"), button:has-text("Add to bag"), ' +
      'button:has-text("Add to Cart"), button:has-text("Add to cart"), ' +
      'button[name="add"], form[action*="/cart/add"] button[type="submit"]'
    );

    if (addBtn) {
      const isDisabled = await addBtn.isDisabled().catch(() => false);
      if (!isDisabled) {
        emit({ step: `[Product ${attempt + 1}] Clicking Add to Bag...` });
        await addBtn.click();
        await page.waitForTimeout(2000);
        addedToCart = true;
        break;
      }
    }

    emit({ step: `[Product ${attempt + 1}] Could not add — trying next...` });
  }

  if (!addedToCart) {
    const failShot = screenshotPath(store.newStore, 'checkout-validation', '01_no_add');
    await page.screenshot({ path: failShot, fullPage: false });
    emit({ screenshot: screenshotUrl(failShot), label: 'Could not add any item' });
    return { passed: false, message: 'Could not add any item to cart to test checkout' };
  }

  // Step 2: Navigate to checkout
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  emit({ step: 'Waiting for checkout to fully load...' });
  await page.waitForTimeout(4000);

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

  if (issues.length > 0) {
    emit({ step: `Validation failed: ${issues.join('; ')}` });
    return { passed: false, message: issues.join('; ') };
  }

  emit({ step: 'All checkout validations passed' });
  return {
    passed: true,
    message: `Financial Aid placement correct ✓. First Name: not optional ✓. Phone: required ✓. Follett disclaimer with linked Terms/Privacy/Cookie above Pay Now ✓. Section order: ${sectionOrder.map(s => s.name).join(' → ')}`,
  };
}

async function testPickupNameValidation(page, store, emit) {
  const origin = storeOrigin(store.newStore);

  // Step 1: Add any item to cart
  emit({ step: 'Finding a product to add to cart...' });
  const searchUrl = `${origin}/search?q=${encodeURIComponent('textbook')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  let addedToCart = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    const productLinks = await page.$$('a[href*="/products/"]');
    const visibleLinks = [];
    const seenPaths = new Set();

    for (const link of productLinks) {
      const visible = await link.isVisible().catch(() => false);
      if (!visible) continue;
      const href = await link.getAttribute('href');
      const cleanPath = href.split('?')[0];
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      visibleLinks.push(href);
    }

    if (attempt >= visibleLinks.length) break;

    const productHref = visibleLinks[attempt];
    const productUrl = productHref.startsWith('http') ? productHref : `${origin}${productHref}`;
    emit({ step: `[Product ${attempt + 1}] Trying: ${productHref}` });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const allElements = await page.$$('label, input[type="checkbox"], input[type="radio"]');
    for (const el of allElements) {
      const text = await el.textContent().catch(() => '');
      const upperText = (text || '').toUpperCase().trim();
      if (/^(BUY|RENT)(\s|$)/.test(upperText) || upperText.includes('BUY NEW') || upperText.includes('BUY USED') || upperText.includes('RENT NEW') || upperText.includes('RENT USED')) {
        const vis = await el.isVisible().catch(() => false);
        if (vis) {
          try { await el.click({ timeout: 3000 }); } catch {}
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    const addBtn = await page.$(
      'button[type="submit"]:has-text("Add to bag"), button[type="submit"]:has-text("Add to Bag"), ' +
      'button:has-text("Add to Bag"), button:has-text("Add to bag"), ' +
      'button:has-text("Add to Cart"), button:has-text("Add to cart"), ' +
      'button[name="add"], form[action*="/cart/add"] button[type="submit"]'
    );

    if (addBtn) {
      const isDisabled = await addBtn.isDisabled().catch(() => false);
      if (!isDisabled) {
        emit({ step: `[Product ${attempt + 1}] Clicking Add to Bag...` });
        await addBtn.click();
        await page.waitForTimeout(2000);
        addedToCart = true;
        break;
      }
    }

    emit({ step: `[Product ${attempt + 1}] Could not add — trying next...` });
  }

  if (!addedToCart) {
    const failShot = screenshotPath(store.newStore, 'pickup-name-validation', '01_no_add');
    await page.screenshot({ path: failShot, fullPage: false });
    emit({ screenshot: screenshotUrl(failShot), label: 'Could not add any item' });
    return { passed: false, message: 'Could not add any item to cart to test checkout' };
  }

  // Step 2: Navigate to checkout
  emit({ step: 'Navigating to checkout...' });
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  emit({ step: 'Waiting for checkout to fully load...' });
  await page.waitForTimeout(4000);

  const checkoutShot = screenshotPath(store.newStore, 'pickup-name-validation', '02_checkout');
  await page.screenshot({ path: checkoutShot, fullPage: false });
  emit({ screenshot: screenshotUrl(checkoutShot), label: 'Checkout page' });

  // Step 3: Click "Pick up" radio under Delivery
  emit({ step: 'Looking for "Pick up" delivery option...' });

  const pickupRadio = await page.$('input[type="radio"][value*="ick" i], label:has-text("Pick up") input[type="radio"]');
  let pickupClicked = false;

  if (pickupRadio) {
    emit({ step: 'Found "Pick up" radio — clicking...' });
    await pickupRadio.click();
    pickupClicked = true;
  } else {
    // Try clicking a label that says "Pick up"
    const pickupLabel = await page.$('label:has-text("Pick up")');
    if (pickupLabel) {
      emit({ step: 'Found "Pick up" label — clicking...' });
      await pickupLabel.click();
      pickupClicked = true;
    }
  }

  if (!pickupClicked) {
    // Fallback: search all radio buttons for Pick up text
    const radios = await page.$$('input[type="radio"]');
    for (const radio of radios) {
      const label = await page.$(`label[for="${await radio.getAttribute('id')}"]`);
      const labelText = label ? await label.textContent().catch(() => '') : '';
      const ariaLabel = await radio.getAttribute('aria-label') || '';
      if (labelText.toLowerCase().includes('pick up') || ariaLabel.toLowerCase().includes('pick up')) {
        emit({ step: 'Found "Pick up" radio via label search — clicking...' });
        await radio.click();
        pickupClicked = true;
        break;
      }
    }
  }

  if (!pickupClicked) {
    const noPickupShot = screenshotPath(store.newStore, 'pickup-name-validation', '02b_no_pickup');
    await page.screenshot({ path: noPickupShot, fullPage: false });
    emit({ screenshot: screenshotUrl(noPickupShot), label: 'No Pick up option' });
    return { passed: false, message: '"Pick up" delivery option not found on checkout page' };
  }

  // Wait for pickup locations to load
  emit({ step: 'Waiting for pickup locations to load...' });
  await page.waitForTimeout(3000);

  const pickupShot = screenshotPath(store.newStore, 'pickup-name-validation', '03_pickup_selected');
  await page.screenshot({ path: pickupShot, fullPage: false });
  emit({ screenshot: screenshotUrl(pickupShot), label: 'Pick up selected' });

  // Step 4: Extract pickup location names
  emit({ step: 'Extracting pickup location names...' });

  const pickupData = await page.evaluate(() => {
    const body = document.body.innerText;
    const locations = [];

    // Look for pickup location text — typically appears after selecting "Pick up"
    // Shopify shows location names in radio labels, headings, or generic text blocks
    // We need to find text that looks like a location name

    // Strategy 1: Find all text near pickup-related elements
    const allElements = document.querySelectorAll(
      '[class*="pickup"], [class*="location"], [data-pickup], [data-location], ' +
      '[aria-label*="ickup"], [aria-label*="ocation"]'
    );
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text && text.length > 0 && text.length < 200) {
        locations.push({ source: 'pickup-element', text });
      }
    }

    // Strategy 2: Find radio labels that might be location names (after delivery section)
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      const label = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
      if (label) {
        const text = label.textContent.trim();
        // Skip known non-location radios
        if (text.includes('Ship') || text.includes('Pick up') || text.includes('Standard') ||
            text.includes('Business Day') || text.includes('Express') || text.includes('Visa') ||
            text.includes('American Express') || text.includes('Mastercard')) continue;
        if (text.length > 0 && text.length < 200) {
          locations.push({ source: 'radio-label', text });
        }
      }
    }

    // Strategy 3: Look for headings or text blocks mentioning "pick up" or "store"
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
    for (const h of headings) {
      const text = h.textContent.trim();
      if (text.toLowerCase().includes('pick up') || text.toLowerCase().includes('pickup') ||
          text.toLowerCase().includes('store location')) {
        locations.push({ source: 'heading', text });
      }
    }

    // Strategy 4: Broader scan — find any text block that appears after "Pick up" content
    // that could be a location name
    const allText = body;
    const pickupIdx = allText.toLowerCase().indexOf('pick up');
    let pickupSectionText = '';
    if (pickupIdx >= 0) {
      // Grab a chunk of text after "Pick up" to analyze
      pickupSectionText = allText.substring(pickupIdx, Math.min(pickupIdx + 500, allText.length));
    }

    return { locations, pickupSectionText };
  });

  emit({ step: `Found ${pickupData.locations.length} potential location elements` });
  if (pickupData.pickupSectionText) {
    emit({ step: `Pickup section text: "${pickupData.pickupSectionText.substring(0, 150)}..."` });
  }

  // Step 5: Check all pickup-related text for numerical store IDs
  // A numerical value like "0913", "0300", etc. indicates a store number instead of a name
  const numericalPattern = /\b\d{3,5}\b/; // 3-5 digit numbers that look like store IDs
  const issues = [];
  const locationTexts = [];

  // Check locations found
  for (const loc of pickupData.locations) {
    locationTexts.push(loc.text);
    const numericalMatch = loc.text.match(numericalPattern);
    if (numericalMatch) {
      // Filter out legitimate numbers (zip codes, phone numbers, prices, addresses)
      const isZipCode = /\b\d{5}(-\d{4})?\b/.test(loc.text) && (loc.text.includes(',') || loc.text.includes('US') || loc.text.includes('CA'));
      const isPrice = loc.text.includes('$');
      const isAddress = /\d+\s+\w+\s+(st|street|ave|avenue|rd|road|dr|drive|blvd|ln|lane|way|ct|court)/i.test(loc.text);

      if (!isZipCode && !isPrice && !isAddress) {
        issues.push(`Location text contains numerical ID "${numericalMatch[0]}": "${loc.text.substring(0, 80)}"`);
      }
    }
  }

  // Also check the broader pickup section text
  if (pickupData.pickupSectionText) {
    // Look for patterns like "0300" or "0913" that appear as standalone store numbers
    const storeIdPattern = /\b0\d{2,4}\b/; // Numbers starting with 0 like 0300, 0913
    const match = pickupData.pickupSectionText.match(storeIdPattern);
    if (match) {
      // Make sure it's not part of an address or zip code
      const context = pickupData.pickupSectionText.substring(
        Math.max(0, pickupData.pickupSectionText.indexOf(match[0]) - 20),
        pickupData.pickupSectionText.indexOf(match[0]) + match[0].length + 20
      );
      const isZipOrAddress = /\d{5}/.test(context) && (context.includes(',') || context.includes('US'));
      if (!isZipOrAddress) {
        issues.push(`Pickup section contains numerical store ID "${match[0]}" in: "${context.trim()}"`);
      }
    }
  }

  // Scroll to show pickup area
  await page.evaluate(() => {
    const pickup = document.querySelector('[class*="pickup"], [class*="location"], label:has(input[type="radio"]:checked)');
    if (pickup) pickup.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);

  const pickupDetailShot = screenshotPath(store.newStore, 'pickup-name-validation', '04_pickup_detail');
  await page.screenshot({ path: pickupDetailShot, fullPage: false });
  emit({ screenshot: screenshotUrl(pickupDetailShot), label: 'Pickup location detail' });

  if (issues.length > 0) {
    emit({ step: `VALIDATION FAILED: ${issues.join('; ')}` });
    return {
      passed: false,
      message: `Pickup location contains numerical store ID: ${issues.join('; ')}`,
    };
  }

  if (locationTexts.length === 0 && !pickupData.pickupSectionText) {
    return { passed: false, message: 'Could not find any pickup location text to validate' };
  }

  emit({ step: 'Pickup location names validated — no numerical store IDs found' });
  return {
    passed: true,
    message: `Pickup location names are clean (no numerical IDs). Locations found: ${locationTexts.join('; ') || pickupData.pickupSectionText.substring(0, 100)}`,
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

  const footerText = await page.evaluate(() => {
    const footer = document.querySelector('footer');
    return footer ? footer.innerText : document.body.innerText.slice(-2000);
  });
  const upperFooter = footerText.toUpperCase();
  const isCanada = upperFooter.includes('CANADA') || upperFooter.includes(' ON ') || upperFooter.includes(' AB ') || upperFooter.includes(' BC ') || upperFooter.includes(' QC ') || upperFooter.includes(' MB ') || upperFooter.includes(' SK ') || upperFooter.includes(' NS ');
  const country = isCanada ? 'Canada' : 'US';
  emit({ step: `Detected store country: ${country}` });

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
  await page.waitForTimeout(1500);

  // Scroll to footer to find store hours
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

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

  // ── Helper: go to homepage footer and gather all footer link info ──
  async function getFooterLinks() {
    await page.goto(newOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    return await page.evaluate(() => {
      const footer = document.querySelector('footer');
      if (!footer) return [];
      const links = footer.querySelectorAll('a');
      return Array.from(links).map(a => ({
        text: (a.textContent || '').trim(),
        href: a.getAttribute('href') || '',
        visible: a.offsetParent !== null && a.offsetWidth > 0 && a.offsetHeight > 0,
      }));
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
  function footerLinkExists(textPattern, hrefPattern) {
    return footerLinks.some(l => {
      const textMatch = textPattern ? textPattern.test(l.text) : true;
      const hrefMatch = hrefPattern ? hrefPattern.test(l.href) : true;
      return l.visible && textMatch && hrefMatch;
    });
  }

  // Helper: combined footer + page check
  async function checkFooterAndPage(checkNumber, name, footerTextRegex, footerHrefRegex, pagePath, shotId) {
    emit({ step: `Check ${checkNumber}: Verifying ${name}...` });

    const inFooter = footerLinkExists(footerTextRegex, footerHrefRegex);
    const fullUrl = `${newOrigin}${pagePath}`;
    const exists = await pageExists(page, fullUrl, name);

    if (exists) {
      const shot = screenshotPath(store.newStore, 'page-content-migration', shotId);
      await page.screenshot({ path: shot, fullPage: false });
      emit({ screenshot: screenshotUrl(shot), label: `${name} page` });
    }

    const passed = inFooter && exists;
    record(name, passed,
      `Footer link: ${inFooter ? 'visible' : 'NOT found'}, Page at ${fullUrl}: ${exists ? 'loads' : 'NOT found'}`
    );
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
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  const cookieLink = await page.$('footer a:has-text("Cookie"), footer button:has-text("Cookie")');
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
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  const dnsLink = await page.$('footer a:has-text("Do Not Sell"), footer button:has-text("Do Not Sell"), footer a:has-text("Do not sell")');
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
  await page.waitForTimeout(2000);

  const bannerShot = screenshotPath(store.newStore, 'homepage-plp-pdp', '01_homepage');
  await page.screenshot({ path: bannerShot, fullPage: false });
  emit({ screenshot: screenshotUrl(bannerShot), label: 'Homepage' });

  const bannerAnalysis = await page.evaluate((storeOrigin) => {
    // Look for banner/hero links — typically large clickable areas at top of page
    const bannerSelectors = [
      '.hero a', '.banner a', '.slideshow a', '[class*="hero"] a', '[class*="banner"] a',
      '[class*="slide"] a', '.carousel a', '[class*="carousel"] a',
      'section:first-of-type a[href]', '.shopify-section:first-of-type a[href]',
      'a[href*="/collections/"]', 'a[href*="/products/"]', 'a[href*="/pages/"]',
    ];

    const results = { bannerLinks: [], hasInternalBanner: false, hasExternalBanner: false };

    for (const sel of bannerSelectors) {
      const links = document.querySelectorAll(sel);
      for (const a of links) {
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

  // Find a collection link from navigation
  let collectionUrl = null;
  const navCollectionLinks = await page.$$('a[href*="/collections/"]');
  for (const link of navCollectionLinks) {
    const href = await link.getAttribute('href');
    if (href && href.match(/\/collections\/[^/?]+/)) {
      collectionUrl = href.startsWith('http') ? href : `${origin}${href.split('?')[0]}`;
      break;
    }
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

    const productLinks = await page.$$('a[href*="/products/"]');
    const visibleLinks = [];
    const seenPaths = new Set();

    for (const link of productLinks) {
      const visible = await link.isVisible().catch(() => false);
      if (!visible) continue;
      const href = await link.getAttribute('href');
      const cleanPath = href.split('?')[0];
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      visibleLinks.push(href);
    }

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

  // Step 3: Select Term (first non-default option)
  // Wait for dropdowns to fully load
  emit({ step: 'Waiting for dropdowns to load...' });
  await page.waitForTimeout(3000);

  emit({ step: 'Selecting Term...' });

  const termSelected = await page.evaluate(() => {
    const selects = document.querySelectorAll('select');
    const termSelect = Array.from(selects).find(s => s.id === 'term' && s.options.length > 1 && !s.className.includes('mobile'));
    if (!termSelect || termSelect.options.length < 2) return null;
    const opt = termSelect.options[1];
    termSelect.value = opt.value;
    termSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.text;
  });

  if (!termSelected) {
    return { passed: false, message: 'Could not select a Term — no options available' };
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

    // Get available departments
    const departments = await page.evaluate(() => {
      const dept = document.querySelector('select#department');
      if (!dept) return [];
      return Array.from(dept.options)
        .filter(o => o.value !== '' && o.value !== 'Department')
        .map(o => ({ text: o.text, value: o.value }));
    });

    if (departments.length === 0) {
      emit({ step: `[Attempt ${attempt + 1}] No departments available` });
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

// ─── Main runner ────────────────────────────────────────────────────

async function runTests(stores, testIds, sendEvent) {
  const browser = await chromium.launch({ headless: true });

  for (const store of stores) {
    sendEvent({
      type: 'store-start',
      store: store.newStore,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Always do login first if any test is selected
    let loginDone = false;

    for (const testId of testIds) {
      const test = TEST_REGISTRY[testId];
      if (!test) continue;

      // Ensure login happens before other tests
      if (!loginDone && testId !== 'storefront-login') {
        const loginTest = TEST_REGISTRY['storefront-login'];
        sendEvent({ type: 'test-start', store: store.newStore, testId: 'storefront-login', testName: loginTest.name });
        try {
          const loginResult = await loginTest.run(page, store, (data) =>
            sendEvent({ type: 'test-progress', store: store.newStore, testId: 'storefront-login', ...data })
          );
          sendEvent({ type: 'test-result', store: store.newStore, testId: 'storefront-login', ...loginResult });
          loginDone = true;
          if (!loginResult.passed) {
            sendEvent({
              type: 'test-result',
              store: store.newStore,
              testId,
              passed: false,
              message: 'Skipped — login failed',
            });
            continue;
          }
        } catch (err) {
          sendEvent({
            type: 'test-result',
            store: store.newStore,
            testId: 'storefront-login',
            passed: false,
            message: `Login error: ${err.message}`,
          });
          sendEvent({
            type: 'test-result',
            store: store.newStore,
            testId,
            passed: false,
            message: 'Skipped — login failed',
          });
          continue;
        }
      }

      if (testId === 'storefront-login' && loginDone) continue;

      sendEvent({ type: 'test-start', store: store.newStore, testId, testName: test.name });
      try {
        const result = await test.run(page, store, (data) =>
          sendEvent({ type: 'test-progress', store: store.newStore, testId, ...data })
        );
        sendEvent({ type: 'test-result', store: store.newStore, testId, ...result });
        if (testId === 'storefront-login') loginDone = true;
      } catch (err) {
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
          passed: false,
          message: `Error: ${err.message}`,
        });
      }
    }

    await context.close();
    sendEvent({ type: 'store-complete', store: store.newStore });
  }

  await browser.close();
}

module.exports = { runTests, TEST_REGISTRY };
