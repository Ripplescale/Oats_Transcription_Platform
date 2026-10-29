const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function fixture(saved, brokenStorage = false) {
  const window = new EventTarget(), document = { documentElement: { dataset: {} } }, writes = [];
  const storage = { getItem: () => { if (brokenStorage) throw Error('unavailable'); return saved; }, setItem: (key, value) => { if (brokenStorage) throw Error('unavailable'); writes.push([key, value]); saved = value; } };
  function load(file, mocks = {}) {
    const context = { exports: {}, require: name => mocks[name] ?? require(name), window, document, localStorage: storage, Event, console };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src', file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
    return context.exports;
  }
  const mode = load('contexts/DisplayModeContext.tsx');
  const state = { window, document, writes, mode, mounts: 0, unmounts: 0, value: null, editor: null, load };
  state.Consumer = () => {
    state.value = mode.useDisplayMode();
    const [text, setText] = React.useState('Original note'); state.editor = { text, setText };
    React.useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
    return React.createElement('textarea', { value: text });
  };
  return state;
}

test('User is the default; switching persists presentation without remounting an edited note', async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(React.createElement(f.mode.DisplayModeProvider, null, React.createElement(f.Consumer))); });
  assert.equal(f.value.mode, 'user'); assert.equal(f.value.isDev, false);
  await act(async () => { f.editor.setText('Unsaved thought'); f.value.setMode('dev'); });
  assert.equal(f.value.isDev, true); assert.equal(f.editor.text, 'Unsaved thought');
  assert.equal(f.mounts, 1); assert.equal(f.unmounts, 0);
  assert.deepEqual(f.writes, [['xx-display-mode', 'dev']]);
  assert.equal(f.document.documentElement.dataset.displayMode, 'dev');
  await act(async () => { f.value.setMode('user'); });
  assert.equal(f.editor.text, 'Unsaved thought'); assert.equal(f.mounts, 1);
  await act(async () => renderer.unmount());
});

test('Saved Dev reloads, invalid values fall back to User, and blocked storage stays usable', async () => {
  for (const [saved, broken, expected] of [['dev', false, 'dev'], ['clean', false, 'user'], ['dev', true, 'user']]) {
    const f = fixture(saved, broken); let renderer;
    await act(async () => { renderer = create(React.createElement(f.mode.DisplayModeProvider, null, React.createElement(f.Consumer))); });
    assert.equal(f.value.mode, expected);
    await act(async () => { f.value.setMode('dev'); });
    assert.equal(f.value.mode, 'dev');
    const event = new Event('storage'); Object.assign(event, { key: 'xx-display-mode', newValue: 'user' });
    await act(async () => { f.window.dispatchEvent(event); });
    assert.equal(f.value.mode, 'user'); assert.equal(f.mounts, 1);
    await act(async () => renderer.unmount());
  }
});

test('User hides live diagnostics while keeping transcript, timestamps, and actual failures visible', async () => {
  const f = fixture(); let renderer;
  const segment = { id: 'one', text: 'Keep this exact transcript.', source_track: 'microphone', start_seconds: 12, end_seconds: 22, quality_flags: ['needs_review'], recovery: { method: 'context_window_retry', requires_review: true } };
  const state = { currentSession: 'session', preferences: { profile: 'trelis-20' }, runs: [{ capture: { session_id: 'session' }, role: 'live-final', preferences: { timing: 'during-recording', profile: 'trelis-20' }, job: { state: 'failed', error: 'Worker unavailable', segments: [segment] } }] };
  const { LiveTranscriptPanel } = f.load('components/LiveTranscriptPanel.tsx', {
    'lucide-react': { AudioLines: () => null, Check: () => null, Mic: () => null, NotebookPen: () => null },
    '@/contexts/DisplayModeContext': f.mode,
    '@/contexts/LocalWorkflowContext': { useLocalWorkflow: () => ({ state }) },
    '@/contexts/RecordingStateContext': { useRecordingState: () => ({ isRecording: true, isPaused: false }) },
    '@/lib/transcript-workspace': { recordingTime: () => '00:12', omitQuietMicrophoneText: () => false, romanizeTranscriptFillers: text => text },
    '@/lib/local-transcription-workflow': { profileChunkSeconds: () => 20, trelisProfile: profile => profile, isTerminalJob: state => ['complete', 'failed', 'stopped'].includes(state) },
    '@/hooks/usePermissionCheck': { usePermissionCheck: () => ({ isChecking: true }) },
    '@/components/PermissionWarning': { PermissionWarning: () => null },
    '@/components/TranscriptProcessingChecks': { TranscriptProcessingChecks: () => React.createElement('div', null, 'Processing checks') },
  });
  const texts = () => {
    const walk = node => typeof node === 'string' ? node : !node ? '' : Array.isArray(node) ? node.map(walk).join(' ') : walk(node.children);
    return walk(renderer.toJSON());
  };
  await act(async () => { renderer = create(React.createElement(f.mode.DisplayModeProvider, null, React.createElement(f.Consumer), React.createElement(LiveTranscriptPanel))); });
  assert.match(texts(), /Keep this exact transcript/); assert.match(texts(), /00:12/);
  assert.match(texts(), /Transcription needs attention/); assert.doesNotMatch(texts(), /Review suggested|Processing checks|Microphone|Left: computer/);
  await act(async () => f.value.setMode('dev'));
  assert.match(texts(), /Review suggested/); assert.match(texts(), /Processing checks/); assert.match(texts(), /Microphone/);
  assert.match(texts(), /Transcription needs attention/);
  assert.equal(state.runs[0].job.segments[0], segment); assert.equal(segment.text, 'Keep this exact transcript.');
  await act(async () => renderer.unmount());
});
