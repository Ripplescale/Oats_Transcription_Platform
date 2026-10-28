const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const available = () => ({ state: 'available', configured: true, current_version: '0.8.2', version: '0.8.3', notes: 'Release notes', downloaded_bytes: 0 });
function fixture() {
  const values = new Map();
  const localStorage = { get length() { return values.size; }, key: n => [...values.keys()][n] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const state = { values, localStorage, now: 100_000, calls: [], prepares: 0, listeners: {}, browserListeners: {}, timers: [], status: available(), fail: null, block: false };
  const browser = { localStorage, setTimeout: cb => { state.timers.push(cb); return state.timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, addEventListener(name, callback) { state.browserListeners[name] = callback; },
    removeEventListener(name, callback) { if (state.browserListeners[name] === callback) delete state.browserListeners[name]; } };
  function load(file, mocks = {}) {
    const scope = { exports: {}, require: name => mocks[name] ?? require(name), console, window: browser };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, scope);
    return scope.exports;
  }
  state.load = load;
  state.safety = load('lib/update-safety.ts');
  state.call = async (command, args) => {
    state.calls.push({ command, args });
    if (state.fail === command) throw Error('Offline');
    if (command === 'updates_download') state.status = { ...state.status, state: 'downloaded', downloaded_bytes: 123 };
    if (command === 'updates_install' && state.block) state.status = { ...state.status, state: 'downloaded', blocked_reason: 'Finish recording before installing.' };
    return structuredClone(state.status);
  };
  const module = load('services/updateService.ts', { '@tauri-apps/api/core': { invoke: state.call }, '@/lib/update-safety': state.safety });
  state.Service = module.UpdateService;
  state.service = new module.UpdateService(state.call, async () => { state.prepares++; await state.safety.prepareForUpdateInstall(); }, () => state.now);
  return state;
}

test('metadata checks never download or install; successful checks throttle, explicit checks do not', async () => {
  const f = fixture();
  await f.service.getStatus(); await f.service.checkForUpdates(); await f.service.checkForUpdates();
  assert.deepEqual(f.calls.map(x => x.command), ['updates_status', 'updates_check']);
  await f.service.checkForUpdates(true);
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 2);
  f.now += 24 * 60 * 60 * 1000;
  await f.service.checkForUpdates();
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 3);
  assert.equal(f.prepares, 0);
});

test('failed checks can retry and null legacy responses become explicitly unconfigured', async () => {
  const f = fixture(); f.fail = 'updates_check';
  await assert.rejects(f.service.checkForUpdates(), /Offline/);
  assert.equal(f.service.wasCheckedRecently(), false);
  f.fail = null; f.status = null;
  assert.equal((await f.service.getStatus()).state, 'unconfigured');
  assert.equal((await f.service.checkForUpdates()).state, 'unconfigured');
});

test('a fresh app session checks despite a recent persisted background check', async () => {
  const f = fixture();
  await f.service.checkForUpdates();
  const restarted = new f.Service(f.call, async () => {}, () => f.now);
  assert.equal(restarted.wasCheckedRecently(), true);
  await restarted.checkOnOpen();
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 2);
  await restarted.checkOnOpen();
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 2);
  f.now += 60_001;
  await restarted.checkOnOpen();
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 3);
  assert.ok(f.calls.every(x => x.command === 'updates_check'));
});

