/* Synthetic popup only. No real microphone, keyboard hook, external app, or clipboard access. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const root = path.resolve(__dirname, '../../public');
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/dictation-popup');
  fs.mkdirSync(output, { recursive: true });
  const allowed = new Set(['dictation.html', 'dictation.css', 'dictation.js', 'oats-buddy.png']);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!allowed.has(name)) return res.writeHead(404).end();
    res.setHeader('Content-Type', name.endsWith('.png') ? 'image/png' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'");
    res.end(fs.readFileSync(path.join(root, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  const report = { native_execution: false, actual_recording: false, os_clipboard: false, checks: [], page_errors: [], screenshots: [] };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 264, height: 48 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => report.page_errors.push(error.message));
    await page.addInitScript(() => {
      let snapshot = { phase: 'idle', session_id: null, elapsed_seconds: 0, level: 0, text: null, message: null, microphone: 'Fictional default microphone', available: true,
        shortcuts: { fallback: { label: 'Ctrl + Alt + Shift + D', registered: true }, copilot: { label: 'Win + Shift + F23', registered: false } } };
      window.qaCalls = []; window.qaFailCommand = null; window.qaCopy = '';
      window.qaSetDictation = next => { snapshot = { ...snapshot, ...next }; };
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        window.qaCalls.push({ command, args });
        if (command === 'dictation_status') return structuredClone(snapshot);
        if (command === 'dictation_popup_layout') return;
        if (command === 'dictation_popup_drag') {
          if (args.sessionId !== snapshot.session_id) throw Error('This dictation session has changed.');
          if (!['start', 'move', 'end', 'cancel'].includes(args.phase) || !Number.isFinite(args.deltaX) || !Number.isFinite(args.deltaY)) throw Error('Invalid synthetic drag command');
          await new Promise(resolve => setTimeout(resolve, 45));
          return;
        }
        if (!['dictation_toggle', 'dictation_cancel', 'dictation_copy', 'dictation_dismiss'].includes(command)) throw Error('Unexpected command');
        if (args.sessionId !== snapshot.session_id) throw Error('This dictation session has changed.');
        if (window.qaFailCommand === command) throw Error('Fictional command failure. Your result is kept.');
        await new Promise(resolve => setTimeout(resolve, 60));
        if (command === 'dictation_toggle') snapshot.phase = 'transcribing';
        if (command === 'dictation_cancel') snapshot.phase = 'cancelled';
        if (command === 'dictation_copy') window.qaCopy = snapshot.text;
        if (command === 'dictation_dismiss') snapshot.phase = 'idle';
      } } };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => { throw Error('Actual clipboard is forbidden in this test'); } } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/dictation.html`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Ready to dictate' }).waitFor();
    assert.ok((await page.evaluate(() => window.qaCalls)).every(call => ['dictation_status', 'dictation_popup_layout'].includes(call.command)), 'Mount performs only read-only status checks');
    assert.equal(await page.getByRole('button', { name: 'Stop dictation', exact: true }).isVisible(), false);
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), false);
    assert.equal(await page.locator('#dictation').evaluate(element => getComputedStyle(element).borderBottomWidth), '0px', 'Unified surface has no bottom divider');
    assert.equal(await page.locator('.pill').evaluate(element => getComputedStyle(element).height), '48px');
    await page.screenshot({ path: path.join(output, 'idle.png') }); report.screenshots.push('idle.png');
    report.checks.push('No capture or clipboard mutation on mount or polling');

    await page.evaluate(() => window.qaSetDictation({ phase: 'listening', session_id: 'degraded-trelis', live_typing: true,
      streaming_message: 'Pause detection is unavailable. Streaming continues with word agreement.' }));
    await page.getByRole('heading', { name: 'Listening · check Settings', exact: true }).waitFor();
    assert.match(await page.locator('#title').getAttribute('title'), /Pause detection is unavailable/);
    assert.equal(await page.getByRole('button', { name: 'Copy text', exact: true }).isVisible(), false);
    await page.evaluate(() => window.qaSetDictation({ streaming_message: null, live_typing: false }));
    report.checks.push('Degraded pause detection is visible without interrupting live typing or offering Copy prematurely');

    await page.evaluate(() => window.qaSetDictation({ phase: 'listening', session_id: 'fictional-one', elapsed_seconds: 65.9, level: 0 }));
    await page.getByRole('heading', { name: 'Listening', exact: true }).waitFor();
    assert.equal(await page.locator('#level').isVisible(), true);
    assert.equal(await page.locator('#processing').isVisible(), false);
    assert.equal(await page.locator('#elapsed').textContent(), '01:05');
    assert.equal(await page.locator('.buddy').count(), 0, 'No mascot in the selected pill');
    assert.equal(await page.locator('#hint').evaluate(element => getComputedStyle(element).clipPath), 'inset(50%)');
    for (const id of ['stop', 'cancel']) {
      const box = await page.locator('#' + id).boundingBox(); assert.ok(box.width >= 32 && box.height >= 32);
    }
    assert.deepEqual(await page.locator('.level i').evaluateAll(bars => bars.map(bar => bar.style.height)), Array(7).fill('2px'));
    await page.evaluate(() => window.qaSetDictation({ level: 0.64 }));
    await page.waitForFunction(() => document.querySelector('#level').getAttribute('aria-valuenow') === '64');
    assert.equal(await page.locator('.level i').last().evaluate(bar => bar.style.height), '12px');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'Compact popup fits 264 × 48');
    await page.screenshot({ path: path.join(output, 'listening.png') }); report.screenshots.push('listening.png');
    const grip = await page.locator('#grip').boundingBox();
    assert.equal(grip.width, 20);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
    assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.command === 'dictation_popup_drag').length), 0);
    await page.evaluate(() => document.querySelector('#grip').addEventListener('pointerdown', event => {
      window.qaPointer = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY };
    }, { once: true }));
    await page.mouse.down();
    await page.mouse.move(grip.x + 60, grip.y + 24, { steps: 2 });
    // Dispatch one actual burst: awaited Playwright mouse steps can each take
    // longer than the coalescing interval on a busy Windows build machine.
    await page.evaluate(() => {
      const grip = document.querySelector('#grip'), start = window.qaPointer;
      for (let index = 1; index <= 20; index++) grip.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: start.pointerId, screenX: start.screenX + index * 6, screenY: start.screenY + 24,
      }));
    });
    await page.mouse.up();
    await page.waitForFunction(() => window.qaCalls.some(call => call.command === 'dictation_popup_drag' && call.args.phase === 'end'));
    const gesture = await page.evaluate(() => window.qaCalls.filter(call => call.command === 'dictation_popup_drag'));
    assert.equal(gesture[0].args.phase, 'start'); assert.equal(gesture.at(-1).args.phase, 'end');
    assert.ok(gesture.every(call => call.args.sessionId === 'fictional-one'));
    assert.ok(gesture.length < 22, 'Move queue coalesces rapid pointer updates');
    assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.command === 'dictation_toggle').length), 0, 'Dragging across Stop never stops capture');
    await page.waitForFunction(() => document.querySelector('#grip').dataset.dragging === 'false');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 60, grip.y + 20);
    await page.locator('#grip').dispatchEvent('pointercancel');
    await page.mouse.up();
    await page.waitForFunction(() => window.qaCalls.some(call => call.command === 'dictation_popup_drag' && call.args.phase === 'cancel'));
    await page.waitForFunction(() => document.querySelector('#grip').dataset.dragging === 'false');
    report.checks.push('Grip-only dragging orders session-bound start/move/end, ignores right clicks, coalesces moves, and never triggers Stop');
    report.checks.push('Cancelled pointer gestures send native cancel and release the grip for future movement');
    await page.evaluate(() => window.qaSetDictation({ live_typing: true, inserted_characters: 8 }));
    await page.getByRole('heading', { name: 'Typing live', exact: true }).waitFor();
    assert.equal(await page.locator('#result-panel').isVisible(), false, 'Live typing preserves the compact indicator');
    const draft = 'अभी <img src=x onerror="window.injected=true"> ' + 'LongDraft'.repeat(40);
    await page.evaluate(text => window.qaSetDictation({ backend: 'faster_whisper', text: 'Stable words.', draft_text: text }), draft);
    await page.waitForFunction(text => document.querySelector('#hint').textContent === `Draft: ${text}`, draft);
    assert.equal(await page.locator('#hint img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#hint').getAttribute('title'), `Draft, may change before typing: ${draft}`);
    assert.equal(await page.locator('#hint').getAttribute('aria-label'), `Draft, may change before typing: ${draft}`);
    assert.equal(await page.locator('#result').textContent(), 'Stable words.', 'Draft never enters the result field');
    assert.equal(await page.locator('#copy').isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'Long draft preserves 264 × 48');
    await page.screenshot({ path: path.join(output, 'draft.png') }); report.screenshots.push('draft.png');
    await page.evaluate(() => window.qaSetDictation({ draft_text: 'A revised ending' }));
    await page.waitForFunction(() => document.querySelector('#hint').textContent === 'Draft: A revised ending');
    assert.ok(!(await page.locator('#hint').textContent()).includes('LongDraft'));
    await page.evaluate(() => window.qaSetDictation({ draft_text: '' }));
    await page.waitForFunction(() => document.querySelector('#hint').dataset.draft === 'false');
    assert.equal(await page.locator('#hint').getAttribute('aria-label'), null);
    assert.ok(!(await page.locator('#hint').getAttribute('title')).includes('Draft'));
    await page.evaluate(() => window.qaSetDictation({ text: 'Stable words. A revised ending', draft_text: 'next words' }));
    await page.waitForFunction(() => document.querySelector('#hint').textContent === 'Draft: next words');
    assert.equal(await page.locator('#result').textContent(), 'Stable words. A revised ending');
    assert.equal(await page.locator('#hint').textContent(), 'Draft: next words', 'Promoted words are not duplicated in the draft');
    assert.equal(await page.evaluate(() => window.qaCopy), '');
    report.checks.push('Tentative draft is escaped, revisable, retractable and accessible within 264 × 48; promotion keeps stable and draft text separate');
    await page.evaluate(() => window.qaSetDictation({ live_typing: false, delivery_message: 'The text destination changed.' }));
    await page.waitForFunction(() => document.querySelector('#hint').textContent === 'Listening. Finish to copy your text.');
    assert.equal(await page.locator('#hint').getAttribute('aria-label'), null, 'Draft never obscures Copy recovery');
    assert.ok((await page.locator('#cancel').getAttribute('title')).includes('words already typed stay'));
    report.checks.push('Live delivery status fits the existing pill and interrupted delivery remains explicit copy recovery');
    await page.locator('#stop').click(); await page.locator('#stop').dispatchEvent('click');
    await page.getByRole('heading', { name: 'Transcribing…', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.qaCalls.filter(call => call.command === 'dictation_toggle'))).length, 1);
    assert.equal(await page.locator('#level').getAttribute('aria-valuenow'), '0');
    assert.deepEqual(await page.locator('.level i').evaluateAll(bars => bars.map(bar => bar.style.height)), Array(7).fill('2px'));
    assert.equal(await page.locator('#level').isVisible(), false, 'Processing never shows fake microphone dots');
    assert.equal(await page.locator('#stop').isVisible(), false, 'Processing has no useless disabled Stop button');
    assert.equal(await page.locator('#processing').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Cancelled', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#hint').textContent === 'Any words already typed are kept.');
    assert.equal(await page.locator('#hint').getAttribute('aria-label'), null, 'Cancelled sessions hide a stale draft');
    assert.equal(await page.locator('#hint').getAttribute('data-draft'), 'false');
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'cancelled.png') }); report.screenshots.push('cancelled.png');
    const mutations = await page.evaluate(() => window.qaCalls.filter(call => !['dictation_status', 'dictation_popup_layout', 'dictation_popup_drag'].includes(call.command)));
    assert.deepEqual(mutations, [{ command: 'dictation_toggle', args: { sessionId: 'fictional-one' } }, { command: 'dictation_cancel', args: { sessionId: 'fictional-one' } }]);
    report.checks.push('Real level samples drive bars; silence and transcription have no fake waveform; Stop is deduplicated and Escape in the focused popup cancels the exact session');

    await page.evaluate(() => window.qaSetDictation({ phase: 'starting', session_id: 'fresh-session', draft_text: 'stale draft from prior session', delivery_message: null }));
    await page.getByRole('heading', { name: 'Getting ready…', exact: true }).waitFor();
    assert.equal(await page.locator('#stop').isVisible(), false);
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), true);
    assert.equal(await page.locator('#processing').evaluate(element => getComputedStyle(element).animationName), 'none', 'Reduced motion keeps the honest processing indicator still');
    assert.equal(await page.locator('#cancel').isEnabled(), true);
    assert.ok(await page.locator('#title').evaluate(element => element.scrollWidth <= element.clientWidth), 'Starting status fits without truncation');
    await page.screenshot({ path: path.join(output, 'starting.png') }); report.screenshots.push('starting.png');
    assert.equal(await page.locator('#hint').getAttribute('data-draft'), 'false');
    assert.ok(!(await page.locator('#hint').textContent()).includes('stale draft'));
    await page.evaluate(() => window.qaSetDictation({ phase: 'listening', draft_text: null, text: null, live_typing: false, inserted_characters: 0 }));
    await page.getByRole('heading', { name: 'Listening', exact: true }).waitFor();
    assert.ok(!(await page.locator('#hint').textContent()).includes('Draft'));
    report.checks.push('Cancellation and a new starting session clear the visible draft without retaining earlier tentative words');

    await page.setViewportSize({ width: 264, height: 220 });
    await page.evaluate(() => { window.qaFailCommand = 'dictation_toggle'; window.qaSetDictation({ text: 'Stable words are not a final result yet.' }); });
    await page.locator('#stop').click();
    await page.locator('#message').filter({ hasText: 'Fictional command failure' }).waitFor();
    assert.equal(await page.locator('#dictation').getAttribute('data-expanded'), 'true');
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await page.locator('#copy').isVisible(), false);
    assert.equal(await page.locator('#cancel').isEnabled(), true);
    await page.screenshot({ path: path.join(output, 'active-error.png') }); report.screenshots.push('active-error.png');
    await page.evaluate(() => { window.qaFailCommand = null; });
    await page.locator('#stop').click();
    await page.getByRole('heading', { name: 'Transcribing…', exact: true }).waitFor();
    assert.equal(await page.locator('#stop').isVisible(), false);
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), true);
    assert.ok(await page.locator('#title').evaluate(element => element.scrollWidth <= element.clientWidth), 'Processing status fits without truncation');
    const processingAlignment = await page.evaluate(() => {
      const center = id => { const box = document.getElementById(id).getBoundingClientRect(); return box.y + box.height / 2; };
      return ['title', 'processing', 'grip', 'cancel'].map(center);
    });
    assert.ok(processingAlignment.every(value => Math.abs(value - 24) <= 1), 'Processing status and controls share the vertical center');
    await page.setViewportSize({ width: 264, height: 48 });
    await page.screenshot({ path: path.join(output, 'transcribing.png') }); report.screenshots.push('transcribing.png');
    await page.evaluate(() => window.qaSetDictation({ phase: 'inserted', text: 'Fictional finished words.', draft_text: null }));
    await page.getByRole('heading', { name: 'Text inserted', exact: true }).waitFor();
    assert.equal(await page.locator('#dictation').getAttribute('data-expanded'), 'false');
    assert.equal(await page.locator('#result-panel').isVisible(), false);
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'inserted.png') }); report.screenshots.push('inserted.png');
    report.checks.push('Starting/transcribing center a status and honest processing indicator with Cancel only; Stop and microphone meter appear only while listening');
    report.checks.push('Active action failures expand visibly without exposing tentative text as a final Copy result');

    await page.setViewportSize({ width: 264, height: 220 });
    const transcript = 'नमस्ते. Keep this exact text.\n<img src=x onerror="window.injected=true">\n' + 'LongToken'.repeat(40);
    await page.evaluate(text => window.qaSetDictation({ phase: 'ready', session_id: 'fictional-two', text, draft_text: 'unresolved stale draft', message: 'No text cursor was available. Copy the result when you are ready.' }), transcript);
    await page.getByRole('heading', { name: 'Ready to copy', exact: true }).waitFor();
    assert.equal(await page.locator('#level').isVisible(), false);
    assert.equal(await page.locator('#processing').isVisible(), false);
    assert.equal(await page.locator('#result').textContent(), transcript);
    assert.equal(await page.locator('#result img').count(), 0);
    assert.equal(await page.locator('#hint').getAttribute('data-draft'), 'false', 'Final result hides any stale draft');
    assert.equal(await page.evaluate(() => window.qaCopy), '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'Result fits 264 × 220');
    await page.screenshot({ path: path.join(output, 'ready.png') }); report.screenshots.push('ready.png');
    await page.getByRole('button', { name: 'Copy text', exact: true }).click();
    await page.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.qaCopy), transcript);
    await page.waitForTimeout(300); await page.getByText('Copied', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Dismiss dictation', exact: true }).click();
    await page.getByRole('heading', { name: 'Ready to dictate', exact: true }).waitFor();
    report.checks.push('Ready text stays local until explicit guarded Copy; result is rendered as text, wraps safely, and Dismiss is explicit');

    await page.evaluate(() => { window.qaFailCommand = 'dictation_copy'; window.qaSetDictation({ phase: 'error', session_id: 'fictional-three', text: 'Preserve this result.', message: 'The target app no longer accepts input. Copy your text instead.' }); });
    await page.getByRole('heading', { name: 'Couldn’t finish', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy text', exact: true }).click();
    await page.locator('#message').filter({ hasText: 'Fictional command failure. Your result is kept.' }).waitFor();
    assert.equal(await page.locator('#result').textContent(), 'Preserve this result.');
    assert.equal(await page.getByRole('button', { name: 'Copy text', exact: true }).isEnabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'Actionable error fits 264 × 220');
    await page.screenshot({ path: path.join(output, 'error.png') }); report.screenshots.push('error.png');
    await page.evaluate(() => { window.qaFailCommand = null; });
    await page.getByRole('button', { name: 'Copy text', exact: true }).click();
    await page.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.qaCopy), 'Preserve this result.');
    await page.setViewportSize({ width: 264, height: 220 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow popup has no horizontal overflow');
    report.checks.push('Failed actions preserve text and support deliberate retry; narrow layout remains usable');
    await page.evaluate(() => window.qaSetDictation({ session_id: 'no-result', phase: 'error', text: null, message: 'Could not open the microphone. Check your selected input device in oats Settings and try again. ' + 'Additional fictional recovery details. '.repeat(8) }));
    await page.waitForFunction(() => document.querySelector('#copy').hidden && document.querySelector('#message').textContent.includes('Could not open'));
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await page.locator('#dismiss').isEnabled(), true);
    const messageBox = await page.locator('#message').boundingBox();
    assert.ok(messageBox.y + messageBox.height <= 220, 'Long error remains scrollable inside the expanded panel');
    await page.screenshot({ path: path.join(output, 'error-no-result.png') }); report.screenshots.push('error-no-result.png');
    report.checks.push('Errors without text retain readable scrollable recovery details and a reachable Dismiss control');
    assert.deepEqual(report.page_errors, []); report.passed = true;
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
