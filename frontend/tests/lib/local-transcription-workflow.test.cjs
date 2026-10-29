const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/lib/local-transcription-workflow.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
const context = { exports: {}, require };
vm.runInNewContext(compiled.outputText, context);
const { LocalWorkflow, readPreferences, pathKey, profileLabel } = context.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const capture = { session_id: 'session-one', session_dir: 'C:\\STTApp\\recordings\\one' };
const second = { session_id: 'session-two', session_dir: 'C:\\STTApp\\recordings\\two' };
const third = { session_id: 'session-three', session_dir: 'C:\\STTApp\\recordings\\three' };
const segment = (id = 'synthetic-one', text = 'मीरा ने seven notebooks कहा') => ({ id, text, source_track: 'system', start_seconds: 0, end_seconds: 20 });

test('same-count context recovery revision reimports the selected text and survives reload', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture);
  const live = f.live();
  f.status(live, { segments: [segment('provisional', 'जब '.repeat(12).trim())], segments_revision: 1 });
  await f.workflow.tick();
  const imported = f.count('import_local_transcription');
  const recovered = { ...segment('context-recovery', 'हाँ, seven notebooks and coloured pencils for the workshop.'), end_seconds: 30, replaces_segment_ids: ['provisional'] };
  f.status(live, { segments: [recovered], segments_revision: 2 });
  await f.workflow.tick();
  assert.equal(f.count('import_local_transcription'), imported + 1);
  assert.equal(live.importedCount, 1); assert.equal(live.importedRevision, 2);
  assert.equal(live.job.segments[0].text, recovered.text);
  await f.workflow.tick();
  assert.equal(f.count('import_local_transcription'), imported + 1, 'unchanged revision is not imported repeatedly');
  f.reload(); await f.workflow.refreshAfterReload(capture);
  assert.equal(f.live().importedRevision, 2);
  assert.equal(f.count('import_local_transcription'), imported + 1, 'reload retains the imported revision pointer');
  f.status(f.live(), { segments: [{ ...recovered, text: 'हाँ, checked workshop details.' }], segments_revision: 3 });
  f.failImport(f.live()); await f.workflow.tick();
  assert.equal(f.live().importedRevision, 2, 'failed import does not advance the pointer');
  f.failImport(f.live(), false); await f.workflow.tick();
  assert.equal(f.live().importedRevision, 3);
});

function fixture(previous) {
  const calls = [], imports = [], stops = [], jobs = new Map(), speakers = new Map(), meetings = new Map(), bindings = new Map();
  const importFailures = new Set(), startFailures = new Set();
  let nextJob = 0, nextSpeaker = 0, stopFailures = 0, speakersEnabled = false, startGate, speakerStartGate, deletionGate, deletionError, profileGate, runtimeTiming='during-recording';
  const dependencies = {
    invoke: async (command, args = {}) => {
      calls.push({ command, args: clone(args) });
      if (command === 'get_local_stt_profiles') {
        if (profileGate) await profileGate;
        return ['trelis-5','trelis-10','trelis-20'].map(id=>({id,recommended_timing:runtimeTiming}));
      }
      if (command === 'api_delete_meeting') {
        if (deletionGate) await deletionGate;
        if (deletionError) throw new Error(deletionError);
        // Native deletion stops only workers belonging to this source meeting.
        for (const run of result.workflow.state.runs.filter(run => run.meetingId === args.meetingId || run.transcriptMeetingId === args.meetingId)) {
          if (run.job) jobs.get(run.job.job_id).state = 'stopped';
        }
        return { status: 'success' };
      }
      if (command === 'delete_recoverable_capture') {
        if (deletionGate) await deletionGate;
        if (deletionError) throw new Error(deletionError);
        return { status: 'deleted' };
      }
      if (command === 'ensure_capture_meeting') {
        const key = pathKey(args.sessionDir);
        if (!meetings.has(key)) meetings.set(key, `meeting-${meetings.size + 1}`);
        return { meeting_id: meetings.get(key) };
      }
      if (command === 'start_local_transcription') {
        if (startFailures.has(args.workflowRole)) throw new Error('synthetic model unavailable');
        let job = args.workflowRole && [...jobs.values()].find(item => item.session_dir === args.sessionDir && item.workflow_role === args.workflowRole);
        if (!job) {
          job = { job_id: `job-${++nextJob}`, session_dir: args.sessionDir, profile: args.profile, final_profile: args.finalProfile, workflow_role: args.workflowRole, state: 'running', segments: [] };
          jobs.set(job.job_id, job);
        }
        if (startGate) await startGate;
        return clone(job);
      }
      if (command === 'get_local_transcription_status') {
        assert.ok(jobs.has(args.jobId), `unknown synthetic job ${args.jobId}`);
        return clone(jobs.get(args.jobId));
      }
      if (command === 'list_local_transcription_jobs') return clone([...jobs.values()].filter(job => pathKey(job.session_dir) === pathKey(args.sessionDir)));
      if (command === 'stop_local_transcription') {
        if (stopFailures > 0) { stopFailures--; throw new Error('synthetic stop request failed'); }
        // Acknowledgment deliberately does not change status: Python may still be saving/exiting.
        return { job_id: args.jobId, state: 'stop_requested' };
      }
      if (command === 'resume_local_transcription') {
        const job = jobs.get(args.jobId); assert.ok(['failed', 'stopped'].includes(job.state));
        job.state = 'running'; return { job_id: args.jobId, state: 'running' };
      }
      if (command === 'import_local_transcription') {
        if (importFailures.has(args.jobId)) throw new Error('synthetic import failure');
        const id = args.primary ? args.meetingId : `meeting-local-${args.jobId}`;
        assert.ok(!bindings.has(id) || bindings.get(id) === args.jobId, 'a new job must not overwrite an occupied workspace');
        bindings.set(id, args.jobId);
        return { meeting_id: id };
      }
      if (command === 'get_speaker_setup_status') return { available: speakersEnabled, enabled: speakersEnabled };
      if (command === 'start_speaker_identification') {
        const job = { job_id: `speaker-${++nextSpeaker}`, state: 'diarizing', transcriptionJobId: args.transcriptionJobId };
        speakers.set(job.job_id, job);
        if (speakerStartGate) await speakerStartGate;
        return clone(job);
      }
      if (command === 'get_speaker_job_status') return clone(speakers.get(args.jobId));
      if (command === 'retry_speaker_identification') { speakers.get(args.jobId).state = 'diarizing'; return clone(speakers.get(args.jobId)); }
      throw new Error(command);
    },
    changed: () => {}, imported: id => imports.push(id), stopped: (id, error) => stops.push({ id, error }),
  };
  const result = {
    workflow: new LocalWorkflow(dependencies, previous), calls, imports, stops, jobs, speakers, meetings, bindings,
    startLegacyCapture: async (session) => {
      if (!result.runs(session).length) for (const role of ['live-draft', 'final']) result.workflow.state.runs.push({
        capture: session, role, primary: role === 'final', recording: false,
        preferences: { profile: role === 'final' ? 'trelis-20' : 'apex-20', timing: role === 'final' ? 'after-recording' : 'during-recording', languageMode: 'hinglish' },
      });
      return result.workflow.captureStarted(session);
    },
    live: (session = capture) => result.runs(session).find(run => run.role === 'live-final'),
    fallback: (session = capture) => result.runs(session).find(run => run.role === 'fallback'),
    count: command => calls.filter(call => call.command === command).length,
    runs: (session = capture) => result.workflow.state.runs.filter(run => run.capture.session_id === session.session_id),
    draft: (session = capture) => result.runs(session).find(run => run.role === 'live-draft'),
    final: (session = capture) => result.runs(session).find(run => run.role === 'final'),
    status: (run, values) => Object.assign(jobs.get(run.job.job_id), clone(values)),
    failImport: (run, fail = true) => fail ? importFailures.add(run.job.job_id) : importFailures.delete(run.job.job_id),
    failStart: (role, fail = true) => fail ? startFailures.add(role) : startFailures.delete(role), failStops: count => { stopFailures = count; },
    enableSpeakers: () => { speakersEnabled = true; result.workflow.state.speakerSetup = undefined; },
    gateStarts: promise => { startGate = promise; },
    gateSpeakerStarts: promise => { speakerStartGate = promise; },
    gateDeletion: promise => { deletionGate = promise; },
    failDeletion: error => { deletionError = error; },
    gateProfiles: (promise,timing='after-recording') => {profileGate=promise;runtimeTiming=timing;},
    reload: () => {
      const saved = clone(result.workflow.state);
      for (const run of saved.runs) if (run.job) delete run.job.segments;
      result.workflow = new LocalWorkflow(dependencies, saved); return result.workflow;
    },
  };
  return result;
}
test('an exited job with an unreadable checkpoint does not block the next saved recording', async () => {
  const f = fixture();
  await f.workflow.captureStarted(capture);
  await f.workflow.captureStopped(capture);
  await f.workflow.captureStarted(second);
  await f.workflow.captureStopped(second);
  assert.equal(f.count('start_local_transcription'), 1);
  const old = f.live();
  // Reload removes checkpoint text, as the real provider does. Native status
  // reports the verified worker exit without inventing replacement segments.
  delete f.jobs.get(old.job.job_id).segments;
  f.status(old, { state: 'failed', checkpoint_unreadable: true,
    error: 'The saved progress file is unreadable. Audio is retained.' });
  const importsBefore = f.count('import_local_transcription');
  f.reload();
  await f.workflow.refreshAfterReload(null);
  assert.equal(f.live().job.state, 'failed');
  assert.equal(f.live(second).job.state, 'running');
  assert.equal(f.count('start_local_transcription'), 2);
  assert.equal(f.count('import_local_transcription'), importsBefore,
    'an unreadable checkpoint cannot replace an existing transcript');
});

