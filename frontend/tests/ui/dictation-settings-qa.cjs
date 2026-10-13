/* Built Settings integration, synthetic IPC only: never starts native capture or writes the clipboard. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '../../out');
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/dictation-settings');
  fs.mkdirSync(output, { recursive: true });
  const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    if (!path.extname(file)) file += '.html';
    if (url.searchParams.has('_rsc') && file.endsWith('.html')) file = file.slice(0, -5) + '.txt';
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  const report = { native_execution: false, actual_recording: false, os_clipboard: false, checks: [], page_errors: [], external_requests: [], screenshots: [] };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 600, height: 820 } });
    page.on('pageerror', error => report.page_errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      report.external_requests.push(url.origin); return route.abort();
    });
    await installFixture(page);
    await page.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.qaDictationCommands = []; window.qaCopiedDictation = '';
      const status = { phase: 'idle', session_id: 'retained-success', elapsed_seconds: 4, level: 0, text: 'The last successful dictation stays available. हिंदी भी सुरक्षित है.', message: null, microphone: null, available: true,
        shortcuts: { fallback: { label: 'Ctrl+Alt+Shift+D', registered: true, observed: false }, copilot: { label: 'Copilot (Win+Shift+F23)', registered: true, observed: false } } };
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (!command.startsWith('dictation_')) return original(command, args);
        window.qaDictationCommands.push({ command, args });
        if (command === 'dictation_status') return structuredClone(status);
        if (command === 'dictation_copy' && args.sessionId === status.session_id) { window.qaCopiedDictation = status.text; return; }
        throw Error('Unexpected dictation mutation');
      };
    });
    await page.goto(`${origin}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Dictation', exact: true }).click();
    await page.getByText('Shortcut ready; key untested', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'Dictation result', exact: true }).waitFor();
    assert.ok((await page.evaluate(() => window.qaDictationCommands)).every(call => call.command === 'dictation_status'));
    for (const height of [820, 560]) {
      await page.setViewportSize({ width: 600, height });
      const layout = await page.getByRole('tablist').evaluate(element => ({ docWidth: document.documentElement.scrollWidth, docHeight: document.documentElement.scrollHeight,
        tabs: [...element.querySelectorAll('[role="tab"]')].map(tab => { const box = tab.getBoundingClientRect(); return { text: tab.textContent, x: box.x, y: box.y, right: box.right, bottom: box.bottom }; }) }));
      assert.ok(layout.docWidth <= 601 && layout.docHeight <= height + 1, `Settings fits 600 × ${height}`);
      assert.equal(layout.tabs.length, 5);
      for (const tab of layout.tabs) assert.ok(tab.x >= 0 && tab.right <= 601 && tab.bottom < height, `Reachable ${tab.text} tab`);
      const copy = page.getByRole('button', { name: 'Copy last dictation', exact: true });
      await copy.scrollIntoViewIfNeeded();
      const box = await copy.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height + 1, 'Retained result copy is reachable by scrolling');
      const shot = `dictation-settings-600x${height}.png`;
      await page.screenshot({ path: path.join(output, shot) }); report.screenshots.push(shot);
      report.checks.push({ viewport: `600x${height}`, tab_rows: new Set(layout.tabs.map(tab => tab.y)).size, retained_copy_reachable: true });
    }
    await page.getByRole('button', { name: 'Copy last dictation', exact: true }).click();
    await page.getByText('Copied. Paste it where you need it.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.qaCopiedDictation), 'The last successful dictation stays available. हिंदी भी सुरक्षित है.');
    const writes = await page.evaluate(() => window.qaDictationCommands.filter(call => call.command !== 'dictation_status'));
    assert.deepEqual(writes, [{ command: 'dictation_copy', args: { sessionId: 'retained-success' } }]);
    assert.deepEqual(report.page_errors, []); assert.deepEqual(report.external_requests, []);
    report.checks.push('Retained successful text can be copied explicitly from idle; no dictation starts on mount'); report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) { report.body = await page.locator('body').innerText(); await page.screenshot({ path: path.join(output, 'failure.png') }); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
