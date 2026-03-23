const express = require('express');
const path = require('path');
const fs = require('fs');
const { runTests } = require('./test-runner');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// SSE endpoint for real-time test results
app.post('/api/run-tests', async (req, res) => {
  const { stores, tests } = req.body;

  if (!stores || !stores.length) {
    return res.status(400).json({ error: 'No stores provided' });
  }
  if (!tests || !tests.length) {
    return res.status(400).json({ error: 'No tests selected' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runTests(stores, tests, sendEvent);
    sendEvent({ type: 'complete' });
  } catch (err) {
    sendEvent({ type: 'error', message: err.message });
  }

  res.end();
});

// PDF report generation endpoint
app.post('/api/generate-pdf', async (req, res) => {
  const { results, totalTests, passedTests, failedTests } = req.body;
  if (!results || !results.length) {
    return res.status(400).json({ error: 'No results provided' });
  }

  // Read logo as base64
  let logoBase64 = '';
  try {
    const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'p3-logo.png'));
    logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;
  } catch (_) {}

  // Convert screenshot paths to base64
  const screenshotCache = {};
  for (const r of results) {
    for (const s of (r.screenshots || [])) {
      if (s.src && !screenshotCache[s.src]) {
        try {
          const filePath = path.join(__dirname, s.src.replace(/^\//, ''));
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            screenshotCache[s.src] = `data:image/png;base64,${buf.toString('base64')}`;
          }
        } catch (_) {}
      }
    }
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Group by store
  const groups = {};
  results.forEach(r => { (groups[r.store] = groups[r.store] || []).push(r); });
  const storeCount = Object.keys(groups).length;

  const html = buildPdfHtml({
    logoBase64, results, groups, totalTests, passedTests, failedTests,
    storeCount, dateStr, timeStr, screenshotCache,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
      preferCSSPageSize: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Follett-QA-Report-${now.toISOString().slice(0,10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

function buildPdfHtml({ logoBase64, results, groups, totalTests, passedTests, failedTests, storeCount, dateStr, timeStr, screenshotCache }) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const truncateUrl = s => {
    try { return new URL(s.startsWith('http') ? s : `https://${s}`).hostname; } catch (_) { return s.replace(/[?#].*$/, '').replace(/\/.*$/, ''); }
  };
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #1d1d1f;
    font-size: 10px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Cover Page ── */
  .cover {
    width: 210mm; height: 297mm;
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    background: #000;
    color: #fff;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover::before {
    content: '';
    position: absolute;
    top: -50%; left: -50%;
    width: 200%; height: 200%;
    background: radial-gradient(ellipse at 30% 50%, rgba(255,255,255,0.03) 0%, transparent 70%);
  }
  .cover-logo { width: 72px; height: 72px; margin-bottom: 40px; border-radius: 16px; position: relative; z-index: 1; filter: invert(1); }
  .cover-title { font-size: 42px; font-weight: 800; letter-spacing: -1.5px; margin-bottom: 8px; position: relative; z-index: 1; }
  .cover-subtitle { font-size: 16px; font-weight: 400; color: rgba(255,255,255,0.5); letter-spacing: 0.5px; margin-bottom: 60px; position: relative; z-index: 1; }
  .cover-meta { font-size: 13px; color: rgba(255,255,255,0.35); position: relative; z-index: 1; }
  .cover-stats {
    display: flex; gap: 48px; margin-bottom: 48px; position: relative; z-index: 1;
  }
  .cover-stat { text-align: center; }
  .cover-stat .val { font-size: 48px; font-weight: 800; letter-spacing: -2px; }
  .cover-stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.4); margin-top: 4px; }
  .cover-stat .val.green { color: #30d158; }
  .cover-stat .val.red { color: #ff453a; }
  .cover-stat .val.white { color: #fff; }

  /* ── Content Pages ── */
  .page {
    width: 210mm;
    min-height: 297mm;
    padding: 24mm 20mm 20mm 20mm;
    page-break-after: always;
    position: relative;
  }
  .page:last-child { page-break-after: auto; }

  .page-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; margin-bottom: 20px;
    border-bottom: 0.5px solid #d2d2d7;
  }
  .page-header-left { display: flex; align-items: center; gap: 8px; }
  .page-header-logo { width: 18px; height: 18px; border-radius: 4px; }
  .page-header-text { font-size: 9px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 1px; }
  .page-header-date { font-size: 9px; color: #86868b; }

  /* ── Executive Summary ── */
  .exec-title { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 24px; }
  .exec-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px; margin-bottom: 28px;
  }
  .exec-card {
    background: #f5f5f7; border-radius: 12px; padding: 20px; text-align: center;
  }
  .exec-card .num { font-size: 32px; font-weight: 800; letter-spacing: -1px; }
  .exec-card .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #86868b; font-weight: 700; margin-top: 4px; }
  .exec-card .num.green { color: #34c759; }
  .exec-card .num.red { color: #ff3b30; }

  .pass-rate-bar {
    background: #f5f5f7; border-radius: 12px; padding: 16px 20px; margin-bottom: 28px;
    display: flex; align-items: center; gap: 16px;
  }
  .pass-rate-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; white-space: nowrap; }
  .pass-rate-track { flex: 1; height: 8px; background: #e5e5ea; border-radius: 4px; overflow: hidden; }
  .pass-rate-fill { height: 100%; border-radius: 4px; background: #34c759; }
  .pass-rate-pct { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }

  /* ── Store Overview Table ── */
  .overview-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin-bottom: 12px; }
  .overview-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  .overview-table th {
    text-align: left; padding: 10px 12px; font-size: 9px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #86868b;
    border-bottom: 1px solid #d2d2d7; background: #fafafa;
  }
  .overview-table td { padding: 10px 12px; font-size: 11px; border-bottom: 0.5px solid #e5e5ea; }
  .overview-table .store-name { font-weight: 600; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.pass { background: #34c759; }
  .dot.fail { background: #ff3b30; }
  .dot.warn { background: #ff9f0a; }

  /* ── Store Detail Sections ── */
  .store-section { margin-bottom: 28px; }
  .store-title {
    font-size: 20px; font-weight: 800; letter-spacing: -0.3px;
    padding-bottom: 8px; border-bottom: 2px solid #1d1d1f; margin-bottom: 16px;
    display: flex; align-items: center; gap: 10px;
  }
  .store-title .dot { width: 10px; height: 10px; }

  .test-card {
    border: 0.5px solid #d2d2d7; border-radius: 10px; margin-bottom: 12px;
    overflow: hidden; page-break-inside: avoid;
  }
  .test-card-header {
    padding: 12px 16px; display: flex; align-items: center; gap: 10px;
    background: #fafafa; border-bottom: 0.5px solid #e5e5ea;
  }
  .test-card-name { font-size: 13px; font-weight: 700; flex: 1; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 5px; font-size: 9px; font-weight: 800; letter-spacing: 0.3px; }
  .badge.pass { background: #d1fae5; color: #065f46; }
  .badge.fail { background: #fee2e2; color: #991b1b; }

  .test-card-body { padding: 14px 16px; }
  .test-message { font-size: 11px; color: #1d1d1f; line-height: 1.6; margin-bottom: 10px; }

  /* ── Sub-checks Table ── */
  .checks-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin-bottom: 8px; }
  .checks-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .checks-table th {
    text-align: left; padding: 6px 10px; font-size: 8px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #86868b;
    border-bottom: 0.5px solid #d2d2d7; background: #fafafa;
  }
  .checks-table td { padding: 7px 10px; font-size: 10px; border-bottom: 0.5px solid #f0f0f0; }
  .checks-table tr.fail td { background: #fff5f5; }
  .check-name { font-weight: 600; }
  .check-status { font-weight: 700; font-size: 9px; }
  .check-status.pass { color: #34c759; }
  .check-status.fail { color: #ff3b30; }

  /* ── Screenshots ── */
  .screenshots-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin: 12px 0 8px; }
  .screenshot-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .screenshot-item { width: 48%; }
  .screenshot-item img { width: 100%; border-radius: 6px; border: 0.5px solid #d2d2d7; display: block; }
  .screenshot-caption { font-size: 8px; color: #86868b; margin-top: 4px; font-weight: 500; }

  /* ── Footer ── */
  .page-footer {
    position: absolute; bottom: 12mm; left: 20mm; right: 20mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 8px; color: #c7c7cc;
    border-top: 0.5px solid #e5e5ea; padding-top: 8px;
  }

  /* ── Disclaimer ── */
  .disclaimer {
    background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 8px 8px 0;
    padding: 12px 16px; margin-bottom: 24px; font-size: 10px; color: #78570a; line-height: 1.6;
  }
  .disclaimer strong { color: #92400e; }
</style></head><body>`;

  // ── Cover Page ──
  html += `
<div class="cover">
  ${logoBase64 ? `<img class="cover-logo" src="${logoBase64}" />` : ''}
  <div class="cover-title">Go Live Report</div>
  <div class="cover-subtitle">Follett Shopify Store Launch Validation</div>
  <div class="cover-stats">
    <div class="cover-stat"><div class="val white">${totalTests}</div><div class="lbl">Tests Run</div></div>
    <div class="cover-stat"><div class="val green">${passedTests}</div><div class="lbl">Passed</div></div>
    <div class="cover-stat"><div class="val red">${failedTests}</div><div class="lbl">Failed</div></div>
    <div class="cover-stat"><div class="val white">${storeCount}</div><div class="lbl">Stores</div></div>
  </div>
  <div class="cover-meta">${dateStr} at ${timeStr} &middot; P3 Media</div>
</div>`;

  // ── Executive Summary Page ──
  html += `
<div class="page">
  <div class="page-header">
    <div class="page-header-left">
      ${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}
      <span class="page-header-text">Follett QA Report</span>
    </div>
    <span class="page-header-date">${dateStr}</span>
  </div>

  <div class="exec-title">Executive Summary</div>

  <div class="exec-grid">
    <div class="exec-card"><div class="num">${storeCount}</div><div class="lbl">Stores Tested</div></div>
    <div class="exec-card"><div class="num">${totalTests}</div><div class="lbl">Total Tests</div></div>
    <div class="exec-card"><div class="num green">${passedTests}</div><div class="lbl">Passed</div></div>
    <div class="exec-card"><div class="num red">${failedTests}</div><div class="lbl">Failed</div></div>
  </div>

  <div class="pass-rate-bar">
    <div class="pass-rate-label">Pass Rate</div>
    <div class="pass-rate-track"><div class="pass-rate-fill" style="width:${passRate}%"></div></div>
    <div class="pass-rate-pct">${passRate}%</div>
  </div>

  <div class="disclaimer">
    <strong>Important:</strong> Automated tests validate element presence, visibility, and basic functionality.
    Each passed check should be manually verified by a QA reviewer before production sign-off.
    This report should be archived for auditing and compliance purposes.
  </div>

  <div class="overview-title">Store Results Overview</div>
  <table class="overview-table">
    <thead><tr><th>Store</th><th>Passed</th><th>Failed</th><th>Status</th></tr></thead>
    <tbody>`;

  for (const [store, tests] of Object.entries(groups)) {
    const sp = tests.filter(t => t.passed).length;
    const sf = tests.filter(t => !t.passed).length;
    const status = sf > 0 ? 'fail' : 'pass';
    html += `
      <tr>
        <td class="store-name">${esc(truncateUrl(store))}</td>
        <td>${sp}</td>
        <td>${sf}</td>
        <td><span class="dot ${status}"></span>${sf > 0 ? 'Needs Attention' : 'All Passed'}</td>
      </tr>`;
  }

  html += `</tbody></table>
  <div class="page-footer">
    <span>P3 Media &middot; Confidential</span>
    <span>Follett Launch QA Report</span>
  </div>
</div>`;

  // ── Store Detail Pages ──
  for (const [store, tests] of Object.entries(groups)) {
    const sf = tests.filter(t => !t.passed).length;
    const storeStatus = sf > 0 ? 'fail' : 'pass';

    html += `
<div class="page">
  <div class="page-header">
    <div class="page-header-left">
      ${logoBase64 ? `<img class="page-header-logo" src="${logoBase64}" />` : ''}
      <span class="page-header-text">Follett QA Report</span>
    </div>
    <span class="page-header-date">${dateStr}</span>
  </div>

  <div class="store-section">
    <div class="store-title">
      <span class="dot ${storeStatus}"></span>
      ${esc(truncateUrl(store))}
    </div>`;

    tests.forEach(t => {
      const status = t.passed ? 'pass' : 'fail';
      html += `
    <div class="test-card">
      <div class="test-card-header">
        <span class="dot ${status}"></span>
        <div class="test-card-name">${esc(t.testName)}</div>
        <span class="badge ${status}">${t.passed ? 'PASS' : 'FAIL'}</span>
      </div>
      <div class="test-card-body">
        <div class="test-message">${esc(t.message)}</div>`;

      // Sub-checks
      if (t.checks && t.checks.length > 0) {
        const cp = t.checks.filter(c => c.passed).length;
        const cf = t.checks.filter(c => !c.passed).length;
        html += `
        <div class="checks-title">Sub-Checks &mdash; ${cp} passed, ${cf} failed</div>
        <table class="checks-table">
          <thead><tr><th style="width:60px">Status</th><th style="width:160px">Check</th><th>Detail</th></tr></thead>
          <tbody>`;
        t.checks.forEach(c => {
          const cs = c.passed ? 'pass' : 'fail';
          html += `
            <tr class="${cs}">
              <td><span class="check-status ${cs}">${c.passed ? 'PASS' : 'FAIL'}</span></td>
              <td class="check-name">${esc(c.name)}</td>
              <td>${esc(c.detail)}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
      }

      // Screenshots
      if (t.screenshots && t.screenshots.length > 0) {
        html += `<div class="screenshots-title">Evidence Screenshots</div><div class="screenshot-grid">`;
        t.screenshots.forEach(s => {
          const imgSrc = screenshotCache[s.src] || s.src;
          html += `
          <div class="screenshot-item">
            <img src="${imgSrc}" />
            <div class="screenshot-caption">${esc(s.label)}</div>
          </div>`;
        });
        html += `</div>`;
      }

      html += `</div></div>`;
    });

    html += `
  </div>
  <div class="page-footer">
    <span>P3 Media &middot; Confidential</span>
    <span>Follett Launch QA Report</span>
  </div>
</div>`;
  }

  html += `</body></html>`;
  return html;
}

app.listen(PORT, () => {
  console.log(`QA Automation running at http://localhost:${PORT}`);
});
