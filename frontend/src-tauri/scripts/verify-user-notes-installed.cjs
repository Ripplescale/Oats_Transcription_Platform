// Installed-app inspection only. Never type, format, save, record, or change preferences.
// Usage: node verify-user-notes-installed.cjs <CDP endpoint> <data root> <version> <report path>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mutation = /^(?:save_|api_save_|api_delete_|set_meeting_tags$|move_meeting_to_project$|archive_project$|create_project$|rename_project$|set_meeting_detection$|start_.*(?:recording|transcription|identification))/;

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

async function safety(page) {
  return page.evaluate(async () => {
    const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const statuses = [...document.querySelectorAll('.xx-saved-note-status, .xx-live-note-meta [role="status"]')].filter(visible);
    const invoke = window.__TAURI_INTERNALS__.invoke;
    return {
      active_capture: (await invoke('get_active_capture')) !== null,
      recording: await invoke('is_recording'),
      journals: Object.keys(localStorage).filter(key => /^xx\.(?:note|workspace)-draft\./.test(key) && localStorage.getItem(key)).length,
      pending_edits: statuses.some(element => /unsaved|saving|not saved|correction in progress/i.test(element.textContent || '')),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
      saved_status: statuses.length === 1 && statuses[0].textContent.trim() === 'Saved',
    };
  });
}

async function requireSafe(page) {
  const state = await safety(page);
  assert.equal(state.active_capture, false, 'A capture is active. App was left intact.');
  assert.equal(state.recording, false, 'Recording is active. App was left intact.');
  assert.equal(state.journals, 0, 'A saved draft journal exists. App was left intact.');
  assert.equal(state.pending_edits, false, 'Unsaved or pending edits exist. App was left intact.');
  assert.equal(state.alerts, 0, 'An app alert needs attention. App was left intact.');
  assert.equal(state.dialogs, 0, 'A dialog is open. App was left intact.');
  return state;
}

