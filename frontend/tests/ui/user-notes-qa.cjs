/* Local browser regression with fictional notes and mocked IPC only. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installFixture } = require('./xx-fixture.cjs');

async function main() {
  const output = path.resolve(__dirname, '../test-results/user-notes');
  fs.mkdirSync(output, { recursive: true });
  const root = path.resolve(__dirname, '../../out');
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
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 680, height: 820 } });
  const report = { synthetic: true, checks: [], errors: [], external: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', async route => {
    if (!route.request().url().startsWith(origin)) { report.external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const shot = async name => page.screenshot({ path: path.join(output, name + '.png') });
  const setMode = async name => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('group', { name: 'Display mode' }).getByRole('button', { name, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('group', { name: 'Display mode' }).waitFor({ state: 'hidden' });
  };
  try {
    await installFixture(page);
    await page.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let library;
      window.qaLibraryChanges = [];
      const getLibrary = async () => {
        if (!library) {
          library = structuredClone(await invoke('list_project_library'));
          library.projects.push({ id: 'cedar', name: 'Project Cedar', revision: 0, entry_count: 1 });
          for (const note of library.meetings) note.tags = [];
          library.meetings.push({ ...library.meetings[0], id: 'qa-orphan', title: 'Recovered note', project_id: 'missing-folder', tags: [] });
        }
        return library;
      };
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'list_project_library') return structuredClone(await getLibrary());
        if (['set_meeting_tags', 'move_meeting_to_project', 'archive_project', 'api_delete_meeting', 'api_save_meeting_title'].includes(command)) {
          const current = await getLibrary();
          const note = current.meetings.find(n => n.id === args.meetingId);
          window.qaLibraryChanges.push({ command, args });
          if (command === 'set_meeting_tags') {
            if (JSON.stringify(note.tags) !== JSON.stringify(args.expectedTags)) throw Error('Tags changed elsewhere');
            const canonical = new Map(current.meetings.flatMap(n => n.tags).map(t => [t.toLowerCase(), t]));
            note.tags = [...new Set(args.tags.map(t => canonical.get(t.toLowerCase()) ?? t))];
          }
          if (command === 'move_meeting_to_project') {
            if (note.project_id !== args.expectedProjectId) throw Error('Folder changed elsewhere');
            if (args.projectId && !current.projects.some(p => p.id === args.projectId)) throw Error('Folder is unavailable');
            note.project_id = args.projectId;
          }
          if (command === 'api_save_meeting_title') { note.title = args.title; await invoke(command, args); }
          if (command === 'api_delete_meeting') current.meetings = current.meetings.filter(n => n.id !== args.meetingId);
          if (command === 'archive_project') {
            current.projects = current.projects.filter(p => p.id !== args.projectId);
            current.meetings.forEach(n => { if (n.project_id === args.projectId) n.project_id = null; });
          }
          return note ? { ...window.qaWorkspace(), tags: note.tags, project_id: note.project_id } : null;
        }
        const result = await invoke(command, args);
        if (command === 'api_get_meeting_transcripts') return { ...result, transcripts: result.transcripts.map((row, index) => index === 0 ? { ...row, text: 'Yes.' } : row) };
        return result;
      };
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    const noteAction = async (title, action) => {
      await page.getByRole('button', { name: `Actions for note ${title}`, exact: true }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
    };
    const originalTitle = 'Project Willow · Friday catch-up';
    await noteAction('Recovered note', 'Move to folder');
    assert.equal(await page.getByRole('combobox', { name: 'Destination folder', exact: true }).inputValue(), '');
    await page.getByRole('button', { name: 'Move note', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.qaLibraryChanges.find(c => c.command === 'move_meeting_to_project').args), { meetingId: 'qa-orphan', expectedProjectId: 'missing-folder', projectId: null });
    report.checks.push('Moving a legacy note from an unavailable folder defaults to Unfiled and keeps conflict protection');
    await noteAction(originalTitle, 'Rename');
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Renamed workshop');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for note Renamed workshop', exact: true }).waitFor();
    await noteAction('Renamed workshop', 'Edit tags');
    await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('Research');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Save tags', exact: true }).click();
    const filters = page.getByRole('navigation', { name: 'Filter notes by tag' });
    await filters.getByRole('button', { name: 'Research', exact: true }).click();
    assert.equal(await page.locator('.xx-note-row').count(), 1);
    await filters.getByRole('button', { name: 'All tags', exact: true }).click();
    await noteAction('Planning for next month', 'Edit tags');
    await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('research');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Save tags', exact: true }).click();
    await filters.getByRole('button', { name: 'Research', exact: true }).click();
    assert.equal(await page.locator('.xx-note-row').count(), 2);
    await page.getByRole('navigation', { name: 'Folders', exact: true }).getByRole('button', { name: 'Project Willow', exact: true }).click();
    await filters.getByRole('button', { name: 'Research', exact: true }).click();
    assert.equal(await page.locator('.xx-note-row').count(), 1);
    report.checks.push('Home renames notes and filters canonical tags within a folder');
    await shot('home-tags');
    await noteAction('Renamed workshop', 'Move to folder');
    await page.getByRole('combobox', { name: 'Destination folder', exact: true }).selectOption('cedar');
    await page.getByRole('button', { name: 'Move note', exact: true }).click();
    await page.getByRole('navigation', { name: 'Folders', exact: true }).getByRole('button', { name: 'Project Cedar', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for note Renamed workshop', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Actions for folder Project Cedar', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete folder', exact: true }).click();
    await page.getByRole('navigation', { name: 'Folders', exact: true }).getByRole('button', { name: 'Unfiled', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for note Renamed workshop', exact: true }).waitFor();
    report.checks.push('Moving and deleting a folder leave its notes accessible under Unfiled');
    await noteAction('Product catch-up', 'Delete note');
    assert.equal(await page.evaluate(() => window.qaLibraryChanges.filter(c => c.command === 'api_delete_meeting').length), 0);
    await page.getByRole('dialog').getByRole('button', { name: 'Keep note', exact: true }).click();
    await noteAction('Product catch-up', 'Delete note');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for note Product catch-up', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.qaLibraryChanges.filter(c => c.command === 'api_delete_meeting').length), 1);
    report.checks.push('Note deletion requires explicit confirmation; cancel preserves it');
    await page.goto(origin + '/meeting-details?id=qa-meeting');
    const editor = page.getByRole('textbox', { name: 'Meeting notes', exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]'));
    assert.match(await editor.innerText(), /24 sketchbooks/);
    assert.equal(await page.locator('.xx-sidebar').count(), 0);
    assert.equal(await page.locator('.xx-main').evaluate(e => e.getBoundingClientRect().x), 0);
    report.checks.push('Legacy plain text opens in full-width notes with no sidebar');

    await editor.fill('Formatting survives saving. आज की notes.');
    await editor.press('Control+a');
    const toolbar = page.getByRole('toolbar', { name: 'Note formatting', exact: true });
    for (const label of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Highlight']) await toolbar.getByRole('button', { name: label, exact: true }).click();
    for (const tag of ['strong', 'em', 'u', 's', 'mark']) assert.equal(await editor.locator(tag).count(), 1, `${tag} formatting visible`);
    await page.waitForFunction(() => window.qaWorkspace().notes_document?.content?.[0]?.content?.[0]?.marks?.length === 5);
    const savedDocument = await page.evaluate(() => structuredClone(window.qaWorkspace().notes_document));
    await editor.press('ArrowRight');
    await setMode('Dev');
    assert.deepEqual(await page.evaluate(() => window.qaWorkspace().notes_document), savedDocument);
    await setMode('User');
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('heading', { name: 'Your notes', exact: true }).waitFor();
    await page.locator('.xx-note-row').filter({ hasText: 'Friday catch-up' }).click();
    await editor.waitFor();
    await editor.locator('mark').waitFor();
    assert.match(await editor.innerText(), /आज की notes/);
    report.checks.push('Five inline styles save with plain-text copy and survive mode changes and reopening');
    await shot('formatted-note');

    await editor.fill('A useful heading');
    await toolbar.getByRole('combobox', { name: 'Insert or format block' }).selectOption('heading2');
    assert.equal(await editor.locator('h2').count(), 1);
    await toolbar.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await editor.locator('h2').count(), 0);
    await toolbar.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal(await editor.locator('h2').count(), 1);
    await editor.press('Control+End'); await editor.press('Enter');
    await editor.pressSequentially('Checklist task');
    await toolbar.getByRole('combobox', { name: 'Insert or format block' }).selectOption('task');
    await editor.getByRole('checkbox', { name: 'Complete checklist item' }).check();
    await page.waitForFunction(() => JSON.stringify(window.qaWorkspace().notes_document).includes('"checked":true'));
    await editor.press('Control+End'); await editor.press('Enter'); await editor.press('Enter');
    await toolbar.getByRole('combobox', { name: 'Insert or format block' }).selectOption('rule');
    assert.equal(await editor.locator('hr').count(), 1);
    await page.waitForFunction(() => JSON.stringify(window.qaWorkspace().notes_document).includes('horizontalRule'));
    report.checks.push('Headings, undo/redo, checked task list and horizontal rule persist');

    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Transcript', exact: true });
    await transcript.getByText('Yes.', { exact: true }).waitFor();
    assert.equal(await transcript.getByText('Processing checks', { exact: true }).count(), 0);
    assert.equal(await transcript.locator('.xx-transcript-source-label').count(), 0);
    const first = transcript.locator('.xx-transcript-message').first();
    const second = transcript.locator('.xx-transcript-message').nth(1);
    assert.ok((await first.boundingBox()).width < (await second.boundingBox()).width * .8, 'Short transcript text must use a narrower bubble');
    await setMode('Dev');
    assert.ok(await transcript.locator('.xx-transcript-source-label').count() > 0);
    assert.ok(await transcript.getByText('Processing checks', { exact: true }).count() > 0);
    await setMode('User');
    assert.equal(await transcript.getByText('Processing checks', { exact: true }).count(), 0);
    report.checks.push('User/Dev switches in place and compact bubbles fit the transcript');
    await shot('user-transcript');
    for (const [width, height] of [[600, 560], [680, 820], [920, 740]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1), true);
    }
    await page.getByRole('button', { name: 'Hide transcript', exact: true }).click();
    await editor.fill(Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: a longer note with enough text to scroll.`).join('\n\n'));
    await editor.press('Control+End');
    const bounds = await page.locator('.xx-rich-notes').boundingBox();
    const dock = await page.locator('.xx-saved-note-dock').boundingBox();
    assert.ok(bounds.y + bounds.height <= dock.y + 1, 'Long note scrolls inside its canvas above the playback dock');
    await page.waitForFunction(() => window.qaWorkspace().notes.includes('Paragraph 79'));
    report.checks.push('Long rich notes stay within the writing area at narrow window sizes');
    await setMode('Dev'); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[aria-label="Meeting notes"][contenteditable="true"]'));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.getByRole('group', { name: 'Display mode' }).getByRole('button', { name: 'Dev', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    report.checks.push('Display preference survives reload');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    report.body = await page.locator('body').innerText().catch(() => '');
    await shot('failure').catch(() => {}); throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
