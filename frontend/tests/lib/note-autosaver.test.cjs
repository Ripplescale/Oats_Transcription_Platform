const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function compile(relative, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
  const context = { exports: {}, require: name => name.startsWith('./') ? compile(path.relative(__dirname, path.resolve(path.dirname(path.join(__dirname, relative)), `${name}.ts`))) : require(name), ...overrides };
  vm.runInNewContext(compiled.outputText, context);
  return context.exports;
}
const { NoteAutosaver } = compile('../../src/lib/note-autosaver.ts');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const workspace = (notes = 'saved notes', revision = 1, project_id = null) => ({ version: 1, meeting_id: 'meeting-one', revision, notes, project_id, profile: 'trelis-20', corrections: [{ text: 'checked correction' }], speaker_names: { first: 'Maya' } });

function fixture(initial = workspace()) {
  const data = { saved: clone(initial), calls: [], journal: undefined, emits: [], saveGate: null, loadGate: null, failSave: false, failLoad: false };
  data.invoke = async (command, args) => {
    data.calls.push({ command, args: clone(args) });
    if (command === 'load_transcript_workspace') {
      if (data.loadGate) await data.loadGate.promise;
      if (data.failLoad) throw Error('read unavailable');
      return clone(data.saved);
    }
    assert.equal(command, 'save_meeting_note');
    if (data.saveGate) await data.saveGate.promise;
    if (data.failSave) throw Error('disk temporarily unavailable');
    if (args.expectedRevision !== data.saved.revision) throw Error('workspace revision conflict');
    data.saved = { ...data.saved, revision: data.saved.revision + 1, notes: args.notes, notes_document: args.notesDocument ?? data.saved.notes_document, project_id: args.projectId };
    return clone(data.saved);
  };
  data.store = new NoteAutosaver('meeting-one', data.invoke, state => data.emits.push(clone(state)), draft => { data.journal = clone(draft); });
  data.saves = () => data.calls.filter(call => call.command === 'save_meeting_note');
  return data;
}

test('serializes edits during an in-flight save and flush waits for the newest draft', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes: 'first edit' });
  f.saveGate = gate(); const flushing = f.store.flush();
  assert.equal(f.store.flush(), flushing);
  f.store.update({ notes: 'newest edit', projectId: 'project-two' });
  assert.equal(f.saves().length, 1);
  f.saveGate.resolve(); await flushing;
  assert.deepEqual(f.saves().map(call => [call.args.expectedRevision, call.args.notes]), [[1, 'first edit'], [2, 'newest edit']]);
  assert.equal(f.saved.notes, 'newest edit'); assert.equal(f.saved.project_id, 'project-two');
  assert.deepEqual(f.saved.corrections, [{ text: 'checked correction' }]);
  assert.equal(f.store.state.dirty, false); assert.equal(f.store.state.saving, false); assert.equal(f.journal, null);
});

test('rebases only revision advances with identical saved notes and project', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes: 'new note' });
  f.saved.revision = 4; f.saved.corrections = [{ text: 'new correction elsewhere' }];
  await f.store.flush();
  assert.deepEqual(f.saves().map(call => call.args.expectedRevision), [1, 4]);
  assert.equal(f.saved.notes, 'new note'); assert.deepEqual(f.saved.corrections, [{ text: 'new correction elsewhere' }]);
});

test('external note changes block every retry and preserve the original journal base', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes: 'local draft' });
  f.saved = workspace('newer notes from another editor', 2);
  await assert.rejects(f.store.flush(), /changed elsewhere/);
  assert.equal(f.store.state.notes, 'local draft'); assert.equal(f.store.state.dirty, true);
  assert.equal(f.journal.baseNotes, 'saved notes'); assert.equal(f.journal.notes, 'local draft');
  const attempts = f.saves().length;
  await assert.rejects(f.store.retry(), /will not replace/);
  f.store.update({ notes: 'local draft with more typing' });
  await assert.rejects(f.store.retry(), /will not replace/);
  assert.equal(f.saves().length, attempts); assert.equal(f.saved.notes, 'newer notes from another editor');
});

