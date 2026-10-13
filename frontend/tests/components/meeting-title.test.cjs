const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function compile(relative, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  const context = { exports: {}, require: name => imports[name] ?? require(name), ...globals };
  vm.runInNewContext(compiled.outputText, context);
  return context.exports;
}

function fixture() {
  const safety = compile('../../src/lib/update-safety.ts', {}, { window: { localStorage: { length: 0 } } });
  const { MeetingTitle } = compile('../../src/components/MeetingDetails/MeetingTitle.tsx', {
    '@/lib/update-safety': safety,
    'lucide-react': { Check: () => null, Pencil: () => null, X: () => null },
  }, { document: { activeElement: null }, requestAnimationFrame: callback => callback() });
  const f = { calls: [], state: null, gate: null, fail: false };
  const onStateChange = state => { f.state = state; };
  function Harness() {
    const [title, setTitle] = React.useState('Original title');
    return React.createElement(MeetingTitle, { title, onStateChange, onSave: async next => {
      f.calls.push(next);
      if (f.gate) await f.gate;
      if (f.fail) throw Error('Fictional disk error');
      setTitle(next);
    } });
  }
  act(() => { f.view = create(React.createElement(Harness), { createNodeMock: () => ({ focus() {}, select() {}, contains: () => false }) }); });
  f.button = label => f.view.root.findByProps({ 'aria-label': label });
  f.begin = () => act(() => f.button('Rename meeting title').props.onClick());
  f.fill = value => act(() => f.button('Meeting title').props.onChange({ target: { value } }));
  f.save = () => act(() => f.button('Save meeting title').props.onClick());
  f.install = safety.prepareForUpdateInstall;
  f.close = () => act(() => f.view.unmount());
  return f;
}

test('update flush saves the latest edited title and unregisters after success', async () => {
  const f = fixture();
  try {
    f.begin(); f.fill('first draft'); f.fill('  latest title  ');
    await act(async () => { await f.install(); });
    assert.deepEqual(f.calls, ['latest title']);
    assert.equal(f.button('Rename meeting title').findByType('span').children.join(''), 'latest title');
    await f.install();
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.dirty, false); assert.equal(f.state.saving, false);
  } finally { f.close(); }
});

test('update waits for an in-flight title save and repeated submit shares that save', async () => {
  const f = fixture();
  try {
    let release; f.gate = new Promise(resolve => { release = resolve; });
    f.begin(); f.fill('pending title'); f.save(); f.save();
    let ready = false;
    const installing = f.install().then(() => { ready = true; });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(f.calls, ['pending title']);
    assert.equal(ready, false); assert.equal(f.state.saving, true);
    await act(async () => { release(); await installing; });
    assert.equal(ready, true); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('failed title save keeps its draft and blocks installation until explicit retry succeeds', async () => {
  const f = fixture();
  try {
    f.fail = true; f.begin(); f.fill('retain this title');
    await act(async () => { await assert.rejects(f.install(), /Fictional disk error/); });
    assert.equal(f.button('Meeting title').props.value, 'retain this title');
    assert.equal(f.state.dirty, true);
    await assert.rejects(f.install(), /Title not saved/);
    assert.equal(f.calls.length, 1, 'Update does not silently retry a failed rename');
    f.fail = false;
    await act(async () => { f.save(); await f.install(); });
    assert.deepEqual(f.calls, ['retain this title', 'retain this title']);
    assert.equal(f.state.dirty, false);
  } finally { f.close(); }
});

test('empty draft blocks installation; Cancel and unmount remove the guard', async () => {
  const f = fixture();
  f.begin(); f.fill('  ');
  await act(async () => { await assert.rejects(f.install(), /Enter a meeting title/); });
  assert.deepEqual(f.calls, []);
  act(() => f.button('Cancel renaming').props.onClick());
  await f.install();
  f.begin(); f.fill('unsaved draft'); f.close();
  await f.install();
  assert.deepEqual(f.calls, []);
});