test('deleting a postcall conversation waits for native stop and removes its queue before the next start', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  await f.workflow.captureStarted(second); await f.workflow.captureStopped(second);
  const old=f.live(); assert.ok(old.job); assert.equal(f.live(second).job,undefined);
  let release; f.gateDeletion(new Promise(resolve=>{release=resolve;}));
  const deleting=f.workflow.deleteMeeting(old.meetingId);
  for(let i=0;i<8;i++) await Promise.resolve();
  const imports=f.count('import_local_transcription');
  await f.workflow.tick();
  assert.equal(f.count('import_local_transcription'),imports,'polls cannot race the deletion transaction');
  assert.ok(f.live(),'run stays recoverable until deletion succeeds');
  release(); await deleting;
  assert.equal(f.live(),undefined);
  await f.workflow.tick();
  assert.equal(f.live(second).job.state,'running');
});

test('failed conversation deletion retains paused recoverable runs and recording cannot be deleted', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture);
  await assert.rejects(f.workflow.deleteMeeting(f.live().meetingId),/Finish recording/);
  assert.equal(f.count('api_delete_meeting'),0);
  await f.workflow.captureStopped(capture); f.failDeletion('worker still exiting');
  await assert.rejects(f.workflow.deleteMeeting(f.live().meetingId),/worker still exiting/);
  assert.ok(f.live().job); assert.equal(f.live().pausedByUser,true);
  assert.equal(f.live().resumeRequested,false);
});

test('capture interruption pauses its worker and requires audio recovery without announcing saved completion', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture); const live=f.live();
  const stopped=f.stops.length;
  await f.workflow.captureInterrupted(capture,'Device disconnected');
  assert.equal(live.recording,false); assert.equal(live.needsRecovery,true);
  assert.match(live.error,/Recover its saved audio/);
  assert.equal(f.workflow.state.currentSession,undefined);
  assert.equal(f.count('stop_local_transcription'),1);
  assert.equal(f.stops.length,stopped,'failure is not a saved recording event');
  f.status(live,{state:'stopped'}); await f.workflow.tick();
  assert.equal(f.count('start_local_transcription'),1,'recovery must precede any new transcript pass');
});

test('recovery audio deletion removes only its workflow pointers after native success', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture); await f.workflow.captureInterrupted(capture,'test capture failure');
  await f.workflow.captureStarted(second); await f.workflow.captureStopped(second);
  let release; f.gateDeletion(new Promise(resolve=>{release=resolve;}));
  const deleting=f.workflow.deleteRecoveredAudio(capture);
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.ok(f.live(),'workflow pointer remains until native audio deletion completes');
  const imports=f.count('import_local_transcription'); await f.workflow.tick();
  assert.equal(f.count('import_local_transcription'),imports);
  release(); await deleting;
  assert.equal(f.live(),undefined); assert.ok(f.live(second));
  assert.equal(f.count('api_delete_meeting'),0,'audio removal never deletes notes/transcript database rows');
  assert.equal(f.count('delete_recoverable_capture'),1);
});

test('failed recovery audio deletion retains the capture and still permits later polling', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture);
  await assert.rejects(f.workflow.deleteRecoveredAudio(capture),/Finish recording/);
  assert.equal(f.count('delete_recoverable_capture'),0);
  await f.workflow.captureInterrupted(capture,'device lost'); f.failDeletion('audio busy');
  await assert.rejects(f.workflow.deleteRecoveredAudio(capture),/audio busy/);
  assert.equal(f.live().needsRecovery,true); assert.equal(f.live().pausedByUser,true);
  await f.workflow.tick();
});

test('CPU runtime records first and starts its same Trelis transcript only after capture finishes', async () => {
  const f=fixture(); f.workflow.configureProfiles([{id:'trelis-10',recommended_timing:'after-recording'}]);
  await f.workflow.captureStarted(capture);
  assert.equal(f.live().preferences.timing,'after-recording');
  assert.equal(f.live().job,undefined); assert.equal(f.count('start_local_transcription'),0);
  await f.workflow.captureStopped(capture);
  assert.equal(f.live().job.state,'running'); assert.equal(f.live().role,'live-final');
  assert.equal(f.count('start_local_transcription'),1); assert.equal(f.workflow.state.runs.length,1);
});