test('concurrent checks share one metadata request', async () => {
  const f = fixture(); let resolve; let calls = 0;
  const service = new f.Service(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = service.checkForUpdates(true); const second = service.checkForUpdates(true);
  assert.equal(calls, 1); resolve(available()); await Promise.all([first, second]);
});

test('explicit download only stages; install flushes notes before the separate native command', async () => {
  const f = fixture(); const order = [];
  f.safety.registerUpdateSaveGuard(async () => { order.push('saved'); });
  await f.service.download('0.8.3');
  assert.deepEqual(f.calls.map(x => x.command), ['updates_download']); assert.equal(f.prepares, 0);
  const call = f.service.call;
  f.service.call = async (...args) => { order.push(args[0]); return call(...args); };
  await f.service.install('0.8.3');
  assert.deepEqual(order, ['saved', 'updates_install']);
  assert.equal(f.calls.at(-1).args.version, '0.8.3');
});

test('failed saves and unresolved journals never invoke native install', async () => {
  const f = fixture(); await f.service.download('0.8.3');
  const unregister = f.safety.registerUpdateSaveGuard(async () => { throw Error('Notes are still saving.'); });
  await assert.rejects(f.service.install('0.8.3'), /Save your changes.*still saving/);
  unregister(); f.values.set('xx.note-draft.fixture', '{"private":"unsaved"}');
  await assert.rejects(f.service.install('0.8.3'), /Unsaved notes/);
  assert.equal(f.calls.filter(x => x.command === 'updates_install').length, 0);
  f.values.clear(); await f.service.install('0.8.3');
  assert.equal(f.calls.filter(x => x.command === 'updates_install').length, 1);
});

test('active native work blocks install while retaining the verified download for retry', async () => {
  const f = fixture(); await f.service.download('0.8.3'); f.block = true;
  await assert.rejects(f.service.install('0.8.3'), /Finish recording/);
  assert.equal((await f.service.getStatus()).state, 'downloaded');
  f.block = false; f.status.blocked_reason = null; await f.service.install('0.8.3');
  assert.equal(f.calls.filter(x => x.command === 'updates_download').length, 1);
  assert.equal(f.calls.filter(x => x.command === 'updates_install').length, 2);
});

test('install rejects a different version and missing storage fails closed', async () => {
  const f = fixture(); await f.service.download('0.8.3');
  await assert.rejects(f.service.install('0.8.4'), /Download this update/);
  Object.defineProperty(f.localStorage, 'length', { get() { throw Error('Blocked storage'); } });
  await assert.rejects(f.service.install('0.8.3'), /Could not verify saved notes/);
  assert.equal(f.calls.filter(x => x.command === 'updates_install').length, 0);
});

test('provider startup and notification perform metadata-only checks; details never starts download', async () => {
  const f = fixture(); const notifications = []; let stopCount = 0;
  const hook = f.load('hooks/useUpdateCheck.ts', { '@/services/updateService': { updateService: f.service } });
  const Dialog = () => null;
  const Provider = f.load('components/UpdateCheckProvider.tsx', {
    '@/hooks/useUpdateCheck': hook, '@/services/updateService': { updateService: f.service }, './UpdateDialog': { UpdateDialog: Dialog },
    './UpdateNotification': { showUpdateNotification: (...args) => notifications.push(args) },
    '@tauri-apps/api/event': { listen: async (name, callback) => { f.listeners[name] = callback; return () => { stopCount++; }; } },
  }).UpdateCheckProvider;
  let renderer;
  await act(async () => { renderer = create(React.createElement(Provider, null, 'App')); await flush(); });
  assert.deepEqual(f.calls.map(x => x.command), ['updates_status']);
  await act(async () => { f.timers[0](); await flush(); });
  assert.deepEqual(f.calls.map(x => x.command), ['updates_status', 'updates_check']);
  assert.equal(notifications.length, 1);
  await act(async () => { f.browserListeners.focus(); await flush(); });
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 1);
  f.now += 60_001;
  await act(async () => { f.browserListeners.focus(); await flush(); });
  assert.equal(f.calls.filter(x => x.command === 'updates_check').length, 2);
  await act(async () => { notifications[0][1](); await flush(); });
  assert.equal(renderer.root.findByType(Dialog).props.open, true);
  assert.ok(f.calls.every(x => x.command === 'updates_status' || x.command === 'updates_check'));
  await act(async () => { renderer.unmount(); }); assert.equal(stopCount, 1);
  assert.deepEqual(Object.keys(f.browserListeners), []);
});

test('install preflight keeps dialog modal and non-dismissible until failure, without losing staged state', async () => {
  const f = fixture(); let reject; let installCalls = 0; const closes = [];
  const Dialog = props => React.createElement('dialog-root', props, props.children);
  const Content = props => React.createElement('dialog-content', props, props.children);
  const wrapper = props => React.createElement('div', props, props.children);
  const Component = f.load('components/UpdateDialog.tsx', {
    './ui/dialog': { Dialog, DialogContent: Content, DialogDescription: wrapper, DialogFooter: wrapper, DialogHeader: wrapper, DialogTitle: wrapper },
    '@/services/updateService': { updateService: { getStatus: async () => f.status,
      install: () => { installCalls++; return new Promise((_, fail) => { reject = fail; }); } } },
  }).UpdateDialog;
  let renderer;
  await act(async () => { renderer = create(React.createElement(Component, { open: true, onOpenChange: x => closes.push(x), updateInfo: { ...available(), state: 'downloaded' }, onCheck: async () => {} })); });
  const install = () => renderer.root.findAllByType('button').find(node => node.children.includes('Install now'));
  await act(async () => { install().props.onClick(); install().props.onClick(); await flush(); });
  assert.equal(installCalls, 1); assert.equal(renderer.root.findByType(Dialog).props.modal, true);
  assert.ok(renderer.root.findAllByType('button').every(node => node.props.disabled));
  let prevented = 0;
  renderer.root.findByType(Content).props.onEscapeKeyDown({ preventDefault() { prevented++; } });
  renderer.root.findByType(Content).props.onInteractOutside({ preventDefault() { prevented++; } });
  renderer.root.findByType(Dialog).props.onOpenChange(false);
  assert.equal(prevented, 2); assert.deepEqual(closes, []);
  await act(async () => { reject(Error('Finish recording before installing.')); await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /Finish recording/); assert.equal(install().props.disabled, false);
  await act(async () => renderer.unmount());
});