test('external project reassignment cannot be overwritten by retry', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes: 'local draft' });
  f.saved = workspace('saved notes', 2, 'other-project');
  await assert.rejects(f.store.flush()); await assert.rejects(f.store.retry());
  assert.equal(f.saved.project_id, 'other-project'); assert.equal(f.journal.baseProject, null);
});

test('recovered conflicting draft never overwrites newer notes after Retry or another restart', async () => {
  const f = fixture(workspace('newer saved notes', 6, 'new-project'));
  const draft = { notes: 'recovered local draft', projectId: 'old-project', baseNotes: 'old saved notes', baseProject: null };
  await f.store.load(undefined, draft);
  assert.match(f.store.state.error, /Newer saved notes/);
  await assert.rejects(f.store.retry()); await assert.rejects(f.store.flush());
  assert.equal(f.saves().length, 0); assert.deepEqual(f.journal, draft);
  const restored = new NoteAutosaver('meeting-one', f.invoke, () => {}, value => { f.journal = clone(value); });
  await restored.load(undefined, f.journal); await assert.rejects(restored.retry());
  assert.equal(f.saves().length, 0); assert.equal(f.saved.notes, 'newer saved notes'); assert.deepEqual(f.journal, draft);
});

test('a recovered draft with an unchanged base saves safely and retains native script', async () => {
  const f = fixture();
  await f.store.load(undefined, { notes: 'आज meeting अच्छी थी', projectId: null, baseNotes: 'saved notes', baseProject: null });
  assert.equal(f.store.state.error, null); await f.store.flush();
  assert.equal(f.saved.notes, 'आज meeting अच्छी थी'); assert.equal(f.journal, null);
});

test('save failure keeps the draft and journal; transient retry uses the same revision', async () => {
  const f = fixture(); await f.store.load(); f.store.update({ notes: 'keep this draft' });
  f.failSave = true; await assert.rejects(f.store.flush());
  assert.equal(f.saved.notes, 'saved notes'); assert.equal(f.store.state.saving, false);
  assert.equal(f.journal.notes, 'keep this draft'); assert.match(f.store.state.error, /draft is kept/);
  f.failSave = false; await f.store.retry();
  assert.equal(f.saved.notes, 'keep this draft'); assert.equal(f.store.state.error, null); assert.equal(f.journal, null);
});

test('load is deduplicated and a repeated load cannot replace newer typing or project selection', async () => {
  const f = fixture(workspace('', 0)); f.loadGate = gate();
  const first = f.store.load('initial-project'), second = f.store.load('wrong-project');
  assert.equal(first, second); assert.equal(f.calls.length, 1);
  f.loadGate.resolve(); await first;
  f.store.update({ notes: 'typing now', projectId: 'chosen-project' });
  await f.store.load('changed-prop');
  assert.equal(f.calls.length, 1); assert.equal(f.store.state.notes, 'typing now'); assert.equal(f.store.state.projectId, 'chosen-project');
});

test('retry after an initial load error loads the note before saving', async () => {
  const f = fixture(workspace('', 0)); f.failLoad = true;
  await f.store.load('initial-project'); assert.equal(f.store.state.loaded, false);
  f.failLoad = false; await f.store.retry();
  assert.equal(f.store.state.loaded, true); assert.equal(f.saved.project_id, 'initial-project');
});

test('a regressed revision is not used as a retry base', async () => {
  const f = fixture(workspace('saved notes', 5)); await f.store.load(); f.store.update({ notes: 'draft' });
  f.saved.revision = 3; await assert.rejects(f.store.flush());
  assert.equal(f.saves().length, 1); assert.equal(f.journal.notes, 'draft');
});