test('an early capture start waits for runtime timing inspection before creating or launching a run', async () => {
  const f=fixture(); let release; f.gateProfiles(new Promise(resolve=>{release=resolve;}));
  const started=f.workflow.captureStarted(capture);
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(f.workflow.state.runs.length,0); assert.equal(f.count('start_local_transcription'),0);
  release(); await started;
  assert.equal(f.live().preferences.timing,'after-recording'); assert.equal(f.live().job,undefined);
  await f.workflow.captureStopped(capture);
  assert.equal(f.live().job.state,'running'); assert.equal(f.count('get_local_stt_profiles'),1);
});

test('runtime timing changes affect future captures without rewriting active job preferences', async () => {
  const f=fixture(); await f.workflow.captureStarted(capture); const old=f.live();
  f.workflow.configureProfiles([{id:'trelis-10',recommended_timing:'after-recording'}]);
  assert.equal(old.preferences.timing,'during-recording');
  await f.workflow.captureStopped(capture); f.status(old,{state:'complete'}); await f.workflow.tick();
  await f.workflow.captureStarted(second);
  assert.equal(f.live(second).preferences.timing,'after-recording'); assert.equal(f.live(second).job,undefined);
});

async function finishDraft(f, values = {}) {
  f.status(f.draft(), { state: 'stopped', ...values }); await f.workflow.tick();
}
async function startFinal(f) {
  await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture); await finishDraft(f);
  assert.ok(f.final().job); return f.final();
}

test('new recording defaults migrate profile/timing while preserving language and legacy run settings', () => {
  const preferences = readPreferences({ profile: 'trelis-15', timing: 'after-recording', languageMode: 'english' });
  assert.equal(preferences.profile, 'trelis-10'); assert.equal(preferences.timing, 'during-recording'); assert.equal(preferences.languageMode, 'english');
  assert.equal(pathKey('\\\\?\\C:\\STTApp\\recordings\\one'), pathKey(capture.session_dir));
  const old = { capture, recording: false, primary: true, preferences: { profile: 'trelis-20', timing: 'after-recording', languageMode: 'hinglish' } };
  const f = fixture({ preferences, runs: [old] });
  assert.equal(f.workflow.state.runs[0].preferences.profile, 'trelis-20'); assert.equal(f.workflow.state.runs[0].role, undefined);
});

test('existing dual-pass capture keeps one base meeting and distinct draft/final records', async () => {
  const f = fixture(); await f.startLegacyCapture(capture);
  assert.equal(f.runs().length, 2); assert.equal(f.count('ensure_capture_meeting'), 1); assert.equal(f.count('start_local_transcription'), 1);
  assert.equal(f.draft().preferences.profile, 'apex-20'); assert.equal(f.draft().primary, false);
  assert.equal(f.final().preferences.profile, 'trelis-20'); assert.equal(f.final().primary, true);
  assert.equal(f.final().job, undefined); assert.equal(f.final().recording, true);
  assert.equal(f.draft().meetingId, f.final().meetingId);
  assert.equal(f.calls.find(call => call.command === 'start_local_transcription').args.workflowRole, 'live-draft');
});

test('duplicate events request one graceful handoff, import the final draft checkpoint, then start distinct Final', async () => {
  const f = fixture(); await Promise.all([f.startLegacyCapture(capture), f.startLegacyCapture(capture)]);
  const raw = segment(); f.status(f.draft(), { segments: [raw] }); await f.workflow.tick();
  const draftId = f.draft().job.job_id, childId = f.draft().transcriptMeetingId;
  await Promise.all([f.workflow.captureStopped(capture), f.workflow.captureStopped(capture)]);
  assert.equal(f.count('stop_local_transcription'), 1); assert.equal(f.count('start_local_transcription'), 1);
  assert.equal(f.stops.length, 1); assert.equal(f.stops[0].id, f.final().meetingId); assert.notEqual(f.stops[0].id, childId);
  assert.equal(f.draft().job.state, 'running'); assert.equal(f.draft().recording, false); assert.equal(f.final().recording, false);
  await finishDraft(f, { segments: [raw, segment('synthetic-tail', 'The workshop is ready.')] });
  assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.final().job.profile, 'trelis-20');
  assert.notEqual(f.final().job.job_id, draftId); assert.equal(f.draft().job.job_id, draftId); assert.equal(f.draft().job.segments[0].text, raw.text);
  const importAt = f.calls.findLastIndex(call => call.command === 'import_local_transcription' && call.args.jobId === draftId);
  const finalAt = f.calls.findIndex(call => call.command === 'start_local_transcription' && call.args.workflowRole === 'final');
  assert.ok(importAt < finalAt); assert.equal(f.draft().importedCount, 2); assert.equal(f.draft().importedState, 'stopped');
  f.status(f.final(), { segments: [segment('final-own-id', 'मीरा ने सात notebooks कहे')] }); await f.workflow.tick();
  assert.equal(f.final().transcriptMeetingId, f.final().meetingId); assert.notEqual(f.final().transcriptMeetingId, childId);
  await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  assert.equal(f.runs().length, 2); assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.stops.length, 1);
});

test('a terminal checkpoint masked as running does not release the model slot early', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  f.status(f.draft(), { state: 'running', checkpoint_state: 'stopped' }); await f.workflow.tick();
  assert.equal(f.final().job, undefined);
  await finishDraft(f); assert.ok(f.final().job);
});

test('failed draft import blocks handoff and explicit retry repairs import without resuming Apex', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  f.failImport(f.draft()); await finishDraft(f, { segments: [segment()] });
  assert.equal(f.final().job, undefined); assert.match(f.draft().error, /import failure/);
  await f.workflow.tick(); assert.equal(f.final().job, undefined);
  f.failImport(f.draft(), false); await f.workflow.retry(f.draft());
  assert.ok(f.final().job); assert.equal(f.count('resume_local_transcription'), 0);
});

test('Apex start failure never blocks saved capture or the Final stage', async () => {
  const f = fixture(); f.failStart('live-draft'); await f.startLegacyCapture(capture);
  assert.equal(f.draft().recording, true); assert.match(f.draft().error, /unavailable/);
  await f.workflow.captureStopped(capture);
  assert.equal(f.draft().draftSkipped, true); assert.equal(f.draft().job, undefined); assert.ok(f.final().job);
  assert.equal(f.final().job.profile, 'trelis-20'); assert.equal(f.stops.length, 1);
});

test('failed Apex with an empty saved checkpoint can hand off to Final', async () => {
  const f = fixture(); await f.startLegacyCapture(capture);
  f.status(f.draft(), { state: 'failed', segments: [], error: 'synthetic decoder failure' });
  await f.workflow.captureStopped(capture);
  assert.equal(f.draft().importedState, 'failed'); assert.equal(f.draft().importedCount, 0); assert.ok(f.final().job);
});

test('an eligible Final gets the free worker before another unstarted live Draft', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  await f.startLegacyCapture(second); assert.equal(f.draft(second).job, undefined);
  await finishDraft(f);
  assert.ok(f.final().job); assert.equal(f.draft(second).job, undefined);
  assert.equal(f.calls.filter(call => call.command === 'start_local_transcription')[1].args.workflowRole, 'final');
});

