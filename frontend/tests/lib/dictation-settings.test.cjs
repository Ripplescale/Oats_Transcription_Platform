const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function fixture(overrides = {}) {
  const state = { status: { phase: 'idle', session_id: null, elapsed_seconds: 0, level: 0, text: null, message: null, microphone: null, available: true,
    shortcuts: { fallback: { label: 'Ctrl + Alt + Shift + D', registered: true }, copilot: { label: 'Win + Shift + F23', registered: false } }, ...overrides }, calls: [], fail: null, interval: null };
  function load(file, mocks = {}) {
    const scope = { exports: {}, require: name => mocks[name] ?? require(name), console,
      window: { setInterval: callback => { state.interval = callback; return 1; }, clearInterval: () => { state.interval = null; } } };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope);
    return scope.exports;
  }
  state.Component = load('components/DictationSettings.tsx', {
    '@/lib/dictation': load('lib/dictation.ts'),
    'lucide-react': { Copy: () => null, Mic: () => null, Square: () => null, X: () => null },
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      state.calls.push({ command, args });
      if (command === 'dictation_status') return structuredClone(state.status);
      if (command === state.fail) throw Error('The target session changed.');
      if (command === 'dictation_toggle') state.status = { ...state.status, phase: state.status.phase === 'listening' ? 'transcribing' : 'listening', session_id: 'sample-session' };
      if (command === 'dictation_cancel') state.status = { ...state.status, phase: 'cancelled' };
    } },
  }).DictationSettings;
  return state;
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const button = (renderer, text) => renderer.root.findAllByType('button').find(node => node.children.includes(text));

test('Settings mounting only reads status; Start and Stop guard the visible session', async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.ok(f.calls.every(call => call.command === 'dictation_status'));
  assert.equal(button(renderer, 'Start dictation').props.disabled, false);
  await act(async () => { button(renderer, 'Start dictation').props.onClick(); button(renderer, 'Start dictation').props.onClick(); await flush(); });
  const starts = f.calls.filter(call => call.command === 'dictation_toggle');
  assert.equal(starts.length, 1); assert.equal(starts[0].args.sessionId, null);
  await act(async () => { button(renderer, 'Stop dictation').props.onClick(); await flush(); });
  assert.equal(f.calls.filter(call => call.command === 'dictation_toggle')[1].args.sessionId, 'sample-session');
  assert.ok(button(renderer, 'Cancel'));
  await act(async () => { renderer.unmount(); }); assert.equal(f.interval, null);
});

