/* Fictional saved notes and audio. Never records, starts a model or sends content. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/xx-saved-notes');
  fs.mkdirSync(output, { recursive: true });
  const root = path.resolve(__dirname, '../../out');
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    if (!path.extname(file)) file += '.html';
    if (url.searchParams.has('_rsc') && file.endsWith('.html')) file = file.replace(/\.html$/, '.txt');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', url.searchParams.has('_rsc') ? 'text/x-component' : mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 920, height: 740 } });
  const report = { fictional_fixture: true, native_ipc: false, captures_started: 0, checks: [], screenshots: [], page_errors: [] };
  page.on('pageerror', error => report.page_errors.push(error.message));
  try {
    await installFixture(page);
    await page.addInitScript(() => {
      localStorage.setItem('xx-display-mode', 'dev');
      window.qaRetryPieces = ['Please bring the notebooks.', Array(12).fill('जब').join(' '), 'The studio opens at three.', "Let's meet by the door."];
      window.qaRetryText = window.qaRetryPieces.join('\n\n');
      window.qaRetryOriginal = 'वो जब था '.repeat(18).trim();
      window.qaClipboard = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.qaClipboard = String(text); } } });
      window.qaWorkspace().segment_metadata.first = {
        source_track: 'system', timestamp_kind: 'audio_window', quality_flags: ['retry_applied', 'needs_review'],
        original_recognition_text: 'वो जब था '.repeat(5),
        alternative: { text: 'Welcome back, everyone. आज Project Willow की workshop plan करते हैं. Maya, would you like to walk us through the new sketchbook idea?', promoted: true, requires_review: true },
      };
      window.qaWorkspace().segment_metadata.fourth = {
        source_track: 'microphone', timestamp_kind: 'audio_window', quality_flags: ['repeated_phrase', 'retry_applied', 'needs_review'],
        original_recognition_text: window.qaRetryOriginal,
        alternative: { text: window.qaRetryText, promoted: true, requires_review: true },
      };
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.qaSaveDelay = 0; window.qaFailSave = false; window.qaSaveFailures = 0;
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'list_project_library') return { projects: [{ id: 'willow', name: 'Project Willow Vault', revision: 0, entry_count: 1 }], meetings: [] };
        if (command === 'api_get_meeting_transcripts') {
          const result = await invoke(command, args);
          return { ...result, transcripts: result.transcripts.map(segment => segment.id === 'fourth' ? { ...segment, text: window.qaRetryText } : segment) };
        }
        if (command === 'save_transcript_workspace') {
          if (window.qaSaveDelay) await new Promise(resolve => setTimeout(resolve, window.qaSaveDelay));
          if (window.qaFailSave) { window.qaSaveFailures++; throw Error('Fictional disk write failure'); }
        }
        return invoke(command, args);
      };
    });
    await page.goto(`${base}/meeting-details?id=qa-meeting`);
    const notes = page.getByRole('textbox', { name: 'Meeting notes', exact: true });
    const transcript = page.getByRole('region', { name: 'Transcript', exact: true });
    await notes.waitFor();
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Meeting notes"]')?.getAttribute('contenteditable') === 'true');
    assert.equal(await transcript.isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Show transcript', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('audio').count(), 1);
    report.checks.push('Saved meeting opens directly to notes, transcript collapsed, one persistent audio player');

    for (const [width, height] of [[680, 820], [600, 560], [720, 560], [920, 740]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, notes: rect('[role="textbox"][aria-label="Meeting notes"]'), audio: rect('audio'), toggle: rect('.xx-saved-note-transcript-toggle') };
      });
      assert.ok(layout.scrollWidth <= width + 1 && layout.scrollHeight <= height + 1, `Page overflow at ${width}x${height}`);
      assert.ok(layout.notes.width > 420 && layout.notes.height > 230, `Writing canvas too small at ${width}x${height}`);
      assert.ok(layout.audio.bottom <= height && layout.toggle.right <= width && layout.toggle.bottom <= height, 'Persistent dock visible');
      const shot = `saved-notes-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, shot) }); report.screenshots.push(shot);
      await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
      await transcript.waitFor();
      await transcript.getByText('Welcome back, everyone. आज Project Willow की workshop plan करते हैं. Maya, would you like to walk us through the new sketchbook idea?', { exact: true }).waitFor();
      const transcriptBox = await transcript.boundingBox();
      assert.ok(transcriptBox.width >= 330 && transcriptBox.height >= 250, 'Readable transcript in compact window');
      const transcriptShot = `saved-transcript-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, transcriptShot) }); report.screenshots.push(transcriptShot);
      const lastSegment = transcript.locator('article').last();
      await lastSegment.scrollIntoViewIfNeeded();
      const lastBox = await lastSegment.boundingBox();
      const dockBox = await page.locator('.xx-saved-note-dock').boundingBox();
      assert.ok(lastBox.y + lastBox.height <= dockBox.y + 1, 'Last transcript segment scrolls above persistent playback');
      const scrolledShot = `saved-transcript-scrolled-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, scrolledShot) }); report.screenshots.push(scrolledShot);
      await lastSegment.evaluate(element => { element.parentElement.scrollTop = 0; });
      await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
      report.checks.push({ viewport: `${width}x${height}`, layout });
    }

    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    const selectedRetry = transcript.locator('article').first();
    await selectedRetry.getByText('Processing checks', { exact: true }).click();
    await selectedRetry.getByText('A shorter-window retry was selected for this transcript. Review it against the recording.', { exact: true }).waitFor();
    assert.equal(await selectedRetry.getByText('A shorter-window retry is available for comparison. It has not replaced the original recognition.', { exact: true }).count(), 0);
    await selectedRetry.getByText('Recognition before shorter retry', { exact: true }).click();
    await selectedRetry.getByText('वो जब था '.repeat(5).trim(), { exact: true }).waitFor();
    const legacyRetry = transcript.locator('article').nth(2);
    await legacyRetry.getByText('Processing checks', { exact: true }).click();
    await legacyRetry.getByText('A shorter-window retry is available for comparison. It has not replaced the original recognition.', { exact: true }).waitFor();
    await legacyRetry.getByText('A shorter-window comparison is available for review.', { exact: true }).waitFor();
    const stillRepeatingRetry = transcript.locator('article').nth(3);
    const retryEvidence = await page.evaluate(() => ({ combined: window.qaRetryText, original: window.qaRetryOriginal,
      metadata: structuredClone(window.qaWorkspace().segment_metadata.fourth) }));
    await stillRepeatingRetry.getByText(retryEvidence.combined, { exact: true }).waitFor();
    await stillRepeatingRetry.getByText('Processing checks', { exact: true }).click();
    await stillRepeatingRetry.getByText('A shorter-window retry was selected for this transcript. Review it against the recording.', { exact: true }).waitFor();
    assert.match(await stillRepeatingRetry.innerText(), /repeated phrase.*retry applied.*needs review/);
    await stillRepeatingRetry.getByText('Recognition before shorter retry', { exact: true }).click();
    await stillRepeatingRetry.getByText(retryEvidence.original, { exact: true }).waitFor();
    await stillRepeatingRetry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'promoted-retry-still-repeats.png') }); report.screenshots.push('promoted-retry-still-repeats.png');
    await transcript.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy only', exact: true }).click();
    await page.waitForFunction(() => !!window.qaClipboard);
    const clipboardEvidence = await page.evaluate(() => ({ clipboard: window.qaClipboard,
      metadata: window.qaWorkspace().segment_metadata.fourth, calls: window.qaCalls }));
    assert.ok(clipboardEvidence.clipboard.includes(retryEvidence.combined), 'Copy includes all four5-second pieces in order, including the remaining repetition');
    assert.ok(!clipboardEvidence.clipboard.includes(retryEvidence.original), 'The20-second recognition remains reference material, not the copied transcript');
    assert.deepEqual(clipboardEvidence.metadata, retryEvidence.metadata, 'Display and copy preserve original recognition and needs_review');
    assert.ok(clipboardEvidence.metadata.quality_flags.includes('needs_review'));
    assert.equal(clipboardEvidence.metadata.alternative.requires_review, true);
    assert.equal(clipboardEvidence.metadata.alternative.promoted, true);
    assert.ok(!clipboardEvidence.calls.some(call => /open_claude/.test(call.command)), 'Copy only does not open Claude');
    report.checks.push('Combined5-second retry is displayed and copied even with a repetitive piece; original20-second recognition remains available and needs_review survives');
    await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
    report.checks.push('Promoted retries show the preserved pre-retry recognition; legacy comparison-only retries keep accurate unchanged wording');

    await notes.fill('Checked fictional notes, saved without pressing a button.');
    await page.waitForFunction(() => window.qaWorkspace().notes === 'Checked fictional notes, saved without pressing a button.');
    await page.getByLabel('Meeting project', { exact: true }).selectOption('');
    await page.waitForFunction(() => window.qaWorkspace().project_id === null);
    await page.getByLabel('Meeting project', { exact: true }).selectOption('willow');
    await page.waitForFunction(() => window.qaWorkspace().project_id === 'willow');
    report.checks.push('Notes and project assignment save automatically');

    await page.evaluate(() => { window.qaSaveDelay = 900; });
    await notes.fill('First snapshot while saving.');
    await page.getByRole('status').filter({ hasText: /^Saving…$/ }).waitFor();
    await notes.fill('Newer edits typed while the first save is in flight.');
    await page.waitForFunction(() => window.qaWorkspace().notes === 'Newer edits typed while the first save is in flight.');
    assert.equal(await notes.innerText(), 'Newer edits typed while the first save is in flight.');
    await page.evaluate(() => { window.qaSaveDelay = 0; });
    report.checks.push('A slower save never replaces edits typed during that save');

    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await transcript.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const correction = page.getByRole('textbox', { name: 'Correct transcript text', exact: true });
    await correction.fill('An incomplete correction, not ready to apply.');
    await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
    await notes.fill('Notes remain local while a correction is unfinished.');
    await page.waitForTimeout(1300);
    assert.equal((await page.evaluate(() => window.qaWorkspace())).corrections.length, 0);
    assert.notEqual((await page.evaluate(() => window.qaWorkspace())).notes, 'Notes remain local while a correction is unfinished.');
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    assert.equal(await correction.inputValue(), 'An incomplete correction, not ready to apply.');
    await correction.fill('Welcome to Willow. आज हम notes की बात करेंगे.');
    await page.getByRole('button', { name: 'Apply correction', exact: true }).click();
    await page.waitForFunction(() => window.qaWorkspace().corrections.length === 1);
    const saved = await page.evaluate(() => window.qaWorkspace());
    assert.equal(saved.notes, 'Notes remain local while a correction is unfinished.');
    assert.match(saved.corrections[0].original_text, /Welcome back, everyone/);
    assert.equal(saved.corrections[0].text, 'Welcome to Willow. आज हम notes की बात करेंगे.');
    report.checks.push('Closing transcript retains unfinished correction and saves only after explicit Apply; original recognition remains separate');

    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
    await page.locator('audio').evaluate(element => { element.muted = true; });
    await transcript.getByRole('button', { name: '00:20', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime >= 20);
    await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
    assert.equal(await page.locator('audio').evaluate(element => element.paused), false);
    await page.locator('audio').evaluate(element => element.pause());
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await transcript.getByRole('button', { name: 'Export', exact: true }).click();
    for (const name of ['Export TXT', 'Export MD', 'Export JSON', 'Copy & open Claude', 'Copy only', 'Open in Claude Cowork']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1);
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await transcript.getByRole('navigation', { name: 'Transcript versions' }).getByRole('button').count(), 2);
    report.checks.push('Segment playback uses the persistent player across toggles; all exports and transcript versions remain accessible');

    await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
    await page.evaluate(() => { window.qaFailSave = true; });
    await notes.fill('Keep these fictional edits when saving fails.');
    await page.getByRole('alert').filter({ hasText: 'Fictional disk write failure' }).waitFor();
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.qaSaveFailures), 1, 'A failed save does not cause an automatic retry loop');
    assert.equal(await notes.innerText(), 'Keep these fictional edits when saving fails.');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href: '/' } })));
    await page.getByRole('dialog', { name: 'Keep your changes?' }).waitFor();
    await page.getByRole('button', { name: 'Stay here', exact: true }).click();
    await page.evaluate(() => { window.qaFailSave = false; });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForFunction(() => window.qaWorkspace().notes === 'Keep these fictional edits when saving fails.');
    report.checks.push('Save failure preserves notes, navigation guard and explicit retry');
    const forbidden = await page.evaluate(() => window.qaCalls.filter(call => /start_.*(recording|transcription|identification)|open_claude|plugin:dialog/.test(call.command)));
    assert.deepEqual(forbidden, []);
    assert.deepEqual(report.page_errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    report.debug = await page.evaluate(() => document.body.innerText.slice(-5000));
    await page.screenshot({ path: path.join(output, 'failure.png') });
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
