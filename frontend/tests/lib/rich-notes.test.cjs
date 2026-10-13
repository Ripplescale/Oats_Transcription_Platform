const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const modules = new Map();
function compile(name) {
  const file = path.resolve(__dirname, '../../src/lib', `${name}.ts`);
  if (modules.has(file)) return modules.get(file);
  const context = { exports: {}, URL, require: name => name.startsWith('./') ? compile(name.slice(2)) : require(name) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, context);
  modules.set(file, context.exports); return context.exports;
}
const { plainNotesDocument, notesDocumentText, editorNotesDocument, isNotesDocument, safeNoteLink, stableNotesValue } = compile('rich-notes');
const { emptyWorkspace, mergeSavedWorkspace, makeTranscriptExport, workspaceEdits } = compile('transcript-workspace');
const { NoteAutosaver } = compile('note-autosaver');
const { WorkspaceAutosaver, parseWorkspaceJournal } = compile('workspace-autosaver');
const clone = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(clone(actual), clone(expected));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function rich(text = 'आज notes', mark = 'bold') { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: mark }] }] }] }; }
function fixture(kind = 'workspace') {
  const data = { saved: { ...emptyWorkspace('meeting'), revision: 1, notes: 'आज notes' }, journal: null, calls: [], fail: false, saveGate: null, loadGate: null, reorder: false };
  data.invoke = async (command, args) => {
    data.calls.push({ command, args: clone(args) });
    if (command === 'load_transcript_workspace') { if (data.loadGate) await data.loadGate.promise; return clone(data.saved); }
    if (data.saveGate) await data.saveGate.promise;
    if (data.fail) throw Error('disk unavailable');
    if (args.expectedRevision !== data.saved.revision) throw Error('workspace revision conflict');
    data.saved = { ...data.saved, notes: args.notes, notes_document: args.notesDocument ?? data.saved.notes_document, project_id: args.projectId, revision: data.saved.revision + 1,
      ...(command === 'save_transcript_workspace' ? { corrections: args.corrections, profile: args.profile, speaker_names: args.speakerNames } : {}) };
    if (data.reorder) data.saved = JSON.parse(stableNotesValue(data.saved));
    return clone(data.saved);
  };
  data.createStore = () => new (kind === 'live' ? NoteAutosaver : WorkspaceAutosaver)('meeting', data.invoke, () => {}, draft => { data.journal = draft ? clone(draft) : null; });
  data.store = data.createStore(); data.saves = () => data.calls.filter(row => row.command.startsWith('save_'));
  return data;
}

test('plain-text migration is lossless, including blank lines, spaces and literal HTML', () => {
  for (const notes of ['', 'आज notes\n\nSecond line\n', '  indent\tand  spaces  ', '<script>literal text</script>', 'CR\r\nLF']) {
    const document = plainNotesDocument(notes);
    assert.equal(isNotesDocument(document), true);
    assert.equal(notesDocumentText(document), notes);
    same(editorNotesDocument(notes), document);
  }
});

test('structured formatting round trips while stale or malformed documents fall back to saved text', () => {
  const document = rich();
  same(editorNotesDocument('आज notes', document), document);
  same(editorNotesDocument('newer plain note', document), plainNotesDocument('newer plain note'));
  for (const invalid of [null, { type: 'doc' }, { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/private' } }] }, { type: 'doc', content: [{ type: 'text', text: 'x', marks: [null] }] }]) {
    assert.equal(isNotesDocument(invalid), false);
    same(editorNotesDocument('safe fallback', invalid), plainNotesDocument('safe fallback'));
  }
});

test('only explicit web or email links survive validation', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/private', '//example.com', 'not a link']) assert.equal(safeNoteLink(value), null);
  assert.equal(safeNoteLink('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(safeNoteLink('mailto:person@example.com'), 'mailto:person@example.com');
  const unsafe = rich(); unsafe.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
  assert.equal(isNotesDocument(unsafe), false);
});

test('checklists and horizontal rules retain meaning in plain exports', () => {
  const document = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Next steps' }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Send notes' }] }] }] },
    { type: 'horizontalRule' }, { type: 'paragraph', content: [{ type: 'text', text: 'Done' }] },
  ] };
  const notes = notesDocumentText(document); assert.equal(notes, 'Next steps\n[x] Send notes\n---\nDone');
  const workspace = { ...emptyWorkspace('meeting'), notes, notes_document: document };
  const json = JSON.parse(makeTranscriptExport({ id: 'meeting', title: 'Test' }, [], workspace, 'json'));
  same(json.notes_document, document); assert.equal(json.notes, notes);
  assert.ok(makeTranscriptExport({ id: 'meeting', title: 'Test' }, [], workspace, 'txt').includes(notes));
});

test('late workspace responses retain newer formatting and the server revision', () => {
  const current = { ...emptyWorkspace('m'), notes: 'same', notes_document: rich('same', 'highlight') };
  const saved = { ...current, revision: 12, notes_document: rich('same', 'italic') };
  const merged = mergeSavedWorkspace(current, saved, true);
  same(merged.notes_document, current.notes_document); assert.equal(merged.revision, 12);
});