test('Result Copy is explicit and an action failure stays visible after status refresh', async () => {
  const f = fixture({ phase: 'ready', session_id: 'ready-session', text: 'Keep this result.' }); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.equal(f.calls.filter(call => call.command === 'dictation_copy').length, 0);
  f.fail = 'dictation_copy';
  await act(async () => { button(renderer, 'Copy result').props.onClick(); await flush(); });
  assert.equal(f.calls.find(call => call.command === 'dictation_copy').args.sessionId, 'ready-session');
  await act(async () => { f.interval(); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /The target session changed/);
  assert.match(JSON.stringify(renderer.toJSON()), /Keep this result/);
  f.fail = null;
  await act(async () => { button(renderer, 'Copy result').props.onClick(); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Copied. Paste it where you need it/);
  await act(async () => renderer.unmount());
});

test('Unavailable capture and unavailable shortcuts are reported without starting anything', async () => {
  const f = fixture({ available: false, message: 'Local model unavailable.', shortcuts: { fallback: { label: 'Ctrl + Alt + Shift + D', registered: false }, copilot: { label: 'Win + Shift + F23', registered: false } } }); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.equal(button(renderer, 'Start dictation').props.disabled, true);
  assert.match(JSON.stringify(renderer.toJSON()), /Local model unavailable/);
  assert.ok(f.calls.every(call => call.command === 'dictation_status'));
  await act(async () => renderer.unmount());
});

test('A registered Copilot binding is untested until observed; idle keeps the last result available', async () => {
  const f = fixture({ text: 'The last successful dictation.', shortcuts: { fallback: { label: 'Ctrl + Alt + Shift + D', registered: true }, copilot: { label: 'Win + Shift + F23', registered: true, observed: false } } }); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Shortcut ready; key untested/);
  assert.match(JSON.stringify(renderer.toJSON()), /The last successful dictation/);
  assert.ok(button(renderer, 'Copy last dictation'));
  f.status.shortcuts.copilot.observed = true;
  await act(async () => { f.interval(); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Key detected/);
  assert.equal(f.calls.filter(call => call.command !== 'dictation_status').length, 0);
  await act(async () => renderer.unmount());
});

test('The current backend labels its model and live-word or phrase instructions', async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Trelis · live words/);
  assert.match(JSON.stringify(renderer.toJSON()), /Text appears as you speak/);
  f.status.backend = 'faster_whisper';
  await act(async () => { f.interval(); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /faster-whisper · live words/);
  assert.match(JSON.stringify(renderer.toJSON()), /Text appears as you speak/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /local Trelis model/);
  await act(async () => renderer.unmount());
});

test('Tentative drafts replace and retract without being concatenated into the stable result', async () => {
  const draft = 'अभी <img src=x onerror="window.injected=true">';
  const f = fixture({ phase: 'listening', session_id: 'live-one', backend: 'faster_whisper', text: 'Stable words.', draft_text: draft }); let renderer;
  const drafts = () => renderer.root.findAll(node => node.props['aria-label'] === 'Tentative dictation draft');
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.deepEqual(drafts()[0].children, [draft]);
  assert.equal(renderer.root.findAllByType('img').length, 0);
  assert.equal(button(renderer, 'Copy result'), undefined);
  f.status.draft_text = 'A revised ending';
  await act(async () => { f.interval(); await flush(); });
  assert.deepEqual(drafts()[0].children, ['A revised ending']);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /window.injected/);
  f.status.draft_text = '';
  await act(async () => { f.interval(); await flush(); });
  assert.equal(drafts().length, 0);
  f.status.text = 'Stable words. A revised ending';
  f.status.draft_text = 'next words';
  await act(async () => { f.interval(); await flush(); });
  assert.deepEqual(drafts()[0].children, ['next words']);
  assert.equal(renderer.root.findAll(node => node.props['aria-label'] === 'Dictation result').length, 0);
  f.status.phase = 'ready';
  await act(async () => { f.interval(); await flush(); });
  assert.equal(drafts().length, 0, 'A stale draft is hidden on final completion');
  assert.deepEqual(renderer.root.findByProps({ 'aria-label': 'Dictation result' }).children, ['Stable words. A revised ending']);
  await act(async () => { button(renderer, 'Copy result').props.onClick(); await flush(); });
  const copied = f.calls.find(call => call.command === 'dictation_copy').args;
  assert.equal(copied.sessionId, 'live-one');
  assert.deepEqual(Object.keys(copied), ['sessionId']);
  assert.equal(f.status.text, 'Stable words. A revised ending');
  await act(async () => renderer.unmount());
});

test('Drafts hide after cancellation, failure, completion and a fresh session starting', async () => {
  const f = fixture({ phase: 'listening', session_id: 'previous', backend: 'faster_whisper', draft_text: 'do not retain this draft' }); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  for (const phase of ['cancelled', 'error', 'inserted', 'idle', 'starting']) {
    f.status.phase = phase;
    if (phase === 'starting') f.status.session_id = 'new-session';
    await act(async () => { f.interval(); await flush(); });
    assert.equal(renderer.root.findAll(node => node.props['aria-label'] === 'Tentative dictation draft').length, 0, phase);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /do not retain this draft/);
  }
  f.status.phase = 'listening'; f.status.draft_text = 'new session words';
  await act(async () => { f.interval(); await flush(); });
  assert.deepEqual(renderer.root.findByProps({ 'aria-label': 'Tentative dictation draft' }).children, ['new session words']);
  assert.ok(f.calls.every(call => call.command === 'dictation_status'));
  await act(async () => renderer.unmount());
});

test('Degraded pause detection stays visible while live Trelis typing continues, then clears on recovery', async () => {
  const warning = 'Pause detection is unavailable. Streaming continues with word agreement.';
  const f = fixture({ phase: 'listening', backend: 'trelis', live_typing: true, streaming_message: warning }); let renderer;
  await act(async () => { renderer = create(React.createElement(f.Component)); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Pause detection is unavailable/);
  assert.equal(button(renderer, 'Copy result'), undefined);
  f.status.streaming_message = null;
  await act(async () => { f.interval(); await flush(); });
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Pause detection is unavailable/);
  assert.ok(f.calls.every(call => call.command === 'dictation_status'));
  await act(async () => renderer.unmount());
});
