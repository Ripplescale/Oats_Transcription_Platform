const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  const context = { exports: {}, require: name => overrides[name] ?? require(name) };
  vm.runInNewContext(compiled.outputText, context);
  return context.exports;
}

test('live bubbles render Roman fillers without changing the job or other Hindi', () => {
  const rich = load('lib/rich-notes.ts');
  const workspace = load('lib/transcript-workspace.ts', { './rich-notes': rich });
  const rows = [
    { id: 'mic', source_track: 'microphone', start_seconds: 0, end_seconds: 10, text: 'अम्म, अः — हम ठीक हैं।' },
    { id: 'sys', source_track: 'system', start_seconds: 0, end_seconds: 10, text: 'हम्म, हाँ जी। अम्मा आएँगी।' },
    { id: 'quiet-mic', source_track: 'microphone', start_seconds: 10, end_seconds: 20,
      text: 'UNWANTED microphone leakage', quality_flags: ['very_quiet_audio'] },
    { id: 'quiet-sys', source_track: 'system', start_seconds: 10, end_seconds: 20,
      text: 'KEEP quiet computer audio', quality_flags: ['very_quiet_audio'] },
  ];
  const state = { currentSession: 's', preferences: { profile: 'trelis-10' }, runs: [{
    capture: { session_id: 's' }, role: 'live-final', preferences: { profile: 'trelis-10', timing: 'during-recording' },
    job: { state: 'complete', segments: rows },
  }] };
  const before = JSON.stringify(state);
  const { LiveTranscriptPanel } = load('components/LiveTranscriptPanel.tsx', {
    'lucide-react': { AudioLines: () => null, Check: () => null, Mic: () => null, NotebookPen: () => null },
    '@/contexts/LocalWorkflowContext': { useLocalWorkflow: () => ({ state }) },
    '@/contexts/RecordingStateContext': { useRecordingState: () => ({ isRecording: false, isPaused: false }) },
    '@/lib/transcript-workspace': workspace,
    '@/lib/local-transcription-workflow': { profileChunkSeconds: () => 10, trelisProfile: x => x },
    '@/hooks/usePermissionCheck': { usePermissionCheck: () => ({ isChecking: true }) },
    '@/components/PermissionWarning': { PermissionWarning: () => null },
    '@/components/TranscriptProcessingChecks': { TranscriptProcessingChecks: () => null },
    '@/contexts/DisplayModeContext': { useDisplayMode: () => ({ isDev: false }), useDisplayModeScroll: () => ({ current: null }) },
  });
  const html = renderToStaticMarkup(React.createElement(LiveTranscriptPanel));
  assert.ok(html.includes('umm, uh — हम ठीक हैं।'));
  assert.ok(html.includes('hmm, हाँ जी। अम्मा आएँगी।'));
  assert.ok(!html.includes('अम्म,'));
  assert.ok(!html.includes('UNWANTED'));
  assert.ok(html.includes('KEEP quiet computer audio'));
  assert.equal(JSON.stringify(state), before);
});