for (const kind of ['live', 'workspace']) {
  const update = (f, document) => f.store.update(kind === 'live' ? { notesDocument: document } : { notes_document: document });
  test(`${kind}: formatting alone is dirty, saves, and reloads without changing plain notes`, async () => {
    const f = fixture(kind); await f.store.load(); update(f, rich());
    assert.equal(f.store.state.dirty, true); await f.store.flush();
    same(f.saved.notes_document, rich()); assert.equal(f.saved.notes, 'आज notes'); assert.equal(f.store.state.dirty, false); assert.equal(f.journal, null);
    const reloaded = f.createStore(); await reloaded.load();
    same(kind === 'live' ? reloaded.state.notesDocument : reloaded.state.workspace.notes_document, rich());
  });
  test(`${kind}: edits during a save preserve newest formatting, never replay old marks`, async () => {
    const f = fixture(kind); await f.store.load(); update(f, rich()); f.saveGate = gate();
    const saving = f.store.flush(); update(f, rich('आज notes', 'highlight'));
    f.saveGate.resolve(); await saving;
    assert.equal(f.saves().length, 2); same(f.saved.notes_document, rich('आज notes', 'highlight')); assert.equal(f.store.state.dirty, false);
  });
  test(`${kind}: worker-only revisions rebase safely without dropping formatting or metadata`, async () => {
    const f = fixture(kind); await f.store.load(); update(f, rich());
    f.saved.revision = 7; f.saved.segment_metadata = { one: { source_track: 'system' } };
    await f.store.flush(); same(f.saved.notes_document, rich()); assert.equal(f.saved.segment_metadata.one.source_track, 'system');
    same(f.saves().map(row => row.args.expectedRevision), [1, 7]);
  });
  test(`${kind}: remote formatting changes block retry even when plain text is identical`, async () => {
    const f = fixture(kind); await f.store.load(); update(f, rich());
    f.saved.revision = 2; f.saved.notes_document = rich('आज notes', 'italic');
    await assert.rejects(f.store.flush(), /changed elsewhere/); await assert.rejects(f.store.retry(), /will not replace/);
    same(f.saved.notes_document, rich('आज notes', 'italic')); assert.equal(f.store.state.dirty, true);
    const recovered = f.createStore(); if (kind === 'live') await recovered.load(undefined, f.journal); else await recovered.load(f.journal);
    await assert.rejects(recovered.retry(), /will not replace/); assert.equal(f.saves().length, 1);
  });
  test(`${kind}: a failed rich save is recoverable after restart and retry`, async () => {
    const f = fixture(kind); await f.store.load(); update(f, rich()); f.fail = true;
    await assert.rejects(f.store.flush(), /disk unavailable/); assert.ok(f.journal);
    const recovered = f.createStore(); if (kind === 'live') await recovered.load(undefined, f.journal); else await recovered.load(f.journal);
    f.fail = false; await recovered.retry(); same(f.saved.notes_document, rich()); assert.equal(f.journal, null);
  });
  test(`${kind}: native JSON key ordering acknowledges one save instead of resaving indefinitely`, async () => {
    const f = fixture(kind); f.reorder = true; await f.store.load(); update(f, rich());
    await f.store.flush(); assert.equal(f.saves().length, 1); assert.equal(f.store.state.dirty, false);
    assert.equal(stableNotesValue(f.saved.notes_document), stableNotesValue(rich()));
    update(f, rich('आज notes', 'highlight')); f.saved.revision += 1;
    await f.store.flush(); assert.equal(f.store.state.error, null);
    assert.equal(f.store.state.dirty, false);
  });
}

test('workspace draft recovery preserves plain text and unreadable raw formatting instead of deleting a journal', () => {
  const editable = workspaceEdits(emptyWorkspace('m'));
  const journal = { version: 1, base: editable, draft: { ...editable, notes: 'draft' } };
  same(parseWorkspaceJournal(journal), journal);
  const unreadable = { ...journal, draft: { ...journal.draft, notes: 'Recover this text', notes_document: { type: 'unknown-future-format' } } };
  same(parseWorkspaceJournal(unreadable), unreadable);
  same(editorNotesDocument(unreadable.draft.notes, unreadable.draft.notes_document), plainNotesDocument('Recover this text'));
});

test('workspace refresh arriving after typing cannot overwrite the editor', async () => {
  const f = fixture(); await f.store.load(); f.loadGate = gate();
  const refresh = f.store.refresh(); f.store.update({ notes_document: rich() });
  f.loadGate.resolve(); await refresh;
  same(f.store.state.workspace.notes_document, rich()); assert.equal(f.store.state.dirty, true);
});

test('explicitly discarded formatting drafts are not recovered on reopening', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes_document: rich() });
  assert.ok(f.journal); assert.equal(f.store.discardDraft(), true); assert.equal(f.journal, null);
  assert.equal(f.store.state.dirty, false); assert.equal(f.store.state.workspace.notes_document, undefined);
  const reopened = f.createStore(); await reopened.load();
  assert.equal(reopened.state.dirty, false); assert.equal(reopened.state.workspace.notes_document, undefined);
  assert.equal(f.saves().length, 0);
});

test('discard waits for native saves already in flight', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes_document: rich() }); f.saveGate = gate();
  const saving = f.store.flush(); assert.equal(f.store.discardDraft(), false);
  f.saveGate.resolve(); await saving; assert.equal(f.store.discardDraft(), true); same(f.saved.notes_document, rich());
});
