// Supplement to verify-user-notes-installed.cjs. Connects to an already-running app only.
// Never starts dictation, shows its window, types, saves, copies, or checks/downloads/installs updates.
// Usage: node verify-release-083-installed.cjs <CDP endpoint> <data root> <version> <report path>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const inspectionKey = '__oatsRelease083Inspection';
const mutation = /^(?:updates_(?:download|install)$|dictation_(?:toggle|cancel|copy|dismiss)$|(?:start|stop|pause|resume)_.*(?:recording|capture|transcription|identification)|save_|api_save_|api_delete_|delete_|set_meeting_tags$|move_meeting_to_project$|archive_project$|create_project$|rename_project$|set_meeting_detection$)/;

function revisions(root, id) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
  const directory = path.join(root, 'workspaces', id);
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory).filter(name => /^revision-\d{12}\.json$/.test(name)).sort();
  if (!files.length) return null;
  const latest = JSON.parse(fs.readFileSync(path.join(directory, files.at(-1)), 'utf8'));
  if (latest.meeting_id !== id || !Number.isInteger(latest.revision) || latest.revision < 1) return null;
  return Object.fromEntries(files.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
}

async function requireSafe(page) {
  const state = await page.evaluate(async () => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const dictation = await invoke('dictation_status');
    return {
      capture: await invoke('get_active_capture') !== null,
      recording: await invoke('is_recording'),
      dictation_phase: dictation.phase,
      dictation_has_result: typeof dictation.text === 'string' && dictation.text.length > 0,
      journals: Object.keys(localStorage).filter(key => /^xx\.(?:note|workspace)-draft\./.test(key) && localStorage.getItem(key)).length,
      pending: [...document.querySelectorAll('.xx-saved-note-status, .xx-live-note-meta [role="status"]')].filter(visible).some(element => /unsaved|saving|not saved|correction in progress/i.test(element.textContent || '')),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
      title_edit: [...document.querySelectorAll('input[aria-label="Meeting title"]')].filter(visible).length,
    };
  });
  assert.equal(state.capture, false);
  assert.equal(state.recording, false);
  assert.equal(state.dictation_phase, 'idle');
  assert.equal(state.dictation_has_result, false);
  assert.equal(state.journals, 0);
  assert.equal(state.pending, false);
  assert.equal(state.alerts, 0);
  assert.equal(state.dialogs, 0);
  assert.equal(state.title_edit, 0);
}