// Minimal hook scheduler exercises lifecycle and navigation without native IPC,
// recording devices, real browser storage, or timers that outlive a test.
function hookFixture(invoke) {
  const slots = [], events = new Map(), storage = new Map(), pushed = [], timers = new Map(), updateGuards = new Set();
  let index = 0, props, current, pendingRender = false, nextTimer = 0;
  const same = (a, b) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const at = index++; slots[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[at].value, value => { slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; pendingRender = true; }]; },
    useRef(initial) { const at = index++; slots[at] ??= { current: initial }; return slots[at]; },
    useMemo(fn, deps) { const at = index++; if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { value: fn(), deps }; return slots[at].value; },
    useEffect(fn, deps) { const at = index++; const prior = slots[at]; if (!prior || !same(prior.deps, deps)) slots[at] = { effect: fn, deps, cleanup: prior?.cleanup, pending: true }; },
  };
  const router = { push: href => pushed.push(href) };
  const window = { addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); }, removeEventListener(name, callback) { events.get(name)?.delete(callback); }, dispatchEvent(event) { for (const callback of [...(events.get(event.type) ?? [])]) callback(event); return !event.defaultPrevented; } };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const { useLiveNote } = compile('../../src/hooks/useLiveNote.ts', {
    require(name) { if (name === 'react') return react; if (name === '@tauri-apps/api/core') return { invoke }; if (name === 'next/navigation') return { useRouter: () => router }; if (name === '@/lib/note-autosaver') return { NoteAutosaver }; if (name === '@/lib/update-safety') return { registerUpdateSaveGuard: guard => { updateGuards.add(guard); return () => updateGuards.delete(guard); } }; throw Error(`Unexpected import ${name}`); },
    window, localStorage, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id), Event: class { constructor(type) { this.type = type; } },
  });
  function render(next = props) { props = next; index = 0; pendingRender = false; current = useLiveNote(next.id, next.project); const effects = slots.filter(slot => slot?.pending); effects.forEach(slot => { slot.cleanup?.(); }); effects.forEach(slot => { slot.pending = false; slot.cleanup = slot.effect(); }); return current; }
  async function settle() { for (let attempt = 0; attempt < 12; attempt++) { await tick(); if (pendingRender) render(); } return current; }
  function strictReplay() { const effects = slots.filter(slot => slot?.effect); effects.forEach(slot => slot.cleanup?.()); effects.forEach(slot => { slot.cleanup = slot.effect(); }); }
  function navigate(href, onProceed) { const event = { type: 'xx-before-navigate', detail: { href, onProceed }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; window.dispatchEvent(event); return event; }
  function unmount() { slots.filter(slot => slot?.effect).forEach(slot => slot.cleanup?.()); }
  return { render, settle, strictReplay, navigate, unmount, pushed, storage, prepareUpdate: async () => { for (const guard of updateGuards) await guard(); }, get updateGuardCount() { return updateGuards.size; }, get value() { return current; } };
}

test('app update waits for the newest live-note edit to save and unregisters on close', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'first pending note' }); await hook.settle(); f.saveGate = gate();
  let prepared = false; const preparing = hook.prepareUpdate().then(() => { prepared = true; });
  await tick(); assert.equal(prepared, false);
  hook.value.update({ notes: 'latest note before updating' }); await hook.settle();
  f.saveGate.resolve(); await preparing;
  assert.equal(f.saved.notes, 'latest note before updating');
  assert.equal(hook.storage.has('xx.note-draft.meeting-one'), false);
  hook.unmount(); assert.equal(hook.updateGuardCount, 0);
});

test('app update is blocked by a failed live-note save and keeps the draft', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'keep my work' }); await hook.settle(); f.failSave = true;
  await assert.rejects(hook.prepareUpdate(), /disk temporarily unavailable/);
  assert.equal(f.saved.notes, 'saved notes');
  assert.equal(JSON.parse(hook.storage.get('xx.note-draft.meeting-one')).notes, 'keep my work');
  hook.unmount();
});