test('missed live Draft stays visibly skipped after stop and is never backfilled', async () => {
  const f = fixture(); await startFinal(f); await f.startLegacyCapture(second); await f.workflow.captureStopped(second);
  assert.equal(f.draft(second).draftSkipped, true); assert.equal(f.draft(second).job, undefined);
  await f.startLegacyCapture(third);
  f.status(f.final(), { state: 'complete' }); await f.workflow.tick();
  assert.ok(f.final(second).job); assert.equal(f.draft(second).job, undefined); assert.equal(f.draft(third).job, undefined);
  assert.ok(!f.calls.some(call => call.command === 'start_local_transcription' && call.args.sessionDir === second.session_dir && call.args.workflowRole === 'live-draft'));
});

test('user pause during capture persists without resuming Draft, and Final still runs after stop', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.stopWorker(f.draft());
  await finishDraft(f); await f.workflow.tick();
  assert.equal(f.draft().pausedByUser, true); assert.equal(f.draft().recording, true); assert.equal(f.final().job, undefined);
  assert.equal(f.count('resume_local_transcription'), 0); assert.equal(f.count('stop_recording'), 0);
  await f.workflow.captureStopped(capture); assert.ok(f.final().job);
});

test('pausing a queued Final persists across reload until explicit Retry', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.stopWorker(f.final());
  await f.workflow.captureStopped(capture); await finishDraft(f);
  assert.equal(f.final().job, undefined); assert.equal(f.final().pausedByUser, true);
  f.reload(); await f.workflow.refreshAfterReload(null); assert.equal(f.final().job, undefined);
  await f.workflow.retry(f.final()); assert.ok(f.final().job); assert.equal(f.count('resume_local_transcription'), 0);
});

test('paused Final does not resume automatically after reload; Retry uses the same job', async () => {
  const f = fixture(); const final = await startFinal(f); const id = final.job.job_id;
  await f.workflow.stopWorker(final); f.status(final, { state: 'stopped' }); await f.workflow.tick();
  f.reload(); await f.workflow.refreshAfterReload(null);
  assert.equal(f.final().pausedByUser, true); assert.equal(f.count('resume_local_transcription'), 0);
  await f.workflow.retry(f.final()); assert.equal(f.count('resume_local_transcription'), 1); assert.equal(f.final().job.job_id, id);
});

test('failed Final requires explicit retry and preserves its identity', async () => {
  const f = fixture(); const final = await startFinal(f); const id = final.job.job_id;
  f.status(final, { state: 'failed', error: 'synthetic inference failure' }); await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.count('resume_local_transcription'), 0);
  await f.workflow.retry(final); assert.equal(f.count('resume_local_transcription'), 1); assert.equal(final.job.job_id, id);
});

test('a duplicate stop cannot clear a failed Final start and silently retry it', async () => {
  const f = fixture(); f.failStart('final');
  await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture); await finishDraft(f);
  assert.equal(f.final().job, undefined); assert.match(f.final().error, /unavailable/);
  const attempts = () => f.calls.filter(call => call.command === 'start_local_transcription' && call.args.workflowRole === 'final').length;
  await f.workflow.captureStopped(capture); await f.workflow.tick(); assert.equal(attempts(), 1);
  f.failStart('final', false); await f.workflow.retry(f.final()); assert.equal(attempts(), 2); assert.ok(f.final().job);
});

test('reload during handoff hydrates saved text and does not repeat stop or start', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  f.status(f.draft(), { state: 'stopped', segments: [segment()] }); f.reload(); await f.workflow.refreshAfterReload(null);
  assert.equal(f.count('stop_local_transcription'), 1); assert.equal(f.count('start_local_transcription'), 2);
  assert.equal(f.draft().job.segments.length, 1); assert.ok(f.final().job);
  await f.workflow.captureStopped(capture); assert.equal(f.stops.length, 1); assert.equal(f.count('start_local_transcription'), 2);
});

test('interrupted capture requires audio recovery before automatic Final', async () => {
  const f = fixture(); await f.startLegacyCapture(capture);
  f.status(f.draft(), { state: 'failed', error: 'parent restarted' }); f.reload(); await f.workflow.refreshAfterReload(null);
  assert.ok(f.runs().every(run => run.needsRecovery)); assert.equal(f.final().job, undefined);
  await f.workflow.captureStopped(capture);
  assert.ok(f.runs().every(run => !run.needsRecovery)); assert.ok(f.final().job);
});

test('missing browser pointers rediscover native role jobs without starting or resuming a duplicate', async () => {
  const f = fixture(); await f.startLegacyCapture(capture);
  const id = f.draft().job.job_id;
  f.status(f.draft(), { state: 'stopped', segments: [segment()] });
  f.workflow.state.runs = []; await f.workflow.refreshAfterReload(capture);
  assert.equal(f.runs().length, 2); assert.equal(f.draft().job.job_id, id);
  assert.equal(f.count('start_local_transcription'), 1); assert.equal(f.count('resume_local_transcription'), 0);
  assert.equal(f.final().job, undefined);
});

test('native legacy jobs stay roleless when browser pointers are missing', async () => {
  const f = fixture(); const job = { job_id: 'old-native-job', session_dir: capture.session_dir, profile: 'apex-20', state: 'stopped', segments: [segment()] };
  f.jobs.set(job.job_id, job); await f.workflow.refreshAfterReload(capture);
  assert.equal(f.runs().length, 1); assert.equal(f.runs()[0].role, undefined);
  assert.equal(f.count('start_local_transcription'), 0); assert.equal(f.count('resume_local_transcription'), 0);
  await f.workflow.captureStopped(capture); assert.equal(f.runs().length, 1); assert.equal(f.count('start_local_transcription'), 0);
});

test('failed graceful stop remains visible, is not flooded, and can be retried once explicitly', async () => {
  const f = fixture(); await f.startLegacyCapture(capture); f.failStops(1); await f.workflow.captureStopped(capture);
  f.status(f.draft(), { segments: [segment()] }); await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.count('stop_local_transcription'), 1); assert.match(f.draft().error, /stop request failed/); assert.equal(f.final().job, undefined);
  await f.workflow.retry(f.draft()); assert.equal(f.count('stop_local_transcription'), 2);
  await finishDraft(f); assert.ok(f.final().job);
});

test('speakers run only for completed Final, never Draft, and failed speakers do not loop', async () => {
  const f = fixture(); f.enableSpeakers(); await f.startLegacyCapture(capture);
  f.status(f.draft(), { state: 'complete', segments: [segment()] }); await f.workflow.captureStopped(capture);
  assert.equal(f.count('start_speaker_identification'), 0);
  f.status(f.final(), { state: 'complete', segments: [segment('final-segment')] }); await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 1);
  const speakerCall = f.calls.find(call => call.command === 'start_speaker_identification');
  assert.equal(speakerCall.args.transcriptionJobId, f.final().job.job_id);
  f.speakers.get(f.final().speakerJob.job_id).state = 'failed'; await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 1);
});

