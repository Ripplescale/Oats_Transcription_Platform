"""Synthetic recording tests; no microphone, downloaded model or network calls."""
import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import wave

import numpy as np
from scipy.signal import resample_poly
from sttbench import local_worker as worker
from sttbench.manifest import file_digest, read_json, write_json
from sttbench.runtime.api import _read_pcm


class LocalWorkerTests(unittest.TestCase):
    recovery_text = 'The speaker describes several distinct points and completes the previously interrupted thought clearly'

    def test_finalized_cpu_live_final_request_completes_without_live_gpu_qualification(self):
        row=self.chunk(0,np.ones(5*16000)*1000)
        config,request=self.transcription_job([row],final_time=5)
        settings=read_json(config)
        settings['models']['trelis']={'backend':'transformers','device':'cpu'}
        write_json(config,settings)
        document=read_json(request); document['workflow_role']='live-final'; write_json(request,document)
        calls=[]
        def infer(spec,audio,runtime):
            calls.append((runtime['backend'],runtime['device']))
            return {'status':'ok','text':self.recovery_text}
        result=self.run_synthetic(config,request,infer)
        self.assertEqual(result['state'],'complete',result.get('error'))
        self.assertEqual(result['cursors']['microphone'],5)
        self.assertEqual(result['segments'][0]['text'],self.recovery_text)
        self.assertTrue(calls)
        self.assertTrue(all(pair==('transformers','cpu') for pair in calls))
        self.assertEqual(read_json(request.parent/'status.json'),result)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='stt-worker-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.session = self.root/'session'
        self.session.mkdir()
        write_json(self.session/'session.json', {'id':'synthetic'})

    def chunk(self, sequence, samples, rate=16000, start=None, track='microphone'):
        start = float(sequence) if start is None else start
        relative = f'tracks/{track}/{sequence:08}.wav'
        path = self.session/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(rate)
            out.writeframes(np.asarray(samples, dtype='<i2').tobytes())
        return {'kind':'audio_chunk','track':track,'file':relative,'sequence':sequence,
                'sample_rate':rate,'sample_count':len(samples),'start_seconds':start,
                'end_seconds':start+len(samples)/rate,'sha256':file_digest(path)}

    def journal(self, rows, tail=b''):
        (self.session/'timeline.jsonl').write_bytes(('\n'.join(json.dumps(r) for r in rows)+'\n').encode()+tail)

    def test_compact_status_roundtrips_nested_unicode_and_default_documents_keep_format(self):
        status = {'state':'running', 'segments_revision':4, 'segments':[
            {'text':'आज की notes are ready.\nKeep both scripts.', 'start_seconds':0.125,
             'recognition':{'warnings':[], 'provenance':{'mixed_code':True}},
             'recovery':{'attempts':[{'text':'पहले words', 'selected':False, 'error':None}]}}]}
        checkpoint = self.root/'status.json'
        worker.write_json(checkpoint, status)
        self.assertEqual(read_json(checkpoint), status)
        compact = (json.dumps(status, ensure_ascii=False, allow_nan=False, separators=(',', ':'))+'\n')
        self.assertEqual(checkpoint.read_bytes(), compact.replace('\n', os.linesep).encode('utf-8'))
        self.assertFalse(checkpoint.with_name('status.json.tmp').exists())
        ordinary = self.root/'document.json'
        write_json(ordinary, status)
        previous_format = json.dumps(status, indent=2, ensure_ascii=False, allow_nan=False)+'\n'
        self.assertEqual(ordinary.read_bytes(), previous_format.replace('\n', os.linesep).encode('utf-8'))
        self.assertEqual(read_json(ordinary), status)
        self.assertLess(checkpoint.stat().st_size, ordinary.stat().st_size)

    def test_compact_checkpoint_failed_replace_preserves_previous_bytes_and_retry_policy(self):
        checkpoint = self.root/'status.json'
        worker.write_json(checkpoint, {'state':'running', 'text':'saved शब्द'})
        previous = checkpoint.read_bytes()
        replacement = {'state':'complete', 'text':'new शब्द'}
        with patch.object(Path, 'replace', side_effect=PermissionError('synthetic busy reader')) as replace, \
                patch('sttbench.manifest.time.sleep') as sleep:
            with self.assertRaisesRegex(PermissionError, 'busy reader'):
                worker.write_json(checkpoint, replacement)
        self.assertEqual(replace.call_count, 12)
        self.assertEqual(sleep.call_count, 11)
        self.assertEqual(checkpoint.read_bytes(), previous)
        self.assertEqual(read_json(checkpoint), {'state':'running', 'text':'saved शब्द'})
        self.assertEqual(read_json(checkpoint.with_name('status.json.tmp')), replacement)
        worker.write_json(checkpoint, replacement)
        self.assertEqual(read_json(checkpoint), replacement)
        self.assertFalse(checkpoint.with_name('status.json.tmp').exists())

    def test_invalid_compact_value_cannot_replace_existing_checkpoint(self):
        checkpoint = self.root/'status.json'
        worker.write_json(checkpoint, {'state':'running', 'text':'saved'})
        previous = checkpoint.read_bytes()
        with self.assertRaises(ValueError):
            worker.write_json(checkpoint, {'timing':float('nan')})
        self.assertEqual(checkpoint.read_bytes(), previous)

    def test_partial_tail_is_ignored_but_missing_chunk_fails(self):
        row = self.chunk(0, np.zeros(16000))
        self.journal([row], b'{"kind":')
        self.assertEqual(len(worker.journal_snapshot(self.session)[0]['microphone']), 1)
        self.journal([row, {**row,'sequence':2}])
        with self.assertRaisesRegex(ValueError, 'sequence'):
            worker.journal_snapshot(self.session)
        self.journal([row], b'{broken}\n')
        with self.assertRaises(json.JSONDecodeError): worker.journal_snapshot(self.session)

    def test_source_hash_and_containment_are_enforced(self):
        row = self.chunk(0, np.zeros(16000))
        with self.assertRaisesRegex(ValueError, 'digest'):
            worker.materialize(self.session, [{**row,'sha256':'invalid'}], 0, 1, self.root/'window.wav')
        (self.root/'outside.wav').write_bytes((self.session/row['file']).read_bytes())
        with self.assertRaisesRegex(ValueError, 'leaves'):
            worker.materialize(self.session, [{**row,'file':'../outside.wav'}], 0, 1, self.root/'window.wav')

    def test_recovered_partial_tail_only_finalizes_with_bound_verification(self):
        row = self.chunk(0,np.zeros(16000))
        self.journal([row],b'{incomplete')
        write_json(self.session/'metadata.json',{'status':'recovered'})
        write_json(self.session/'recovery-verified.json',{'verified':True,'duration_seconds':1,
            'source_journal_sha256':file_digest(self.session/'timeline.jsonl')})
        self.assertTrue(worker.journal_snapshot(self.session)[1])
        self.journal([row],b'{changed')
        with self.assertRaisesRegex(ValueError,'verified journal'): worker.journal_snapshot(self.session)

    def test_contiguous_files_resample_as_one_span(self):
        rate = 48000
        values = np.rint(np.sin(np.arange(rate*2)*.1)*8000).astype('<i2')
        rows = [self.chunk(0, values[:rate],rate), self.chunk(1, values[rate:],rate)]
        target = self.root/'window.wav'
        report = worker.materialize(self.session, rows, 0, 2, target)
        with wave.open(str(target), 'rb') as wav:
            actual = np.frombuffer(wav.readframes(wav.getnframes()),dtype='<i2')
        expected = np.clip(np.rint(resample_poly(values.astype(np.float32)/32768,1,3)*32768),-32768,32767).astype('<i2')
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(report['uncovered_seconds'], 0)

    def test_gap_is_kept_as_silence_and_overlap_is_flagged(self):
        rows = [self.chunk(0,np.ones(16000)*1000,start=1),self.chunk(1,np.ones(16000)*2000,start=1.5)]
        report = worker.materialize(self.session,rows,0,3,self.root/'window.wav')
        self.assertEqual(report['uncovered_seconds'],1.5)
        self.assertEqual(report['overlap_seconds'],.5)
        self.assertIn('capture_gap',worker.review_flags('words',report,3))

    def test_short_retry_preserves_original_instead_of_choosing_longer(self):
        row = self.chunk(0,np.ones(15*16000)*1000)
        calls = []
        def infer(spec,path,config):
            calls.append(path)
            return {'status':'ok','text':'original' if len(calls)==1 else 'an alternative with several more words'}
        result = worker.evaluate_window({}, {}, self.session, [row],0,15,self.root/'window.wav',infer)
        self.assertEqual(result['text'],'original')
        self.assertTrue(result['alternative']['requires_review'])
        self.assertEqual(len(calls),3)
        self.assertEqual([(p['start_seconds'],p['end_seconds']) for p in result['alternative']['chunks']],[(0,10),(10,15)])

    def test_digital_silence_bypasses_inference(self):
        row = self.chunk(0,np.zeros(16000))
        def infer(*args): self.fail('All-zero PCM must not call a model')
        result = worker.evaluate_window({}, {}, self.session,[row],0,1,self.root/'zero.wav',infer)
        self.assertEqual(result['text'],'')
        self.assertTrue(result['audio']['digital_silence'])

    def test_quiet_system_audio_preserves_recognition_and_flags_review(self):
        row = self.chunk(0, np.ones(16000) * 8, track='system')
        for text in ('nan', 'Mira'):
            with self.subTest(text=text):
                calls = []
                def infer(*args):
                    calls.append(args)
                    return {'status': 'ok', 'text': text}
                result = worker.evaluate_window({}, {}, self.session, [row], 0, 1,
                                                self.root / 'quiet.wav', infer)
                self.assertEqual(result['text'], text)
                self.assertEqual(len(calls), 1)
                self.assertIn('very_quiet_audio', result['quality_flags'])
                self.assertIsNone(result['alternative'])
        loud = self.chunk(1, np.ones(16000) * 1000)
        result = worker.evaluate_window({}, {}, self.session, [loud], 1, 2,
                                        self.root / 'audible.wav', infer)
        self.assertNotIn('very_quiet_audio', result['quality_flags'])

    def test_whole_quiet_microphone_window_skips_detector_decoder_and_retries(self):
        row = self.chunk(0, np.ones(20 * 16000) * 196)
        before = file_digest(self.session / row['file'])
        for model in ('trelis', 'apex'):
            with self.subTest(model=model):
                with patch.object(worker, 'transcribe') as infer, patch.object(worker, 'assess_window') as gate:
                    result = worker.evaluate_window({'id': model}, {}, self.session, [row], 0, 20,
                                                    self.root / 'quiet.wav', infer, gate=gate)
                    infer.assert_not_called()
                    gate.assert_not_called()
                self.assertEqual(result['text'], '')
                self.assertFalse(result['audio']['digital_silence'])
                self.assertIn('quiet_microphone_omitted', result['quality_flags'])
                self.assertIsNone(result['alternative'])
                policy = result['result']['provenance']['volume_gate']
                self.assertEqual(policy['threshold_rms'], .006)
                self.assertTrue(policy['source_audio_preserved'])
        self.assertEqual(file_digest(self.session / row['file']), before)

    def test_one_frame_above_microphone_cutoff_retains_whole_window(self):
        samples = np.ones(16000) * 8
        samples[320:640] = 197
        row = self.chunk(0, samples)
        def infer(*args):
            return {'status': 'ok', 'text': 'हाँ, keep the whole sentence'}
        with patch.object(worker, 'transcribe', side_effect=infer) as model:
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 1,
                                            self.root / 'audible-frame.wav', model, gate=self.keep_gate)
        model.assert_called_once()
        self.assertEqual(result['text'], 'हाँ, keep the whole sentence')
        self.assertNotIn('quiet_microphone_omitted', result['quality_flags'])
        self.assertNotIn('very_quiet_audio', result['quality_flags'])

    def test_quiet_unidentified_track_is_not_assumed_to_be_microphone(self):
        row = self.chunk(0, np.ones(16000) * 8, track='unknown')
        with patch.object(worker, 'transcribe', return_value={'status': 'ok', 'text': 'keep me'}) as model:
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 1,
                                            self.root / 'unknown.wav', model, gate=self.keep_gate)
        model.assert_called_once()
        self.assertEqual(result['text'], 'keep me')
        self.assertNotIn('quiet_microphone_omitted', result['quality_flags'])

    def keep_gate(self, *args):
        return {'status': 'ok', 'skip_stt': False, 'decision': 'keep',
                'model_sha256': 'a' * 64, 'elapsed_seconds': .01,
                'raw_max_probability': .6, 'boosted_max_probability': .8}

    def recovery_fixture(self, row, start, end, previous=(), text=None, diagnostics=None):
        job = self.root/'context-job'
        job.mkdir(exist_ok=True)
        job_id = '12345678-1234-1234-1234-123456789abc'
        text = 'वो जब था ' * 5 if text is None else text
        def segment(begin, finish, value, track='microphone', source_row=row, segment_id=None):
            audio = worker.materialize(self.session, [source_row], begin, finish,
                                       job/'windows'/f'{track}-{round(begin*16000)}.wav')
            result = {'status': 'ok', 'text': value, 'decoding_diagnostics': diagnostics or {}}
            evaluated = {'text': value, 'result': result, 'original_result': copy.deepcopy(result),
                         'audio': audio, 'quality_flags': worker.recognition_flags(result, audio, finish-begin),
                         'alternative': None}
            return worker._segment_record(segment_id or f'{job_id}-{track}-{round(begin*16000)}',
                                          track, 'trelis-20', 'trelis', begin, finish, evaluated)
        core = segment(start, end, text)
        left, right, desired, _ = worker.context_window_bounds(start, end, row['end_seconds'], True)
        core['quality_flags'].extend(['context_retry_pending', 'needs_review'])
        core['recovery'] = {'state': 'waiting_for_context', 'method': 'pending',
                            'core_segment_id': core['id'], 'core_start_seconds': start, 'core_end_seconds': end,
                            'context_start_seconds': left, 'context_end_seconds': right,
                            'desired_context_end_seconds': desired, 'requires_review': True, 'attempts': []}
        segments = [segment(*args) for args in previous] + [core]
        status = {'version': 1, 'job_id': job_id, 'segments': segments, 'segments_revision': len(segments),
                  'superseded_segments': [], 'cursors': {'microphone': end}, 'state': 'running'}
        return status, job, segment

    def test_context_bounds_match_profiles_and_clamp_capture_edges(self):
        for seconds, expected in ((20, (35,65)), (10, (30,60)), (5, (27.5,57.5))):
            with self.subTest(seconds=seconds):
                self.assertEqual(worker.context_window_bounds(40,40+seconds,100,False),
                                 (*expected, expected[1], True))
                self.assertFalse(worker.context_window_bounds(40,40+seconds,40+seconds,False)[3])
        self.assertEqual(worker.context_window_bounds(0,20,20,False), (0,25,25,False))
        self.assertEqual(worker.context_window_bounds(0,20,20,True), (0,20,25,True))
        self.assertEqual(worker.context_window_bounds(20,23,23,True), (6.5,23,36.5,True))

    def test_live_near_full_core_context_never_exceeds_runtime_thirty_second_cap(self):
        # All are accepted by the run loop's seconds-.001 live tolerance.
        for start,end in ((20,39.9990625),(60,79.9998125),(0,19.9990625)):
            with self.subTest(start=start,end=end):
                self.assertGreaterEqual(end-start,20-.001)
                row=self.chunk(0,np.ones(50*16000)*1000,start=max(0,start-20))
                left,right,desired,ready=worker.context_window_bounds(start,end,row['end_seconds'],False)
                self.assertTrue(ready)
                self.assertEqual(right,desired)
                frames=round((right-left)*16000)
                self.assertLessEqual(frames,30*16000)
                if start:self.assertEqual(frames,30*16000)
                path=self.root/'odd-padding.wav'
                worker.materialize(self.session,[row],left,right,path)
                _,duration=_read_pcm(path)  # Actual runtime validation; no inference.
                self.assertLessEqual(duration,30)
                pending=worker.context_window_bounds(start,end,end,False)
                self.assertFalse(pending[3])
                self.assertEqual(pending[:3],(left,right,desired))
                final_left,final_right,final_desired,final_ready=worker.context_window_bounds(start,end,end,True)
                self.assertTrue(final_ready)
                self.assertEqual(final_right,end)
                self.assertEqual((final_left,final_desired),(left,desired))
                self.assertLessEqual(round((final_right-final_left)*16000),30*16000)

    def test_final_context_preserves_unaligned_committed_edge_without_added_audio(self):
        end=20+959999/48000
        left,right,desired,ready=worker.context_window_bounds(20,end,end,True)
        self.assertTrue(ready)
        self.assertEqual(right,end)
        self.assertLessEqual(round((desired-left)*16000),30*16000)
        self.assertLessEqual(right,end)

    def test_token_cap_defers_context_without_deleting_low_confidence_text(self):
        row = self.chunk(0, np.ones(20*16000)*1000)
        result = {'status':'ok', 'text':'short but unfinished words', 'decoding_diagnostics':{
            'token_cap_reached': True, 'avg_logprob': None, 'no_speech_probability': None}}
        evaluated = worker.evaluate_window({'id':'trelis'}, {}, self.session, [row], 0,20,
                                            self.root/'cap.wav', lambda *args:result,
                                            gate=self.keep_gate, defer_recovery=True)
        self.assertEqual(evaluated['text'], result['text'])
        self.assertIsNone(evaluated['alternative'])
        self.assertIn('token_cap_reached', evaluated['quality_flags'])
        self.assertIn('context_retry_pending', evaluated['quality_flags'])
        with self.assertRaisesRegex(RuntimeError, 'device failed'):
            worker.evaluate_window({'id':'trelis'}, {}, self.session,[row],0,20,self.root/'failed.wav',
                lambda *args:{'status':'failed','error':'device failed'}, gate=self.keep_gate, defer_recovery=True)

    def test_context_replaces_whole_range_and_re_recognizes_fringe_without_other_track_loss(self):
        row = self.chunk(0,np.ones(60*16000)*1000)
        before = file_digest(self.session/row['file'])
        status, job, segment = self.recovery_fixture(row,20,40,previous=[(0,20,'earlier words')])
        # A later retry may cut into an earlier context segment: IDs stay flat.
        status['segments'][0]['id'] = status['job_id'] + '-microphone-c-0-320000'
        system_row = self.chunk(0,np.ones(60*16000)*1500,track='system')
        system = segment(0,60,'computer words','system',system_row)
        status['segments'].insert(1,system)
        originals = copy.deepcopy(status['segments'])
        calls = []
        def infer(spec,path,config):
            calls.append(path.name)
            return {'status':'ok','text':self.recovery_text}
        self.assertTrue(worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},
                         self.session,[row],'microphone',True,infer=infer,gate=self.keep_gate))
        mic = [s for s in status['segments'] if s['source_track']=='microphone']
        self.assertEqual([(s['start_seconds'],s['end_seconds']) for s in mic],[(0,15),(15,45)])
        self.assertEqual([s for s in status['segments'] if s['source_track']=='system'],[system])
        self.assertEqual(len(calls),2)
        self.assertEqual(status['cursors']['microphone'],45)
        self.assertEqual(status['segments_revision'],3)
        self.assertTrue(all(len(s['id'])<=100 for s in mic))
        self.assertTrue(mic[0]['id'].endswith('-f-0-240000'))
        context = mic[1]
        self.assertEqual(context['text'],self.recovery_text)
        self.assertEqual(context['recognition_original']['text'],originals[-1]['text'])
        self.assertEqual(context['recovery']['method'],'context_window_retry')
        self.assertEqual(set(context['replaces_segment_ids']),{originals[0]['id'], originals[-1]['id']})
        self.assertEqual(len(status['superseded_segments']),2)
        self.assertEqual(status['superseded_segments'][-1]['recovery']['state'],'waiting_for_context')
        self.assertTrue(all(s['superseded_at_segments_revision']==3 for s in status['superseded_segments']))
        self.assertEqual(file_digest(self.session/row['file']),before)

    def test_bad_context_uses_five_second_fallback_even_when_pieces_still_loop(self):
        row = self.chunk(0,np.ones(40*16000)*1000)
        loop = 'वो जब था ' * 5
        failures = ({'status':'ok','text':loop}, {'status':'failed','text':'','error':'recovery failed'},
                    {'status':'ok','text':''}, {'status':'ok','text':'unfinished context',
                     'decoding_diagnostics':{'token_cap_reached':True}})
        for context_result in failures:
            with self.subTest(context_result=context_result):
                status,job,_ = self.recovery_fixture(row,10,20,previous=[(0,10,'earlier words')])
                original = copy.deepcopy(status['segments'])
                def infer(spec,path,config):
                    return context_result if '-context-' in path.name else {'status':'ok','text':loop}
                worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                                               [row],'microphone',True,infer=infer,gate=self.keep_gate)
                self.assertEqual(status['segments'][0],original[0])
                selected = status['segments'][1]
                self.assertEqual(selected['id'],original[1]['id'])
                self.assertEqual(selected['text'],loop+'\n\n'+loop)
                self.assertEqual(selected['recovery']['method'],'shorter_window_retry')
                self.assertIn('repeated_phrase',selected['quality_flags'])
                self.assertFalse(selected['alternative']['long_repetition_resolved'])
                self.assertEqual([a['kind'] for a in selected['recovery']['attempts']],
                                 ['context_window_retry','shorter_window_retry','shorter_window_retry'])
                self.assertEqual(status['cursors']['microphone'],20)
                self.assertEqual(status['superseded_segments'][0]['id'],selected['id'])

    def test_uncertain_nonzero_fringe_keeps_prior_words_and_ignores_gate_skip(self):
        row = self.chunk(0,np.ones(60*16000)*1000)
        failures = ({'status':'ok','text':''}, {'status':'failed','text':'','error':'fringe failed'},
                    {'status':'ok','text':'वो जब था '*5}, {'status':'ok','text':'unfinished fringe',
                     'decoding_diagnostics':{'token_cap_reached':True}})
        for fringe_result in failures:
            with self.subTest(fringe_result=fringe_result):
                status,job,_ = self.recovery_fixture(row,20,40,previous=[(0,20,'earlier words')])
                previous = copy.deepcopy(status['segments'][0])
                calls = []
                def infer(spec,path,config):
                    calls.append(path.name)
                    if '-fringe-' in path.name:return fringe_result
                    return {'status':'ok','text':self.recovery_text}
                def gate(path,config):
                    return {**self.keep_gate(),'skip_stt': '-fringe-' in path.name}
                worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                                               [row],'microphone',True,infer=infer,gate=gate)
                self.assertEqual(status['segments'][0],previous)
                selected = status['segments'][1]
                self.assertEqual(selected['recovery']['method'],'shorter_window_retry')
                fringe = selected['recovery']['attempts'][1]
                self.assertEqual(fringe['kind'],'overlap_fringe')
                self.assertTrue(fringe['audio_provenance']['speech_gate']['skip_overridden_for_overlap_fringe'])
                self.assertFalse(fringe['audio_provenance']['speech_gate']['skip_stt'])
                self.assertTrue(any('-fringe-' in call for call in calls))
                self.assertEqual(len(status['superseded_segments']),1)

    def assert_sparse_recovery_preserves_neighbor(self, sparse_kind):
        row=self.chunk(0,np.ones(60*16000)*1000)
        status,job,_=self.recovery_fixture(row,20,40,previous=[(0,20,self.recovery_text)])
        previous=copy.deepcopy(status['segments'][0])
        def infer(spec,path,config):
            if '-context-' in path.name:
                text='word' if sparse_kind=='context_window_retry' else self.recovery_text
            else:
                # One-word fringe and fallback pieces are both completed and nonempty.
                # Sparse context/fringes cannot erase neighbors; fallback stays visible.
                text='word'
            return {'status':'ok','text':text}
        worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                                       [row],'microphone',True,infer=infer,gate=self.keep_gate)
        self.assertEqual(status['segments'][0],previous)
        selected=status['segments'][1]
        self.assertEqual(selected['recovery']['method'],'shorter_window_retry')
        self.assertEqual(selected['text'],'\n\n'.join(['word']*4))
        self.assertIn('suspiciously_sparse_text',selected['quality_flags'])
        self.assertTrue(selected['alternative']['promoted'])
        self.assertTrue(selected['alternative']['all_chunks_ok'])
        sparse_attempt=next(a for a in selected['recovery']['attempts'] if a['kind']==sparse_kind)
        self.assertIn('suspiciously_sparse_text',sparse_attempt['quality_flags'])
        self.assertEqual(len(status['superseded_segments']),1)
        self.assertEqual(status['superseded_segments'][0]['id'],selected['id'])
        self.assertEqual(status['cursors']['microphone'],40)

    def test_sparse_context_uses_five_second_fallback_and_preserves_neighbor(self):
        self.assert_sparse_recovery_preserves_neighbor('context_window_retry')

    def test_sparse_fringe_uses_five_second_fallback_and_preserves_neighbor(self):
        self.assert_sparse_recovery_preserves_neighbor('overlap_fringe')

    def test_empty_or_failed_context_fallback_retains_original_core(self):
        row=self.chunk(0,np.ones(40*16000)*1000)
        loop='वो जब था '*5
        for failed in (False,True):
            with self.subTest(failed=failed):
                status,job,_=self.recovery_fixture(row,10,20,previous=[(0,10,'earlier words')])
                def infer(spec,path,config):
                    if '-context-' in path.name:return {'status':'ok','text':loop}
                    return {'status':'failed' if failed else 'ok','text':'','error':'retry failure' if failed else None}
                worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                                               [row],'microphone',True,infer=infer,gate=self.keep_gate)
                selected=status['segments'][-1]
                self.assertEqual(selected['text'],loop)
                self.assertEqual(selected['recovery']['method'],'original')
                self.assertFalse(selected['alternative']['promoted'])
                self.assertEqual(status['superseded_segments'],[])
                self.assertIn('repeated_phrase',selected['quality_flags'])
                self.assertIn('needs_review',selected['quality_flags'])
                self.assertEqual(status['segments_revision'],3)

    def test_token_cap_without_repetition_can_select_clean_context(self):
        row=self.chunk(0,np.ones(40*16000)*1000)
        status,job,_=self.recovery_fixture(row,10,20,previous=[(0,10,'earlier words')],
                    text='unfinished words',diagnostics={'token_cap_reached':True})
        worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
            [row],'microphone',True,infer=lambda *args:{'status':'ok','text':self.recovery_text,
                 'decoding_diagnostics':{'token_cap_reached':False,'avg_logprob':None,'no_speech_probability':None}},
            gate=self.keep_gate)
        self.assertEqual(len(status['segments']),1)
        selected=status['segments'][0]
        self.assertEqual(selected['text'],self.recovery_text)
        self.assertEqual((selected['start_seconds'],selected['end_seconds']),(0,30))
        self.assertEqual(selected['recovery']['method'],'context_window_retry')
        self.assertTrue(selected['recognition_original']['decoding_diagnostics']['token_cap_reached'])
        self.assertNotIn('token_cap_reached',selected['quality_flags'])

    def test_context_attempt_checkpoint_reuses_result_after_stop(self):
        row = self.chunk(0,np.ones(60*16000)*1000)
        status,job,_ = self.recovery_fixture(row,20,40,previous=[(0,20,'earlier words')])
        calls = []
        def infer(spec,path,config):
            calls.append(path.name)
            return {'status':'ok','text':self.recovery_text}
        with self.assertRaises(worker._RecoveryInterrupted):
            worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                [row],'microphone',True,infer=infer,gate=self.keep_gate,keep_running=lambda: not calls)
        saved = read_json(job/'status.json')
        self.assertEqual(saved['segments_revision'],2)
        self.assertEqual(len(saved['segments'][-1]['recovery']['attempts']),1)
        self.assertEqual(saved['segments'][-1]['recovery']['state'],'waiting_for_context')
        worker.recover_pending_segment(saved,job/'status.json',job,{'id':'trelis'}, {},self.session,
                                       [row],'microphone',True,infer=infer,gate=self.keep_gate)
        self.assertEqual(sum('-context-' in name for name in calls),1)
        self.assertEqual(sum('-fringe-' in name for name in calls),1)
        self.assertEqual(saved['segments_revision'],3)
        self.assertEqual(len(saved['superseded_segments']),2)
        self.assertFalse(worker.recover_pending_segment(saved,job/'status.json',job,{'id':'trelis'}, {},
                         self.session,[row],'microphone',True,infer=infer,gate=self.keep_gate))

    def test_same_revision_attempt_checkpoints_have_newer_timestamps(self):
        row=self.chunk(0,np.ones(60*16000)*1000)
        status,job,_=self.recovery_fixture(row,20,40,previous=[(0,20,self.recovery_text)])
        first=datetime(2026,10,7,12,0,0,100000,tzinfo=timezone.utc)
        second=first+timedelta(microseconds=1)
        snapshots=[]
        original_write=worker.write_json
        def checkpoint(path,value):
            snapshots.append(copy.deepcopy(value))
            original_write(path,value)
        with patch.object(worker,'datetime') as clock, patch.object(worker,'write_json',side_effect=checkpoint):
            clock.now.side_effect=[first,second]
            worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                [row],'microphone',True,infer=lambda *args:{'status':'ok','text':self.recovery_text},
                gate=self.keep_gate)
        self.assertEqual(len(snapshots),4)
        self.assertEqual([len(s['segments'][-1]['recovery']['attempts']) for s in snapshots],[0,1,1,2],
                         'Each model attempt publishes its running phase before its completed result')
        self.assertTrue(all(s['state']=='running' and s['phase']=='recovering_context' for s in snapshots))
        snapshots=snapshots[1::2]  # Completed attempt timestamps remain strictly newer.
        self.assertEqual([s['segments_revision'] for s in snapshots],[2,2])
        self.assertEqual([s['updated_at'] for s in snapshots],[first.isoformat(),second.isoformat()])
        self.assertLess(datetime.fromisoformat(snapshots[0]['updated_at']),
                        datetime.fromisoformat(snapshots[1]['updated_at']))
        self.assertEqual([len(s['segments'][-1]['recovery']['attempts']) for s in snapshots],[1,2])

    def test_cached_recovery_rejects_changed_derived_audio(self):
        row = self.chunk(0,np.ones(60*16000)*1000)
        status,job,_ = self.recovery_fixture(row,20,40,previous=[(0,20,'earlier words')])
        calls = []
        def infer(*args):
            calls.append(True)
            return {'status':'ok','text':self.recovery_text}
        with self.assertRaises(worker._RecoveryInterrupted):
            worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,
                [row],'microphone',True,infer=infer,gate=self.keep_gate,keep_running=lambda: not calls)
        changed = self.chunk(0,np.ones(60*16000)*2000)
        with self.assertRaisesRegex(ValueError,'Recovery audio changed'):
            worker.recover_pending_segment(read_json(job/'status.json'),job/'status.json',job,{'id':'trelis'}, {},
                self.session,[changed],'microphone',True,infer=infer,gate=self.keep_gate)
        self.assertEqual(len(calls),1)

    def test_five_second_core_attempts_context_before_single_piece_fallback(self):
        row = self.chunk(0,np.ones(40*16000)*1000)
        status,job,_ = self.recovery_fixture(row,10,15,previous=[(0,10,'earlier words')])
        calls = []
        def infer(spec,path,config):
            calls.append(path.name)
            return {'status':'ok','text':'वो जब था '*5 if '-context-' in path.name else 'recovered five seconds'}
        worker.recover_pending_segment(status,job/'status.json',job,{'id':'trelis'}, {},self.session,[row],
                                       'microphone',True,infer=infer,gate=self.keep_gate)
        self.assertEqual(len(calls),2)
        self.assertIn('-context-',calls[0])
        self.assertEqual(status['segments'][-1]['text'],'recovered five seconds')
        self.assertEqual(status['segments'][-1]['recovery']['method'],'shorter_window_retry')

    def transcription_job(self, rows, profile='trelis-20', final_time=None):
        events = rows if final_time is None else [*rows,{'kind':'capture_stopped','at_seconds':final_time},
                                                   {'kind':'capture_finalized'}]
        self.journal(events)
        registry = self.root/'models.json'
        write_json(registry,{'models':[{'id':'trelis','decoding':{}}]})
        config = self.root/'runtime.json'
        write_json(config,{'registry_path':str(registry),'models':{'trelis':{}},'speech_gate':{}})
        job = self.root/'run-job';job.mkdir()
        request = job/'request.json'
        write_json(request,{'job_id':'run-synthetic','session_dir':str(self.session),
                            'profile':profile,'language_mode':'hinglish'})
        return config,request

    def run_synthetic(self, config, request, infer, sleep=None):
        # Mock this worker's waiting clock, preserving manifest.py's independent
        # real time.sleep for transient Windows JSON replacement retries.
        with patch.object(socket.socket,'connect',socket.socket.connect), patch.object(socket.socket,'connect_ex',socket.socket.connect_ex), patch.object(socket,'create_connection',socket.create_connection), patch.object(worker,'parent_alive',return_value=True), patch.object(worker,'transcribe',side_effect=infer), patch.object(worker,'assess_window',side_effect=self.keep_gate), patch.object(worker,'time') as clock:
            clock.sleep.side_effect=sleep or (lambda delay:self.fail('Unexpected wait for synthetic capture'))
            return worker.run(config,request)

    def test_unchanged_idle_publishes_once_and_stop_still_checkpoints(self):
        row = self.chunk(0, np.ones(16000)*1000)
        config, request = self.transcription_job([row])
        snapshots, waits = [], []
        original_write = worker.write_json
        def checkpoint(path, value):
            snapshots.append(copy.deepcopy(value))
            original_write(path, value)
        def wait(delay):
            waits.append(delay)
            self.assertEqual(read_json(request.parent/'status.json')['state'], 'waiting_for_audio')
            if len(waits) == 4:
                (request.parent/'stop.request').write_text('stop', encoding='utf-8')
        with patch.object(worker, 'write_json', side_effect=checkpoint):
            result = self.run_synthetic(config, request,
                lambda *args: self.fail('Incomplete live window must not infer'), wait)
        idle = [s for s in snapshots if s['state'] == 'waiting_for_audio']
        self.assertEqual(len(idle), 1)
        self.assertEqual(waits, [.5]*4)
        self.assertEqual([s['state'] for s in snapshots], ['waiting_for_audio', 'stopped'])
        self.assertEqual(result['state'], 'stopped')
        self.assertEqual(read_json(request.parent/'status.json'), result)

    def test_changed_idle_audio_and_capture_event_publish_without_extra_inference(self):
        first = self.chunk(0, np.ones(16000)*1000)
        config, request = self.transcription_job([first])
        snapshots, waits = [], []
        original_write = worker.write_json
        def checkpoint(path, value):
            snapshots.append(copy.deepcopy(value))
            original_write(path, value)
        def wait(delay):
            waits.append(delay)
            if len(waits) == 2:
                second = self.chunk(1, np.ones(16000)*1200, start=1)
                self.journal([first, second])
            elif len(waits) == 3:
                rows = worker.journal_snapshot(self.session)[3]
                self.journal([*rows, {'kind':'capture_stopped', 'at_seconds':2}])
            elif len(waits) == 5:
                (request.parent/'stop.request').write_text('stop', encoding='utf-8')
        with patch.object(worker, 'write_json', side_effect=checkpoint):
            result = self.run_synthetic(config, request,
                lambda *args: self.fail('Incomplete live window must not infer'), wait)
        idle = [s for s in snapshots if s['state'] == 'waiting_for_audio']
        self.assertEqual([s['available_audio_seconds'] for s in idle], [1, 2, 2])
        self.assertEqual([s['capture_event_count'] for s in idle], [1, 2, 3])
        self.assertTrue(all(s['phase'] == 'waiting_for_audio' for s in idle))
        self.assertEqual(result['state'], 'stopped')

    def test_idle_phase_change_and_pending_recovery_keep_required_checkpoints(self):
        first = self.chunk(0, np.ones(16000)*1000)
        config, request = self.transcription_job([first])
        snapshots, waits, calls = [], [], []
        recovery_states = []
        original_write = worker.write_json
        def checkpoint(path, value):
            snapshots.append(copy.deepcopy(value))
            original_write(path, value)
        def infer(spec, path, runtime):
            calls.append(path.name)
            if '-context-' in path.name:
                loading = read_json(request.parent/'status.json')
                recovery_states.append((loading['state'], loading['phase']))
            return {'status':'ok', 'text':'वो जब था '*5 if path.name == 'microphone-0.wav'
                    else self.recovery_text}
        def wait(delay):
            waits.append(delay)
            if len(waits) == 1:
                second = self.chunk(1, np.ones(19*16000)*1200, start=1)
                self.journal([first, second])
            elif len(waits) == 3:
                rows = worker.journal_snapshot(self.session)[3]
                future = self.chunk(2, np.ones(10*16000)*1400, start=20)
                self.journal([*rows, future, {'kind':'capture_stopped', 'at_seconds':30},
                              {'kind':'capture_finalized'}])
            elif len(waits) > 3:
                self.fail('Finalized recovery must finish without another idle wait')
        with patch.object(worker, 'write_json', side_effect=checkpoint):
            result = self.run_synthetic(config, request, infer, wait)
        idle = [s for s in snapshots if s['state'] == 'waiting_for_audio']
        self.assertEqual([s['phase'] for s in idle], ['waiting_for_audio', 'waiting_for_context'])
        self.assertEqual([s['segments_revision'] for s in idle], [0, 1])
        attempts = [s for s in snapshots if s.get('phase') == 'recovering_context'
                    and any(segment.get('recovery', {}).get('attempts') for segment in s['segments'])]
        self.assertTrue(attempts, 'The completed context attempt must still be checkpointed')
        self.assertEqual(result['state'], 'complete', result.get('error'))
        self.assertEqual(result['cursors']['microphone'], 30)
        self.assertEqual(sum('-context-' in name for name in calls), 1)
        self.assertEqual(recovery_states, [('running', 'recovering_context')],
                         'A blocked recovery call must be visible to the worker watchdog')
        self.assertEqual(read_json(request.parent/'status.json'), result)

    def test_canonical_result_is_durable_before_fresh_journal_read(self):
        row = self.chunk(0, np.ones(20*16000)*1000)
        config, request = self.transcription_job([row], final_time=20)
        calls, checked = [], []
        original_snapshot = worker.journal_snapshot
        def infer(*args):
            calls.append(1)
            return {'status':'ok', 'text':self.recovery_text}
        def journal(session):
            if calls:
                saved = read_json(request.parent/'status.json')
                self.assertEqual(saved['segments'][0]['text'], self.recovery_text)
                self.assertEqual(saved['segments_revision'], 1)
                self.assertEqual(saved['cursors']['microphone'], 20)
                checked.append(1)
            return original_snapshot(session)
        with patch.object(worker, 'journal_snapshot', side_effect=journal):
            result = self.run_synthetic(config, request, infer)
        self.assertTrue(checked)
        self.assertEqual(result['state'], 'complete')

    def test_live_pending_core_waits_while_other_track_continues_then_resumes_once(self):
        mic = self.chunk(0,np.ones(20*16000)*1000)
        system = self.chunk(0,np.ones(40*16000)*1200,track='system')
        config,request = self.transcription_job([mic,system])
        calls=[]
        def infer(spec,path,runtime):
            calls.append(path.name)
            return {'status':'ok','text':'वो जब था '*5 if path.name=='microphone-0.wav'
                    else 'The speaker continues with several ordinary distinct words in this complete audio window '+path.stem}
        def advance_capture(delay):
            saved=read_json(request.parent/'status.json')
            self.assertEqual(saved['state'],'waiting_for_audio')
            self.assertEqual(saved['phase'],'waiting_for_context')
            self.assertEqual(saved['cursors'],{'microphone':20,'system':40})
            self.assertEqual(saved['segments_revision'],3)
            self.assertEqual(len(saved['segments'][0]['recovery']['attempts']),0)
            self.assertEqual(saved['segments'][0]['text'],'वो जब था '*5)
            future=self.chunk(1,np.ones(20*16000)*1400,start=20)
            self.journal([mic,system,future,{'kind':'capture_stopped','at_seconds':40}, {'kind':'capture_finalized'}])
        first=self.run_synthetic(config,request,infer,advance_capture)
        self.assertEqual(first['state'],'complete', first.get('error'))
        self.assertEqual(len(calls),5)
        self.assertEqual(calls[:3],['microphone-0.wav','system-0.wav','system-320000.wav'])
        self.assertIn('-context-',calls[3])
        self.assertEqual(calls[4],'microphone-400000.wav')
        self.assertEqual(first['cursors'],{'microphone':40,'system':40})
        self.assertEqual(first['segments_revision'],5)
        for track,expected in (('microphone',[(0,25),(25,40)]),('system',[(0,20),(20,40)])):
            self.assertEqual([(s['start_seconds'],s['end_seconds']) for s in first['segments']
                              if s['source_track']==track],expected)
        self.assertEqual(len(first['superseded_segments']),1)
        second=self.run_synthetic(config,request,infer)
        self.assertEqual(len(calls),5)
        self.assertEqual(first['segments'],second['segments'])
        self.assertEqual(first['superseded_segments'],second['superseded_segments'])
        self.assertEqual(second['segments_revision'],5)

    def test_final_tail_context_never_pads_past_committed_audio(self):
        row=self.chunk(0,np.ones(23*16000)*1000)
        config,request=self.transcription_job([row],final_time=23)
        calls=[]
        def infer(spec,path,runtime):
            with wave.open(str(path),'rb') as wav:duration=wav.getnframes()/wav.getframerate()
            calls.append((path.name,duration))
            return {'status':'ok','text':'वो जब था '*5 if path.name=='microphone-320000.wav' else self.recovery_text}
        result=self.run_synthetic(config,request,infer)
        self.assertEqual(result['state'],'complete')
        self.assertEqual([s['end_seconds'] for s in result['segments']],[6.5,23])
        self.assertEqual(result['cursors']['microphone'],23)
        self.assertEqual([duration for name,duration in calls if '-context-' in name],[16.5])
        context=result['segments'][-1]
        self.assertEqual(context['recovery']['context_end_seconds'],23)
        self.assertEqual(context['recovery']['desired_context_end_seconds'],36.5)
        self.assertEqual(context['audio_provenance']['uncovered_seconds'],0)

    def test_primary_failure_keeps_failure_state_cursor_and_original_source(self):
        row=self.chunk(0,np.ones(20*16000)*1000)
        config,request=self.transcription_job([row],final_time=20)
        before=file_digest(self.session/row['file'])
        result=self.run_synthetic(config,request,lambda *args:{'status':'failed','error':'synthetic GPU failure'})
        self.assertEqual(result['state'],'failed')
        self.assertIn('synthetic GPU failure',result['error'])
        self.assertEqual(result['segments'],[])
        self.assertEqual(result['cursors'],{})
        self.assertEqual(result['segments_revision'],0)
        self.assertEqual(file_digest(self.session/row['file']),before)

    def test_stop_after_context_checkpoint_preserves_provisional_core_for_resume(self):
        row=self.chunk(0,np.ones(45*16000)*1000)
        config,request=self.transcription_job([row],final_time=45)
        calls=[]
        def infer(spec,path,runtime):
            calls.append(path.name)
            if '-context-' in path.name:
                (request.parent/'stop.request').write_text('stop',encoding='utf-8')
            return {'status':'ok','text':'वो जब था '*5 if path.name=='microphone-320000.wav' else self.recovery_text}
        first=self.run_synthetic(config,request,infer)
        self.assertEqual(first['state'],'stopped')
        self.assertEqual(first['segments_revision'],2)
        self.assertEqual(first['cursors']['microphone'],40)
        self.assertEqual(first['segments'][-1]['recovery']['state'],'waiting_for_context')
        self.assertEqual(len(first['segments'][-1]['recovery']['attempts']),1)
        (request.parent/'stop.request').unlink()
        second=self.run_synthetic(config,request,infer)
        self.assertEqual(second['state'],'complete')
        self.assertEqual(sum('-context-' in name for name in calls),1)
        self.assertEqual(sum('-fringe-' in name for name in calls),1)
        self.assertEqual(second['cursors']['microphone'],45)
        self.assertEqual(second['segments_revision'],3)
        self.assertEqual(len(second['superseded_segments']),2)

    def test_repetition_recognizes_three_word_loop_but_allows_short_repeats(self):
        for phrase in ('जब', 'वो जब', 'वो जब था', 'a b c d e f g h'):
            with self.subTest(phrase=phrase):
                repeats = max(4, (12 + len(phrase.split()) - 1) // len(phrase.split()))
                self.assertIsNotNone(worker.repetition_details((' ' + phrase) * repeats))
        for text in ('yes yes yes', 'वो जब था वो जब था वो जब था', 'a b c d a b c d a b c d'):
            self.assertIsNone(worker.repetition_details(text))

    def test_trelis_loop_retries_once_at_five_seconds_and_preserves_every_source(self):
        loop = 'वो जब था ' * 5
        for duration in (10, 20):
            with self.subTest(duration=duration):
                row = self.chunk(0, np.ones(duration * 16000) * 1000, start=2)
                before = file_digest(self.session / row['file'])
                calls, gates = [], []
                def infer(spec, path, config):
                    calls.append(path)
                    return {'status': 'ok', 'text': loop if len(calls) == 1 else f'piece number {len(calls)}'}
                def gate(path, config):
                    gates.append(path)
                    return self.keep_gate()
                result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 2, 2 + duration,
                                                self.root / 'loop.wav', infer, gate=gate)
                self.assertEqual(len(calls), 1 + duration // 5)
                self.assertEqual(len(gates), len(calls))
                self.assertEqual(result['original_result']['text'], loop)
                self.assertNotEqual(result['text'], loop)
                self.assertTrue(result['alternative']['promoted'])
                self.assertNotIn('repeated_phrase', result['quality_flags'])
                self.assertIn('needs_review', result['quality_flags'])
                pieces = result['alternative']['chunks']
                self.assertEqual([(p['start_seconds'], p['end_seconds']) for p in pieces],
                                 [(2 + i, 7 + i) for i in range(0, duration, 5)])
                for piece in pieces:
                    self.assertEqual(piece['audio_provenance']['source_chunks'][0]['sha256'], before)
                    self.assertEqual(piece['audio_provenance']['uncovered_seconds'], 0)
                    self.assertEqual(len(piece['audio_provenance']['audio_sha256']), 64)
                    self.assertEqual(piece['source_audio_sha256'], result['audio']['audio_sha256'])
                    self.assertEqual(piece['audio_provenance']['speech_gate']['model_sha256'], 'a' * 64)
                self.assertEqual(file_digest(self.session / row['file']), before)

    def test_five_second_loop_does_not_retry_and_ordinary_repetition_is_retained(self):
        row = self.chunk(0, np.ones(5 * 16000) * 1000)
        for text in ('yes yes yes', 'वो जब था ' * 5):
            calls = []
            def infer(*args):
                calls.append(args)
                return {'status': 'ok', 'text': text}
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 5,
                                            self.root / 'five.wav', infer, gate=self.keep_gate)
            self.assertEqual(result['text'], text)
            self.assertEqual(len(calls), 1)
            self.assertIsNone(result['alternative'])
            self.assertEqual('needs_review' in result['quality_flags'], len(text.split()) > 3)

    def test_failed_retry_keeps_original_and_failed_piece_audio(self):
        loop = 'वो जब था ' * 5
        row = self.chunk(0, np.ones(10 * 16000) * 1000)
        for outcome in ('failed', 'exception'):
            calls = []
            def infer(*args):
                calls.append(args)
                if len(calls) == 1:
                    return {'status': 'ok', 'text': loop}
                if len(calls) == 2 and outcome == 'exception':
                    raise RuntimeError('synthetic model failure')
                if len(calls) == 2 and outcome == 'failed':
                    return {'status': 'failed', 'error': 'synthetic model failure'}
                return {'status': 'ok', 'text': 'speech recovered'}
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 10,
                                            self.root / 'failure.wav', infer, gate=self.keep_gate)
            self.assertEqual(len(calls), 3)
            self.assertEqual(result['text'], loop)
            self.assertFalse(result['alternative']['promoted'])
            self.assertIn('needs_review', result['quality_flags'])
            self.assertEqual(len(result['alternative']['chunks'][0]['audio_provenance']['audio_sha256']), 64)
            self.assertIn('repeated_phrase', result['quality_flags'])

    def test_still_looping_retry_selects_all_pieces_and_keeps_original_for_review(self):
        loop = 'वो जब था ' * 5
        row = self.chunk(0, np.ones(20 * 16000) * 1000)
        before = file_digest(self.session / row['file'])
        for pieces in (['पहले विषय पर बात करें', 'The deadline is Friday.',
                        'अगला कदम तय करते हैं', 'ये प्रकार देते हैं कि ' * 17],
                       [loop] * 4):
            with self.subTest(pieces=pieces):
                texts = iter([loop, *pieces])
                calls = []
                def infer(*args):
                    calls.append(args)
                    return {'status': 'ok', 'text': next(texts)}
                result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 20,
                                                self.root / 'persistent.wav', infer, gate=self.keep_gate)
                joined = '\n\n'.join(pieces)
                self.assertEqual(len(calls), 5)
                self.assertEqual(result['text'], joined)
                self.assertEqual(result['result']['text'], joined)
                self.assertEqual(result['alternative']['text'], joined)
                self.assertEqual(result['original_result']['text'], loop)
                self.assertTrue(result['alternative']['promoted'])
                self.assertTrue(result['alternative']['all_chunks_ok'])
                self.assertFalse(result['alternative']['long_repetition_resolved'])
                self.assertTrue(result['alternative']['requires_review'])
                for flag in ('retry_applied', 'needs_review', 'repeated_phrase'):
                    self.assertIn(flag, result['quality_flags'])
                self.assertEqual([(p['start_seconds'], p['end_seconds'])
                                  for p in result['alternative']['chunks']],
                                 [(0, 5), (5, 10), (10, 15), (15, 20)])
                self.assertEqual(file_digest(self.session / row['file']), before)

    def test_conservative_gate_skip_retains_nonzero_audio_and_unavailable_keeps_words(self):
        row = self.chunk(0, np.ones(20 * 16000) * 8, track='system')
        before = file_digest(self.session / row['file'])
        def infer(*args):
            return {'status': 'ok', 'text': 'Mira'}
        def no_speech(*args):
            return {'status': 'ok', 'skip_stt': True, 'raw_max_probability': .01,
                    'boosted_max_probability': .01, 'model_sha256': 'a' * 64, 'elapsed_seconds': .02}
        with patch.object(worker, 'transcribe') as model:
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 20,
                                            self.root / 'nonzero.wav', model, gate=no_speech)
            model.assert_not_called()
        self.assertEqual(result['text'], '')
        self.assertFalse(result['audio']['digital_silence'])
        self.assertEqual(result['audio']['speech_gate']['model_sha256'], 'a' * 64)
        def unavailable(*args):
            raise RuntimeError('synthetic unavailable classifier')
        result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 20,
                                        self.root / 'nonzero.wav', infer, gate=unavailable)
        self.assertEqual(result['text'], 'Mira')
        self.assertIn('speech_gate_unavailable', result['quality_flags'])
        self.assertEqual(file_digest(self.session / row['file']), before)

    def test_all_empty_or_skipped_retry_does_not_erase_speech_containing_original(self):
        loop = 'वो जब था ' * 5
        row = self.chunk(0, np.ones(10 * 16000) * 1000)
        for skip_retry in (False, True):
            calls, gates = [], []
            def infer(*args):
                calls.append(args)
                return {'status': 'ok', 'text': loop if len(calls) == 1 else ''}
            def gate(*args):
                gates.append(args)
                report = self.keep_gate()
                if len(gates) > 1 and skip_retry:
                    report.update(skip_stt=True, decision='skip', raw_max_probability=.01,
                                  boosted_max_probability=.01)
                return report
            result = worker.evaluate_window({'id': 'trelis'}, {}, self.session, [row], 0, 10,
                                            self.root / 'empty-retry.wav', infer, gate=gate)
            self.assertEqual(len(gates), 3)
            self.assertEqual(len(calls), 1 if skip_retry else 3)
            self.assertEqual(result['text'], loop)
            self.assertEqual(result['alternative']['text'], '')
            self.assertFalse(result['alternative']['promoted'])
            self.assertIn('needs_review', result['quality_flags'])
            self.assertIn('repeated_phrase', result['quality_flags'])
            self.assertEqual(len(result['alternative']['chunks']), 2)

    def test_trelis_retry_checkpoint_keeps_drafts_provenance_and_cursor_on_resume(self):
        row = self.chunk(0, np.ones(10 * 16000) * 1000)
        self.journal([row, {'kind': 'capture_stopped', 'at_seconds': 10}, {'kind': 'capture_finalized'}])
        registry = self.root / 'models.json'
        write_json(registry, {'models': [{'id': 'trelis', 'decoding': {}}]})
        config = self.root / 'runtime.json'
        gate_settings = {'model_path': 'synthetic', 'model_sha256': 'a' * 64, 'threshold': .15}
        settings = {'registry_path': str(registry), 'models': {'trelis': {}}, 'speech_gate': gate_settings}
        write_json(config, settings)
        job = self.root / 'retry-job'; job.mkdir()
        request = job / 'request.json'
        write_json(request, {'job_id': 'retry', 'session_dir': str(self.session),
                             'profile': 'trelis-10', 'language_mode': 'hinglish'})
        calls = []
        def infer(spec, path, runtime):
            self.assertEqual(runtime['speech_gate'], gate_settings)
            calls.append(path)
            return {'status': 'ok', 'text': 'वो जब था ' * 5 if len(calls) in (1, 3) else 'recovered piece 2'}
        with patch.object(socket.socket, 'connect', socket.socket.connect), patch.object(socket.socket, 'connect_ex', socket.socket.connect_ex), patch.object(socket, 'create_connection', socket.create_connection), patch.object(worker, 'parent_alive', return_value=True), patch.object(worker, 'transcribe', side_effect=infer), patch.object(worker, 'assess_window', side_effect=self.keep_gate):
            first = worker.run(config, request)
            second = worker.run(config, request)
        self.assertEqual(first['state'], 'complete')
        self.assertEqual(len(calls), 3)
        self.assertEqual(first['segments'], second['segments'])
        self.assertEqual(second['cursors']['microphone'], 10)
        self.assertEqual(second['segments'][0]['recognition_original']['text'], 'वो जब था ' * 5)
        self.assertTrue(second['segments'][0]['alternative']['promoted'])
        self.assertFalse(second['segments'][0]['alternative']['long_repetition_resolved'])
        self.assertEqual(second['segments'][0]['text'], 'recovered piece 2\n\n' + 'वो जब था ' * 5)
        self.assertIn('repeated_phrase', second['segments'][0]['quality_flags'])
        self.assertEqual(second['identity']['speech_gate'], gate_settings)
        self.assertEqual(second['segments_revision'], 2)
        self.assertEqual(second['segments'][0]['recovery']['method'], 'shorter_window_retry')
        self.assertEqual(second['superseded_segments'][0]['id'], second['segments'][0]['id'])
        write_json(config, {**settings, 'speech_gate': {**gate_settings, 'threshold': .1}})
        with self.assertRaisesRegex(ValueError, 'Cannot resume changed'):
            worker.run(config, request)

    def test_checkpoint_resume_does_not_duplicate_and_identity_changes_fail(self):
        row = self.chunk(0,np.zeros(16000))
        self.journal([row,{'kind':'capture_stopped','at_seconds':1},{'kind':'capture_finalized'}])
        registry = self.root/'models.json'; write_json(registry,{'models':[{'id':'apex','decoding':{}}]})
        config = self.root/'runtime.json'; write_json(config,{'registry_path':str(registry),'models':{'apex':{}}})
        job = self.root/'job'; job.mkdir()
        request = job/'request.json'
        req = {'job_id':'synthetic','session_dir':str(self.session),'profile':'apex-15','language_mode':'english'}
        write_json(request,req)
        with patch.object(socket.socket,'connect',socket.socket.connect), patch.object(socket.socket,'connect_ex',socket.socket.connect_ex), patch.object(socket,'create_connection',socket.create_connection), patch.object(worker,'parent_alive',return_value=True):
            first = worker.run(config,request)
            second = worker.run(config,request)
        self.assertEqual(first['state'],'complete')
        self.assertEqual(first['segments'],second['segments'])
        self.assertEqual(len(second['segments']),1)
        write_json(request,{**req,'language_mode':'hinglish'})
        with self.assertRaisesRegex(ValueError,'Cannot resume changed'): worker.run(config,request)

    def test_process_lock_is_exclusive_and_released(self):
        path = self.root/'worker.lock'
        with worker.job_lock(path):
            with self.assertRaises(OSError):
                with worker.job_lock(path): self.fail('Second writer entered')
        with worker.job_lock(path): pass

    def test_gpu_warmup_emits_no_transcript_and_failure_keeps_audio(self):
        row = self.chunk(0, np.zeros(16000))
        self.journal([row, {'kind':'capture_stopped','at_seconds':1}, {'kind':'capture_finalized'}])
        registry = self.root/'models.json'
        write_json(registry, {'models':[{'id':'trelis','decoding':{}}]})
        config = self.root/'runtime.json'
        write_json(config, {'registry_path':str(registry),'models':{'trelis':{'backend':'openvino'}}})
        before = file_digest(self.session/row['file'])
        for failed in (False, True):
            job = self.root/str(failed); job.mkdir()
            request = job/'request.json'
            write_json(request, {'job_id':'warmup','session_dir':str(self.session),'profile':'trelis-20','language_mode':'hinglish'})
            def load(spec, runtime):
                checkpoint = read_json(job/'status.json')
                self.assertEqual(checkpoint['phase'], 'loading_model')
                self.assertEqual(checkpoint['segments'], [])
                return {'status':'failed' if failed else 'ok','text':'','segments':[], 'error':'synthetic failure' if failed else None}
            with patch.object(socket.socket,'connect',socket.socket.connect), patch.object(socket.socket,'connect_ex',socket.socket.connect_ex), patch.object(socket,'create_connection',socket.create_connection), patch.object(worker,'parent_alive',return_value=True), patch.object(worker,'warmup',side_effect=load) as warm:
                result = worker.run(config, request)
            warm.assert_called_once()
            self.assertEqual(result['state'], 'failed' if failed else 'complete')
            self.assertEqual(len(result['segments']), 0 if failed else 1)
            self.assertEqual(file_digest(self.session/row['file']), before)


if __name__ == '__main__': unittest.main()
