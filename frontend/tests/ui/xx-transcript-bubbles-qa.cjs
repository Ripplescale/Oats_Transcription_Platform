/* Fictional transcript and silent audio; OS clipboard, native models and recording are unused. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/xx-transcript-bubbles');
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
  let browser, page;
  const report = { fictional_fixture: true, native_execution: false, actual_recording: false, os_clipboard: false, checks: [], screenshots: [], page_errors: [] };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 920, height: 740 } });
    page.on('pageerror', error => report.page_errors.push(error.message));
    await installFixture(page);
    await page.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.qaClipboard = '';
      window.qaBubbleRows = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.qaClipboard = String(text); } } });
      const extra = [
        { id: 'legacy-source', text: 'An older combined recording keeps a neutral source label.', timestamp: '15:05', audio_start_time: 100, audio_end_time: 120, source_track: 'mixed' },
        { id: 'missing-source', text: 'Source information was not saved.\n\nReference: ' + 'LongReferenceToken'.repeat(40), timestamp: '15:06', audio_start_time: 120, audio_end_time: 140 },
        { id: 'short-source', text: 'Yes.', timestamp: '15:07', audio_start_time: 140, audio_end_time: 142, source_track: 'system' },
      ];
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'api_get_meeting_transcripts') {
          const result = await original(command, { ...args, limit: 500, offset: 0 });
          const rows = [...result.transcripts, ...extra];
          window.qaBubbleRows = structuredClone(rows);
          return { transcripts: rows.slice(args.offset, args.offset + args.limit), total_count: rows.length, has_more: args.offset + args.limit < rows.length };
        }
        return original(command, args);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/meeting-details?id=qa-meeting`);
    await page.getByRole('textbox', { name: 'Meeting notes', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Transcript', exact: true });
    await transcript.locator('article[data-segment-id="missing-source"]').waitFor({ state: 'attached' });
    assert.deepEqual(await transcript.locator('article').evaluateAll(rows => rows.map(row => row.dataset.segmentId)), ['first', 'second', 'third', 'fourth', 'fifth', 'legacy-source', 'missing-source', 'short-source']);
    const setMode = async mode => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('group', { name: 'Display mode', exact: true }).getByRole('button', { name: mode, exact: true }).click();
      await page.keyboard.press('Escape');
    };
    assert.equal(await transcript.locator('.xx-transcript-source-label').count(), 0);
    assert.equal(await transcript.getByText('Processing checks', { exact: true }).count(), 0);
    assert.equal(await transcript.getByText('Review suggested', { exact: true }).count(), 0);
    const short = transcript.locator('article[data-segment-id="short-source"]');
    const long = transcript.locator('article[data-segment-id="first"]');
    assert.ok((await short.boundingBox()).width < (await long.boundingBox()).width * 0.6, 'A short User bubble fits its text instead of filling the column');
    await page.screenshot({ path: path.join(output, 'user-mode.png') }); report.screenshots.push('user-mode.png');
    await short.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'user-short-bubble.png') }); report.screenshots.push('user-short-bubble.png');
    await setMode('Dev');
    await transcript.getByText('Left: computer audio · Right: microphone. Labels identify audio sources, not people.', { exact: true }).waitFor();
    assert.ok((await short.boundingBox()).width < (await long.boundingBox()).width, 'Dev metadata uses natural width without a forced column-wide bubble');
    report.checks.push('User defaults to text and timestamps; Dev restores diagnostics and source labels without changing chronology');

    for (const [width, height] of [[600, 560], [600, 820], [680, 820], [920, 740]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(180);
      const layout = await transcript.evaluate(element => {
        const rows = [...element.querySelectorAll('article')];
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
          rows: rows.map(row => { const box = row.getBoundingClientRect(), text = row.querySelector('.xx-transcript-message-text'); return { id: row.dataset.segmentId, channel: row.dataset.sourceChannel,
            x: box.x, right: box.right, width: box.width, background: getComputedStyle(row).backgroundColor, textOverflows: text.scrollWidth > text.clientWidth + 1 }; }) };
      });
      assert.ok(layout.scrollWidth <= width + 1 && layout.scrollHeight <= height + 1, `Window overflow at ${width}x${height}`);
      const system = layout.rows[0], microphone = layout.rows[1];
      assert.equal(system.channel, 'system'); assert.equal(microphone.channel, 'microphone');
      assert.ok(microphone.x > system.x + 12, 'Microphone aligns to the right of computer audio');
      assert.notEqual(system.background, microphone.background, 'Both source colors are distinguishable');
      for (const row of layout.rows) {
        assert.ok(row.x >= 0 && row.right <= width + 1 && row.width > 40, `Bubble fits its content within the window for ${row.id}`);
        assert.equal(row.textOverflows, false, `Long tokens wrap within ${row.id}`);
      }
      for (const row of layout.rows.filter(row => ['legacy-source', 'missing-source'].includes(row.id))) {
        assert.equal(row.channel, 'unknown'); assert.notEqual(row.background, system.background); assert.notEqual(row.background, microphone.background);
        const container = await transcript.locator('.xx-transcript-thread').boundingBox();
        assert.ok(Math.abs((row.x + row.right) / 2 - (container.x + container.width / 2)) < 15, 'Legacy and missing sources remain centered');
      }
      const missing = transcript.locator('article[data-segment-id="missing-source"]');
      await missing.getByText('Source unavailable', { exact: true }).waitFor({ state: 'attached' });
      await missing.scrollIntoViewIfNeeded();
      const unknownShot = `neutral-long-token-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, unknownShot) }); report.screenshots.push(unknownShot);
      await transcript.locator('article').first().evaluate(row => { row.parentElement.scrollTop = 0; });
      const shot = `source-bubbles-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, shot) }); report.screenshots.push(shot);
      report.checks.push({ viewport: `${width}x${height}`, layout });
    }

    const microphone = transcript.locator('article[data-segment-id="second"]');
    await microphone.getByText('Microphone', { exact: true }).waitFor();
    await microphone.getByRole('button', { name: 'Edit', exact: true }).click();
    const corrected = 'Checked microphone line. हिंदी and English remain together.';
    await microphone.getByRole('textbox', { name: 'Correct transcript text', exact: true }).fill(corrected);
    await page.evaluate(() => { window.qaDraftElement = document.querySelector('textarea[aria-label="Correct transcript text"]'); window.qaAudioElement = document.querySelector('audio'); });
    await setMode('User');
    assert.equal(await microphone.getByRole('textbox', { name: 'Correct transcript text', exact: true }).inputValue(), corrected);
    assert.equal(await page.evaluate(() => window.qaDraftElement === document.querySelector('textarea[aria-label="Correct transcript text"]') && window.qaAudioElement === document.querySelector('audio')), true);
    assert.equal(await microphone.getByText('Microphone', { exact: true }).count(), 0);
    await setMode('Dev');
    await microphone.getByRole('button', { name: 'Apply correction', exact: true }).click();
    await page.waitForFunction(() => window.qaWorkspace().corrections.some(item => item.segment_id === 'second'));
    await microphone.getByText(corrected, { exact: true }).waitFor();
    await microphone.getByText('Original recognition', { exact: true }).click();
    const raw = await page.evaluate(() => window.qaBubbleRows.find(row => row.id === 'second').text);
    await microphone.getByText(raw, { exact: true }).waitFor();
    await page.locator('audio').evaluate(audio => { audio.muted = true; });
    await microphone.getByRole('button', { name: '00:20', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime >= 20);
    await page.locator('audio').evaluate(audio => audio.pause());
    report.checks.push('Bubble editing retains raw mixed-script recognition and timestamp playback uses the persistent audio player');

    await transcript.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy only', exact: true }).click();
    await page.waitForFunction(() => !!window.qaClipboard);
    const evidence = await page.evaluate(() => ({ copied: window.qaClipboard, rows: window.qaBubbleRows, calls: window.qaCalls }));
    let position = -1;
    for (const row of evidence.rows) {
      const text = row.id === 'second' ? corrected : row.text;
      const next = evidence.copied.indexOf(text, position + 1);
      assert.ok(next > position, `Complete copied text retains chronology for ${row.id}`); position = next;
    }
    assert.ok(evidence.copied.includes('LongReferenceToken'.repeat(40)), 'Copy keeps the full unbroken long token');
    assert.ok(!evidence.calls.some(call => /start_.*(recording|transcription|identification)|open_claude|plugin:dialog/.test(call.command)));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await transcript.getByText('Left: computer audio · Right: microphone. Labels identify audio sources, not people.', { exact: true }).waitFor();
    await setMode('User'); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await transcript.locator('article[data-segment-id="first"]').waitFor({ state: 'attached' });
    assert.equal(await transcript.locator('.xx-transcript-source-label').count(), 0);
    report.checks.push('Mode changes keep the exact correction editor and audio element mounted; both mode choices persist across reloads');
    assert.deepEqual(report.page_errors, []);
    report.checks.push('Copy uses every complete segment in unchanged order, including correction, unknown sources and the untruncated long token');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) { report.debug = await page.evaluate(() => document.body.innerText.slice(-5000)); await page.screenshot({ path: path.join(output, 'failure.png') }); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