test('stopping while native start is in flight never mistakes the started Draft for skipped', async () => {
  const f = fixture(); let release; f.gateStarts(new Promise(resolve => { release = resolve; }));
  const started = f.startLegacyCapture(capture);
  for (let i = 0; i < 20 && !f.count('start_local_transcription'); i++) await Promise.resolve();
  assert.equal(f.count('start_local_transcription'), 1);
  await f.workflow.captureStopped(capture); assert.notEqual(f.draft().draftSkipped, true); assert.equal(f.final().job, undefined);
  release(); await started; f.gateStarts(undefined); await f.workflow.tick();
  assert.ok(f.draft().job); assert.equal(f.count('stop_local_transcription'), 1); assert.equal(f.final().job, undefined);
  await finishDraft(f); assert.ok(f.final().job);
});

test('legacy roleless captures remain single-model and never gain an automatic Final', async () => {
  const oldPreferences = { profile: 'apex-20', languageMode: 'english', timing: 'during-recording' };
  const legacy = { capture, meetingId: 'legacy-meeting', recording: true, primary: true, preferences: oldPreferences };
  const f = fixture({ runs: [legacy] }); await f.startLegacyCapture(capture); await f.workflow.captureStopped(capture);
  assert.equal(f.runs().length, 1); assert.equal(f.runs()[0].role, undefined); assert.equal(f.runs()[0].preferences.languageMode, 'english');
  assert.equal(f.count('start_local_transcription'), 1); assert.equal(f.count('stop_local_transcription'), 0);
  assert.equal(f.calls.find(call => call.command === 'start_local_transcription').args.workflowRole, undefined);
});

test('manual reruns retain the selected model and separate workspace without creating a pair', async () => {
  const f = fixture();
  const job = { job_id: 'manual-job', session_dir: capture.session_dir, profile: 'trelis-20', state: 'complete', segments: [segment()] };
  f.jobs.set(job.job_id, job); await f.workflow.adopt(job, 'base-meeting', false);
  const run = f.workflow.state.runs[0];
  assert.equal(run.role, undefined); assert.equal(run.preferences.profile, 'trelis-20'); assert.equal(run.transcriptMeetingId, 'meeting-local-manual-job');
  assert.equal(f.workflow.state.runs.length, 1); assert.equal(f.count('start_local_transcription'), 0);
});

test('manual versions cannot hijack a paired capture when a duplicate stop arrives', async () => {
  const f = fixture(); await startFinal(f);
  f.status(f.final(), { state: 'complete' }); await f.workflow.tick();
  const manual = { job_id: 'manual-copy', session_dir: capture.session_dir, capture_session_id: capture.session_id,
    profile: 'apex-20', state: 'complete', segments: [segment('manual-segment')] };
  f.jobs.set(manual.job_id, manual); await f.workflow.adopt(manual, f.final().meetingId, false);
  await f.workflow.captureStopped(capture);
  assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.stops.length, 1);
  assert.equal(f.draft().captureEnded, true); assert.equal(f.final().captureEnded, true);
  assert.equal(f.workflow.state.runs.find(run => run.job?.job_id === manual.job_id).role, undefined);
});

test('new calls start a single primary Trelis live job and drain that same job after stop', async () => {
  const f = fixture(); await Promise.all([f.workflow.captureStarted(capture), f.workflow.captureStarted(capture)]);
  assert.equal(f.runs().length, 1); const live = f.live(), id = live.job.job_id;
  assert.equal(live.primary, true); assert.equal(live.preferences.profile, 'trelis-10');
  assert.equal(live.preferences.timing, 'during-recording'); assert.equal(f.count('start_local_transcription'), 1);
  f.status(live, { segments: [segment()] }); await f.workflow.tick();
  assert.equal(live.transcriptMeetingId, live.meetingId);
  await Promise.all([f.workflow.captureStopped(capture), f.workflow.captureStopped(capture)]);
  assert.equal(f.count('stop_local_transcription'), 0); assert.equal(f.count('start_local_transcription'), 1);
  assert.equal(live.job.job_id, id); assert.equal(live.recording, false); assert.equal(f.stops.length, 1);
  f.status(live, { state: 'complete', segments: [segment(), segment('tail')] }); await f.workflow.tick();
  await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  assert.equal(live.recording, false); assert.equal(live.importedCount, 2); assert.equal(f.runs().length, 1);
  assert.equal(f.count('start_local_transcription'), 1);
});

test('a missed start event still creates only Trelis and processes saved audio once', async () => {
  const f = fixture(); await f.workflow.captureStopped(capture);
  assert.equal(f.runs().length, 1); assert.equal(f.live().recording, false);
  assert.equal(f.live().job.workflow_role, 'live-final'); assert.equal(f.count('stop_local_transcription'), 0);
});

test('fallback waits for actual Trelis exit and final checkpoint import, then creates a child version', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); const live = f.live();
  f.status(live, { segments: [segment()] }); await f.workflow.tick();
  const primaryId = live.transcriptMeetingId;
  await Promise.all([f.workflow.useApexFallback(live), f.workflow.useApexFallback(live)]);
  assert.equal(f.runs().length, 2); assert.equal(f.count('stop_local_transcription'), 1);
  assert.equal(f.fallback().job, undefined); assert.equal(live.pausedByUser, true);
  f.status(live, { state: 'running', checkpoint_state: 'stopped', segments: [segment(), segment('tail')] }); await f.workflow.tick();
  assert.equal(f.fallback().job, undefined);
  f.failImport(live); f.status(live, { state: 'stopped' }); await f.workflow.tick();
  assert.equal(f.fallback().job, undefined); f.failImport(live, false); await f.workflow.tick();
  assert.equal(f.fallback().job.workflow_role, 'fallback'); assert.equal(f.fallback().primary, false);
  f.status(f.fallback(), { segments: [segment('apex-own-id', 'Mira said seven notebooks.')] }); await f.workflow.tick();
  assert.notEqual(f.fallback().transcriptMeetingId, primaryId);
  assert.equal(live.transcriptMeetingId, primaryId); assert.equal(live.job.segments[0].text, segment().text);
  assert.equal(f.bindings.get(primaryId), live.job.job_id);
  const imported = f.calls.findLastIndex(call => call.command === 'import_local_transcription' && call.args.jobId === live.job.job_id);
  const started = f.calls.findIndex(call => call.command === 'start_local_transcription' && call.args.workflowRole === 'fallback');
  assert.ok(imported < started);
});

test('Trelis start failure leaves recording intact and permits explicit fallback without a Trelis job', async () => {
  const f = fixture(); f.failStart('live-final'); await f.workflow.captureStarted(capture);
  assert.equal(f.live().job, undefined); assert.equal(f.live().recording, true);
  await f.workflow.tick(); assert.equal(f.count('start_local_transcription'), 1);
  await f.workflow.useApexFallback(f.live()); assert.ok(f.fallback().job);
  assert.equal(f.count('stop_local_transcription'), 0);
  await f.workflow.captureStopped(capture); assert.equal(f.fallback().recording, false);
  assert.equal(f.count('stop_local_transcription'), 0); assert.equal(f.count('start_local_transcription'), 2);
});

