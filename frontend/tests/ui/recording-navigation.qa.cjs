/* Browser regression with fictional audio, notes and IPC. Never connects to oats. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installCleanLiveFixture } = require('./xx-clean-live-notes-qa.cjs');

async function main() {
  const root = path.resolve(__dirname, '../../out');
  const output = path.resolve(process.argv[2] || 'frontend/tests/test-results/recording-navigation');
  fs.mkdirSync(output, { recursive: true });
  const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end(); }
    if (!path.extname(file)) file += '.html';
    if (url.searchParams.has('_rsc') && file.endsWith('.html')) file = file.replace(/\.html$/, '.txt');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = { synthetic_ipc: true, actual_recording: false, checks: [], page_errors: [], external_requests: [] };
  let browser, page;
  const bar = () => page.getByRole('complementary', { name: 'Current recording', exact: true });
  const home = () => page.getByRole('heading', { name: 'Your notes', exact: true });
  const live = () => page.getByRole('textbox', { name: 'Live meeting notes', exact: true });
  const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 680, height: 820 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      report.external_requests.push(url.origin); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.page_errors.push(error.message));
    await installCleanLiveFixture(page);
    await page.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.qaHoldWorkspace = false;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'save_transcript_workspace' && window.qaHoldWorkspace) {
          await new Promise(resolve => { window.qaReleaseWorkspace = resolve; });
        }
        return original(command, args);
      };
    });
    await page.goto(origin);
    await home().waitFor();
    assert.equal(await bar().count(), 0);
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await live().waitFor();
    await page.waitForFunction(() => !!window.qaCleanState().job);
    const jobId = await page.evaluate(() => window.qaCleanState().job.job_id);
    assert.equal(await bar().count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Back to notes', exact: true }).isEnabled(), true);
    await page.evaluate(() => window.qaCleanHoldSave());
    const thought = 'Keep this last thought while I browse another meeting. आज की notes.';
    await live().fill(thought);
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await page.waitForFunction(() => window.qaCalls.some(call => call.command === 'save_meeting_note' && call.args.notes.includes('last thought')));
    assert.equal(await live().isVisible(), true);
    assert.equal(new URL(page.url()).searchParams.get('view'), 'recording');
    assert.equal((await page.evaluate(() => window.qaCleanState())).recording, true);
    await page.evaluate(() => window.qaCleanReleaseSave());
    await home().waitFor();
    assert.equal((await page.evaluate(() => window.qaCleanState())).live.notes, thought);
    await bar().getByText('Recording in progress', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'New note', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Return to recording', exact: true }).count(), 1);
    report.checks.push('Back opens Home during capture, waits for the final note save and prevents a second recording');
    for (const [width, height] of [[680, 820], [600, 560]]) {
      await page.setViewportSize({ width, height });
      const bounds = await bar().boundingBox();
      assert.ok(bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      assert.ok(dimensions.width <= width + 1 && dimensions.height <= height + 1);
      await shot(`recording-home-${width}`);
    }
    await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('sketchbooks');
    assert.equal(await page.locator('.xx-note-row').count(), 1);
    await page.locator('.xx-note-row').click();
    await page.waitForURL('**/meeting-details?id=qa-meeting');
    const saved = page.getByRole('textbox', { name: 'Meeting notes', exact: true });
    await saved.waitFor();
    await bar().waitFor();
    await page.evaluate(() => window.qaCleanSetText());
    await page.waitForFunction(() => window.qaCleanState().imported.length === 2);
    assert.equal((await page.evaluate(() => window.qaCleanState())).job.job_id, jobId);
    await shot('another-meeting-during-recording');
    report.checks.push('Search and another saved meeting work while the same transcription job imports new text in the background');

    await page.evaluate(() => { window.qaHoldWorkspace = true; });
    await saved.fill('An independent saved-note edit.');
    await page.getByRole('button', { name: 'Return to recording', exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Keep your changes?', exact: true });
    await guard.waitFor();
    await guard.getByRole('button', { name: 'Stay here', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('id'), 'qa-meeting');
    assert.equal((await page.evaluate(() => window.qaCleanState())).recording, true);
    await page.waitForFunction(() => typeof window.qaReleaseWorkspace === 'function');
    await page.evaluate(() => { window.qaHoldWorkspace = false; window.qaReleaseWorkspace(); });
    await page.waitForFunction(() => window.qaWorkspace().notes === 'An independent saved-note edit.');
    await page.locator('.xx-saved-note-status').getByText('Saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Return to recording', exact: true }).click();
    await live().waitFor();
    assert.equal(await live().innerText(), thought);
    assert.equal(await bar().count(), 0);
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await page.getByText('आज Project Willow की workshop plan करते हैं. We need 24 sketchbooks.', { exact: true }).waitFor();
    report.checks.push('Return respects other-note save protection and restores the live notes and growing transcript without restarting capture');

    await page.getByRole('button', { name: 'Pause recording', exact: true }).click();
    await page.getByRole('button', { name: 'Resume recording', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await home().waitFor();
    await bar().getByText('Recording paused', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Return to recording', exact: true }).click();
    await page.getByRole('button', { name: 'Resume recording', exact: true }).click();
    await page.getByRole('button', { name: 'Pause recording', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await home().waitFor();
    await page.locator('.xx-note-row').filter({ hasText: 'Friday catch-up' }).click();
    await saved.waitFor();
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('stop_recording'));
    await bar().waitFor({ state: 'hidden' });
    await page.getByText('Recording saved. Your transcript will appear as processing finishes.', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('id'), 'qa-meeting');
    assert.equal(await saved.innerText(), 'An independent saved-note edit.');
    await page.getByRole('button', { name: 'Open note', exact: true }).click();
    await page.waitForURL('**/meeting-details?id=qa-live');
    await page.getByRole('textbox', { name: 'Meeting notes', exact: true }).waitFor();
    const state = await page.evaluate(() => window.qaCleanState());
    const calls = await page.evaluate(() => window.qaCalls);
    assert.equal(state.live.notes, thought);
    assert.equal(state.recording, false);
    for (const command of ['start_recording_with_devices_and_meeting', 'start_local_transcription', 'pause_recording', 'resume_recording', 'stop_recording']) {
      assert.equal(calls.filter(call => call.command === command).length, 1, command);
    }
    assert.equal(await page.evaluate(() => window.qaCleanMediaCalls), 0);
    assert.deepEqual(report.page_errors, []);
    assert.deepEqual(report.external_requests, []);
    report.checks.push('Pause/resume survives browsing; a background stop keeps the viewed note open and offers Open note for the saved recording');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) { report.debug = await page.evaluate(() => ({ text: document.body.innerText, state: window.qaCleanState?.(), calls: window.qaCalls })); await shot('failure'); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
