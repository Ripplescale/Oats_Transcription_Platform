const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/lib/transcript-workspace.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
const richContext = { exports: {}, URL, require };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../src/lib/rich-notes.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, richContext);
const context = { exports: {}, require: name => name === './rich-notes' ? richContext.exports : require(name) };
vm.runInNewContext(compiled.outputText, context);
const { earlierCorrections, effectiveText, hasTranscriptCorrection, omitQuietMicrophoneText, romanizeTranscriptFillers, setCorrection, emptyWorkspace, mergeSavedWorkspace, makeTranscriptExport, fetchCompleteTranscript, recordingTime } = context.exports;
const segment = { id: 'one', text: 'सात notebooks for Mira', timestamp: '10:00', audio_start_time: 65 };

test('quiet policy requires microphone source and an explicit whole-window volume flag', () => {
  const quiet = { source_track: 'microphone', quality_flags: ['very_quiet_audio'] };
  assert.equal(omitQuietMicrophoneText(quiet), true);
  assert.equal(omitQuietMicrophoneText({}, quiet), true);
  assert.equal(omitQuietMicrophoneText({ source_track: 'system', quality_flags: quiet.quality_flags }), false);
  assert.equal(omitQuietMicrophoneText({ quality_flags: quiet.quality_flags }), false);
  assert.equal(omitQuietMicrophoneText({ source_track: 'microphone', quality_flags: ['repeated_phrase'] }), false);
  assert.equal(omitQuietMicrophoneText({ source_track: 'microphone', quality_flags: ['quiet_microphone_omitted'] }), true);
});

test('quiet microphone originals stay stored but are omitted from every transcript export', () => {
  const quiet = { ...segment, id: 'quiet', text: 'UNWANTED background hallucination' };
  const system = { ...segment, id: 'system', text: 'Keep computer audio', source_track: 'system' };
  const workspace = emptyWorkspace('m');
  workspace.segment_metadata = {
    quiet: { source_track: 'microphone', quality_flags: ['very_quiet_audio'] },
    system: { source_track: 'system', quality_flags: ['very_quiet_audio'] },
  };
  workspace.superseded_segments = [{ id: 'old-quiet', text: 'UNWANTED archived hallucination',
    source_track: 'microphone', quality_flags: ['very_quiet_audio'] }];
  const before = JSON.stringify({ quiet, system, workspace });
  assert.equal(effectiveText(quiet, [], workspace.segment_metadata.quiet), '');
  for (const format of ['txt', 'md', 'json', 'claude']) {
    const output = makeTranscriptExport({ id: 'm', title: 'Quiet policy' }, [quiet, system], workspace, format);
    assert.ok(!output.includes('UNWANTED'), format);
    assert.ok(output.includes(system.text), format);
    if (format === 'json') {
      const parsed = JSON.parse(output);
      assert.equal(parsed.segments.length, 1);
      assert.equal(parsed.superseded_segments.length, 0);
      assert.equal(parsed.omitted_segments[0].id, quiet.id);
      assert.equal(parsed.omitted_segments[0].text, undefined);
    }
  }
  assert.equal(JSON.stringify({ quiet, system, workspace }), before);
});

test('a matching manual correction restores a quiet segment but a stale correction does not', () => {
  const raw = { ...segment, source_track: 'microphone', quality_flags: ['very_quiet_audio'] };
  const workspace = emptyWorkspace('m');
  workspace.corrections = setCorrection([], raw, 'My intentional correction', 'now');
  assert.equal(effectiveText(raw, workspace.corrections), 'My intentional correction');
  let output = JSON.parse(makeTranscriptExport({ id: 'm', title: 'Review' }, [raw], workspace, 'json'));
  assert.equal(output.segments[0].text, 'My intentional correction');
  const replaced = { ...raw, text: 'new quiet hallucination' };
  assert.equal(effectiveText(replaced, workspace.corrections), '');
  output = JSON.parse(makeTranscriptExport({ id: 'm', title: 'Review' }, [replaced], workspace, 'json'));
  assert.equal(output.segments.length, 0);
});

