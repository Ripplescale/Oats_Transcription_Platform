// Installed-app inspection only. Never start/stop capture, dictate, inject text, copy, or edit preferences/notes.
// Usage: node verify-dictation-installed.cjs <CDP endpoint> <data root> <version> <report path>
// Requires the saved, idle main app at Home in its normal narrow window. Note safety is checked separately
// by verify-user-notes-installed.cjs; this verifier never opens a note or reads its contents.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSPECTION = '__oatsDictationInstalledInspection';
const mutationSource = '^(?:dictation_(?:toggle|cancel|copy|dismiss)$|(?:start|stop|pause|resume)_.*(?:recording|capture|transcription|identification)|save_|api_save_|api_delete_|delete_|set_meeting_tags$|move_meeting_to_project$|archive_project$|create_project$|rename_project$|set_meeting_detection$)';
const phases = new Set(['idle', 'starting', 'listening', 'transcribing', 'ready', 'inserted', 'cancelled', 'error']);

async function safety(page) {
  return page.evaluate(async () => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const statuses = [...document.querySelectorAll('.xx-saved-note-status, .xx-live-note-meta [role="status"]')].filter(visible);
    const dictation = await invoke('dictation_status');
    return {
      active_capture: (await invoke('get_active_capture')) !== null,
      recording: await invoke('is_recording'),
      dictation_phase: dictation.phase,
      journals: Object.keys(localStorage).filter(key => /^xx\.(?:note|workspace)-draft\./.test(key) && localStorage.getItem(key)).length,
      pending_edits: statuses.some(element => /unsaved|saving|not saved|correction in progress/i.test(element.textContent || '')),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
    };
  });
}

async function requireSafe(page) {
  const state = await safety(page);
  assert.equal(state.active_capture, false, 'Capture is active; app left intact.');
  assert.equal(state.recording, false, 'Recording is active; app left intact.');
  assert(phases.has(state.dictation_phase), 'Unknown dictation phase.');
  assert(!['starting', 'listening', 'transcribing'].includes(state.dictation_phase), 'Dictation is active; app left intact.');
  assert.equal(state.journals, 0, 'A saved draft journal needs attention; app left intact.');
  assert.equal(state.pending_edits, false, 'Pending edits exist; app left intact.');
  assert.equal(state.alerts, 0, 'An alert needs attention; app left intact.');
  assert.equal(state.dialogs, 0, 'A dialog is open; app left intact.');
  return state;
}

async function nativeStatus(page) {
  // Deliberately omit dictated text, session IDs, microphone names and native error detail from reports.
  return page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const status = await invoke('dictation_status');
    const binding = value => ({ registered: value?.registered, observed: value?.observed, has_error: value?.error != null });
    return {
      version: await window.__TAURI__.app.getVersion(),
      data_root: await invoke('get_database_directory'),
      phase: status.phase, available: status.available, backend: status.backend,
      elapsed_valid: Number.isFinite(status.elapsed_seconds) && status.elapsed_seconds >= 0,
      level_valid: Number.isFinite(status.level) && status.level >= 0 && status.level <= 1,
      text_valid: status.text == null || typeof status.text === 'string',
      has_result: typeof status.text === 'string' && status.text.length > 0,
      shortcuts: { fallback: binding(status.shortcuts?.fallback), copilot: binding(status.shortcuts?.copilot) },
      stored_mode: localStorage.getItem('xx-display-mode'),
    };
  });
}