test('fallback during an in-flight Trelis start waits and pauses the eventual job', async () => {
  const f = fixture(); let release; f.gateStarts(new Promise(resolve => { release = resolve; }));
  const started = f.workflow.captureStarted(capture);
  for (let i = 0; i < 30 && !f.count('start_local_transcription'); i++) await Promise.resolve();
  await f.workflow.useApexFallback(f.live()); await f.workflow.captureStopped(capture);
  assert.equal(f.fallback().job, undefined); release(); await started; f.gateStarts(undefined); await f.workflow.tick();
  assert.equal(f.count('stop_local_transcription'), 1); assert.equal(f.fallback().job, undefined);
  f.status(f.live(), { state: 'stopped' }); await f.workflow.tick();
  assert.ok(f.fallback().job); assert.equal(f.fallback().captureEnded, true);
});

test('fallback stop failures are visible, bounded, and repaired by an explicit fallback action', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); f.failStops(1);
  await f.workflow.useApexFallback(f.live()); await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.count('stop_local_transcription'), 1); assert.match(f.live().stopError, /stop request failed/);
  assert.equal(f.fallback().job, undefined); await f.workflow.useApexFallback(f.live());
  assert.equal(f.count('stop_local_transcription'), 2);
  f.status(f.live(), { state: 'stopped' }); await f.workflow.tick(); assert.ok(f.fallback().job);
});

test('reload preserves fallback choice, rehydrates checkpoints, and never resumes Trelis automatically', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); await f.workflow.useApexFallback(f.live());
  f.status(f.live(), { state: 'stopped', segments: [segment()] }); f.reload(); await f.workflow.refreshAfterReload(capture);
  assert.equal(f.count('stop_local_transcription'), 1); assert.equal(f.count('start_local_transcription'), 2);
  assert.equal(f.live().pausedByUser, true); assert.equal(f.live().importedCount, 1); assert.ok(f.fallback().job);
  await f.workflow.captureStopped(capture); f.status(f.fallback(), { state: 'complete' }); await f.workflow.tick();
  f.reload(); await f.workflow.refreshAfterReload(null); await f.workflow.tick();
  assert.equal(f.count('resume_local_transcription'), 0); assert.equal(f.count('start_local_transcription'), 2);
});

test('native fallback rediscovery preserves roles and identities when browser pointers are missing', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); await f.workflow.useApexFallback(f.live());
  f.status(f.live(), { state: 'stopped' }); await f.workflow.tick();
  const id = f.fallback().job.job_id; f.workflow.state.runs = []; await f.workflow.refreshAfterReload(capture);
  assert.equal(f.runs().length, 2); assert.equal(f.live().pausedByUser, true); assert.equal(f.live().fallbackRequested, true);
  assert.equal(f.fallback().job.job_id, id); assert.equal(f.fallback().primary, false);
  assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.count('resume_local_transcription'), 0);
});

test('explicit Trelis retry waits for fallback checkpoint and resumes its original primary job', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); const id = f.live().job.job_id;
  await f.workflow.useApexFallback(f.live()); f.status(f.live(), { state: 'stopped' }); await f.workflow.tick();
  await assert.rejects(f.workflow.retry(f.live()), /Pause Apex/);
  assert.equal(f.live().pausedByUser, true); assert.equal(f.live().fallbackRequested, true);
  await f.workflow.stopWorker(f.fallback()); await assert.rejects(f.workflow.retry(f.live()), /Pause Apex/);
  f.status(f.fallback(), { state: 'stopped', segments: [segment('fallback-tail')] }); await f.workflow.tick();
  await f.workflow.retry(f.live()); assert.equal(f.live().job.job_id, id);
  assert.equal(f.count('resume_local_transcription'), 1); assert.equal(f.fallback().pausedByUser, true);
  assert.equal(f.live().fallbackRequested, false);
});

test('paused queued Trelis stays paused through stop and reload until explicit retry', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); await f.workflow.captureStarted(second);
  assert.equal(f.live(second).job, undefined); await f.workflow.stopWorker(f.live(second));
  await f.workflow.captureStopped(second); f.status(f.live(), { state: 'complete' }); await f.workflow.captureStopped(capture);
  f.reload(); await f.workflow.refreshAfterReload(null);
  assert.equal(f.live(second).job, undefined); await f.workflow.retry(f.live(second)); assert.ok(f.live(second).job);
});

test('capture stop while Trelis starts drains it without requesting stop or making a second pass', async () => {
  const f = fixture(); let release; f.gateStarts(new Promise(resolve => { release = resolve; }));
  const started = f.workflow.captureStarted(capture);
  for (let i = 0; i < 30 && !f.count('start_local_transcription'); i++) await Promise.resolve();
  await f.workflow.captureStopped(capture); release(); await started; f.gateStarts(undefined); await f.workflow.tick();
  assert.equal(f.count('stop_local_transcription'), 0); assert.equal(f.count('start_local_transcription'), 1);
  assert.equal(f.live().captureEnded, true); assert.equal(f.live().job.state, 'running');
});

test('interrupted Trelis capture requires recovery and never silently resumes a failed job', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture);
  f.status(f.live(), { state: 'failed', segments: [segment()], error: 'synthetic interrupted process' });
  f.reload(); await f.workflow.refreshAfterReload(null); assert.equal(f.live().needsRecovery, true);
  await assert.rejects(f.workflow.useApexFallback(f.live()), /Recover/);
  await f.workflow.captureStopped(capture); assert.equal(f.live().needsRecovery, false);
  assert.equal(f.count('resume_local_transcription'), 0); await f.workflow.retry(f.live());
  assert.equal(f.count('resume_local_transcription'), 1); assert.equal(f.count('start_local_transcription'), 1);
});

test('speaker processing waits for recording to end and the completed primary to be imported', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture);
  f.status(f.live(), { state: 'complete', segments: [segment()] }); await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 0); await f.workflow.captureStopped(capture);
  assert.equal(f.count('start_speaker_identification'), 1);
});

test('a previous call speaker job overlaps the next live transcript and queues the next speakers', async () => {
  const f = fixture(); f.enableSpeakers();
  await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete', segments: [segment('first-final')] }); await f.workflow.tick();
  const firstSpeaker = f.live().speakerJob.job_id;
  await f.workflow.captureStarted(second);
  assert.ok(f.live(second).job, 'Trelis starts before the second call stops');
  assert.equal(f.live(second).recording, true);
  assert.equal(f.live().speakerJob.state, 'diarizing');
  f.status(f.live(second), { segments: [segment('second-progress', 'A separate fictional call.')] });
  f.speakers.get(firstSpeaker).state = 'matching'; await f.workflow.tick();
  assert.equal(f.live(second).importedCount, 1);
  assert.equal(f.live().speakerJob.state, 'matching');
  assert.equal(f.live(second).speakerJob, undefined);
  await f.workflow.captureStopped(second);
  f.status(f.live(second), { state: 'complete' }); await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 1, 'the second speaker job waits for its own slot');
  f.speakers.get(firstSpeaker).state = 'complete'; await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 2);
  assert.equal(f.speakers.get(f.live(second).speakerJob.job_id).transcriptionJobId, f.live(second).job.job_id);
  assert.equal(f.count('start_local_transcription'), 2);
  assert.equal(f.count('stop_local_transcription'), 0);
});

