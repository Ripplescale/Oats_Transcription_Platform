/* Browser-only regression: all IPC, audio, jobs and notes below are fictional.
 * No native bridge, microphone/system capture, account access or model execution. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');
const laptopSizes = [[680, 820], [600, 560], [720, 560], [920, 740], [1366, 768]];

async function installCleanLiveFixture(page) {
  await installFixture(page);
  await page.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const transform = window.__TAURI_INTERNALS__.transformCallback;
    const callbacks = new Map(), listeners = new Map();
    let listenerId = 0, recording = false, paused = false, job = null, hasMeeting = false;
    let imported = [], saveGate = null;
    const capture = { session_id: 'qa-clean-session', session_dir: 'C:/STTApp/recordings/qa-clean-session' };
    const projects = [
      { id: 'willow', name: 'Project Willow Vault', revision: 0, entry_count: 1 },
      { id: 'cedar', name: 'Project Cedar Vault', revision: 0, entry_count: 0 },
    ];
    const notes = [
      { id: 'qa-meeting', title: 'Project Willow · Friday catch-up', created_at: '2026-10-07T09:30:00Z', project_id: 'willow', notes_preview: 'Prepare sketchbooks for the studio workshop.' },
      { id: 'qa-planning', title: 'Planning for next month', created_at: '2026-10-06T12:00:00Z', project_id: 'cedar', notes_preview: 'A fictional courtyard exhibition.' },
      { id: 'qa-design', title: 'Product catch-up', created_at: '2026-10-05T10:00:00Z', project_id: null, notes_preview: 'Choose a new notebook cover.' },
    ];
    let live = { version: 1, meeting_id: 'qa-live', revision: 0, notes: '', project_id: null,
      corrections: [], speaker_names: {}, segment_metadata: {}, speaker_metadata: null,
      source_meeting_id: 'qa-live', source_job_id: 'qa-live-job', profile: 'trelis-10', workflow_role: 'live-final' };
    let title = 'Untitled note';
    const raw = [
      { id: 'clean-first', text: 'आज Project Willow की workshop plan करते हैं. We need 24 sketchbooks.', source_track: 'system', start_seconds: 0, end_seconds: 20 },
      { id: 'clean-second', text: 'हाँ, मैं studio booking confirm कर दूँगा. Friday afternoon works for us.', source_track: 'microphone', start_seconds: 20, end_seconds: 40 },
    ];
    const clone = value => structuredClone(value);
    const record = (command, args = {}, extra = {}) => window.qaCalls.push({ command, args, synthetic: true, ...extra });
    const emit = (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); };
    window.qaCleanState = () => clone({ recording, paused, job, live, projects, notes, imported, hasMeeting });
    window.qaCleanSetText = () => { if (!job) throw Error('No synthetic job'); job.phase = 'transcribing'; job.segments = clone(raw); job.processed_audio_seconds = 40; job.available_audio_seconds = 40; job.backlog_seconds = 0; };
    window.qaCleanSetSegments = (segments, metadata = {}) => { if (!job) throw Error('No synthetic job'); job.phase = 'transcribing'; job.segments = clone(segments); job.segments_revision = metadata.segments_revision ?? (job.segments_revision ?? 0) + 1; job.superseded_segments = clone(metadata.superseded_segments ?? []); if (metadata.workspace_corrections) live.corrections = clone(metadata.workspace_corrections); job.processed_audio_seconds = Math.max(0, ...segments.map(segment => segment.end_seconds ?? 0)); job.available_audio_seconds = job.processed_audio_seconds; job.backlog_seconds = 0; };
    window.qaCleanFailNextStart = false;
    window.qaCleanFailWorker = () => { if (!job) throw Error('No synthetic job'); job.state = 'failed'; job.error = 'Synthetic worker unavailable'; };
    window.qaCleanAddOrphan = () => { notes.push({ id: 'qa-orphan', title: 'Sketchbook colour discussion', created_at: '2026-10-04T09:00:00Z', project_id: 'missing-project', notes_preview: 'A saved fictional note whose project metadata is unavailable.' }); window.dispatchEvent(new Event('xx-projects-updated')); };
    window.qaCleanHoldSave = () => { saveGate = {}; saveGate.promise = new Promise(resolve => { saveGate.release = resolve; }); };
    window.qaCleanReleaseSave = () => { const gate = saveGate; saveGate = null; gate?.release(); };
    window.qaCleanMediaCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.qaCleanMediaCalls++; throw Error('Real device capture forbidden in synthetic QA'); };
    window.__TAURI_INTERNALS__.transformCallback = fn => { const id = transform(fn); callbacks.set(id, fn); return id; };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { listeners.delete(id); } };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:store|get' && args.key === 'show_recording_notification') { record(command, args); return [false, true]; }
      const handled = command.startsWith('plugin:event|') || command.startsWith('plugin:path|') || [
        'list_project_library', 'create_project', 'rename_project', 'list_project_vaults', 'load_project_vault',
        'get_active_capture', 'is_recording', 'get_recording_state', 'get_speaker_setup_status',
        'start_recording_with_devices_and_meeting', 'stop_recording', 'pause_recording', 'resume_recording',
        'ensure_capture_meeting', 'start_local_transcription', 'get_local_transcription_status',
        'list_local_transcription_jobs', 'import_local_transcription', 'get_local_transcript_layers',
        'get_local_transcript_groups', 'api_get_meetings', 'api_get_meeting_metadata',
        'api_get_meeting_transcripts', 'api_save_meeting_title', 'load_transcript_workspace', 'save_meeting_note', 'save_transcript_workspace',
      ].includes(command);
      if (!handled) {
        if (/^(start_|resume_|stop_|open_claude)|summary|outlook|calendar|oauth|plugin:opener/.test(command) && command !== 'api_get_summary') throw Error(`Unexpected side effect in clean fixture: ${command}`);
        return original(command, args);
      }
      record(command, args);
      if (command === 'plugin:event|listen') { listeners.set(++listenerId, args); return listenerId; }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
      if (command.startsWith('plugin:event|')) return null;
      if (command.startsWith('plugin:path|')) return 'C:/SyntheticSTTApp';
      if (command === 'list_project_library') return clone({ projects, meetings: [...notes, ...(hasMeeting ? [{ id: 'qa-live', title, created_at: '2026-10-03T09:30:00Z', project_id: live.project_id, notes_preview: live.notes }] : [])] });
      if (command === 'create_project') {
        if (projects.some(item => item.name === args.name)) throw Error('Duplicate fictional project');
        const project = { id: `qa-project-${projects.length}`, name: args.name, revision: 0, entry_count: 0 };
        projects.push(project); return clone(project);
      }
      if (command === 'rename_project') { const project = projects.find(item => item.id === args.projectId); if (project.revision !== args.expectedRevision) throw Error('Revision conflict'); project.name = args.name; project.revision++; return clone(project); }
      if (command === 'list_project_vaults') return clone(projects);
      if (command === 'load_project_vault') return args.projectId === 'willow' ? original(command, args) : { ...clone(projects.find(item => item.id === args.projectId)), version: 1, entries: [], relationships: [] };
      if (command === 'get_active_capture') return recording ? clone(capture) : null;
      if (command === 'is_recording') return recording;
      if (command === 'get_recording_state') return { is_recording: recording, is_paused: paused, is_active: recording && !paused, recording_duration: recording ? 40 : 0, active_duration: recording ? 40 : 0 };
      if (command === 'get_speaker_setup_status') return { available: false, enabled: false };
      if (command === 'start_recording_with_devices_and_meeting') {
        if (window.qaCleanFailNextStart) { window.qaCleanFailNextStart = false; throw Error('Synthetic microphone start failure'); }
        if (recording) throw Error('Duplicate synthetic recording start');
        await new Promise(resolve => setTimeout(resolve, 80));
        recording = true; emit('recording-started', { capture: clone(capture) }); return null;
      }
      if (command === 'stop_recording') { recording = false; emit('recording-stopped', { capture: clone(capture), folder_path: capture.session_dir, meeting_name: title }); return null; }
      if (command === 'pause_recording') { paused = true; emit('recording-paused', {}); return null; }
      if (command === 'resume_recording') { paused = false; emit('recording-resumed', {}); return null; }
      if (command === 'ensure_capture_meeting') { hasMeeting = true; return { meeting_id: 'qa-live' }; }
      if (command === 'start_local_transcription') {
        if (job) throw Error('Duplicate synthetic transcription job');
        if (args.profile !== 'trelis-10' || args.workflowRole !== 'live-final') throw Error('Unexpected profile or workflow role');
        job = { job_id: 'qa-live-job', session_dir: capture.session_dir, capture_session_id: capture.session_id,
          profile: args.profile, workflow_role: args.workflowRole, state: 'running', phase: 'loading_model', segments: [] };
        return clone(job);
      }
      if (command === 'list_local_transcription_jobs') return job ? [clone(job)] : [];
      if (command === 'get_local_transcription_status') return clone(job);
      if (command === 'import_local_transcription') {
        imported = job.segments.map(segment => ({ ...segment, audio_start_time: segment.start_seconds, audio_end_time: segment.end_seconds, timestamp: '15:00' }));
        live = { ...live, segments_revision: job.segments_revision, superseded_segments: clone(job.superseded_segments ?? []), segment_metadata: Object.fromEntries(job.segments.map(segment => [segment.id, {
          source_track: segment.source_track, quality_flags: segment.quality_flags, recovery: segment.recovery, alternative: segment.alternative,
          replaces_segment_ids: segment.replaces_segment_ids, original_recognition_text: segment.original_recognition_text ?? segment.recognition_original?.text,
        }])) };
        return { meeting_id: 'qa-live' };
      }
      if (command === 'get_local_transcript_groups') return [{ meeting_id: 'qa-draft', source_meeting_id: 'qa-meeting', workflow_role: 'live-draft' }];
      if (command === 'get_local_transcript_layers' && args.meetingId === 'qa-live') return { source_meeting_id: 'qa-live', layers: [{ meeting_id: 'qa-live', title, profile: 'trelis-10', workflow_role: 'live-final', state: job?.state ?? 'running', job_id: job?.job_id, primary: true }] };
      if (command === 'api_get_meetings') { const rows = await original(command, args); return [...rows, ...(hasMeeting ? [{ id: 'qa-live', title, created_at: '2026-10-03T09:30:00Z', updated_at: '2026-10-03T09:30:00Z', folder_path: capture.session_dir }] : [])]; }
      if (command === 'api_get_meeting_metadata' && args.meetingId === 'qa-live') return { id: 'qa-live', title, created_at: '2026-10-03T09:30:00Z', updated_at: '2026-10-03T09:30:00Z', folder_path: capture.session_dir };
      if (command === 'api_get_meeting_transcripts' && args.meetingId === 'qa-live') return { transcripts: clone(imported.slice(args.offset, args.offset + args.limit)), total_count: imported.length, has_more: false };
      if (command === 'api_save_meeting_title' && args.meetingId === 'qa-live') { title = args.title; return null; }
      if (command === 'load_transcript_workspace' && args.meetingId === 'qa-live') return clone(live);
      if (command === 'save_transcript_workspace' && args.meetingId === 'qa-live') {
        if (args.expectedRevision !== live.revision) throw Error('Revision conflict');
        live = { ...live, notes: args.notes, notes_document: args.clearNotesDocument ? null : args.notesDocument ?? live.notes_document, corrections: clone(args.corrections), project_id: args.projectId, profile: args.profile, speaker_names: clone(args.speakerNames ?? {}), revision: live.revision + 1 };
        return clone(live);
      }
      if (command === 'save_meeting_note') {
        if (args.meetingId !== 'qa-live') throw Error('Unexpected note target');
        if (args.expectedRevision !== live.revision) throw Error('Revision conflict');
        if (saveGate) await saveGate.promise;
        live = { ...live, notes: args.notes, notes_document: args.clearNotesDocument ? null : args.notesDocument ?? live.notes_document, project_id: args.projectId, revision: live.revision + 1 };
        record('qa:note-save-completed', { revision: live.revision, notes: live.notes }); return clone(live);
      }
      return original(command, args);
    };
  });
}

async function targetedChecks(page, report, screen, checkSize) {
  await page.evaluate(() => window.qaCleanAddOrphan());
  await page.locator('.xx-note-row').filter({ hasText: 'Sketchbook colour discussion' }).waitFor();
  const orphanGroup = page.locator('.xx-library-group').filter({ hasText: 'Unavailable folder' });
  assert.equal(await orphanGroup.count(), 1);
  assert.match(await orphanGroup.innerText(), /Sketchbook colour discussion/);
  assert.equal(await page.locator('.xx-note-row').count(), 4);
  await checkSize('orphan-project-home', 920, 740);
  report.checks.push('All notes retains an orphaned project meeting under Unavailable folder without silently dropping or reassigning it');

  await page.evaluate(() => { window.qaCleanFailNextStart = true; });
  await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Recording could not start.' }).waitFor();
  await page.getByRole('button', { name: 'Try recording again', exact: true }).waitFor();
  const failed = await page.evaluate(() => window.qaCleanState());
  assert.equal(failed.recording, false); assert.equal(failed.hasMeeting, false); assert.equal(failed.job, null);
  assert.equal(await page.getByRole('textbox', { name: 'Live meeting notes', exact: true }).count(), 0);
  assert.equal(await page.locator('.xx-recording-status').innerText(), 'Not recording');
  assert.equal(await page.evaluate(() => window.qaCalls.filter(call => ['ensure_capture_meeting', 'start_local_transcription', 'save_meeting_note'].includes(call.command)).length), 0);
  await screen('recording-start-failure.png');
  await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
  assert.equal(await page.locator('.xx-note-row').count(), 4);
  report.checks.push('Native-start failure is visible with retry and back actions; no hidden recording, transcription job, saved note or phantom meeting is created');

  await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Live meeting notes', exact: true });
  await editor.waitFor();
  await page.waitForFunction(() => !!window.qaCleanState().job);
  assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
  await editor.fill('Keep this fictional workshop thought while transcription recovers.');
  await page.waitForFunction(() => window.qaCleanState().live.notes.includes('workshop thought'));
  await page.evaluate(() => window.qaCleanFailWorker());
  await page.getByRole('alert').filter({ hasText: 'Audio is still being saved. Transcription needs attention;' }).waitFor();
  assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
  assert.equal((await page.evaluate(() => window.qaCleanState())).recording, true);
  assert.equal(await page.getByRole('button', { name: 'Stop recording', exact: true }).isEnabled(), true);
  assert.equal(await editor.isEnabled(), true);
  assert.match(await editor.innerText(), /workshop thought/);
  await checkSize('live-worker-failure', 920, 740);
  await checkSize('live-worker-failure', 720, 560);
  assert.equal(await page.evaluate(() => window.qaCleanMediaCalls), 0);
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.external_requests, []);
  report.checks.push('Worker failure remains visible with the transcript drawer collapsed, while synthetic recording, editable saved notes and Finish controls stay available');
}

async function main() {
  const output = path.resolve(process.argv[2] || 'frontend/test-artifacts/xx-clean-live-notes');
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
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = { synthetic_ipc: true, native_execution: false, actual_recording: false, account_access: false, model_execution: false, checks: [], page_errors: [], external_requests: [], screenshots: [] };
  let browser, page;
  const screen = async name => { await page.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name); };
  const checkSize = async (label, width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    assert.ok(dimensions.scrollWidth <= width + 1 && dimensions.scrollHeight <= height + 1, `${label} overflows ${width}x${height}: ${JSON.stringify(dimensions)}`);
    if (label.startsWith('live')) {
      const textarea = await page.getByRole('textbox', { name: 'Live meeting notes', exact: true }).boundingBox();
      const dock = await page.locator('.xx-note-dock').boundingBox();
      assert.ok(textarea && dock && textarea.height >= 79 && textarea.y + textarea.height <= dock.y + 1, `Writing surface is clipped or overlaps controls at ${width}x${height}: ${JSON.stringify({ textarea, dock })}`);
      assert.ok(dock.x >= -1 && dock.x + dock.width <= width + 1 && dock.y + dock.height <= height + 1, `Dock is outside window at ${width}x${height}`);
      for (const control of await page.locator('.xx-note-dock button, .xx-note-dock > details > summary').all()) {
        if (!await control.isVisible()) continue;
        const box = await control.boundingBox();
        assert.ok(box && box.x >= dock.x - 1 && box.x + box.width <= dock.x + dock.width + 1 && box.y >= dock.y - 1 && box.y + box.height <= dock.y + dock.height + 1, `Recording control is clipped at ${width}x${height}: ${await control.getAttribute('aria-label')}`);
        assert.ok(box.width >= 28 && box.height >= 30, `Recording control is too small at ${width}x${height}`);
      }
    }
    await screen(`${label}-${width}x${height}.png`);
  };
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
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await page.waitForFunction(() => window.qaCalls.some(call => call.command === 'list_project_library'));
    assert.match(await page.title(), /^oats/);
    assert.equal(await page.getByRole('complementary', { name: 'Workspace navigation' }).count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('.xx-brand-mascot, .xx-library-illustration')].every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.xx-library .xx-wordmark').innerText(), 'oats');
    await checkSize('library-full-width', 1366, 768);
    await page.getByRole('button', { name: 'About oats', exact: true }).click();
    const about = page.getByRole('dialog', { name: 'About oats', exact: true });
    await about.waitFor();
    await about.getByText('oats', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await about.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 920, height: 740 });
    report.checks.push('Full-width Home has no sidebar and keeps loaded branding and the About dialog accessible');
    if (process.argv.includes('--targeted-errors')) {
      await targetedChecks(page, report, screen, checkSize);
    } else {
    assert.equal(await page.locator('.xx-library-group').count(), 3);
    assert.equal(await page.locator('.xx-note-row').count(), 3);
    assert.equal(await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).count(), 1);
    const newNoteBounds = await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).boundingBox();
    const searchBounds = await page.getByRole('textbox', { name: 'Search notes', exact: true }).boundingBox();
    assert.ok(newNoteBounds.x > searchBounds.x && Math.abs((newNoteBounds.y + newNoteBounds.height / 2) - (searchBounds.y + searchBounds.height / 2)) < 4, 'New note sits beside search in the toolbar');
    for (const [width, height] of laptopSizes) await checkSize('home', width, height);
    report.checks.push('Home groups fictional recordings into projects and Unfiled, with one New note action beside search at narrow and standard laptop sizes');
    await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('sketchbooks');
    assert.equal(await page.locator('.xx-note-row').count(), 1);
    await page.getByRole('button', { name: 'Clear note search', exact: true }).click();
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Project Juniper');
    await page.getByRole('button', { name: 'Save folder', exact: true }).click();
    await page.getByRole('heading', { name: 'Project Juniper', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.qaCleanState().projects)).length, 3);
    await page.getByRole('navigation', { name: 'Folders', exact: true }).getByRole('button', { name: 'Project Willow', exact: true }).click();
    await page.getByRole('button', { name: 'Folder memory', exact: false }).click();
    const memory = page.getByRole('region', { name: 'Folder memory', exact: true });
    await memory.getByText('Willow Studio', { exact: true }).waitFor();
    assert.match(await memory.innerText(), /Prepare sketchbooks/);
    assert.match(await memory.innerText(), /Fictional workshop brief/);
    assert.equal(await memory.getByText('Planning for next month', { exact: true }).count(), 0);
    await screen('project-memory.png');
    report.checks.push('Project creation, note-text search and project-scoped memory expose saved notes and checked source references without generated claims');
    await page.getByRole('button', { name: 'Back to notes', exact: false }).first().click();
    await page.setViewportSize({ width: 920, height: 740 });
    await page.locator('.xx-library-toolbar').getByRole('button', { name: 'New note', exact: true }).evaluate(button => { button.click(); button.click(); });
    const editor = page.getByRole('textbox', { name: 'Live meeting notes', exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => !!window.qaCleanState().job && window.qaCleanState().live.project_id === 'willow');
    assert.equal((await page.evaluate(() => window.qaCalls.filter(call => call.command === 'start_recording_with_devices_and_meeting'))).length, 1);
    assert.equal((await page.evaluate(() => window.qaCalls.filter(call => call.command === 'start_local_transcription'))).length, 1);
    assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Show transcript', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal((await editor.innerText()).trim(), '');
    report.checks.push('Rapid New note clicks start exactly one synthetic capture and one Trelis10 job, attach a durable meeting and open an empty notes canvas with transcript collapsed');
    await editor.fill('Workshop notes\n\nPrepare 24 sketchbooks. Maya will confirm the room.');
    await page.waitForFunction(() => window.qaCleanState().live.notes.includes('24 sketchbooks'));
    const firstSaved = await page.evaluate(() => window.qaCleanState().live);
    assert.ok(firstSaved.revision >= 2);
    const saveCalls = await page.evaluate(() => window.qaCalls.filter(call => call.command === 'save_meeting_note'));
    assert.deepEqual(saveCalls.map(call => call.args.expectedRevision), saveCalls.map((_, index) => index));
    assert.deepEqual(firstSaved.corrections, []);
    report.checks.push('Live note and selected project autosave with sequential expected revisions, leaving correction data separate');
    for (const [width, height] of laptopSizes) await checkSize('live-collapsed', width, height);
    await page.evaluate(() => window.qaCleanSetText());
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await page.getByText('आज Project Willow की workshop plan करते हैं. We need 24 sketchbooks.', { exact: true }).waitFor();
    assert.equal(await page.locator('#live-transcript-drawer').isVisible(), true);
    for (const [width, height] of laptopSizes) await checkSize('live-transcript', width, height);
    await page.locator('.xx-transcript-toggle').click();
    assert.equal(await page.locator('#live-transcript-drawer').isVisible(), false);
    report.checks.push('Transcript control reveals unchanged mixed Devanagari/Latin text on demand, then hides it while preserving notes and reachable recording controls');
    await page.evaluate(() => window.qaCleanHoldSave());
    const finalNote = 'Workshop notes\n\nPrepare 24 sketchbooks. Maya will confirm the room.\nFinal thought: bring coloured pencils.';
    await editor.fill(finalNote);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.waitForFunction(() => !window.qaCleanState().recording && window.qaCalls.some(call => call.command === 'save_meeting_note' && call.args.notes.includes('Final thought')));
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await editor.isVisible(), true);
    assert.notEqual((await page.evaluate(() => window.qaCleanState().live.notes)), finalNote);
    await page.evaluate(() => window.qaCleanReleaseSave());
    await page.waitForURL('**/meeting-details?id=qa-live');
    assert.equal((await page.evaluate(() => window.qaCleanState().live.notes)), finalNote);
    const calls = await page.evaluate(() => window.qaCalls);
    const savedIndex = calls.findIndex(call => call.command === 'qa:note-save-completed' && call.args.notes === finalNote);
    const detailIndex = calls.findIndex(call => call.command === 'api_get_meeting_metadata' && call.args.meetingId === 'qa-live');
    assert.ok(savedIndex >= 0 && detailIndex > savedIndex, 'Saved note completes before opening saved-meeting detail');
    assert.equal(calls.filter(call => call.command === 'stop_recording').length, 1);
    assert.equal(calls.filter(call => call.command === 'start_local_transcription').length, 1);
    assert.equal(await page.evaluate(() => window.qaCleanMediaCalls), 0);
    assert.deepEqual(report.page_errors, []);
    assert.deepEqual(report.external_requests, []);
    await screen('saved-after-finish.png');
    report.checks.push('Finish stops synthetic capture once, waits for pending note save before navigation, preserves the last keystrokes and starts no second transcription pass');
    }
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) { report.debug = await page.evaluate(() => ({ body: document.body.innerText, calls: window.qaCalls, state: window.qaCleanState?.() })); await screen('failure.png'); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
module.exports = { installCleanLiveFixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
