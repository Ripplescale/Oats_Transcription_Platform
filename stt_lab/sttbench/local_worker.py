"""Restartable offline worker over committed recorder audio, never the capture callback.

Capture owns source audio. This worker owns only derived windows, raw recognition
and review flags. Window times are not word alignment or speaker identity.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import time
import wave
import contextlib

from sttbench.manifest import digest, file_digest, read_json, write_json as _write_json
from sttbench.normalization import basic_tokens
from sttbench.runtime import transcribe
from sttbench.runtime.api import warmup
from sttbench.speech_gate import assess_window

PROFILES = {'apex-15': ('apex', 15), 'apex-20': ('apex', 20), 'apex-30': ('apex', 30),
            'trelis-5': ('trelis', 5), 'trelis-10': ('trelis', 10),
            'trelis-15': ('trelis', 15), 'trelis-20': ('trelis', 20)}
TRACKS = ('microphone', 'system')


def write_json(path: Path, value):
    """Publish this worker's status checkpoints without indentation overhead.

    Other documents keep the manifest writer's existing default formatting.
    Historical jobs retain their immutable worker, so their checkpoint bytes and
    downstream speaker identity bindings are never rewritten by this change.
    """
    _write_json(path, value, compact=True)


def contained(root: Path, relative: str) -> Path:
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Committed audio path leaves the recording')
    return path


def journal_snapshot(session: Path):
    raw = (session / 'timeline.jsonl').read_bytes()
    # Ignore a live writer's partial last record; complete malformed records fail.
    complete = raw[:raw.rfind(b'\n') + 1]
    rows = [json.loads(line) for line in complete.splitlines() if line.strip()]
    chunks = {track: [] for track in TRACKS}
    finalized = False
    final_time = 0.0
    for row in rows:
        if row.get('kind') == 'audio_chunk':
            track = row.get('track')
            if track not in chunks:
                raise ValueError('Unknown capture track')
            start, end = row.get('start_seconds'), row.get('end_seconds')
            if not all(type(t) in (int, float) and math.isfinite(t) for t in (start, end)) or not 0 <= start < end:
                raise ValueError('Invalid committed audio timeline')
            if row['sequence'] != len(chunks[track]):
                raise ValueError('Missing or non-monotonic committed audio sequence')
            if row['sample_count'] <= 0 or row['sample_rate'] <= 0 or abs((end-start) - row['sample_count']/row['sample_rate']) > .002:
                raise ValueError('Committed sample count differs from timeline')
            chunks[track].append(row)
            final_time = max(final_time, end)
        elif row.get('kind') == 'capture_stopped':
            final_time = max(final_time, float(row.get('at_seconds', 0)))
        elif row.get('kind') == 'capture_finalized':
            finalized = True
    # Crash recovery keeps the original journal immutable. Only a recovery
    # report bound to those exact bytes may finalize a missing tail marker.
    if not finalized and (session/'metadata.json').is_file():
        metadata = read_json(session/'metadata.json')
        report_path = session/'recovery-verified.json'
        if metadata.get('status') == 'recovered' and report_path.is_file():
            report = read_json(report_path)
            if report.get('verified') is not True or report.get('source_journal_sha256') != hashlib.sha256(raw).hexdigest():
                raise ValueError('Recovered recording no longer matches its verified journal')
            duration = report.get('duration_seconds')
            if type(duration) not in (int,float) or not math.isfinite(duration) or duration < final_time:
                raise ValueError('Invalid recovered duration')
            finalized = True
            final_time = duration
    return chunks, finalized, final_time, rows


def materialize(session: Path, rows: list[dict], start: float, end: float, target: Path) -> dict:
    import numpy as np
    from scipy.signal import resample_poly
    n = round((end - start) * 16000)
    values = np.zeros(n, dtype=np.float32)
    covered = np.zeros(n, dtype=np.bool_)
    bindings, overlaps, spans = [], 0, []
    for row in rows:
        if row['end_seconds'] <= start or row['start_seconds'] >= end:
            continue
        path = contained(session, row['file'])
        actual_hash = file_digest(path)
        expected_hash = row.get('sha256') or row.get('audio_sha256')
        if not expected_hash or actual_hash != expected_hash:
            raise ValueError('Committed audio digest does not match')
        with wave.open(str(path), 'rb') as wav:
            rate = wav.getframerate()
            if (wav.getnchannels(), wav.getsampwidth(), rate, wav.getnframes()) != (1, 2, row['sample_rate'], row['sample_count']):
                raise ValueError('Committed WAV metadata differs from journal')
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        # Resample adjacent source chunks together: resetting the filter at every
        # recorder file boundary would add avoidable artifacts each second.
        if spans and rate == spans[-1]['rate'] and abs(row['start_seconds'] - spans[-1]['end']) <= .5/rate:
            spans[-1]['parts'].append(audio)
            spans[-1]['end'] = row['end_seconds']
        else:
            spans.append({'rate':rate,'start':row['start_seconds'],'end':row['end_seconds'],'parts':[audio]})
        bindings.append({'file': row['file'], 'sha256': actual_hash, 'sequence': row['sequence']})
    for span in spans:
        rate = span['rate']
        audio = np.concatenate(span['parts'])
        divisor = math.gcd(rate, 16000)
        converted = resample_poly(audio, 16000 // divisor, rate // divisor) if rate != 16000 else audio
        offset = round((span['start'] - start) * 16000)
        left, right = max(0, offset), min(n, offset + len(converted))
        if right <= left:
            continue
        segment = converted[left-offset:right-offset]
        occupied = covered[left:right]
        overlaps += int(occupied.sum())
        # Do not double-amplify callback jitter; earliest committed audio wins.
        view = values[left:right]
        view[~occupied] = segment[~occupied]
        covered[left:right] = True
    pcm = np.clip(np.rint(values * 32768), -32768, 32767).astype('<i2')
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm.tobytes())
    # Volume measurement, not VAD. Whole quiet microphone windows are omitted
    # by explicit user policy, including faint speech and background leakage.
    active = sum(float(np.sqrt(np.mean(values[i:i+320] ** 2))) > .006 for i in range(0, n, 320)) * .02
    return {'audio_sha256': file_digest(target), 'source_chunks': bindings,
            'uncovered_seconds': float((~covered).sum()) / 16000,
            'overlap_seconds': overlaps / 16000, 'active_energy_seconds': active,
            'digital_silence': not bool(pcm.any()), 'resampler': 'scipy.signal.resample_poly'}


def repetition_details(text: str) -> dict | None:
    """Detect long consecutive 1..8-word loops without treating a triple as failure."""
    words = basic_tokens(text)
    for period in range(1, 9):
        for start in range(len(words) - max(12, period * 4) + 1):
            phrase = words[start:start + period]
            cycles = 1
            while words[start + cycles * period:start + (cycles + 1) * period] == phrase:
                cycles += 1
            if cycles >= 4 and cycles * period >= 12:
                return {'start_word': start, 'period_words': period, 'cycles': cycles,
                        'repeated_words': cycles * period, 'phrase': ' '.join(phrase)}
    return None


def review_flags(text: str, audio: dict, duration: float) -> list[str]:
    words = basic_tokens(text)
    flags = []
    if audio['uncovered_seconds'] > .1:
        flags.append('capture_gap')
    if audio['overlap_seconds'] > .1:
        flags.append('capture_clock_overlap')
    if words and audio['active_energy_seconds'] == 0:
        # Quiet nonzero input can still produce a fluent or spurious draft.
        # This remains a volume label, not a claim that nobody spoke.
        flags.append('very_quiet_audio')
    if audio.get('volume_gate', {}).get('decision') == 'omit':
        flags.append('quiet_microphone_omitted')
    if duration >= 10 and audio['active_energy_seconds'] >= 8 and len(words) < audio['active_energy_seconds'] * .4:
        flags.append('suspiciously_sparse_text')
    if repetition_details(text):
        flags.append('repeated_phrase')
    if audio.get('speech_gate', {}).get('status') == 'unavailable':
        flags.append('speech_gate_unavailable')
    return flags


def _recognize_window(spec, config, session, rows, start, end, target, infer, speech_gate, gate,
                      *, allow_gate_skip=True):
    audio = materialize(session, rows, start, end, target)
    if audio['digital_silence']:
        return ({'status': 'ok', 'text': '', 'segments': [],
                 'warnings': ['Verified all-zero PCM; no speech inferred.'],
                 'provenance': {'digital_silence': True}, 'timing': {}}, audio)
    source_tracks = {row.get('track') for row in rows
                     if row['end_seconds'] > start and row['start_seconds'] < end}
    if source_tracks == {'microphone'} and audio['active_energy_seconds'] == 0:
        policy = {'decision': 'omit', 'reason': 'whole_microphone_window_below_volume_cutoff',
                  'threshold_rms': .006, 'frame_seconds': .02, 'source_audio_preserved': True}
        audio['volume_gate'] = policy
        return ({'status': 'ok', 'text': '', 'segments': [],
                 'warnings': ['Whole microphone window stayed below the volume cutoff; '
                              'transcription omitted and original audio retained.'],
                 'provenance': {'volume_gate': policy}, 'timing': {}}, audio)
    if spec.get('id') == 'trelis':
        # Retained windows reach Silero with analysis gain only. The explicit
        # microphone volume policy runs first; inference audio is unchanged.
        try:
            assessment = gate(target, speech_gate)
        except Exception as exc:
            assessment = {'status': 'unavailable', 'skip_stt': False, 'decision': 'keep',
                          'warning': 'speech_gate_unavailable', 'error': str(exc)}
        if not allow_gate_skip and assessment.get('skip_stt') is True:
            # A newly cut overlap fringe must not silently erase prior words.
            # Record the classifier's suggestion while retaining its raw audio.
            assessment = {**assessment, 'skip_stt': False, 'decision': 'keep',
                          'skip_overridden_for_overlap_fringe': True}
        audio['speech_gate'] = assessment
        if assessment.get('status') == 'ok' and assessment.get('skip_stt') is True:
            return ({'status': 'ok', 'text': '', 'segments': [],
                     'warnings': ['Silero found no speech evidence in either original or analysis-gain pass.'],
                     'provenance': {'speech_gate': assessment}, 'timing': {}}, audio)
    try:
        result = infer(spec, target, config)
    except Exception as exc:
        result = {'status': 'failed', 'text': '', 'error': str(exc)}
    if audio.get('speech_gate', {}).get('status') == 'unavailable':
        result = copy.deepcopy(result)
        result.setdefault('warnings', []).append('speech_gate_unavailable: original audio retained for recognition.')
    return result, audio


def recognition_flags(result, audio, duration):
    flags = review_flags(result.get('text', ''), audio, duration)
    if result.get('status') != 'ok':
        flags.append('recognition_failed')
    if result.get('decoding_diagnostics', {}).get('token_cap_reached') is True:
        flags.append('token_cap_reached')
    return flags


def needs_context_recovery(result, flags):
    return any(flag in flags for flag in ('repeated_phrase', 'token_cap_reached'))


def _shorter_retry(spec, config, session, rows, start, end, target, evaluated, infer,
                   speech_gate, gate, *, retry_piece=None, allow_single_piece=False):
    """Bounded core-only fallback; complete nonempty pieces remain reviewable."""
    evaluated = copy.deepcopy(evaluated)
    result, audio = evaluated['result'], evaluated['audio']
    original_result, flags = evaluated['original_result'], evaluated['quality_flags']
    alternative = None
    trelis = spec.get('id') == 'trelis'
    triggered = trelis and needs_context_recovery(result, flags)
    retry_seconds = 5 if trelis else 10
    should_retry = (triggered or 'suspiciously_sparse_text' in flags) and (
        end-start > retry_seconds or allow_single_piece)
    if should_retry:
        # One bounded retry, using disjoint original-source windows. There is no
        # recursive retry: even a looping 5s piece is preserved for review.
        pieces = []
        for index, cursor in enumerate(range(round(start*16000), round(end*16000), retry_seconds*16000)):
            left, right = cursor / 16000, min(end, (cursor + retry_seconds*16000) / 16000)
            retry = target.with_name(target.stem + f'-retry-{index}.wav')
            if retry_piece is not None:
                candidate, candidate_audio = retry_piece(left, right, retry)
            else:
                try:
                    candidate, candidate_audio = _recognize_window(spec, config, session, rows, left, right, retry,
                                                                   infer, speech_gate, gate)
                except Exception as exc:
                    candidate = {'status': 'failed', 'text': '', 'error': str(exc)}
                    candidate_audio = None
            candidate_flags = (recognition_flags(candidate, candidate_audio, right-left)
                               if candidate_audio is not None else ['recognition_failed'])
            pieces.append({'start_seconds': left, 'end_seconds': right, 'timestamp_kind': 'audio_window',
                           'source_audio_sha256': audio['audio_sha256'], 'audio_provenance': candidate_audio,
                           'quality_flags': candidate_flags, 'result': candidate})
        all_ok = all(p['result'].get('status') == 'ok' for p in pieces)
        joined = '\n\n'.join(p['result'].get('text', '') for p in pieces if p['result'].get('text'))
        resolved = all_ok and not repetition_details(joined) and not any(
            'repeated_phrase' in p['quality_flags'] for p in pieces)
        # Select a completed, nonempty shorter retry even if a piece still loops,
        # so useful speech from the other pieces is not hidden by the original.
        # Failed or entirely empty retries cannot replace a speech-containing draft.
        promoted = triggered and all_ok and bool(joined.strip())
        alternative = {'text': joined, 'chunks': pieces, 'requires_review': True, 'promoted': bool(promoted),
                       'all_chunks_ok': all_ok, 'long_repetition_resolved': bool(resolved),
                       'reason': ('Repeated or token-capped core; bounded shorter-window retry' if triggered
                                  else 'Energy/text heuristic, not proof of missing speech')}
        if promoted:
            result = {'status': 'ok', 'text': joined, 'segments': [],
                      'warnings': ['Shorter-window retry selected; original recognition preserved for review.'],
                      'provenance': {'selection': 'shorter_window_retry', 'original_recognition_preserved': True},
                      'timing': {'initial': original_result.get('timing', {}),
                                 'retries': [p['result'].get('timing', {}) for p in pieces]}}
            flags = review_flags(joined, audio, end-start)
            if any('token_cap_reached' in p['quality_flags'] for p in pieces):
                flags.append('token_cap_reached')
            flags.extend(['retry_applied', 'needs_review'])
        else:
            flags.append('retry_available' if all_ok else 'retry_failed')
            if triggered:
                flags.append('needs_review')
        if any('speech_gate_unavailable' in p['quality_flags'] for p in pieces) and 'speech_gate_unavailable' not in flags:
            flags.append('speech_gate_unavailable')
    elif triggered:
        flags.append('needs_review')
    return {'text': result.get('text', ''), 'result': result, 'original_result': original_result, 'audio': audio,
            'quality_flags': flags, 'alternative': alternative}


def evaluate_window(spec, config, session, rows, start, end, target, infer=transcribe,
                    speech_gate=None, gate=assess_window, *, defer_recovery=False):
    if speech_gate is None:
        speech_gate = config.get('speech_gate')
    result, audio = _recognize_window(spec, config, session, rows, start, end, target,
                                      infer, speech_gate, gate)
    trelis = spec.get('id') == 'trelis'
    if result.get('status') != 'ok':
        raise RuntimeError(result.get('error', 'Local model failed'))
    flags = recognition_flags(result, audio, end-start)
    evaluated = {'text': result.get('text', ''), 'result': result, 'original_result': copy.deepcopy(result),
                 'audio': audio, 'quality_flags': flags, 'alternative': None}
    if trelis and defer_recovery and needs_context_recovery(result, flags):
        flags.extend(['context_retry_pending', 'needs_review'])
        return evaluated
    return _shorter_retry(spec, config, session, rows, start, end, target, evaluated,
                          infer, speech_gate, gate)


def context_window_bounds(start, end, committed_end, finalized):
    """Thirty-second neighborhood, with no invented future capture samples."""
    start_sample, end_sample = round(start*16000), round(end*16000)
    padding = max(0, 30*16000 - (end_sample-start_sample))
    # Odd padding cannot be rounded independently at both edges: that could
    # create a 480001-sample WAV and exceed the model's strict 30s limit.
    left = max(0, start_sample-padding//2) / 16000
    desired_right = (end_sample + padding-padding//2) / 16000
    # A finalized primary may already include a verified trailing capture gap.
    # Preserve that core range, but never add new context beyond committed audio.
    limit = max(end, committed_end)
    right = min(desired_right, limit) if finalized else desired_right
    ready = finalized or committed_end >= desired_right - 1/16000
    return left, right, desired_right, ready


def _segment_record(segment_id, track, profile, model, start, end, evaluated):
    return {'id': segment_id, 'text': evaluated['text'], 'start_seconds': start,
            'end_seconds': end, 'source_track': track, 'timestamp_kind': 'audio_window', 'speaker': None,
            'model_id': model, 'profile': profile, 'quality_flags': evaluated['quality_flags'],
            'alternative': evaluated['alternative'], 'audio_provenance': evaluated['audio'],
            'recognition': evaluated['result'], 'recognition_original': evaluated['original_result']}


def _selection_changed(status):
    status['segments_revision'] = status.get('segments_revision', 0) + 1


def _archive_segments(status, originals, replacements):
    revision = status.get('segments_revision', 0) + 1
    archive = status.setdefault('superseded_segments', [])
    for original in originals:
        archive.append({**copy.deepcopy(original), 'superseded_by': list(replacements),
                        'superseded_at_segments_revision': revision})


def _pending_recovery(status, track):
    return next((segment for segment in status['segments'] if segment['source_track'] == track
                 and segment.get('recovery', {}).get('state') == 'waiting_for_context'), None)


def _idle_publication_key(status):
    """Constant-size idle state; never copy/serialize a growing transcript.

    Pending recovery returns without mutation while context is unavailable.
    Once ready, every attempt is checkpointed unconditionally and a completed
    recovery advances segments_revision before returning to the main loop.
    updated_at also distinguishes attempt checkpoints at the same revision.
    """
    return (status.get('state'), status.get('phase'), status.get('segments_revision'),
            *(status.get('cursors', {}).get(track, 0) for track in TRACKS),
            status.get('available_audio_seconds'), status.get('processed_audio_seconds'),
            status.get('backlog_seconds'), status.get('capture_finalized'),
            status.get('capture_event_count'), status.get('updated_at'))


class _RecoveryInterrupted(Exception):
    """Keep a provisional core and completed attempts when capture is stopped."""


def recover_pending_segment(status, status_path, job, spec, config, session, rows, track,
                             finalized, *, infer=transcribe, gate=assess_window, keep_running=lambda: True):
    """Replace a complete covered range, or select a bounded core-only fallback.

    We have no aligned word timestamps: trimming text would guess which words
    belong to an overlap. Re-recognize every untouched fringe, or retain all
    original segments. Checkpoint attempts before publishing a replacement.
    """
    core = _pending_recovery(status, track)
    if core is None:
        return False
    recovery = core['recovery']
    start, end = recovery['core_start_seconds'], recovery['core_end_seconds']
    committed_end = max((row['end_seconds'] for row in rows), default=0)
    left, right, desired_right, ready = context_window_bounds(start, end, committed_end, finalized)
    if not ready:
        return False
    recovery.update(context_start_seconds=left, context_end_seconds=right,
                    desired_context_end_seconds=desired_right)
    speech_gate = config.get('speech_gate')
    core_hash = core['audio_provenance']['audio_sha256']

    def attempt(kind, begin, finish, path, *, superseded=None, source_hash=core_hash):
        if not keep_running():
            raise _RecoveryInterrupted()
        saved = next((item for item in recovery['attempts'] if item['kind'] == kind
                      and item['start_seconds'] == begin and item['end_seconds'] == finish
                      and item.get('superseded_segment_id') == superseded), None)
        if saved is not None:
            # The immutable result can be reused only against the same source
            # bytes and derived waveform, including on a interrupted restart.
            verified = materialize(session, rows, begin, finish, path)
            if verified['audio_sha256'] != saved['audio_provenance']['audio_sha256']:
                raise ValueError('Recovery audio changed since its checkpoint')
            return saved
        # Publish before entering the model: a blocked context retry must not
        # masquerade as harmless waiting for future capture in the supervisor.
        status.update(state='running', phase='recovering_context')
        write_json(status_path, status)
        result, audio = _recognize_window(spec, config, session, rows, begin, finish, path,
                                          infer, speech_gate, gate,
                                          allow_gate_skip=kind != 'overlap_fringe')
        item = {'kind': kind, 'start_seconds': begin, 'end_seconds': finish,
                'timestamp_kind': 'audio_window', 'source_audio_sha256': source_hash,
                'audio_provenance': audio, 'result': result,
                'quality_flags': recognition_flags(result, audio, finish-begin)}
        if superseded is not None:
            item['superseded_segment_id'] = superseded
        recovery['attempts'].append(item)
        status.update(state='running', phase='recovering_context')
        status['updated_at'] = datetime.now(timezone.utc).isoformat()
        write_json(status_path, status)
        return item

    def clean(item):
        return item['result'].get('status') == 'ok' and not any(
            flag in item['quality_flags'] for flag in ('repeated_phrase', 'token_cap_reached',
                                                       'suspiciously_sparse_text'))

    expanded = left < start-1/16000 or right > end+1/16000
    context = None
    if expanded:
        path = job/'windows'/f'{track}-context-{round(left*16000)}-{round(right*16000)}.wav'
        context = attempt('context_window_retry', left, right, path)
    overlaps = [segment for segment in status['segments'] if segment['source_track'] == track
                and segment['start_seconds'] < right and segment['end_seconds'] > left]
    fringes = []
    promotable = context is not None and clean(context) and bool(context['result'].get('text', '').strip())
    if promotable:
        for previous in overlaps:
            residuals = []
            if previous['start_seconds'] < left:
                residuals.append((previous['start_seconds'], min(left, previous['end_seconds'])))
            if previous['end_seconds'] > right:
                residuals.append((max(right, previous['start_seconds']), previous['end_seconds']))
            for begin, finish in residuals:
                path = job/'windows'/f'{track}-fringe-{round(begin*16000)}-{round(finish*16000)}.wav'
                fringe = attempt('overlap_fringe', begin, finish, path, superseded=previous['id'],
                                 source_hash=previous['audio_provenance']['audio_sha256'])
                # An empty nonzero fringe is uncertain even when VAD calls it
                # nonspeech; it cannot erase an untouched part of prior speech.
                if not clean(fringe) or (not fringe['result'].get('text', '').strip()
                                          and not fringe['audio_provenance']['digital_silence']):
                    promotable = False
                    break
                fringes.append((previous, fringe))
            if not promotable:
                break
    if promotable:
        if not keep_running():
            raise _RecoveryInterrupted()
        originals = copy.deepcopy(overlaps)
        recovery.update(state='complete', method='context_window_retry')
        replaced_ids = [segment['id'] for segment in overlaps]
        alternative = {'text': context['result']['text'], 'chunks': [copy.deepcopy(context)],
                       'requires_review': True, 'promoted': True, 'all_chunks_ok': True,
                       'long_repetition_resolved': True, 'reason': 'Bounded context retry with complete overlap replacement'}
        evaluated = {'text': context['result']['text'], 'result': context['result'],
                     'original_result': core['recognition_original'], 'audio': context['audio_provenance'],
                     'quality_flags': [*context['quality_flags'], 'retry_applied', 'needs_review'],
                     'alternative': alternative}
        context_id = f"{status['job_id']}-{track}-c-{round(left*16000)}-{round(right*16000)}"
        selected = _segment_record(context_id, track, core['profile'], core['model_id'], left, right, evaluated)
        selected.update(replaces_segment_ids=replaced_ids, recovery=copy.deepcopy(recovery))
        replacements = [selected]
        for previous, fringe in fringes:
            begin, finish = fringe['start_seconds'], fringe['end_seconds']
            fringe_evaluated = {'text': fringe['result'].get('text', ''), 'result': fringe['result'],
                                'original_result': previous['recognition'], 'audio': fringe['audio_provenance'],
                                'quality_flags': [*fringe['quality_flags'], 'retry_applied', 'needs_review'],
                                'alternative': {**alternative, 'text': fringe['result'].get('text', ''),
                                                'chunks': [copy.deepcopy(fringe)],
                                                'reason': 'Untouched overlap fringe re-recognized without text trimming'}}
            fringe_id = f"{status['job_id']}-{track}-f-{round(begin*16000)}-{round(finish*16000)}"
            record = _segment_record(fringe_id, track, previous['profile'], previous['model_id'],
                                     begin, finish, fringe_evaluated)
            record.update(replaces_segment_ids=[previous['id']], recovery={**copy.deepcopy(recovery),
                          'original_segment_id': previous['id'], 'original_start_seconds': previous['start_seconds'],
                          'original_end_seconds': previous['end_seconds']})
            replacements.append(record)
        _archive_segments(status, originals, [segment['id'] for segment in replacements])
        status['segments'] = [segment for segment in status['segments'] if segment['id'] not in replaced_ids] + replacements
        status['segments'].sort(key=lambda segment: (segment['start_seconds'], segment['source_track'], segment['id']))
        status['cursors'][track] = max(status['cursors'].get(track, 0), right)
        _selection_changed(status)
        return True

    evaluated = {'text': core['text'], 'result': core['recognition'],
                 'original_result': core['recognition_original'], 'audio': core['audio_provenance'],
                 'quality_flags': recognition_flags(core['recognition'], core['audio_provenance'], end-start),
                 'alternative': None}
    def piece(begin, finish, path):
        item = attempt('shorter_window_retry', begin, finish, path)
        return item['result'], item['audio_provenance']
    target = job/'windows'/f'{track}-{round(start*16000)}.wav'
    fallback = _shorter_retry(spec, config, session, rows, start, end, target, evaluated,
                              infer, speech_gate, gate, retry_piece=piece, allow_single_piece=expanded)
    if not keep_running():
        raise _RecoveryInterrupted()
    promoted = fallback['alternative'] is not None and fallback['alternative']['promoted']
    original_snapshot = copy.deepcopy(core)
    recovery.update(state='complete', method='shorter_window_retry' if promoted else 'original')
    replacement = _segment_record(core['id'], track, core['profile'], core['model_id'], start, end, fallback)
    replacement['recovery'] = copy.deepcopy(recovery)
    if promoted:
        replacement['replaces_segment_ids'] = [core['id']]
        _archive_segments(status, [original_snapshot], [core['id']])
    status['segments'][status['segments'].index(core)] = replacement
    _selection_changed(status)
    return True


@contextlib.contextmanager
def job_lock(path: Path):
    handle = path.open('a+b')
    if not path.stat().st_size:
        handle.write(b'0'); handle.flush()
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        handle.close()


def parent_alive():
    pid = int(os.environ.get('STTAPP_PARENT_PID', '0'))
    if not pid:
        return True
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        dll = ctypes.WinDLL('kernel32', use_last_error=True)
        dll.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        dll.OpenProcess.restype = wintypes.HANDLE
        dll.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        dll.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = dll.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(dll.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            dll.CloseHandle(handle)
    try:
        os.kill(pid, 0); return True
    except ProcessLookupError:
        return False


def run(config_path: Path, request_path: Path):
    with job_lock(request_path.parent / 'worker.lock'):
        return run_locked(config_path, request_path)


def run_locked(config_path: Path, request_path: Path):
    config = read_json(config_path)
    request = read_json(request_path)
    session = Path(request['session_dir']).resolve(strict=True)
    job = request_path.parent.resolve()
    model, seconds = PROFILES[request['profile']]
    registry = read_json(Path(config['registry_path']))
    spec = copy.deepcopy(next(m for m in registry['models'] if m['id'] == model))
    runtime = copy.deepcopy(config['models'][model])
    if model == 'trelis':
        spec['decoding'].update(language='en' if request['language_mode'] == 'english' else 'hi',
                                mixed_code=request['language_mode'] != 'english')
    identity = {'request_sha256': file_digest(request_path), 'session_sha256': file_digest(session/'session.json'),
                'spec': spec, 'runtime': runtime, 'worker_sha256': file_digest(Path(__file__))}
    if model == 'trelis':
        identity.update(speech_gate=config.get('speech_gate'),
                        speech_gate_worker_sha256=file_digest(Path(__file__).with_name('speech_gate.py')))
    identity_hash = digest(identity)
    status_path = job/'status.json'
    status = read_json(status_path) if status_path.exists() else {
        'version': 1, 'job_id': request['job_id'], 'session_dir': str(session), 'profile': request['profile'],
        'state': 'running', 'segments': [], 'segments_revision': 0, 'superseded_segments': [],
        'cursors': {}, 'identity': identity, 'identity_sha256': identity_hash,
        'processed_audio_seconds': 0, 'available_audio_seconds': 0, 'backlog_seconds': 0,
        'live_qualified': False, 'speaker_identification': 'unavailable', 'timestamp_kind': 'audio_window'}
    if status.get('identity_sha256') != identity_hash:
        raise ValueError('Cannot resume changed model, input or worker identity')
    status.setdefault('segments_revision', 0)
    status.setdefault('superseded_segments', [])
    # Network calls are never needed by this app worker. Native CLI also has no service URL.
    def no_network(*args, **kwargs):
        raise OSError('Local transcription worker cannot connect to a network')
    socket.socket.connect = socket.socket.connect_ex = socket.create_connection = no_network
    stop = job/'stop.request'
    status.pop('error', None)
    last_idle_publication = None
    try:
        if runtime.get('backend') == 'openvino' and not stop.exists() and parent_alive():
            # Compile while the independent recorder accumulates its first window.
            # No dummy inference or fabricated transcript enters the checkpoint.
            status.update(state='running', phase='loading_model')
            write_json(status_path, status)
            loaded = warmup(spec, runtime)
            status['model_startup'] = loaded
            if loaded['status'] != 'ok':
                raise RuntimeError('Local model could not load: ' + str(loaded.get('error')))
            status['phase'] = 'transcribing'
            write_json(status_path, status)
        while True:
            if stop.exists() or not parent_alive():
                status['state'] = 'stopped'; break
            rows, finalized, final_time, events = journal_snapshot(session)
            progressed = False
            available = {track: (final_time if finalized and rows[track] else max((r['end_seconds'] for r in rows[track]), default=0)) for track in TRACKS}
            status['available_audio_seconds'] = max(available.values())
            status['capture_finalized'] = finalized
            status['capture_event_count'] = len(events)
            # Round-robin tracks; one bounded window per track per pass.
            for track in TRACKS:
                window_runtime = {**runtime, 'speech_gate': config.get('speech_gate')} if model == 'trelis' else runtime
                if _pending_recovery(status, track) is not None:
                    if not recover_pending_segment(status, status_path, job, spec, window_runtime,
                            session, rows[track], track, finalized, infer=transcribe, gate=assess_window,
                            keep_running=lambda: not stop.exists() and parent_alive()):
                        continue
                else:
                    cursor = status['cursors'].get(track, 0)
                    limit = available[track]
                    if limit - cursor < seconds - .001 and not finalized:
                        continue
                    if limit <= cursor + 1/16000:
                        continue
                    end = min(cursor + seconds, limit)
                    segment_id = f"{request['job_id']}-{track}-{round(cursor*16000)}"
                    target = job/'windows'/f'{track}-{round(cursor*16000)}.wav'
                    status.update(state='running', phase='transcribing')
                    write_json(status_path, status)
                    evaluated = evaluate_window(spec, window_runtime, session, rows[track], cursor,
                                                 end, target, infer=transcribe, gate=assess_window,
                                                 defer_recovery=model == 'trelis')
                    segment = _segment_record(segment_id, track, request['profile'], model, cursor, end, evaluated)
                    if model == 'trelis' and needs_context_recovery(evaluated['result'], evaluated['quality_flags']):
                        committed_end = max((row['end_seconds'] for row in rows[track]), default=0)
                        left, right, desired_right, _ = context_window_bounds(cursor, end, committed_end, finalized)
                        segment['recovery'] = {'state': 'waiting_for_context', 'method': 'pending',
                            'core_segment_id': segment_id, 'core_start_seconds': cursor, 'core_end_seconds': end,
                            'context_start_seconds': left, 'context_end_seconds': right,
                            'desired_context_end_seconds': desired_right, 'requires_review': True, 'attempts': []}
                    status['segments'].append(segment)
                    status['cursors'][track] = end
                    _selection_changed(status)
                # Publish the complete canonical change before further work.
                write_json(status_path, status)
                # Inference can be slower than capture; refresh the backlog clock.
                fresh_rows, fresh_finalized, fresh_end, _ = journal_snapshot(session)
                fresh_available = {t: (fresh_end if fresh_finalized and fresh_rows[t] else max((r['end_seconds'] for r in fresh_rows[t]), default=0)) for t in TRACKS}
                status['available_audio_seconds'] = max(fresh_available.values())
                status['processed_audio_seconds'] = min((status['cursors'].get(t,0) for t in TRACKS if fresh_available[t]), default=0)
                status['backlog_seconds'] = max((fresh_available[t]-status['cursors'].get(t,0) for t in TRACKS), default=0)
                status['updated_at'] = datetime.now(timezone.utc).isoformat()
                write_json(status_path, status)
                progressed = True
                last_idle_publication = None
                if stop.exists() or not parent_alive(): break
            if stop.exists() or not parent_alive():
                status['state'] = 'stopped'; break
            if finalized and not any(_pending_recovery(status, t) for t in TRACKS) and all(
                    status['cursors'].get(t, 0) >= available[t]-1/16000 for t in TRACKS):
                status.update(state='complete', phase='complete'); break
            if not progressed:
                phase = 'waiting_for_context' if any(_pending_recovery(status, t) for t in TRACKS) else 'waiting_for_audio'
                status.update(state='waiting_for_audio', phase=phase)
                idle_key = _idle_publication_key(status)
                if idle_key != last_idle_publication:
                    write_json(status_path, status)
                    last_idle_publication = idle_key
                time.sleep(.5)
    except _RecoveryInterrupted:
        status['state'] = 'stopped'
    except Exception as exc:
        status.update(state='failed', error=str(exc))
    finally:
        status['updated_at'] = datetime.now(timezone.utc).isoformat()
        write_json(status_path, status)
    return status


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--request', type=Path, required=True)
    args = parser.parse_args()
    report = run(args.config, args.request)
    print(json.dumps({'job_id': report['job_id'], 'state': report['state']}), flush=True)
    raise SystemExit(1 if report['state'] == 'failed' else 0)