test('a completed previous call can start speakers while another transcription is already running', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete', segments: [segment('first-final')] }); await f.workflow.tick();
  await f.workflow.captureStarted(second); assert.equal(f.live(second).job.state, 'running');
  f.enableSpeakers(); await f.workflow.tick();
  assert.ok(f.live().speakerJob);
  assert.equal(f.live(second).job.state, 'running');
  assert.equal(f.live(second).speakerJob, undefined);
});

test('two transcription jobs remain serialized while the separate speaker slot is occupied', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete' }); await f.workflow.tick();
  await f.workflow.captureStarted(second); await f.workflow.captureStarted(third);
  assert.ok(f.live(second).job); assert.equal(f.live(third).job, undefined);
  await f.workflow.captureStopped(second);
  assert.equal(f.live(third).job, undefined, 'capture stop does not free a draining transcription');
  f.status(f.live(second), { state: 'complete' }); await f.workflow.tick();
  assert.ok(f.live(third).job); assert.equal(f.live(third).recording, true);
  assert.equal(f.count('start_local_transcription'), 3);
  assert.equal(f.count('start_speaker_identification'), 1);
});

test('reload retains both jobs and explicit Trelis retry proceeds beside the earlier speakers', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete', segments: [segment('first-final')] }); await f.workflow.tick();
  await f.workflow.captureStarted(second);
  const asrId = f.live(second).job.job_id, speakerId = f.live().speakerJob.job_id;
  f.status(f.live(second), { state: 'failed', segments: [segment('second-checkpoint')], segments_revision: 1 }); await f.workflow.tick();
  f.reload(); await f.workflow.refreshAfterReload(second);
  assert.equal(f.live(second).job.job_id, asrId); assert.equal(f.live().speakerJob.job_id, speakerId);
  assert.equal(f.count('resume_local_transcription'), 0, 'reload does not silently retry a failed ASR job');
  await f.workflow.retry(f.live(second));
  assert.equal(f.count('resume_local_transcription'), 1);
  assert.equal(f.live(second).job.job_id, asrId); assert.equal(f.live(second).job.state, 'running');
  assert.equal(f.live(second).job.segments[0].id, 'second-checkpoint');
  assert.equal(f.live().speakerJob.job_id, speakerId); assert.equal(f.live().speakerJob.state, 'diarizing');
  assert.equal(f.count('start_speaker_identification'), 1);
  assert.equal(f.count('start_local_transcription'), 2);
});

test('manual speaker retry requires stopped capture and the fully imported completed source', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture);
  await f.workflow.retrySpeakers(f.live()); assert.equal(f.count('start_speaker_identification'), 0);
  f.status(f.live(), { state: 'complete', segments: [segment('before-stop')], segments_revision: 1 }); await f.workflow.tick();
  await f.workflow.retrySpeakers(f.live()); assert.equal(f.count('start_speaker_identification'), 0);
  // Hydrate a newer completed checkpoint while the earlier import pointer is still retained.
  const updated = { segments: [segment('changed-source')], segments_revision: 2 };
  f.status(f.live(), updated); Object.assign(f.live().job, clone(updated)); f.failImport(f.live());
  await f.workflow.captureStopped(capture); await f.workflow.retrySpeakers(f.live());
  assert.equal(f.count('start_speaker_identification'), 0, 'an earlier complete import cannot authorize changed source text');
  f.failImport(f.live(), false); await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 1);
  assert.equal(f.live().importedRevision, 2);
});

test('one shared launch gate prevents duplicate speaker starts and defers ASR only until launch returns', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture);
  f.status(f.live(), { state: 'complete' });
  let release; f.gateSpeakerStarts(new Promise(resolve => { release = resolve; }));
  const stopped = f.workflow.captureStopped(capture);
  for (let i = 0; i < 60 && !f.count('start_speaker_identification'); i++) await Promise.resolve();
  assert.equal(f.count('start_speaker_identification'), 1);
  await Promise.all([f.workflow.captureStarted(second), f.workflow.retrySpeakers(f.live()), f.workflow.tick()]);
  assert.equal(f.count('start_local_transcription'), 1, 'ASR launch waits for the shared launch gate');
  assert.equal(f.count('start_speaker_identification'), 1);
  release(); await stopped; f.gateSpeakerStarts(undefined); await f.workflow.tick();
  assert.ok(f.live(second).job); assert.equal(f.live(second).recording, true);
  assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.count('start_speaker_identification'), 1);
});

test('duplicate capture events cannot launch two ASR jobs while earlier speakers run', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete' }); await f.workflow.tick();
  let release; f.gateStarts(new Promise(resolve => { release = resolve; }));
  const started = f.workflow.captureStarted(second);
  for (let i = 0; i < 60 && f.count('start_local_transcription') < 2; i++) await Promise.resolve();
  assert.equal(f.count('start_local_transcription'), 2);
  await Promise.all([f.workflow.captureStarted(second), f.workflow.captureStarted(third), f.workflow.tick()]);
  assert.equal(f.count('start_local_transcription'), 2);
  release(); await started; f.gateStarts(undefined); await f.workflow.tick();
  assert.ok(f.live(second).job); assert.equal(f.live(third).job, undefined);
  assert.equal(f.count('start_speaker_identification'), 1);
});

test('failed speakers retry explicitly beside ASR and never occupy a second speaker slot', async () => {
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete' }); await f.workflow.tick();
  const speakerId = f.live().speakerJob.job_id;
  f.speakers.get(speakerId).state = 'failed'; await f.workflow.tick();
  await f.workflow.captureStarted(second); await f.workflow.retrySpeakers(f.live());
  assert.equal(f.count('retry_speaker_identification'), 1);
  assert.equal(f.live().speakerJob.job_id, speakerId); assert.equal(f.live(second).job.state, 'running');
  await f.workflow.captureStopped(second); f.status(f.live(second), { state: 'complete' }); await f.workflow.tick();
  await f.workflow.retrySpeakers(f.live(second));
  assert.equal(f.count('start_speaker_identification'), 1, 'manual and automatic starts share the occupied speaker slot');
  f.speakers.get(speakerId).state = 'complete'; await f.workflow.tick();
  assert.equal(f.count('start_speaker_identification'), 2);
});