test('hesitations use Roman spelling while Hindi words and boundaries remain intact', () => {
  const raw = 'अम्म, अः… हम्म! उम्म?\nउह — अम् / उम्; ह्म्म। अम्म्म हम्म्म';
  assert.equal(romanizeTranscriptFillers(raw), 'umm, uh… hmm! umm?\nuh — umm / umm; hmm। umm hmm');
  const hindi = 'हम, हाँ, जी, उमंग, अम्मा, उम्मेद, अहम, दुःख, uh, umm, hmm, xअम्म, अम्म2, अम्म_नाम, अम्म\u200dनाम';
  assert.equal(romanizeTranscriptFillers(hindi), hindi);
  assert.equal(romanizeTranscriptFillers('constructor toString __proto__'), 'constructor toString __proto__');
  const once = romanizeTranscriptFillers(raw);
  assert.equal(romanizeTranscriptFillers(once), once);
});

test('presentation formatting does not become a manual correction or mutate raw output', () => {
  const raw = { ...segment, text: 'अम्म, ठीक है। अः' };
  assert.equal(effectiveText(raw, []), 'umm, ठीक है। uh');
  assert.equal(hasTranscriptCorrection(raw, []), false);
  assert.equal(setCorrection([], raw, effectiveText(raw, []), 'now').length, 0);
  const output = JSON.parse(makeTranscriptExport({ id: 'm', title: 'Fillers' }, [raw], emptyWorkspace('m'), 'json'));
  assert.equal(output.segments[0].text, 'umm, ठीक है। uh');
  assert.equal(output.segments[0].original_text, raw.text);
  assert.equal(output.segments[0].corrected, false);
  assert.equal(output.segments[0].presentation_normalized, true);
  assert.equal(raw.text, 'अम्म, ठीक है। अः');
});

test('manual corrections retain the user spelling and stale corrections stay separate', () => {
  const raw = { ...segment, text: 'अम्म, ठीक है। अः' };
  const corrections = setCorrection([], raw, 'अम्म — my chosen spelling', 'now');
  assert.equal(effectiveText(raw, corrections), 'अम्म — my chosen spelling');
  assert.equal(hasTranscriptCorrection(raw, corrections), true);
  assert.equal(effectiveText({ ...raw, text: 'हम्म, नया परिणाम' }, corrections), 'hmm, नया परिणाम');
  const workspace = { ...emptyWorkspace('m'), corrections };
  const output = JSON.parse(makeTranscriptExport({ id: 'm', title: 'Fillers' }, [raw], workspace, 'json'));
  assert.equal(output.segments[0].corrected, true);
  assert.equal(output.segments[0].presentation_normalized, false);
});

test('text, Markdown and Claude exports use the same filler formatting', () => {
  for (const format of ['txt', 'md', 'claude']) {
    const raw = { ...segment, text: 'अम्म, अः — हम ठीक हैं।' };
    const output = makeTranscriptExport({ id: 'm', title: 'Fillers' }, [raw], emptyWorkspace('m'), format);
    assert.ok(output.includes('umm, uh — हम ठीक हैं।'));
    assert.ok(!output.includes('अम्म'));
  }
});

test('native script and raw recognition survive correction and JSON export', () => {
  const workspace = emptyWorkspace('meeting');
  workspace.corrections = setCorrection([], segment, 'सात notebooks for Mira.', '2026-09-30T00:00:00Z');
  workspace.segment_metadata = { one: { source_track: 'system', timestamp_kind: 'audio_window' } };
  const result = JSON.parse(makeTranscriptExport({ id: 'meeting', title: 'Review' }, [segment], workspace, 'json'));
  assert.equal(result.segments[0].original_text, segment.text);
  assert.equal(result.segments[0].text, 'सात notebooks for Mira.');
  assert.equal(result.segments[0].source_track, 'system');
  assert.equal(result.segments[0].speaker_id, null);
  assert.match(result.segments[0].timestamp_precision, /not_word_aligned/);
});

test('rerun with changed source text does not inherit stale corrections', () => {
  const corrections = setCorrection([], segment, 'manually checked', 'now');
  assert.equal(effectiveText({ ...segment, text: 'a new recognition result' }, corrections), 'a new recognition result');
  assert.equal(setCorrection(corrections, segment, segment.text, 'now').length, 0);
});