async function main() {
  const [endpoint, expectedRoot, expectedVersion, reportPath] = process.argv.slice(2);
  if (!endpoint || !expectedRoot || !expectedVersion || !reportPath) throw Error('Pass CDP endpoint, data root, expected version, and report path.');
  const reportFile = path.resolve(reportPath);
  const screenshotFile = path.join(path.dirname(reportFile), `${path.basename(reportFile, path.extname(reportFile))}-settings.png`);
  const report = { state: 'checking', checked_at: new Date().toISOString(), checks: [], live_dictation_tested: false, text_insertion_tested: false, clipboard_tested: false };
  let browser, page, observing = false, stage = 'connect';
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      if (!/tauri|localhost/.test(candidate.url()) || /(?:meeting-prompt|dictation)\.html/.test(candidate.url())) continue;
      const label = await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null);
      if (label === 'main') { page = candidate; break; }
    }
    assert(page, 'Installed main WebView not found.');
    page.setDefaultTimeout(15000);
    stage = 'idle_home';
    await requireSafe(page);
    assert.equal(await page.evaluate(() => location.pathname.replace(/\/$/, '') || '/'), '/', 'Start from Home; app left intact.');
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    const search = page.getByRole('textbox', { name: 'Search notes', exact: true });
    await search.waitFor();
    assert.equal(await search.inputValue(), '', 'Clear the library search before inspection.');

    stage = 'guard_native_calls';
    await page.evaluate(({ key, mutationSource }) => {
      if (window[key]) throw Error('A dictation inspection is already active.');
      const original = window.__TAURI_INTERNALS__.invoke;
      const mutations = new RegExp(mutationSource);
      const counts = Object.create(null), blocked = Object.create(null);
      const wrapper = function(command, ...args) {
        counts[command] = (counts[command] || 0) + 1;
        if (mutations.test(command)) {
          blocked[command] = (blocked[command] || 0) + 1;
          return Promise.reject(new Error('Read-only installed inspection blocked a mutating command.'));
        }
        return original.call(this, command, ...args);
      };
      window[key] = { original, wrapper, counts, blocked };
      window.__TAURI_INTERNALS__.invoke = wrapper;
    }, { key: INSPECTION, mutationSource });
    observing = true;

    stage = 'native_dictation_status';
    const before = await nativeStatus(page);
    assert.equal(before.version, expectedVersion, 'Installed version differs from expected build.');
    assert.equal(path.resolve(before.data_root).toLowerCase(), path.resolve(expectedRoot).toLowerCase(), 'Installed data root changed.');
    assert.equal(before.available, true, 'Dictation runtime prerequisites are unavailable.');
    assert.equal(before.backend, 'trelis', 'The installed app is not using the restored Trelis backend.');
    assert(before.elapsed_valid && before.level_valid && before.text_valid, 'Dictation status has invalid fields.');
    assert.equal(before.shortcuts.fallback.registered, true, 'Fallback dictation shortcut is unavailable.');
    assert.equal(before.shortcuts.fallback.has_error, false, 'Fallback dictation shortcut has an error.');
    for (const value of Object.values(before.shortcuts)) {
      assert.equal(typeof value.registered, 'boolean'); assert.equal(typeof value.observed, 'boolean');
    }
    report.version = before.version;
    report.data_root_matches = true;
    report.dictation = { backend: before.backend, phase: before.phase, available: before.available, has_retained_result: before.has_result, shortcuts: before.shortcuts };
    report.checks.push('Expected installed version and data root; idle capture/dictation; available runtime prerequisites; fallback shortcut registered');

    stage = 'open_dictation_settings';
    await requireSafe(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'All settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Dictation', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Dictation', exact: true });
    await panel.waitFor();
    await panel.getByRole('heading', { name: 'Dictation', exact: true }).waitFor();
    const start = panel.getByRole('button', { name: 'Start dictation', exact: true });
    await start.waitFor();
    await page.waitForFunction(() => {
      const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
      return panel && !panel.textContent.includes('Checking…');
    });
    assert.equal(await start.isEnabled(), true, 'Dictation start control is unavailable.');
    const copilotLabel = !before.shortcuts.copilot.registered ? 'Unavailable on this setup' : before.shortcuts.copilot.observed ? 'Key detected' : 'Shortcut ready; key untested';
    await panel.getByText(copilotLabel, { exact: true }).waitFor();
    await panel.getByText(/Copilot support depends on the key signal your laptop sends/).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Stop dictation', exact: true }).count(), 0);

    stage = 'narrow_settings_layout';
    const layout = await page.getByRole('tablist').evaluate(element => ({ width: innerWidth, height: innerHeight,
      scroll_width: document.documentElement.scrollWidth, scroll_height: document.documentElement.scrollHeight,
      tabs: [...element.querySelectorAll('[role="tab"]')].map(tab => { const b = tab.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; }) }));
    assert(layout.width >= 320 && layout.width <= 720, 'Use the normal narrow app window for this inspection.');
    assert(layout.scroll_width <= layout.width + 1 && layout.scroll_height <= layout.height + 1, 'Settings overflows the app window.');
    assert.equal(layout.tabs.length, 5, 'Settings tab count is unexpected.');
    assert(layout.tabs.every(tab => tab.x >= 0 && tab.right <= layout.width + 1 && tab.y >= 0 && tab.bottom <= layout.height + 1), 'A Settings tab is unreachable.');
    await start.scrollIntoViewIfNeeded();
    const startBox = await start.boundingBox();
    assert(startBox && startBox.y >= 0 && startBox.y + startBox.height <= layout.height + 1, 'Dictation control is unreachable by scrolling.');
    const result = panel.getByRole('region', { name: 'Dictation result', exact: true });
    if (before.has_result) {
      await result.waitFor();
      const copy = panel.getByRole('button', { name: /^(?:Copy result|Copy last dictation)$/ });
      await copy.waitFor(); assert.equal(await copy.isEnabled(), true, 'Retained-result copy control is unavailable.');
      report.retained_result_control = 'present_not_clicked';
    } else report.retained_result_control = 'not_applicable';
    await requireSafe(page);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    // Only Settings is captured. Mask any retained dictated text and device label without changing the DOM.
    await page.screenshot({ path: screenshotFile, mask: [result, panel.locator('p').filter({ hasText: 'Microphone:' })] });
    report.screenshot = path.basename(screenshotFile);
    report.layout = { width: layout.width, height: layout.height, tab_rows: new Set(layout.tabs.map(tab => tab.y)).size, overflow: false };
    report.checks.push('Dictation Settings renders in the narrow window; tabs and controls are reachable; Copilot hardware observation is described separately');

    stage = 'return_home';
    await requireSafe(page);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await requireSafe(page);
    const after = await nativeStatus(page);
    assert.equal(after.stored_mode, before.stored_mode, 'Display preference changed.');
    assert.equal(after.phase, before.phase, 'Dictation state changed during inspection.');
    assert.equal(after.has_result, before.has_result, 'Retained-result availability changed.');
    const observations = await page.evaluate(key => ({ counts: { ...window[key].counts }, blocked: { ...window[key].blocked } }), INSPECTION);
    report.blocked_mutation_count = Object.values(observations.blocked).reduce((sum, count) => sum + count, 0);
    report.dictation_mutation_count = Object.entries(observations.counts).filter(([command]) => /^dictation_(toggle|cancel|copy|dismiss)$/.test(command)).reduce((sum, [, count]) => sum + count, 0);
    assert.equal(report.blocked_mutation_count, 0, 'A mutating command was attempted and blocked.');
    assert.equal(report.dictation_mutation_count, 0, 'A dictation mutation was attempted.');
    report.no_capture_or_dictation_started = true;
    report.returned_to_home = true;
    report.display_preference_unchanged = true;
    report.checks.push('Returned Home with no dictation/capture, clipboard, injection, note edits, or preference changes requested');
    report.state = before.shortcuts.copilot.registered && before.phase !== 'error' ? 'passed' : 'passed_with_limitations';
    if (!before.shortcuts.copilot.registered) report.copilot_limitation = 'binding_unavailable_fallback_registered';
    if (before.phase === 'error') report.prior_dictation_outcome = 'error_not_retried';
  } catch (error) {
    report.state = 'failed'; report.failure_stage = stage; report.failure_kind = error.name || 'Error';
    report.app_exit_requested = false; process.exitCode = 1;
  } finally {
    if (page && observing) await page.evaluate(key => {
      const inspection = window[key];
      if (!inspection) return;
      if (window.__TAURI_INTERNALS__.invoke === inspection.wrapper) window.__TAURI_INTERNALS__.invoke = inspection.original;
      delete window[key];
    }, INSPECTION).catch(() => {});
    // Disconnect the CDP inspection connection using the same pattern as the installed notes verifier.
    if (browser) await browser.close().catch(() => {});
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

main().catch(() => { console.error('Installed dictation verification could not start or write its report.'); process.exitCode = 1; });
