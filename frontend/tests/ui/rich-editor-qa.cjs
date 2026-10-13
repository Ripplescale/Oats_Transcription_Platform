/* Fictional data, mocked IPC, no app installation or user library access. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '../../out');
  const output = path.resolve(__dirname, '../test-results/rich-editor'); fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end(); }
    if (!path.extname(file)) file += '.html';
    if (url.searchParams.has('_rsc') && file.endsWith('.html')) file = file.replace(/\.html$/, '.txt');
    if (!fs.existsSync(file)) { response.writeHead(404); return response.end(); }
    const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 680, height: 820 } });
  const report = { synthetic: true, checks: [], errors: [], external: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', async route => { if (!route.request().url().startsWith(origin)) { report.external.push(route.request().url()); await route.abort(); } else await route.continue(); });
  try {
    await installFixture(page);
    await page.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.qaSaveCount = 0; window.qaSaveFails = false; window.qaSaveDelay = 0;
      const sorted = value => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item));
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'load_transcript_workspace') { await new Promise(resolve => setTimeout(resolve, 350)); return sorted(await invoke(command, args)); }
        if (command === 'save_transcript_workspace') {
          window.qaSaveCount++;
          if (window.qaSaveDelay) await new Promise(resolve => setTimeout(resolve, window.qaSaveDelay));
          if (window.qaSaveFails) throw Error('Fictional disk write failure');
          return sorted(await invoke(command, args));
        }
        return invoke(command, args);
      };
    });
    await page.goto(origin + '/meeting-details?id=qa-meeting');
    const editor = page.getByRole('textbox', { name: 'Meeting notes', exact: true });
    const toolbar = page.getByRole('toolbar', { name: 'Note formatting', exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]')?.textContent.includes('24 sketchbooks'));
    const original = await page.evaluate(() => window.qaWorkspace().notes);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.qaWorkspace().notes), original);
    assert.equal(await page.evaluate(() => window.qaSaveCount), 0, 'Async load/enabling editor must not emit an empty change or migration save');
    report.checks.push('Delayed legacy load preserves original note and emits zero saves');

    await editor.fill('Save preserves my caret.');
    await page.waitForTimeout(550); // Distinct undo group, before the one-second autosave debounce.
    await editor.press('Control+a'); await toolbar.getByRole('button', { name: 'Bold', exact: true }).click();
    await editor.press('ArrowLeft'); await editor.press('ArrowRight');
    const caret = await page.evaluate(() => ({ anchor: getSelection().anchorOffset, focus: getSelection().focusOffset, text: getSelection().anchorNode.textContent }));
    await page.waitForFunction(() => window.qaWorkspace().notes_document?.content?.[0]?.content?.[0]?.marks?.some(mark => mark.type === 'bold'));
    assert.deepEqual(await page.evaluate(() => ({ anchor: getSelection().anchorOffset, focus: getSelection().focusOffset, text: getSelection().anchorNode.textContent })), caret);
    assert.equal(await page.evaluate(() => window.qaSaveCount), 1);
    await toolbar.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await editor.locator('strong').count(), 0, 'Undo history survives a reordered native save acknowledgment');
    await page.waitForFunction(() => !JSON.stringify(window.qaWorkspace().notes_document).includes('bold'));
    report.checks.push('Native reordered JSON save preserves caret and undo history without repeated saves');

    await page.evaluate(() => { window.qaSaveFails = true; });
    const saved = await page.evaluate(() => window.qaWorkspace().notes);
    await editor.fill('A draft deliberately discarded.');
    await page.getByRole('alert').filter({ hasText: 'Could not save' }).waitFor();
    assert.ok(await page.evaluate(() => localStorage.getItem('xx.workspace-draft.qa-meeting')));
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('xx.workspace-draft.qa-meeting')), null);
    await page.evaluate(() => { window.qaSaveFails = false; });
    await page.locator('.xx-note-row').filter({ hasText: 'Friday catch-up' }).click();
    await page.waitForFunction(text => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]')?.textContent === text, saved);
    assert.equal(await editor.innerText(), saved);
    report.checks.push('Leave without saving clears a failed recovery draft and reopening shows saved text');

    await editor.press('Control+a'); await toolbar.getByRole('button', { name: 'Link', exact: true }).click();
    await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://example.com/notes');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal(await editor.locator('a').getAttribute('href'), 'https://example.com/notes');
    await page.waitForFunction(() => JSON.stringify(window.qaWorkspace().notes_document).includes('https://example.com/notes'));
    report.checks.push('Link toolbar preserves selected text and stores a safe URL');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); report.passed = true;
    await page.screenshot({ path: path.join(output, 'passed.png') });
  } catch (error) { report.failure = error.stack || String(error); report.body = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