async function main() {
  const [endpoint, expectedRoot, expectedVersion, reportPath] = process.argv.slice(2);
  if (!endpoint || !expectedRoot || !expectedVersion || !reportPath) throw Error('Pass CDP endpoint, data root, expected version, and report path.');
  const report = { state: 'checking', checked_at: new Date().toISOString(), checks: [], title_inspection: 'not_attempted', capture_started: false, clipboard_used: false, update_action_requested: false };
  let browser, page, popup, observing = false, stage = 'connect';
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      const label = await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null);
      if (label === 'main') page = candidate;
      if (label === 'dictation') popup = candidate;
    }
    assert(page);
    page.setDefaultTimeout(15000);
    stage = 'idle_home';
    await requireSafe(page);
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Search notes', exact: true }).inputValue(), '');

    stage = 'observe_commands';
    await page.evaluate(key => {
      if (window[key]) throw Error('Inspection already active.');
      const original = window.__TAURI_INTERNALS__.invoke, counts = Object.create(null);
      const wrapper = function(command, ...args) {
        counts[command] = (counts[command] || 0) + 1;
        return original.call(this, command, ...args);
      };
      window[key] = { original, wrapper, counts };
      window.__TAURI_INTERNALS__.invoke = wrapper;
    }, inspectionKey);
    observing = true;

    stage = 'update_status_only';
    const native = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const update = await invoke('updates_status');
      return { version: await window.__TAURI__.app.getVersion(), root: await invoke('get_database_directory'),
        update: { configured: update.configured, current_version: update.current_version, state: update.state } };
    });
    assert.equal(native.version, expectedVersion);
    assert.equal(path.resolve(native.root).toLowerCase(), path.resolve(expectedRoot).toLowerCase());
    assert.equal(native.update.current_version, expectedVersion);
    assert.equal(native.update.configured, true);
    assert(!['downloading', 'installing'].includes(native.update.state));
    report.version = native.version;
    report.updater = native.update;
    report.checks.push('Signed updater is configured for the installed version; status read only');

    stage = 'hidden_slim_popup';
    assert(popup);
    // The popup deliberately has no core-window permissions. Read its visibility
    // through the already-authorized main window without granting new privileges.
    const popupHidden = await page.evaluate(async () => {
      const target = await window.__TAURI__.window.Window.getByLabel('dictation');
      if (!target) throw Error('Dictation window not found.');
      return !(await target.isVisible());
    });
    assert.equal(popupHidden, true);
    // Evaluate the existing hidden WebView; never show, focus, or invoke capture/layout commands.
    const geometry = await popup.evaluate(() => {
      const root = document.getElementById('dictation');
      const grip = document.getElementById('grip');
      const level = document.getElementById('level');
      const rect = element => { const value = element.getBoundingClientRect(); return { width: value.width, height: value.height }; };
      return {
        width: innerWidth, height: innerHeight, phase: root?.dataset.phase, expanded: root?.dataset.expanded,
        grip: grip ? rect(grip) : null, grip_label: grip?.getAttribute('aria-label'),
        meter_role: level?.getAttribute('role'), bars: level?.children.length,
        style_loaded: getComputedStyle(document.documentElement).backgroundColor === 'rgb(255, 253, 250)',
        result_hidden: document.getElementById('result-panel')?.hidden,
        errors: !document.getElementById('error')?.hidden,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
      };
    });
    assert.equal(geometry.width, 264);
    assert.equal(geometry.height, 48);
    assert.equal(geometry.phase, 'idle');
    assert.equal(geometry.expanded, 'false');
    assert.deepEqual(geometry.grip, { width: 20, height: 32 });
    assert.equal(geometry.grip_label, 'Move dictation popup');
    assert.equal(geometry.meter_role, 'meter');
    assert.equal(geometry.bars, 7);
    assert.equal(geometry.style_loaded, true);
    assert.equal(geometry.result_hidden, true);
    assert.equal(geometry.errors, false);
    assert.equal(geometry.overflow, false);
    report.popup = { hidden: popupHidden, ...geometry };
    report.checks.push('Hidden dictation WebView loads the 264 by 48 slim pill without showing or recording');

    stage = 'select_existing_workspace';
    // IDs/titles and source contents stay inside this process; the report contains no note text.
    const notes = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_project_library')).meetings.map(note => ({ id: note.id, title: note.title })));
    let selected, before, index;
    for (const note of notes) {
      if (notes.filter(other => other.title === note.title).length !== 1) continue;
      const existing = revisions(expectedRoot, note.id);
      if (!existing) continue;
      const row = await page.evaluate(title => [...document.querySelectorAll('.xx-note-row')].findIndex(item => item.querySelector('strong')?.textContent === title), note.title);
      if (row >= 0) { selected = note; before = existing; index = row; break; }
    }
    if (selected) {
      stage = 'title_open_cancel';
      await requireSafe(page);
      await page.locator('.xx-note-row').nth(index).click();
      await page.waitForFunction(id => new URLSearchParams(location.search).get('id') === id, selected.id);
      await page.waitForFunction(() => document.querySelector('.xx-saved-note-status')?.textContent.trim() === 'Saved');
      await requireSafe(page);
      const trigger = page.getByRole('button', { name: 'Rename meeting title', exact: true });
      const originalTitle = await trigger.textContent();
      await trigger.click();
      const input = page.getByRole('textbox', { name: 'Meeting title', exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), originalTitle);
      // Do not type or blur the editor. Escape cancels the unchanged draft.
      await input.press('Escape');
      await input.waitFor({ state: 'hidden' });
      assert.equal(await trigger.textContent(), originalTitle);
      await page.waitForTimeout(2500);
      await requireSafe(page);
      assert.deepEqual(revisions(expectedRoot, selected.id), before);
      report.title_inspection = 'passed';
      report.checks.push('One existing title enters edit mode and cancels with Escape, with unchanged workspace revisions');
      stage = 'return_home';
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    } else report.title_inspection = 'skipped_no_unique_materialized_workspace';

    stage = 'final_safety';
    await requireSafe(page);
    const counts = await page.evaluate(key => ({ ...window[key].counts }), inspectionKey);
    report.native_mutation_count = Object.entries(counts).filter(([command]) => mutation.test(command)).reduce((total, [, count]) => total + count, 0);
    assert.equal(report.native_mutation_count, 0);
    report.returned_to_home = true;
    report.state = report.title_inspection === 'passed' ? 'passed' : 'passed_with_limitations';
  } catch (error) {
    report.state = 'failed'; report.failure_stage = stage; report.failure_kind = error.name || 'Error';
    // No locator dumps, stacks, screenshots, or real-note content in output.
    process.exitCode = 1;
  } finally {
    if (page && observing) await page.evaluate(key => {
      const inspection = window[key];
      if (!inspection) return;
      if (window.__TAURI_INTERNALS__.invoke === inspection.wrapper) window.__TAURI_INTERNALS__.invoke = inspection.original;
      delete window[key];
    }, inspectionKey).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
main().catch(() => { console.error('Release inspection could not start or write its report.'); process.exitCode = 1; });