async function main() {
  const [endpoint, expectedRoot, expectedVersion, reportPath] = process.argv.slice(2);
  if (!endpoint || !expectedRoot || !expectedVersion || !reportPath) throw new Error('Pass CDP endpoint, data root, expected version, and report path.');
  const report = { state: 'checking', checked_at: new Date().toISOString(), checks: [], note_inspection: 'not_attempted' };
  let browser, page, stage = 'connect', observing = false;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      if (!/tauri|localhost/.test(candidate.url()) || /meeting-prompt/.test(candidate.url())) continue;
      const label = await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null);
      if (label === 'main') { page = candidate; break; }
    }
    assert(page, 'Installed main WebView was not found.');
    page.setDefaultTimeout(15000);
    stage = 'idle_home';
    await requireSafe(page);
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search notes', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Search notes', exact: true }).inputValue(), '', 'Clear the library search before validation.');

    stage = 'observe_native_calls';
    await page.evaluate(() => {
      if (window.__xxInstalledInspection) throw new Error('An installed-app inspection is already active.');
      const original = window.__TAURI_INTERNALS__.invoke;
      const counts = Object.create(null);
      const wrapper = function(command, ...args) {
        counts[command] = (counts[command] || 0) + 1;
        return original.call(this, command, ...args);
      };
      window.__xxInstalledInspection = { original, wrapper, counts };
      window.__TAURI_INTERNALS__.invoke = wrapper;
    });
    observing = true;

    stage = 'native_runtime';
    const native = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const profiles = await invoke('get_local_stt_profiles');
      const speaker = await invoke('get_speaker_setup_status');
      const detector = await invoke('meeting_detection_status');
      return {
        version: await window.__TAURI__.app.getVersion(),
        data_root: await invoke('get_database_directory'),
        profiles: profiles.map(profile => ({ id: profile.id, available: profile.available })),
        speaker: { available: speaker.available, enabled: speaker.enabled },
        detector: { supported: detector.supported, enabled: detector.enabled, has_error: detector.error != null },
        stored_mode: localStorage.getItem('xx-display-mode'),
      };
    });
    assert.equal(native.version, expectedVersion, 'Installed version does not match the tested build.');
    assert.equal(path.resolve(native.data_root).toLowerCase(), path.resolve(expectedRoot).toLowerCase(), 'Installed data root changed.');
    assert.deepEqual(native.profiles.map(profile => profile.id).sort(), ['apex-20', 'trelis-10', 'trelis-20', 'trelis-5']);
    assert(native.profiles.every(profile => profile.available), 'A configured model is unavailable.');
    assert.equal(native.speaker.available, true, 'Speaker setup is unavailable.');
    assert.equal(native.detector.supported, true, 'Meeting detector is unsupported.');
    assert.equal(native.detector.has_error, false, 'Meeting detector reports an error.');
    report.version = native.version;
    report.data_root_matches = true;
    report.profiles = native.profiles;
    report.speaker = native.speaker;
    report.detector = native.detector;
    report.checks.push('Expected version, data root, models, speaker setup, and detector verified');

    stage = 'home_layout';
    assert.equal(await page.locator('.xx-sidebar').count(), 0, 'Legacy sidebar remains mounted.');
    assert.equal(await page.getByRole('button', { name: /^(?:Expand|Collapse) sidebar$/ }).count(), 0, 'Sidebar toggle remains mounted.');
    assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'About oats', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Home overflows horizontally.');
    await requireSafe(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const mode = page.getByRole('group', { name: 'Display mode', exact: true });
    await mode.waitFor();
    const expectedMode = native.stored_mode === 'dev' ? 'Dev' : 'User';
    for (const label of ['User', 'Dev']) {
      assert.equal(await mode.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), String(label === expectedMode));
    }
    assert.equal(await mode.getByRole('button', { name: 'Clean', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await mode.waitFor({ state: 'hidden' });
    report.display_mode = expectedMode;
    report.checks.push('Home has Settings/About, no sidebar, and User/Dev controls without changing preference');

    stage = 'library_metadata';
    // Keep note titles/IDs inside this process only; never place them in the report.
    const library = await page.evaluate(async () => {
      const value = await window.__TAURI_INTERNALS__.invoke('list_project_library');
      return { projects: value.projects.map(project => ({ id: project.id })),
        meetings: value.meetings.map(note => ({ id: note.id, title: note.title, tags: note.tags })) };
    });
    assert(Array.isArray(library.meetings) && Array.isArray(library.projects), 'Library data is invalid.');
    assert(library.meetings.every(note => Array.isArray(note.tags) && note.tags.every(tag => typeof tag === 'string')), 'Library tag metadata is invalid.');
    report.note_count = library.meetings.length;
    report.folder_count = library.projects.length;
    report.tagged_note_count = library.meetings.filter(note => note.tags.length).length;
    report.tag_count = new Set(library.meetings.flatMap(note => note.tags)).size;
    assert.equal(await page.locator('.xx-note-row').count(), library.meetings.length, 'Home is filtered or notes are missing.');
    report.checks.push('Library note count and tag metadata verified without editing');

    // Loading a legacy note can create its first workspace revision. Inspect
    // only an existing materialized workspace with an unambiguous Home row.
    let candidate, beforeRevisions, rowIndex;
    for (const note of library.meetings) {
      if (library.meetings.filter(other => other.title === note.title).length !== 1) continue;
      const existing = revisions(expectedRoot, note.id);
      if (!existing) continue;
      const index = await page.evaluate(title => [...document.querySelectorAll('.xx-note-row')].findIndex(row => row.querySelector('strong')?.textContent === title), note.title);
      if (index < 0) continue;
      candidate = note; beforeRevisions = existing; rowIndex = index; break;
    }
    if (candidate) {
      stage = 'saved_note_open';
      await requireSafe(page);
      await page.locator('.xx-note-row').nth(rowIndex).click();
      await page.waitForFunction(id => location.pathname.replace(/\/$/, '') === '/meeting-details' && new URLSearchParams(location.search).get('id') === id, candidate.id);
      const editor = page.locator('[role="textbox"][aria-label="Meeting notes"][contenteditable="true"]');
      await editor.waitFor();
      await page.waitForFunction(() => document.querySelector('.xx-saved-note-status')?.textContent.trim() === 'Saved');
      await page.getByRole('toolbar', { name: 'Note formatting', exact: true }).waitFor();
      // Cover more than two autosave debounce intervals without touching text.
      await page.waitForTimeout(2500);
      const state = await requireSafe(page);
      assert.equal(state.saved_status, true, 'Loaded note is not in a saved state.');
      const counts = await page.evaluate(() => ({ ...window.__xxInstalledInspection.counts }));
      assert.equal(Object.keys(counts).filter(command => mutation.test(command)).length, 0, 'Opening a saved note caused an unexpected write. App was left intact.');
      assert.deepEqual(revisions(expectedRoot, candidate.id), beforeRevisions, 'Saved workspace changed during read-only inspection.');
      report.note_inspection = 'passed';
      report.checks.push('One existing saved note opened as a rich editor with zero save commands or revision changes');
      stage = 'return_home';
      await requireSafe(page);
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    } else {
      report.note_inspection = 'skipped_no_unique_materialized_workspace';
    }

    stage = 'final_safety';
    await requireSafe(page);
    const after = await page.evaluate(async () => ({
      counts: { ...window.__xxInstalledInspection.counts },
      stored_mode: localStorage.getItem('xx-display-mode'),
      detector: await window.__TAURI_INTERNALS__.invoke('meeting_detection_status'),
    }));
    report.native_write_count = Object.entries(after.counts).filter(([command]) => mutation.test(command)).reduce((total, [, count]) => total + count, 0);
    assert.equal(report.native_write_count, 0, 'Unexpected native writes occurred.');
    assert.equal(after.stored_mode, native.stored_mode, 'Display preference changed.');
    assert.equal(after.detector.enabled, native.detector.enabled, 'Detector preference changed.');
    report.no_recording_started = true;
    report.preferences_unchanged = true;
    report.returned_to_home = true;
    report.state = report.note_inspection === 'passed' ? 'passed' : 'passed_with_limitations';
  } catch (error) {
    report.state = 'failed';
    // Avoid exception stacks/locator dumps, which can include private note text.
    report.failure_stage = stage;
    report.failure_kind = error.name || 'Error';
    report.app_exit_requested = false;
    process.exitCode = 1;
  } finally {
    if (page && observing) await page.evaluate(() => {
      const inspection = window.__xxInstalledInspection;
      if (!inspection) return;
      if (window.__TAURI_INTERNALS__.invoke === inspection.wrapper) window.__TAURI_INTERNALS__.invoke = inspection.original;
      delete window.__xxInstalledInspection;
    }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

main().catch(() => { console.error('Installed-app verification could not start or write its report.'); process.exitCode = 1; });