test('rendered ASR retry and rerun controls ignore active speakers but respect another transcription', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const panelSource = fs.readFileSync(path.join(__dirname, '../../src/components/LocalTranscriptionPanel.tsx'), 'utf8');
  const panelCompiled = ts.transpileModule(panelSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  const f = fixture(); f.enableSpeakers(); await f.workflow.captureStarted(capture); await f.workflow.captureStopped(capture);
  f.status(f.live(), { state: 'complete' }); await f.workflow.tick();
  await f.workflow.captureStarted(second); await f.workflow.captureStopped(second);
  f.status(f.live(second), { state: 'failed' }); await f.workflow.tick();
  const props = { sessionDir: second.session_dir, meetingId: f.live(second).meetingId };
  const render = () => {
    let hook = 0;
    const panel = { exports: {}, require: id => {
      if (id === 'react') return { ...React, useEffect: () => {}, useState: initial => [
        hook++ === 0 ? [{ id: 'trelis-10', available: true }] : initial, () => {},
      ] };
      if (id === '@tauri-apps/api/core') return { invoke: () => { throw new Error('render must not invoke native commands'); } };
      if (id === 'next/navigation') return { useRouter: () => ({ push: () => {} }) };
      if (id === '@/components/ui/button') return { Button: buttonProps => React.createElement('button', buttonProps) };
      if (id === '@/contexts/LocalWorkflowContext') return { useLocalWorkflow: () => ({ state: f.workflow.state, workflow: f.workflow }) };
      if (id === '@/contexts/RecordingStateContext') return { useRecordingState: () => ({ isRecording: false }) };
      if (id === '@/lib/local-transcription-workflow') return context.exports;
      return require(id);
    } };
    vm.runInNewContext(panelCompiled.outputText, panel);
    return renderToStaticMarkup(React.createElement(panel.exports.LocalTranscriptionPanel, props));
  };
  const enabled = (html, label) => {
    const match = html.match(new RegExp(`<button\\b[^>]*>${label}</button>`));
    assert.ok(match, `missing rendered ${label} control`);
    return !/\bdisabled=/.test(match[0]);
  };
  let html = render();
  assert.equal(enabled(html, 'Retry Trelis'), true);
  assert.equal(enabled(html, 'Create another version'), true);
  const pending = f.live(second).job; delete f.live(second).job;
  html = render(); assert.match(html, /Audio is saved\. Preparing transcription\./);
  f.live(second).job = pending;
  await f.workflow.captureStarted(third);
  html = render(); assert.equal(enabled(html, 'Retry Trelis'), false);
  assert.equal(enabled(html, 'Create another version'), false);
  delete f.live(second).job;
  assert.match(render(), /Waiting for another transcription to finish/);
  f.live(second).job = pending;
});

test('adopting a durable fallback cannot bind it as the primary transcript', async () => {
  const f = fixture(); const job = { job_id: 'fallback-existing', session_dir: capture.session_dir,
    workflow_role: 'fallback', profile: 'apex-20', state: 'complete', segments: [segment()] };
  f.jobs.set(job.job_id, job); await f.workflow.adopt(job, 'base-meeting', true);
  const run = f.workflow.state.runs[0]; assert.equal(run.primary, false);
  assert.equal(run.transcriptMeetingId, 'meeting-local-fallback-existing');
});

test('rediscovery does not pause Trelis that was explicitly resumed after fallback', async () => {
  const f = fixture(); await f.workflow.captureStarted(capture); await f.workflow.useApexFallback(f.live());
  f.status(f.live(), { state: 'stopped' }); await f.workflow.tick();
  f.status(f.fallback(), { state: 'complete' }); await f.workflow.tick(); await f.workflow.retry(f.live());
  const stopCount = f.count('stop_local_transcription'); f.workflow.state.runs = [];
  await f.workflow.refreshAfterReload(capture);
  assert.equal(f.live().job.state, 'running'); assert.notEqual(f.live().fallbackRequested, true);
  assert.notEqual(f.live().pausedByUser, true); assert.equal(f.count('stop_local_transcription'), stopCount);
  assert.equal(f.count('start_local_transcription'), 2); assert.equal(f.count('resume_local_transcription'), 1);
});

test('chunk preferences default to 10 and persist each valid Trelis duration', () => {
  assert.equal(readPreferences().profile, 'trelis-10');
  assert.equal(readPreferences({ profile: 'apex-20' }).profile, 'trelis-10');
  for (const seconds of [5, 10, 20]) {
    const profile = `trelis-${seconds}`;
    assert.equal(readPreferences({ profile }).profile, profile);
    assert.equal(profileLabel(profile), `Trelis · ${seconds}s`);
    const f = fixture(); f.workflow.setPreferences({ profile, languageMode: 'english', timing: 'during-recording' });
    f.reload(); assert.equal(f.workflow.state.preferences.profile, profile);
  }
});

test('chosen chunk size stays with the live job after preferences change, fallback and resume', async () => {
  for (const profile of ['trelis-5', 'trelis-10', 'trelis-20']) {
    const f = fixture({ preferences: { profile } }); await f.workflow.captureStarted(capture);
    const id = f.live().job.job_id; assert.equal(f.live().job.profile, profile);
    f.workflow.setPreferences({ profile: 'trelis-20', languageMode: 'hinglish', timing: 'during-recording' });
    await f.workflow.useApexFallback(f.live()); f.status(f.live(), { state: 'stopped' }); await f.workflow.tick();
    assert.equal(f.fallback().job.profile, 'apex-20'); assert.equal(f.fallback().job.final_profile, profile);
    assert.equal(f.calls.find(call => call.args.workflowRole === 'fallback').args.finalProfile, profile);
    f.status(f.fallback(), { state: 'complete' }); await f.workflow.tick();
    await f.workflow.retry(f.live()); await f.workflow.captureStopped(capture);
    assert.equal(f.live().job.job_id, id); assert.equal(f.live().job.profile, profile);
  }
});

test('manual versions preserve all chosen Trelis durations without rewriting historical20', async () => {
  const f = fixture();
  for (const seconds of [5, 10, 20]) {
    const job = { job_id: `manual-${seconds}`, session_dir: capture.session_dir, profile: `trelis-${seconds}`, state: 'complete', segments: [segment()] };
    f.jobs.set(job.job_id, job); await f.workflow.adopt(job, 'base-meeting');
    assert.equal(f.workflow.state.runs.find(run => run.job.job_id === job.job_id).preferences.profile, job.profile);
  }
});

test('fallback-only native recovery restores selected final duration while old fallback remains20', async () => {
  for (const finalProfile of ['trelis-5', 'trelis-10', 'trelis-20', undefined]) {
    const f = fixture({ preferences: { profile: 'trelis-10' } });
    const job = { job_id: 'fallback-only', session_dir: capture.session_dir, capture_session_id: capture.session_id,
      profile: 'apex-20', final_profile: finalProfile, workflow_role: 'fallback', state: 'complete', segments: [] };
    f.jobs.set(job.job_id, job); await f.workflow.refreshAfterReload(capture);
    assert.equal(f.live().preferences.profile, finalProfile ?? 'trelis-20');
    assert.equal(f.live().pausedByUser, true); assert.equal(f.count('start_local_transcription'), 0);
    await f.workflow.retry(f.live()); assert.equal(f.live().job.profile, finalProfile ?? 'trelis-20');
  }
});

test('legacy dual-pass creation keeps a saved Trelis final duration and Apex draft duration', async () => {
  const f = fixture({ preferences: { profile: 'trelis-5' }, runs: [{ capture, role: 'live-draft', recording: true, primary: false,
    preferences: { profile: 'apex-20', languageMode: 'hinglish', timing: 'during-recording' }, finalProfile: 'trelis-10' }] });
  await f.workflow.captureStarted(capture);
  assert.equal(f.draft().preferences.profile, 'apex-20'); assert.equal(f.final().preferences.profile, 'trelis-10');
  await f.workflow.captureStopped(capture); await finishDraft(f); assert.equal(f.final().job.profile, 'trelis-10');
});
