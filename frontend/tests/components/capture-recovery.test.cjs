const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), React = require('react');
const { create, act } = require('react-test-renderer');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function fixture() {
  const f = { calls: [], fail: false, listeners: {}, captures: [{ session_id: 'one', session_dir: 'C:/Synthetic/one', meeting_name: 'First call' }, { session_id: 'two', session_dir: 'C:/Synthetic/two', meeting_name: 'Second call' }] };
  const wrapper = ({ children, ...props }) => React.createElement('div', props, children);
  const mocks = { '@tauri-apps/api/core': { invoke: async (command, args) => { f.calls.push(command); return f.invokeOverride ? f.invokeOverride(command, args) : structuredClone(f.captures); } },
    'next/navigation': { useRouter: () => ({}) }, '@/components/Sidebar/SidebarProvider': { useSidebar: () => ({ refetchMeetings: async () => {} }) },
    '@/components/ui/button': { Button: props => React.createElement('button', props, props.children) },
    '@/components/ui/dialog': { Dialog: ({ open, children }) => open ? React.createElement('dialog', null, children) : null, DialogContent: wrapper, DialogDescription: wrapper, DialogFooter: wrapper, DialogTitle: wrapper },
    '@/contexts/LocalWorkflowContext': { useLocalWorkflow: () => ({ workflow: { deleteRecoveredAudio: async capture => { f.calls.push(['delete', capture.session_id]); if (f.fail) throw Error('Audio device is still releasing'); } } }) },
  };
  const scope = { exports: {}, require: name => mocks[name] ?? require(name), window: { addEventListener: (name, callback) => { f.listeners[name] = callback; }, removeEventListener: name => { delete f.listeners[name]; } } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../src/components/CaptureRecoveryPanel.tsx'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, scope);
  await act(async () => { f.view = create(React.createElement(scope.exports.CaptureRecoveryPanel)); await flush(); });
  f.buttons = name => f.view.root.findAllByType('button').filter(button => button.children.includes(name));
  f.click = async button => { await act(async () => { button.props.onClick(); await flush(); }); };
  f.close = async () => { await act(async () => f.view.unmount()); };
  return f;
}
test('recovery audio deletion requires confirmation and removes only the chosen item after success', async () => {
  const f = await fixture();
  try {
    await f.click(f.buttons('Delete saved audio')[0]);
    assert.equal(f.calls.length, 1);
    assert.match(JSON.stringify(f.view.toJSON()), /First call.*Notes and transcript text already saved/s);
    await f.click(f.buttons('Keep audio')[0]); assert.equal(f.calls.length, 1);
    await f.click(f.buttons('Delete saved audio')[0]);
    await f.click(f.view.root.findByType('dialog').findAllByType('button').find(button => button.children.includes('Delete saved audio')));
    assert.deepEqual(f.calls.at(-1), ['delete', 'one']);
    assert.doesNotMatch(JSON.stringify(f.view.toJSON()), /First call/);
    assert.match(JSON.stringify(f.view.toJSON()), /Second call/);
  } finally { await f.close(); }
});
test('failed deletion keeps its recovery item and error, and interrupted capture refreshes the list', async () => {
  const f = await fixture(); f.fail = true;
  try {
    await f.click(f.buttons('Delete saved audio')[0]);
    await f.click(f.view.root.findByType('dialog').findAllByType('button').find(button => button.children.includes('Delete saved audio')));
    assert.match(JSON.stringify(f.view.toJSON()), /Audio device is still releasing/);
    assert.match(JSON.stringify(f.view.toJSON()), /First call/);
    await act(async () => { f.listeners['xx-capture-interrupted'](); await flush(); });
    assert.equal(f.calls.filter(call => call === 'list_recoverable_captures').length, 3);
  } finally { await f.close(); }
  assert.deepEqual(Object.keys(f.listeners), []);
});

test('partially deleted audio offers retry deletion without attempting recovery', async () => {
  const f = await fixture();
  try {
    f.fail = true; f.captures[0].audio_removal_pending = true;
    await f.click(f.buttons('Delete saved audio')[0]);
    await f.click(f.view.root.findByType('dialog').findAllByType('button').find(button => button.children.includes('Delete saved audio')));
    assert.equal(f.buttons('Retry deleting audio').length, 1);
    assert.equal(f.buttons('Recover saved audio').length, 1); // only the unaffected entry
    assert.equal(f.calls.includes('recover_local_capture'), false);
  } finally { await f.close(); }
});

test('a stale list response cannot restore an entry deleted while the list was pending', async () => {
  const f = await fixture();
  try {
    let release;
    const stale = structuredClone(f.captures);
    f.invokeOverride = command => command === 'list_recoverable_captures' ? new Promise(resolve => { release = resolve; }) : null;
    await act(async () => { f.listeners['xx-capture-interrupted'](); await flush(); });
    await f.click(f.buttons('Delete saved audio')[0]);
    await f.click(f.view.root.findByType('dialog').findAllByType('button').find(button => button.children.includes('Delete saved audio')));
    await act(async () => { release(stale); await flush(); });
    assert.doesNotMatch(JSON.stringify(f.view.toJSON()), /First call/);
    assert.match(JSON.stringify(f.view.toJSON()), /Second call/);
  } finally { await f.close(); }
});

test('a recovery retry rechecks source audio after an earlier database-link failure', async () => {
  const f = await fixture();
  try {
    let verifications = 0, links = 0;
    f.invokeOverride = command => {
      if (command === 'list_recoverable_captures') return structuredClone(f.captures);
      if (command === 'recover_local_capture') {
        if (++verifications > 1) throw Error('Source checksum changed');
        return { capture: f.captures[0], verification: { verified: true }, meeting_name: 'First call' };
      }
      if (command === 'ensure_capture_meeting') { links++; throw Error('Database link failed'); }
    };
    await f.click(f.buttons('Recover saved audio')[0]);
    await f.click(f.buttons('Recover saved audio')[0]);
    assert.equal(verifications, 2); assert.equal(links, 1);
    assert.match(JSON.stringify(f.view.toJSON()), /Source checksum changed/);
  } finally { await f.close(); }
});
