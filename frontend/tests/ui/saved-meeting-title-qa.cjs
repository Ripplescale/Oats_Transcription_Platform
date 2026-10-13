/* Fictional meetings and mocked IPC only. Never opens the installed app or user data. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '../../out');
  const output = path.resolve(__dirname, '../test-results/saved-meeting-title');
  fs.mkdirSync(output, { recursive: true });
  const report = { synthetic: true, checks: [], errors: [], external: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end(); }
    if (!path.extname(file)) file += '.html';
    if (url.searchParams.has('_rsc') && file.endsWith('.html')) file = file.replace(/\.html$/, '.txt');
    if (!fs.existsSync(file)) { response.writeHead(404); return response.end(); }
    const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 680, height: 820 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', async route => {
      if (!route.request().url().startsWith(origin)) { report.external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    await installFixture(page);
    await page.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.qaTitleRequests = []; window.qaTitleEvents = [];
      window.qaUpdateInstalls = [];
      window.qaUpdateStatus = { state: 'downloaded', current_version: '0.8.2', version: '0.8.3', configured: true,
        downloaded_bytes: 100, total_bytes: 100, notes: 'Fictional signed update fixture', published_at: null, error: null, blocked_reason: null };
      window.qaTitleDelay = 0; window.qaTitleFails = false;
      window.addEventListener('xx-meeting-renamed', event => window.qaTitleEvents.push(event.detail));
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'api_get_summary') return { status: 'completed', data: { markdown: 'A fictional earlier summary, retained for review.' } };
        if (['updates_status', 'updates_check', 'updates_download'].includes(command)) return structuredClone(window.qaUpdateStatus);
        if (command === 'updates_install') {
          window.qaUpdateInstalls.push(structuredClone(args));
          return { ...window.qaUpdateStatus, blocked_reason: 'Synthetic installer handoff stopped. No installer runs in this test.' };
        }
        if (command === 'api_save_meeting_title') {
          window.qaTitleRequests.push(structuredClone(args));
          if (window.qaTitleDelay) await new Promise(resolve => setTimeout(resolve, window.qaTitleDelay));
          if (window.qaTitleFails) throw Error('Fictional title write failure');
        }
        return invoke(command, args);
      };
    });
    await page.goto(origin + '/meeting-details?id=qa-meeting');
    const rename = page.getByRole('button', { name: 'Rename meeting title', exact: true });
    const title = page.getByRole('textbox', { name: 'Meeting title', exact: true });
    const editor = page.getByRole('textbox', { name: 'Meeting notes', exact: true });
    const count = () => page.evaluate(() => window.qaTitleRequests.length);
    await page.waitForFunction(() => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]')?.textContent.includes('24 sketchbooks'));
    const originalWorkspace = await page.evaluate(() => structuredClone(window.qaWorkspace()));
    await rename.click();
    assert.equal(await title.inputValue(), 'Project Willow · Friday catch-up');
    assert.equal(await title.getAttribute('maxlength'), '200');
    assert.deepEqual(await title.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, (await title.inputValue()).length]);
    await page.evaluate(() => { window.qaTitleDelay = 450; });
    await title.fill('  Workshop follow-up  ');
    await title.press('Enter');
    await page.getByRole('button', { name: 'Tools', exact: true }).focus();
    await page.getByRole('heading', { name: 'Workshop follow-up', exact: true }).waitFor();
    assert.equal(await count(), 1, 'Enter plus blur submits once');
    assert.deepEqual(await page.evaluate(() => window.qaTitleRequests[0]), { meetingId: 'qa-meeting', title: 'Workshop follow-up' });
    assert.deepEqual(await page.evaluate(() => window.qaTitleEvents), [{ id: 'qa-meeting', title: 'Workshop follow-up' }]);
    assert.deepEqual(await page.evaluate(() => window.qaWorkspace()), originalWorkspace, 'Title rename must not write workspace metadata or notes');
    assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.command === 'save_transcript_workspace').length), 0);
    report.checks.push('Click selects the title; Enter trims and saves exactly once without writing notes or metadata');

    await rename.focus(); await rename.press('Enter');
    await title.fill('Discard this title'); await title.press('Escape');
    await rename.waitFor(); assert.equal(await count(), 1);
    await rename.press('Enter'); await title.fill('Also discard this title');
    await page.getByRole('button', { name: 'Cancel renaming', exact: true }).focus();
    await page.keyboard.press('Enter');
    await rename.waitFor(); assert.equal(await count(), 1, 'Enter on Cancel cancels instead of saving');
    await page.getByRole('heading', { name: 'Workshop follow-up', exact: true }).waitFor();
    report.checks.push('Keyboard activation, Escape, and keyboard Cancel preserve the saved title');

    await page.evaluate(() => { window.qaTitleDelay = 0; });
    await rename.click(); await title.fill('Workshop notes'); await editor.click();
    await page.getByRole('heading', { name: 'Workshop notes', exact: true }).waitFor();
    assert.equal(await count(), 2);
    assert.equal(await editor.evaluate(element => document.activeElement === element), true, 'Blur save does not steal focus from notes');
    await rename.click(); await title.fill('   '); await title.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Enter a meeting title.' }).waitFor();
    assert.equal(await count(), 2); await title.press('Escape');
    await rename.click(); await title.fill('  Workshop notes  '); await title.press('Enter');
    await rename.waitFor(); assert.equal(await count(), 2, 'Unchanged trimmed title does not write');
    report.checks.push('Blur saves without moving focus; empty titles and unchanged values never reach the backend');

    await page.evaluate(() => { window.qaTitleFails = true; });
    await rename.click(); await title.fill('A title kept for retry'); await title.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Title not saved.' }).waitFor();
    assert.equal(await title.inputValue(), 'A title kept for retry');
    assert.equal(await page.locator('.xx-saved-note-status').innerText(), 'Unsaved title');
    assert.equal(await count(), 3);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Keep your changes?', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stay here', exact: true }).click();
    assert.equal(await count(), 3, 'Failed blur does not silently retry');
    assert.equal(await title.inputValue(), 'A title kept for retry');
    await page.evaluate(() => { window.qaTitleFails = false; });
    await page.getByRole('button', { name: 'Save meeting title', exact: true }).click();
    await page.getByRole('heading', { name: 'A title kept for retry', exact: true }).waitFor();
    assert.equal(await count(), 4);
    assert.deepEqual(await page.evaluate(() => window.qaWorkspace()), originalWorkspace);
    report.checks.push('Failed rename preserves the draft, reports unsaved state, guards navigation, and retries explicitly');

    await editor.fill('These edited notes stay intact while the title changes. आज की notes.');
    await rename.click(); await title.fill('Workshop decisions');
    await title.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(await title.count(), 1); assert.equal(await count(), 4, 'IME confirmation must not submit a title');
    await title.press('Enter');
    await page.getByRole('heading', { name: 'Workshop decisions', exact: true }).waitFor();
    await page.waitForFunction(() => window.qaWorkspace().notes.includes('आज की notes.'));
    const saved = await page.evaluate(() => structuredClone(window.qaWorkspace()));
    for (const [key, value] of Object.entries(originalWorkspace)) {
      if (!['notes', 'notes_document', 'revision'].includes(key)) assert.deepEqual(saved[key], value, `${key} survives concurrent note autosave and title rename`);
    }
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await page.locator('.xx-note-row').filter({ hasText: 'Workshop decisions' }).click();
    await page.getByRole('heading', { name: 'Workshop decisions', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]')?.textContent.includes('आज की notes.'));
    report.checks.push('Title remains in Home and on reopening while concurrent notes, project, and transcript metadata survive');

    await page.setViewportSize({ width: 430, height: 740 });
    await rename.click(); await title.fill('A longer workshop title with room for the follow-up discussion');
    const row = await page.locator('.xx-saved-note-title-row').boundingBox();
    const field = await title.boundingBox();
    const tools = await page.getByRole('button', { name: 'Tools', exact: true }).boundingBox();
    assert.ok(field.x >= row.x - 5 && field.x + field.width < tools.x, 'Title editor fits beside Tools at a narrow width');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
    await page.screenshot({ path: path.join(output, 'title-editing-narrow.png') });
    await title.press('Escape');
    await page.setViewportSize({ width: 680, height: 820 });
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const correction = page.locator('textarea[aria-label="Correct transcript text"]');
    await correction.fill('Keep this unapplied correction until I decide.');
    const openUpdate = async () => {
      await page.getByRole('button', { name: 'About oats', exact: true }).click();
      await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await page.getByRole('heading', { name: 'Update ready to install', exact: true }).waitFor();
    };
    const closeUpdate = async () => {
      await page.getByRole('button', { name: 'Later', exact: true }).click();
      await page.getByRole('heading', { name: 'Update ready to install', exact: true }).waitFor({ state: 'hidden' });
      const about = page.getByRole('dialog', { name: 'About oats', exact: true });
      await about.getByRole('button', { name: 'Close', exact: true }).click();
      await about.waitFor({ state: 'hidden' });
    };
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Apply or cancel your transcript correction' }).waitFor();
    assert.equal(await page.evaluate(() => window.qaUpdateInstalls.length), 0, 'Pending correction blocks native installation');
    assert.equal(await correction.inputValue(), 'Keep this unapplied correction until I decide.');
    await closeUpdate();
    await page.getByRole('button', { name: 'Apply correction', exact: true }).click();
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.waitForFunction(() => window.qaUpdateInstalls.length === 1);
    assert.ok(await page.evaluate(() => window.qaWorkspace().corrections.some(item => item.text === 'Keep this unapplied correction until I decide.')), 'Applied correction is saved before installer handoff');
    await closeUpdate();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await correction.fill('This correction is cancelled.');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.waitForFunction(() => window.qaUpdateInstalls.length === 2);
    assert.ok(await page.evaluate(() => !window.qaWorkspace().corrections.some(item => item.text === 'This correction is cancelled.')));
    await closeUpdate();
    report.checks.push('In-place About/update blocks unapplied corrections, retains drafts, and permits handoff only after Apply/save or Cancel');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByText('Project vault · optional', { exact: true }).click();
    await page.getByRole('button', { name: 'Add reference', exact: true }).click();
    const reference = page.getByLabel('Name or value', { exact: true });
    await reference.fill('Retain this fictional reference draft');
    await page.keyboard.press('Escape');
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Save or cancel your project reference' }).waitFor();
    assert.equal(await page.evaluate(() => window.qaUpdateInstalls.length), 2);
    assert.equal(await reference.inputValue(), 'Retain this fictional reference draft');
    await closeUpdate();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Escape');
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.waitForFunction(() => window.qaUpdateInstalls.length === 3);
    await closeUpdate();
    report.checks.push('Project reference draft blocks update and stays intact until explicit cancellation');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const summaryPanel = page.locator('details').filter({ has: page.getByText('Previously saved summary', { exact: true }) });
    await page.getByText('Previously saved summary', { exact: true }).click();
    const summaryEditor = summaryPanel.locator('[contenteditable="true"]').first();
    await summaryEditor.waitFor();
    await summaryEditor.fill('Keep these fictional earlier-summary edits.');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save earlier summary changes' && !button.disabled));
    await page.keyboard.press('Escape');
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Save your summary changes' }).waitFor();
    assert.equal(await page.evaluate(() => window.qaUpdateInstalls.length), 3);
    assert.ok((await summaryEditor.innerText()).includes('Keep these fictional earlier-summary edits.'));
    await closeUpdate();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Save earlier summary changes', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save earlier summary changes' && button.disabled));
    assert.ok(await page.evaluate(() => window.qaCalls.some(call => call.command === 'api_save_meeting_summary' && JSON.stringify(call.args.summary).includes('Keep these fictional earlier-summary edits.'))));
    await page.keyboard.press('Escape');
    await openUpdate();
    await page.getByRole('button', { name: 'Install now', exact: true }).click();
    await page.waitForFunction(() => window.qaUpdateInstalls.length === 4);
    await closeUpdate();
    report.checks.push('Earlier-summary edits block update and remain intact until explicitly saved');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