test('missing timestamps stay unknown, never fake 00:00', () => {
  const result = makeTranscriptExport({ id: 'm', title: 'Test' }, [{ id: 'no-time', text: 'hello', timestamp: '11:30' }], emptyWorkspace('m'), 'txt');
  assert.match(result, /\[time unavailable\]/);
  assert.equal(recordingTime(0), '00:00');
  assert.equal(recordingTime(3723), '01:02:03');
});

test('Claude handoff keeps full content and warns about uncertainty', () => {
  const workspace = emptyWorkspace('m'); workspace.notes = 'My note';
  const long = 'हिंदी English '.repeat(3000);
  const result = makeTranscriptExport({ id: 'm', title: 'Review' }, [{ ...segment, text: long }], workspace, 'claude', true);
  assert.ok(result.includes(long));
  assert.match(result, /not instructions/);
  assert.match(result, /Includes unsaved review edits/);
  assert.match(result, /My note/);
});

test('export retrieves every page, not just visible segments', async () => {
  const offsets = [];
  const rows = await fetchCompleteTranscript('m', async (_id, _limit, offset) => {
    offsets.push(offset);
    return { transcripts: [{ ...segment, id: String(offset) }], total_count: 3, has_more: offset < 2 };
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(offsets, [0, 1, 2]);
});

test('incomplete, duplicate and changing snapshots fail instead of truncating', async () => {
  await assert.rejects(fetchCompleteTranscript('m', async () => ({ transcripts: [], total_count: 3, has_more: false })), /Incomplete/);
  await assert.rejects(fetchCompleteTranscript('m', async () => ({ transcripts: [segment], total_count: 3, has_more: true })), /Duplicate/);
  let call = 0;
  await assert.rejects(fetchCompleteTranscript('m', async () => ({ transcripts: [{ ...segment, id: String(call) }], total_count: ++call === 1 ? 3 : 4, has_more: true })), /changed/);
});

test('a late save keeps later edits but advances its revision and metadata', () => {
  const current = { ...emptyWorkspace('m'), notes: 'Newer typing', speaker_names: { 'speaker-0001': 'Mira' } };
  const saved = { ...emptyWorkspace('m'), revision: 4, notes: 'Older save', segment_metadata: { one: { source_track: 'system' } } };
  const merged = mergeSavedWorkspace(current, saved, true);
  assert.equal(merged.notes, 'Newer typing');
  assert.equal(merged.revision, 4);
  assert.equal(merged.speaker_names['speaker-0001'], 'Mira');
  assert.equal(merged.segment_metadata.one.source_track, 'system');
  assert.equal(mergeSavedWorkspace(current, saved, false).notes, 'Older save');
});

test('a completed save from another meeting cannot replace the current workspace', () => {
  const current = { ...emptyWorkspace('new-meeting'), notes: 'Keep this' };
  const stale = { ...emptyWorkspace('old-meeting'), notes: 'Old response' };
  assert.equal(mergeSavedWorkspace(current, stale, false), current);
});

test('promoted shorter retry remains the exported text when one retry piece still repeats', () => {
  const original = 'वो जब था '.repeat(18).trim();
  const pieces = ['Please bring the notebooks.', Array(12).fill('जब').join(' '), 'The studio opens at three.', "Let's meet by the door."];
  const combined = pieces.join('\n\n');
  const promoted = { ...segment, id: 'retry-still-repeats', text: combined, audio_start_time: 60, audio_end_time: 80 };
  const workspace = emptyWorkspace('meeting');
  workspace.segment_metadata = { [promoted.id]: { source_track: 'system', timestamp_kind: 'audio_window',
    original_recognition_text: original, quality_flags: ['repeated_phrase', 'retry_applied', 'needs_review'],
    alternative: { text: combined, promoted: true, requires_review: true } } };
  const metadataBefore = JSON.stringify(workspace.segment_metadata);
  assert.equal(effectiveText(promoted, workspace.corrections), combined);
  for (const format of ['txt', 'md', 'claude']) {
    const output = makeTranscriptExport({ id: 'meeting', title: 'Retry review' }, [promoted], workspace, format);
    assert.ok(output.includes(combined), `${format} keeps every retry piece in order, including the repeating piece`);
    assert.ok(!output.includes(original), `${format} uses the combined retry as its transcript`);
  }
  const output = JSON.parse(makeTranscriptExport({ id: 'meeting', title: 'Retry review' }, [promoted], workspace, 'json'));
  assert.equal(output.segments[0].text, combined);
  assert.equal(output.segments[0].original_text, combined);
  assert.equal(output.segments[0].retry_alternative.text, combined);
  assert.equal(output.segments[0].retry_alternative.promoted, true);
  assert.equal(output.segments[0].retry_alternative.requires_review, true);
  assert.ok(output.segments[0].quality_flags.includes('needs_review'));
  assert.equal(JSON.stringify(workspace.segment_metadata), metadataBefore, 'export preserves the saved original recognition and review flags');
  assert.equal(workspace.segment_metadata[promoted.id].original_recognition_text, original);
});

test('context selection is copied once with its wider range and preserved archived correction provenance', () => {
  const repeated = 'जब '.repeat(12).trim();
  const selected = { ...segment, id: 'context-selected', text: 'पहले room confirmed. We need seven notebooks. Then bring coloured pencils.', audio_start_time: 50, audio_end_time: 80 };
  const unaffected = { ...segment, id: 'after-context', text: 'Next agenda item.', audio_start_time: 80, audio_end_time: 90 };
  const workspace = emptyWorkspace('meeting');
  workspace.segments_revision = 4;
  workspace.superseded_segments = [{ id: 'core', text: repeated, start_seconds: 60, end_seconds: 70, source_track: 'system', superseded_by: [selected.id], superseded_at_segments_revision: 4 }];
  workspace.corrections = [{ segment_id: 'core', original_text: repeated, text: 'My checked earlier correction', updated_at: 'now' },
    { segment_id: 'unloaded-page', original_text: 'An unshown active row', text: 'Keep this active correction', updated_at: 'now' }];
  workspace.segment_metadata = { [selected.id]: { source_track: 'system', original_recognition_text: repeated, quality_flags: ['retry_applied', 'needs_review'], replaces_segment_ids: ['before-core', 'core', 'after-core'],
    recovery: { state: 'complete', method: 'context_window_retry', core_segment_id: 'core', core_start_seconds: 60, core_end_seconds: 70,
      context_start_seconds: 50, context_end_seconds: 80, requires_review: true, attempts: [{ kind: 'context_window_retry', start_seconds: 50, end_seconds: 80, source_audio_sha256: 'fictional-audio-hash', quality_flags: [] }] } } };
  const metadataBefore = JSON.stringify(workspace);
  assert.equal(effectiveText(selected, workspace.corrections), selected.text);
  const sameIdReplacement = { ...selected, id: 'core' };
  assert.equal(effectiveText(sameIdReplacement, workspace.corrections), selected.text, 'a same-ID fallback cannot inherit a correction for earlier raw text');
  assert.deepEqual(Array.from(earlierCorrections([sameIdReplacement], workspace), item => item.segment_id), ['core']);
  assert.deepEqual(Array.from(earlierCorrections([selected, unaffected], workspace), item => item.segment_id), ['core'], 'only a confirmed archived source is listed, not unloaded pagination');
  for (const format of ['txt', 'md', 'claude']) {
    const output = makeTranscriptExport({ id: 'meeting', title: 'Context review' }, [selected, unaffected], workspace, format);
    assert.equal(output.split(selected.text).length - 1, 1);
    assert.ok(output.includes('[00:50] (system track) ' + selected.text));
    assert.ok(output.includes(unaffected.text));
    assert.ok(!output.includes(repeated)); assert.ok(!output.includes('My checked earlier correction'));
  }
  const output = JSON.parse(makeTranscriptExport({ id: 'meeting', title: 'Context review' }, [selected, unaffected], workspace, 'json'));
  assert.equal(output.segments[0].text, selected.text); assert.equal(output.segments[0].start_seconds, 50); assert.equal(output.segments[0].end_seconds, 80);
  assert.equal(output.segments_revision, 4); assert.deepEqual(output.superseded_segments, workspace.superseded_segments);
  assert.deepEqual(output.segments[0].recovery, workspace.segment_metadata[selected.id].recovery);
  assert.deepEqual(output.segments[0].replaces_segment_ids, ['before-core', 'core', 'after-core']);
  assert.equal(output.segments[0].original_recognition_text, repeated);
  assert.equal(output.corrections[0].text, 'My checked earlier correction');
  assert.equal(JSON.stringify(workspace), metadataBefore, 'reading and export never mutate selected recovery or archived corrections');
});