test('hook StrictMode replay does not duplicate load or replace notes after typing', async () => {
  const f = fixture(workspace('', 0)); f.loadGate = gate();
  const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one', project: 'initial' }); hook.strictReplay();
  assert.equal(f.calls.filter(call => call.command === 'load_transcript_workspace').length, 1);
  f.loadGate.resolve(); await hook.settle(); hook.value.update({ notes: 'my note' }); await hook.settle();
  hook.render({ id: 'meeting-one', project: 'other' }); await hook.settle();
  assert.equal(hook.value.notes, 'my note'); assert.equal(hook.value.projectId, 'initial');
  hook.unmount(); await tick();
});

test('hook ignores old meeting load completion after switching to another meeting', async () => {
  const old = gate();
  const hook = hookFixture(async (_command, args) => { if (args.meetingId === 'old') { await old.promise; return { ...workspace('old note'), meeting_id: 'old' }; } return { ...workspace('new note'), meeting_id: 'new' }; });
  hook.render({ id: 'old' }); hook.render({ id: 'new' }); await hook.settle();
  assert.equal(hook.value.notes, 'new note'); old.resolve(); await hook.settle();
  assert.equal(hook.value.notes, 'new note'); hook.unmount();
});

test('navigation waits for all pending edits and only the latest requested destination wins', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'first draft' }); await hook.settle(); f.saveGate = gate();
  assert.equal(hook.navigate('/first').defaultPrevented, true);
  hook.value.update({ notes: 'last draft' }); hook.navigate('/last'); await hook.settle();
  assert.deepEqual(hook.pushed, []); f.saveGate.resolve(); await hook.settle();
  assert.equal(f.saved.notes, 'last draft'); assert.deepEqual(hook.pushed, ['/last']); hook.unmount();
});

test('failed navigation save stays in the editor and leaves a recoverable journal', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'keep this' }); await hook.settle(); f.failSave = true;
  hook.navigate('/other'); await hook.settle();
  assert.deepEqual(hook.pushed, []); assert.equal(hook.value.notes, 'keep this');
  assert.equal(JSON.parse(hook.storage.get('xx.note-draft.meeting-one')).notes, 'keep this'); hook.unmount();
});

test('Back to notes closes the composer only after the newest draft is durably saved', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'pending live note' }); await hook.settle(); f.saveGate = gate();
  let closed = false;
  assert.equal(hook.navigate('/', () => { closed = true; }).defaultPrevented, true);
  await hook.settle(); assert.equal(closed, false);
  hook.value.update({ notes: 'newest live note' }); f.saveGate.resolve(); await hook.settle();
  assert.equal(closed, true); assert.equal(f.saved.notes, 'newest live note'); assert.deepEqual(hook.pushed, []);
  hook.unmount();
});

test('Back to notes cannot hide a failed or conflicting live draft', async () => {
  const f = fixture(); const hook = hookFixture(f.invoke); hook.render({ id: 'meeting-one' }); await hook.settle();
  hook.value.update({ notes: 'keep the stopped call draft visible' }); await hook.settle();
  f.saved = workspace('a newer saved note from elsewhere', 2);
  let closed = false; hook.navigate('/', () => { closed = true; }); await hook.settle();
  assert.equal(closed, false); assert.deepEqual(hook.pushed, []); assert.equal(hook.value.notes, 'keep the stopped call draft visible');
  assert.match(hook.value.error, /changed elsewhere/);
  hook.navigate('/', () => { closed = true; }); await hook.settle();
  assert.equal(closed, false); assert.equal(f.saved.notes, 'a newer saved note from elsewhere');
  assert.equal(JSON.parse(hook.storage.get('xx.note-draft.meeting-one')).notes, 'keep the stopped call draft visible');
  hook.unmount();
});
