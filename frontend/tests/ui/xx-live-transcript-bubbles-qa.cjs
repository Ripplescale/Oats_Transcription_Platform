/* Fictional live job and notes. No capture, model, account, or OS clipboard access. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installCleanLiveFixture } = require('./xx-clean-live-notes-qa.cjs');
const editorText = editor => editor.evaluate(element => 'value' in element ? element.value : element.innerText.replace(/\n{3,}/g, '\n\n'));

async function main() {
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/xx-live-transcript-bubbles');
  fs.mkdirSync(output, { recursive: true });
  const root = path.resolve(__dirname, '../../out');
  const mime = { '.html': 'text/html', '.txt': 'text/x-component', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  const report = { fictional_fixture: true, native_execution: false, actual_recording: false, model_execution: false, os_clipboard: false, checks: [], screenshots: [], page_errors: [], external_requests: [] };
  let browser, page;
  const screenshot = async name => { await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name); };
  const raw = [
    { id: 'live-system', text: 'Yes.', source_track: 'system', start_seconds: 0, end_seconds: 10 },
    { id: 'live-microphone', text: 'हाँ, मैं studio booking confirm कर दूँगा.\nFriday afternoon works for us.', source_track: 'microphone', start_seconds: 10, end_seconds: 20, quality_flags: ['needs_review'] },
    { id: 'live-legacy', text: 'An older combined track keeps a neutral label.', source_track: 'mixed', start_seconds: 20, end_seconds: 30 },
    { id: 'live-missing', text: 'Source information was not saved.\n\nReference: ' + 'LongReferenceToken'.repeat(40), start_seconds: 30, end_seconds: 40 },
  ];
  const incoming = { id: 'live-incoming', text: 'नया incoming line arrives without changing the note.', source_track: 'system', start_seconds: 40, end_seconds: 50 };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 920, height: 740 } });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      report.external_requests.push(url.origin); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.page_errors.push(error.message));
    await installCleanLiveFixture(page);
    await page.addInitScript(() => {
      window.qaClipboard = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.qaClipboard = String(text); } } });
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Live meeting notes', exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => !!window.qaCleanState().job);
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Workshop · fictional demo');
    await page.getByRole('textbox', { name: 'Note title', exact: true }).blur();
    const note = 'Workshop notes\n\nKeep my own notes while the live transcript arrives.';
    await editor.fill(note);
    await page.waitForFunction(value => window.qaCleanState().live.notes === value, note);
    assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
    await page.evaluate(rows => window.qaCleanSetSegments(rows), raw);
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Live transcript', exact: true });
    await transcript.locator('article[data-segment-id="live-missing"]').waitFor({ state: 'attached' });
    const setMode = async mode => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('group', { name: 'Display mode', exact: true }).getByRole('button', { name: mode, exact: true }).click();
      await page.keyboard.press('Escape');
    };
    assert.equal(await transcript.locator('.xx-transcript-source-label').count(), 0);
    assert.equal(await transcript.getByText('Review suggested', { exact: true }).count(), 0);
    assert.equal(await transcript.getByText('Processing checks', { exact: true }).count(), 0);
    assert.ok((await transcript.locator('article').first().boundingBox()).width < (await transcript.locator('article').nth(1).boundingBox()).width / 2, 'A short live User bubble follows its text width');
    await page.evaluate(() => { window.qaLiveEditor = document.querySelector('[aria-label="Live meeting notes"]'); });
    const startsBeforeMode = await page.evaluate(() => window.qaCalls.filter(call => /start_.*(recording|transcription)/.test(call.command)).length);
    await setMode('Dev');
    assert.equal(await page.evaluate(() => window.qaLiveEditor === document.querySelector('[aria-label="Live meeting notes"]')), true);
    assert.equal(await page.evaluate(() => window.qaCalls.filter(call => /start_.*(recording|transcription)/.test(call.command)).length), startsBeforeMode);
    assert.equal((await page.evaluate(() => window.qaCleanState())).recording, true);
    await transcript.getByText('Left: computer audio · Right: microphone. Labels identify audio sources, not people.', { exact: true }).waitFor({ state: 'attached' });
    assert.deepEqual(await transcript.locator('article').evaluateAll(rows => rows.map(row => row.dataset.segmentId)), raw.map(row => row.id));
    assert.deepEqual(await transcript.locator('.xx-transcript-message-text').allTextContents(), raw.map(row => row.text));
    await transcript.locator('article[data-segment-id="live-microphone"]').getByText('00:10', { exact: true }).waitFor({ state: 'attached' });
    await transcript.locator('article[data-segment-id="live-microphone"]').getByText('Review suggested', { exact: true }).waitFor({ state: 'attached' });
    report.checks.push('Live job segments retain original mixed script, multiline text, timestamp order and review indicators with explicit source labels');
    await transcript.evaluate(element => {
      const row = element.querySelector('[data-segment-id="live-missing"]');
      element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top + 12;
    });
    const anchor = await transcript.evaluate(element => {
      const edge = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll('[data-segment-id]')].find(item => item.getBoundingClientRect().bottom > edge);
      return { id: row.dataset.segmentId, offset: row.getBoundingClientRect().top - edge };
    });
    await setMode('User');
    const afterMode = await transcript.evaluate((element, id) => ({ offset: element.querySelector(`[data-segment-id="${id}"]`).getBoundingClientRect().top - element.getBoundingClientRect().top }), anchor.id);
    assert.ok(Math.abs(afterMode.offset - anchor.offset) < 2, 'Switching mode retains the same transcript reading position');
    assert.equal(await editorText(editor), note);
    await setMode('Dev');
    report.checks.push('Live mode switching preserves the current passage, mounted editor, note text, and recording without restarting capture');

    for (const [width, height] of [[600, 560], [600, 820], [680, 820], [920, 740]]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(150);
      const layout = await transcript.evaluate(element => ({ width: innerWidth, height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        rows: [...element.querySelectorAll('article')].map(row => {
          const box = row.getBoundingClientRect(), text = row.querySelector('.xx-transcript-message-text');
          return { id: row.dataset.segmentId, channel: row.dataset.sourceChannel, x: box.x, right: box.right, width: box.width,
            background: getComputedStyle(row).backgroundColor, textOverflows: text.scrollWidth > text.clientWidth + 1 };
        }) }));
      assert.ok(layout.scrollWidth <= width + 1 && layout.scrollHeight <= height + 1, `Window fits ${width}x${height}`);
      const [computer, microphone, legacy, missing] = layout.rows;
      assert.equal(computer.channel, 'system'); assert.equal(microphone.channel, 'microphone');
      assert.ok(microphone.x > computer.x + 12, 'Microphone aligns right of computer audio');
      assert.equal(computer.background, 'rgb(255, 242, 223)'); assert.equal(microphone.background, 'rgb(255, 229, 219)');
      for (const row of [legacy, missing]) {
        assert.equal(row.channel, 'unknown'); assert.equal(row.background, 'rgb(243, 238, 234)');
        const container = await transcript.boundingBox();
        assert.ok(Math.abs((row.x + row.right) / 2 - (container.x + container.width / 2)) < 15, 'Unknown track remains centered');
      }
      for (const row of layout.rows) {
        assert.ok(row.x >= 0 && row.right <= width + 1 && row.width > 40, `Content width remains within the window for ${row.id}`);
        assert.equal(row.textOverflows, false, `Full long token wraps in ${row.id}`);
      }
      const dock = await page.locator('.xx-note-dock').boundingBox();
      const writing = await editor.boundingBox();
      assert.ok(writing.height >= 79 && writing.y + writing.height <= dock.y + 1, 'Notes and controls remain separate');
      for (const name of ['Pause recording', 'Stop recording']) {
        const control = page.getByRole('button', { name, exact: true }), box = await control.boundingBox();
        assert.equal(await control.isEnabled(), true); assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${name} stays reachable`);
      }
      await transcript.evaluate(element => { element.scrollTop = 0; });
      await screenshot(`live-source-bubbles-${width}x${height}.png`);
      await transcript.locator('article[data-segment-id="live-missing"]').scrollIntoViewIfNeeded();
      await screenshot(`live-neutral-long-token-${width}x${height}.png`);
      report.checks.push({ viewport: `${width}x${height}`, layout });
    }

    await page.evaluate(rows => window.qaCleanSetSegments(rows), [...raw, incoming]);
    await transcript.locator('article[data-segment-id="live-incoming"]').waitFor({ state: 'attached' });
    assert.deepEqual(await transcript.locator('article').evaluateAll(rows => rows.map(row => row.dataset.segmentId)), [...raw, incoming].map(row => row.id));
    assert.deepEqual(await transcript.locator('.xx-transcript-message-text').allTextContents(), [...raw, incoming].map(row => row.text));
    assert.equal(await editorText(editor), note);
    assert.equal((await page.evaluate(() => window.qaCleanState())).live.notes, note);
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click();
    await page.getByRole('button', { name: 'Resume recording', exact: true }).waitFor();
    assert.equal(await page.locator('.xx-recording-status').innerText(), 'Paused');
    await page.getByRole('button', { name: 'Resume recording', exact: true }).click();
    await page.getByRole('button', { name: 'Pause recording', exact: true }).waitFor();
    assert.equal(await page.locator('.xx-recording-status').innerText(), 'Listening');
    await page.locator('.xx-transcript-toggle').click();
    assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
    assert.equal(await editorText(editor), note);
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await transcript.locator('article[data-segment-id="live-incoming"]').waitFor({ state: 'attached' });
    await transcript.evaluate(element => { element.scrollTop = 0; });
    await screenshot('live-incoming-and-controls.png');
    report.checks.push('Incoming job text, pause/resume status and show/hide retain the note, segment sequence and existing recording controls');

    const originalLoop = Array(12).fill('जब').join(' ');
    const pending = { ...raw[0], text: originalLoop, quality_flags: ['repeated_phrase', 'needs_review'],
      recovery: { state: 'waiting_for_context', method: 'pending', core_segment_id: raw[0].id, core_start_seconds: 0, core_end_seconds: 10,
        context_start_seconds: 0, context_end_seconds: 30, desired_context_end_seconds: 30, requires_review: true, attempts: [] } };
    const correction = { segment_id: pending.id, original_text: originalLoop, text: 'My earlier checked workshop correction.', updated_at: '2026-10-07T15:00:00Z' };
    await page.evaluate(({ rows, correction }) => window.qaCleanSetSegments(rows, { workspace_corrections: [correction] }), { rows: [pending, ...raw.slice(1), incoming], correction });
    const pendingBubble = transcript.locator(`article[data-segment-id="${pending.id}"]`);
    await pendingBubble.getByText(originalLoop, { exact: true }).waitFor();
    await pendingBubble.getByText('Processing checks', { exact: true }).click();
    await pendingBubble.getByText('Waiting for surrounding audio before retrying this window. The current recognition is provisional.', { exact: true }).waitFor();
    const recovered = { ...raw[0], id: 'live-context-selected', text: 'आज workshop plan करते हैं. We need 24 sketchbooks.\nBring coloured pencils for the children.', end_seconds: 30,
      quality_flags: ['retry_applied', 'needs_review'], replaces_segment_ids: [pending.id], recognition_original: { text: originalLoop },
      recovery: { ...pending.recovery, state: 'complete', method: 'context_window_retry', attempts: [{ kind: 'context_window_retry', start_seconds: 0, end_seconds: 30,
        source_audio_sha256: 'fictional-audio-hash', audio_provenance: { fictional: true }, result: { status: 'ok', text: 'Fictional recovered result.' }, quality_flags: [] }] } };
    let selected = [recovered, ...raw.slice(1), incoming];
    let archived = [{ ...pending, superseded_by: [recovered.id], superseded_at_segments_revision: 4 }];
    await page.evaluate(({ rows, archived }) => window.qaCleanSetSegments(rows, { superseded_segments: archived }), { rows: selected, archived });
    const recoveredBubble = transcript.locator('article[data-segment-id="live-context-selected"]');
    await recoveredBubble.waitFor({ state: 'attached' });
    assert.equal(await transcript.locator(`article[data-segment-id="${pending.id}"]`).count(), 0);
    assert.equal(await recoveredBubble.locator('.xx-transcript-message-text').innerText(), recovered.text);
    await recoveredBubble.getByText('–00:30', { exact: true }).waitFor({ state: 'attached' });
    await recoveredBubble.getByText('Processing checks', { exact: true }).click();
    await recoveredBubble.getByText('A retry with surrounding audio was selected for this transcript. Review it against the recording.', { exact: true }).waitFor();
    await recoveredBubble.getByText('Selected audio window: 00:00–00:30.', { exact: true }).waitFor();
    await recoveredBubble.getByText('Surrounding audio retry: 00:00–00:30. Repeated window: 00:00–00:10.', { exact: true }).waitFor();
    await recoveredBubble.getByText('Recognition before context recovery', { exact: true }).click();
    await recoveredBubble.getByText(originalLoop, { exact: true }).waitFor();
    await recoveredBubble.getByText('Recovery attempts', { exact: true }).click();
    await recoveredBubble.getByText('Surrounding audio retry · 00:00–00:30', { exact: true }).waitFor();
    await page.waitForFunction(() => window.qaCleanState().live.segment_metadata['live-context-selected']?.recovery?.method === 'context_window_retry');
    assert.equal(await editorText(editor), note);
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('sttapp.local-workflow.v1')));
    assert.ok(persisted.runs.every(run => !run.job?.segments && !run.job?.superseded_segments), 'browser pointers omit selected and archived transcript text');
    await page.setViewportSize({ width: 680, height: 820 });
    await recoveredBubble.evaluate(row => { row.parentElement.parentElement.scrollTop = 0; });
    await screenshot('live-context-recovery.png');
    report.checks.push('Same-count recovery revision replaces the provisional bubble with one full 30-second selected range; original recognition and recovery attempts remain reviewable');

    const earlierNeighbor = { id: 'live-prior-neighbor', text: 'The earlier neighbor includes markers for the workshop.', source_track: 'system', start_seconds: 20, end_seconds: 40 };
    const fringe = { ...recovered, id: 'live-boundary-replay', text: 'Bring markers for the workshop.', start_seconds: 30, end_seconds: 40, replaces_segment_ids: [earlierNeighbor.id],
      recognition_original: { text: earlierNeighbor.text }, recovery: { ...recovered.recovery, original_segment_id: earlierNeighbor.id, original_start_seconds: 20, original_end_seconds: 40,
        attempts: [...recovered.recovery.attempts, { kind: 'overlap_fringe', start_seconds: 30, end_seconds: 40, superseded_segment_id: earlierNeighbor.id, quality_flags: [] }] } };
    selected = [...selected.slice(0, -1), fringe, incoming];
    archived = [...archived, { ...earlierNeighbor, superseded_by: [recovered.id, fringe.id], superseded_at_segments_revision: 5 }];
    await page.evaluate(({ rows, archived }) => window.qaCleanSetSegments(rows, { superseded_segments: archived }), { rows: selected, archived });
    const liveFringe = transcript.locator('article[data-segment-id="live-boundary-replay"]');
    await liveFringe.waitFor({ state: 'attached' });
    await liveFringe.getByText('Processing checks', { exact: true }).click();
    await liveFringe.getByText('A boundary replay was selected to preserve neighboring speech. Review it against the recording.', { exact: true }).waitFor();
    await liveFringe.getByText('Selected audio window: 00:30–00:40.', { exact: true }).waitFor();
    await liveFringe.getByText('Parent retry: 00:00–00:30. Repeated window: 00:00–00:10.', { exact: true }).waitFor();
    await liveFringe.getByText('Earlier source window: 00:20–00:40.', { exact: true }).waitFor();
    await liveFringe.getByText('Recognition before boundary replay', { exact: true }).click();
    await liveFringe.getByText(earlierNeighbor.text, { exact: true }).waitFor();
    await screenshot('live-boundary-replay-provenance.png');
    report.checks.push('Boundary replay uses its actual selected 30–40-second coverage and identifies the parent 0–30-second retry, repeated core and earlier source separately');

    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.waitForURL('**/meeting-details?id=qa-live');
    await page.getByRole('textbox', { name: 'Meeting notes', exact: true }).waitFor();
    assert.equal(await editorText(page.getByRole('textbox', { name: 'Meeting notes', exact: true })), note);
    const savedToggle = page.getByRole('button', { name: 'Show transcript', exact: true });
    await savedToggle.focus(); await savedToggle.press('Enter');
    await page.mouse.move(0, 0);
    await page.locator('[data-sonner-toast]').waitFor({ state: 'detached', timeout: 10000 });
    const saved = page.getByRole('region', { name: 'Transcript', exact: true });
    await saved.locator('article[data-segment-id="live-incoming"]').waitFor({ state: 'attached' });
    assert.deepEqual(await saved.locator('.xx-transcript-message-text').allTextContents(), selected.map(row => row.text));
    const savedRecovery = saved.locator('article[data-segment-id="live-context-selected"]');
    const savedFringe = saved.locator('article[data-segment-id="live-boundary-replay"]');
    await savedFringe.getByText('Processing checks', { exact: true }).click();
    await savedFringe.getByText('Selected audio window: 00:30–00:40.', { exact: true }).waitFor();
    await savedFringe.getByText('Parent retry: 00:00–00:30. Repeated window: 00:00–00:10.', { exact: true }).waitFor();
    await savedFringe.getByText('Processing checks', { exact: true }).click();
    await savedRecovery.getByText('–00:30', { exact: true }).waitFor({ state: 'attached' });
    await savedRecovery.getByText('Processing checks', { exact: true }).click();
    await savedRecovery.getByText('A retry with surrounding audio was selected for this transcript. Review it against the recording.', { exact: true }).waitFor();
    await savedRecovery.getByText('Recognition before context recovery', { exact: true }).click();
    await savedRecovery.getByText(originalLoop, { exact: true }).waitFor();
    await saved.getByText('1 earlier correction kept for review', { exact: true }).click();
    await saved.getByText(correction.text, { exact: true }).waitFor();
    await saved.getByText('Source text for that correction', { exact: true }).click();
    const archivedSource = saved.locator('header').getByText(originalLoop, { exact: true });
    await archivedSource.waitFor(); await archivedSource.scrollIntoViewIfNeeded();
    const archivedBox = await archivedSource.boundingBox(), archiveHeader = await saved.locator('header').boundingBox();
    assert.ok(archivedBox.y >= archiveHeader.y && archivedBox.y + archivedBox.height <= archiveHeader.y + archiveHeader.height + 1, 'archived source text can scroll fully into view');
    await screenshot('saved-context-and-earlier-correction.png');
    report.checks.push('Saved recovery shows its range and original reference; archived manual correction remains retrievable and is never guessed onto the selected context');
    await saved.getByText('1 earlier correction kept for review', { exact: true }).click();
    await savedRecovery.getByText('Processing checks', { exact: true }).click();
    await saved.locator('.xx-transcript-thread').evaluate(element => { element.scrollTop = 0; });
    await screenshot('public-ready-bubbles-680x820.png');
    if (process.argv[3]) {
      const publicImage = path.resolve(process.argv[3]);
      fs.mkdirSync(path.dirname(publicImage), { recursive: true });
      fs.copyFileSync(path.join(output, 'public-ready-bubbles-680x820.png'), publicImage);
      report.public_preview = publicImage;
    }
    await saved.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy only', exact: true }).click();
    await page.waitForFunction(() => !!window.qaClipboard);
    const evidence = await page.evaluate(() => ({ copied: window.qaClipboard, state: window.qaCleanState(), calls: window.qaCalls, media: window.qaCleanMediaCalls }));
    let position = -1;
    for (const row of selected) { const next = evidence.copied.indexOf(row.text, position + 1); assert.ok(next > position, `Copied text keeps ${row.id}`); position = next; }
    assert.equal(evidence.copied.split(recovered.text).length - 1, 1, 'selected context appears exactly once in copy');
    assert.ok(!evidence.copied.includes(originalLoop)); assert.ok(!evidence.copied.includes(correction.text));
    assert.deepEqual(evidence.state.live.corrections, [correction], 'copy keeps the archived correction intact as reference');
    assert.equal(evidence.state.recording, false); assert.equal(evidence.media, 0);
    assert.equal(evidence.calls.filter(call => call.command === 'start_local_transcription').length, 1);
    assert.equal(evidence.calls.filter(call => call.command === 'stop_recording').length, 1);
    assert.ok(!evidence.calls.some(call => /open_claude|plugin:dialog|start_speaker/.test(call.command)));
    await page.mouse.move(0, 0);
    await page.locator('[data-sonner-toast]').waitFor({ state: 'detached', timeout: 10000 });
    const draftText = 'My in-progress correction belongs to the earlier recognition.';
    await savedRecovery.getByRole('button', { name: 'Edit', exact: true }).click();
    await savedRecovery.getByRole('textbox', { name: 'Correct transcript text', exact: true }).fill(draftText);
    const removedReplacement = { ...recovered, id: 'live-context-next', text: 'A newly selected context result keeps the original Hindi + English script.' };
    const removedArchive = [...archived, { ...recovered, superseded_by: [removedReplacement.id], superseded_at_segments_revision: 5 }];
    await page.evaluate(({ rows, archived }) => window.qaCleanSetSegments(rows, { superseded_segments: archived }), { rows: [removedReplacement, ...selected.slice(1)], archived: removedArchive });
    const retained = saved.getByRole('region', { name: 'Earlier correction draft', exact: true });
    await retained.waitFor();
    assert.equal(await retained.getByRole('textbox', { name: 'Correct earlier transcript text', exact: true }).inputValue(), draftText);
    assert.equal(await saved.getByRole('button', { name: 'Export', exact: true }).isEnabled(), false);
    await retained.getByText('Source text for this draft', { exact: true }).click();
    await retained.getByText(recovered.text, { exact: true }).waitFor();
    await retained.getByRole('button', { name: 'Cancel', exact: true }).click();
    await retained.waitFor({ state: 'detached' });
    assert.equal(await saved.getByRole('button', { name: 'Export', exact: true }).isEnabled(), true);
    assert.deepEqual((await page.evaluate(() => window.qaCleanState())).live.corrections, [correction], 'Cancel adds no guessed correction to the replacement');

    const changedBubble = saved.locator('article[data-segment-id="live-context-next"]');
    await changedBubble.getByRole('button', { name: 'Edit', exact: true }).click();
    await changedBubble.getByRole('textbox', { name: 'Correct transcript text', exact: true }).fill(draftText);
    const changedReplacement = { ...removedReplacement, text: 'Selected shorter retry result. यह नया text है.', recovery: { ...removedReplacement.recovery, method: 'shorter_window_retry' }, alternative: { text: 'Selected shorter retry result. यह नया text है.', promoted: true, requires_review: true }, recognition_original: { text: removedReplacement.text } };
    const changedArchive = [...removedArchive, { ...removedReplacement, superseded_by: [removedReplacement.id], superseded_at_segments_revision: 6 }];
    const finalRows = [changedReplacement, ...selected.slice(1)];
    await page.evaluate(({ rows, archived }) => window.qaCleanSetSegments(rows, { superseded_segments: archived }), { rows: finalRows, archived: changedArchive });
    await retained.waitFor();
    assert.equal(await retained.getByRole('textbox', { name: 'Correct earlier transcript text', exact: true }).inputValue(), draftText);
    await retained.getByRole('button', { name: 'Apply correction', exact: true }).click();
    await retained.waitFor({ state: 'detached' });
    await page.waitForFunction(text => window.qaCleanState().live.corrections.some(item => item.text === text), draftText);
    assert.equal(await changedBubble.locator('.xx-transcript-message-text').innerText(), changedReplacement.text, 'earlier draft cannot change new recognition with the same ID');
    await saved.getByText('2 earlier corrections kept for review', { exact: true }).click();
    await saved.locator('header').getByText(draftText, { exact: true }).waitFor();
    assert.equal(await saved.getByRole('button', { name: 'Export', exact: true }).isEnabled(), true);
    await screenshot('retained-draft-after-apply.png');
    await saved.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy only', exact: true }).click();
    await page.waitForFunction(text => window.qaClipboard.includes(text), changedReplacement.text);
    const finalCopy = await page.evaluate(() => window.qaClipboard);
    assert.equal(finalCopy.split(changedReplacement.text).length - 1, 1); assert.ok(!finalCopy.includes(draftText));
    report.checks.push('Removed and same-ID changed recognition keep the editing source snapshot visible; Cancel and Apply release export, and Apply archives the draft without changing selected copy');
    assert.deepEqual(report.page_errors, []); assert.deepEqual(report.external_requests, []);
    report.checks.push('Finish still opens the saved note and complete transcript; in-memory Copy only preserves all incoming text, including multiline and long tokens');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) { report.debug = await page.evaluate(() => ({ body: document.body.innerText.slice(-6000), state: window.qaCleanState?.() })); await screenshot('failure.png'); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
