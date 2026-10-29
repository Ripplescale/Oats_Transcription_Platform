const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react');
const { create, act } = require('react-test-renderer');
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
function load(file, mocks = {}, globals = {}) {
  const scope = { exports: {}, require: name => mocks[name] ?? require(name), console: { log() {}, warn() {}, error() {} }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, scope);
  return scope.exports;
}
async function fixture(mode) {
  const f = { listeners: {}, intervals: [], timers: [], calls: [], toasts: [], state: null,
    backend: { is_recording: true, is_paused: false, is_active: true, recording_duration: 40, active_duration: 40, is_stopping: false, last_error: null } };
  const globals = { window: {}, sessionStorage: { setItem() {} },
    setTimeout: (callback, ms) => { f.timers.push({ callback, ms }); return f.timers.length; }, clearTimeout() {},
    setInterval: callback => { f.intervals.push(callback); return f.intervals.length; }, clearInterval() {} };
  const listen = async (name, callback) => { f.listeners[name] = callback; return () => { delete f.listeners[name]; }; };
  const invoke = async command => {
    f.calls.push(command);
    if (command === 'get_recording_state') return f.readState ? f.readState() : { ...f.backend };
    if (command !== 'stop_recording') return true;
    if (mode === 'pending') { Object.assign(f.backend, { is_recording: false, is_active: false, is_stopping: true }); return new Promise(() => {}); }
    Object.assign(f.backend, { is_recording: false, is_active: false, last_error: mode === 'disk-error' ? 'Source audio needs recovery: disk full' : null });
    throw Error(mode === 'missing' ? 'No recording in progress' : f.backend.last_error);
  };
  const service = load('services/recordingService.ts', { '@tauri-apps/api/core': { invoke }, '@tauri-apps/api/event': { listen } }, globals);
  const toast = Object.fromEntries(['error', 'warning', 'success', 'info'].map(name => [name, (...args) => f.toasts.push({ name, args })]));
  const context = load('contexts/RecordingStateContext.tsx', {
    '@/services/recordingService': service, '@/lib/local-workflow': { LOCAL_TRANSCRIPT_ONLY: true }, sonner: { toast },
  }, globals);
  const imports = { '@tauri-apps/api/event': { listen }, 'next/navigation': { useRouter: () => ({}) }, sonner: { toast },
    '@/lib/local-workflow': { LOCAL_TRANSCRIPT_ONLY: true }, '@/contexts/RecordingStateContext': context,
    '@/contexts/TranscriptContext': { useTranscripts: () => ({ transcriptsRef: { current: [] } }) },
    '@/components/Sidebar/SidebarProvider': { useSidebar: () => ({}) }, '@/services/storageService': {}, '@/services/transcriptService': {},
    '@/lib/analytics': { default: { trackTranscriptionSuccess() {}, trackButtonClick() {} } }, '@/lib/summary-language-preferences': {} };
  const { useRecordingStop } = load('hooks/useRecordingStop.ts', imports, globals);
  const { RecordingControls } = load('components/RecordingControls.tsx', { ...imports,
    '@tauri-apps/api/core': { invoke }, '@tauri-apps/api/path': { appDataDir: async () => 'C:/Fictional' },
    '@/services/recordingService': service,
    'lucide-react': Object.fromEntries(['Play', 'Pause', 'Square', 'Mic', 'AlertCircle', 'X'].map(name => [name, () => null])),
    '@/components/ui/alert': Object.fromEntries(['Alert', 'AlertDescription', 'AlertTitle'].map(name => [name, ({ children }) => React.createElement('div', null, children)])),
    '@/components/ui/tooltip': {},
    '@/lib/update-safety': { prepareForUpdateInstall: async () => { f.calls.push('flush-notes'); if (f.failSave) throw Error('Notes are not saved'); } },
    '@/components/ui/dialog': { Dialog: ({ open, children }) => open ? React.createElement('dialog', null, children) : null,
      ...Object.fromEntries(['DialogContent', 'DialogDescription', 'DialogFooter', 'DialogTitle'].map(name => [name, ({ children }) => React.createElement('div', null, children)])) },
  }, globals);
  function Harness() {
    f.state = context.useRecordingState();
    const stop = useRecordingStop(() => {}, () => {});
    return React.createElement(RecordingControls, { isRecording: f.state.isRecording, barHeights: [], onRecordingStart() {},
      onRecordingStop: stop.handleRecordingStop, onStopInitiated: () => stop.setIsStopping(true), onTranscriptReceived() {}, isRecordingDisabled: false, isParentProcessing: false });
  }
  await act(async () => { f.view = create(React.createElement(context.RecordingStateProvider, null, React.createElement(Harness))); await flush(); });
  f.stop = async () => { await act(async () => { f.view.root.findByProps({ 'aria-label': 'Stop recording' }).props.onClick(); await flush(); }); };
  f.poll = async () => { await act(async () => { for (const callback of f.intervals) await callback(); await flush(); }); };
  f.close = async () => { await act(async () => { f.view.unmount(); await flush(); }); };
  f.text = () => JSON.stringify(f.view.toJSON());
  return f;
}
test('concurrent state refreshes share one read and reread after a newer native event', async () => {
  const f = await fixture('missing');
  try {
    const stale = { ...f.backend };
    let release, reads = 0;
    f.readState = () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ...f.backend });
    let first, second;
    await act(async () => {
      first = f.state.refreshState(); second = f.state.refreshState(); await flush();
      assert.equal(reads, 1);
      Object.assign(f.backend, { is_recording: false, is_active: false });
      f.listeners['recording-state-changed']({ payload: { ...f.backend } });
      release(stale);
      const snapshots = await Promise.all([first, second]);
      assert.equal(snapshots[0].is_recording, false); assert.equal(snapshots[1].is_recording, false);
      await flush();
    });
    assert.equal(reads, 2); assert.equal(f.state.isRecording, false);
  } finally { await f.close(); }
});
for (const mode of ['disk-error', 'missing']) test(`Finish ${mode} reconciles and releases the New note guard`, async () => {
  const f = await fixture(mode);
  try {
    await f.stop(); await f.poll();
    assert.equal(f.state.isRecording, false); assert.equal(f.state.isStopping, false);
    assert.equal(f.state.status, mode === 'disk-error' ? 'error' : 'idle');
    assert.doesNotMatch(f.text(), /Saving your recording/);
    if (mode === 'disk-error') assert.match(f.text(), /disk full/);
  } finally { await f.close(); }
});
test('a pending native stop times out visibly but remains quarantined until ownership is released', async () => {
  const f = await fixture('pending');
  try {
    await f.stop();
    await act(async () => { f.timers.find(timer => timer.ms === 25000).callback(); await flush(); });
    await f.poll();
    assert.equal(f.state.isStopping, true); assert.equal(f.state.nativeStopping, true);
    assert.doesNotMatch(f.text(), /Saving your recording/); assert.match(f.text(), /Check finish/);
    Object.assign(f.backend, { is_stopping: false }); await f.poll();
    assert.equal(f.state.isStopping, false); assert.equal(f.state.status, 'idle');
  } finally { await f.close(); }
});
test('recording health errors remain visible after capture stops and listeners are cleaned up', async () => {
  const f = await fixture('missing');
  Object.assign(f.backend, { is_recording: false, is_active: false, last_error: 'Source writer failed' });
  await act(async () => { f.listeners['recording-error']({ payload: 'Source writer failed' }); await flush(); });
  assert.equal(f.state.isRecording, false); assert.equal(f.state.recordingError, 'Source writer failed');
  assert.ok(f.toasts.some(item => item.name === 'error'));
  await f.close(); assert.deepEqual(Object.keys(f.listeners), []);
});
test('recovery restart requires confirmation and saved notes before invoking the scoped restart', async () => {
  const f = await fixture('pending');
  const button = text => f.view.root.findAllByType('button').find(node => node.children.includes(text));
  try {
    Object.assign(f.backend, { is_recording: false, is_active: false, is_stopping: true, can_restart_after_capture_failure: true });
    await f.poll();
    await act(async () => { button('Restart oats to recover').props.onClick(); await flush(); });
    assert.ok(!f.calls.includes('restart_after_capture_failure'));
    await act(async () => { button('Keep waiting').props.onClick(); await flush(); });
    assert.ok(!f.calls.includes('flush-notes'));
    await act(async () => { button('Restart oats to recover').props.onClick(); await flush(); });
    f.failSave = true;
    await act(async () => { button('Save notes and restart').props.onClick(); await flush(); });
    assert.ok(!f.calls.includes('restart_after_capture_failure'));
    assert.match(f.text(), /Notes are not saved/);
    f.failSave = false;
    await act(async () => { button('Restart oats to recover').props.onClick(); await flush(); });
    await act(async () => { button('Save notes and restart').props.onClick(); await flush(); });
    assert.deepEqual(f.calls.slice(-2), ['flush-notes', 'restart_after_capture_failure']);
    assert.equal(button('Keep waiting').props.disabled, true);
    assert.equal(button('Saving and restarting…').props.disabled, true);
  } finally { await f.close(); }
});
