"""Synthetic dictation only: fake inference, no microphone or model loading."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import uuid
import wave

import numpy as np

SOURCE = Path(__file__).resolve().parents[2] / 'frontend/src-tauri/scripts/dictation_worker.py'
SPEC = importlib.util.spec_from_file_location('dictation_worker', SOURCE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class DictationWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dictation-synthetic-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.audio = self.root / 'microphone.wav'
        self.config = self.root / 'runtime.json'
        self.request = self.root / 'request.json'
        self.registry = self.root / 'models.json'
        self.registry.write_text(json.dumps({'models': [
            {'id': 'trelis', 'model_id': 'trelis', 'decoding': {'language': 'hi', 'mixed_code': True}},
            {'id': 'apex', 'model_id': 'apex', 'decoding': {'language': 'en'}}]}))
        self.config.write_text(json.dumps({'registry_path': str(self.registry), 'models': {
            'trelis': {'backend': 'openvino'}, 'apex': {'backend': 'transformers'}}, 'speech_gate': {'synthetic': True}}))
        self.request.write_text(json.dumps({'version': 1, 'request_id': str(uuid.uuid4()), 'audio_path': str(self.audio), 'model': 'trelis', 'language_mode': 'hinglish'}))
        self.calls = []
        self.gates = []

    def wav(self, seconds=1, rate=16000, silence=False):
        samples = np.zeros(round(seconds * rate), dtype='<i2') if silence else np.rint(np.sin(np.arange(round(seconds * rate)) * 2 * np.pi * 300 / rate) * 9000).astype('<i2')
        with wave.open(str(self.audio), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(rate); out.writeframes(samples.tobytes())

    def infer(self, spec, audio, runtime):
        with wave.open(str(audio), 'rb') as source:
            self.calls.append({'spec': copy.deepcopy(spec), 'runtime': copy.deepcopy(runtime), 'frames': source.getnframes(), 'rate': source.getframerate(), 'channels': source.getnchannels()})
        return {'status': 'ok', 'text': 'आज की notes are ready.'}

    def gate(self, path, config):
        self.gates.append((str(path), config))
        return {'status': 'ok', 'skip_stt': False}

    def run_worker(self, **kwargs):
        return worker.run(self.config, self.request, infer=kwargs.get('infer', self.infer), gate=kwargs.get('gate', self.gate))

    def test_native_rate_normalizes_and_preserves_hindi_english_text(self):
        self.wav(rate=48000)
        result = self.run_worker()
        self.assertEqual(result['text'], 'आज की notes are ready.')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.calls[0]['frames'], 16000)
        self.assertEqual(self.calls[0]['rate'], 16000)
        self.assertEqual(self.calls[0]['channels'], 1)
        self.assertFalse((self.root / 'dictation-window.wav').exists())
        self.assertEqual({p.name for p in self.root.iterdir()}, {'microphone.wav', 'runtime.json', 'request.json', 'models.json'})

    def test_45_seconds_uses_contiguous_20_second_windows_and_preserves_all_text(self):
        self.wav(seconds=45)
        result = self.run_worker()
        self.assertEqual([c['frames'] for c in self.calls], [320000, 320000, 80000])
        self.assertEqual([w['start_seconds'] for w in result['windows']], [0, 20, 40])
        self.assertEqual(result['text'], ' '.join(['आज की notes are ready.'] * 3))

    def test_digital_silence_never_invokes_speech_gate_or_model(self):
        self.wav(seconds=21, silence=True)
        result = self.run_worker()
        self.assertEqual(result['text'], '')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.gates, [])

    def test_confirmed_no_speech_returns_empty_success_without_model(self):
        self.wav()
        result = self.run_worker(gate=lambda *_: {'status': 'ok', 'skip_stt': True})
        self.assertEqual(result['text'], '')
        self.assertEqual(result['windows'][0]['state'], 'no_speech')
        self.assertEqual(self.calls, [])

    def test_unavailable_gate_keeps_quiet_audio_instead_of_dropping_speech(self):
        self.wav()
        result = self.run_worker(gate=lambda *_: {'status': 'unavailable', 'skip_stt': False})
        self.assertEqual(result['text'], 'आज की notes are ready.')
        self.assertFalse(result['windows'][0]['gate_available'])

    def test_language_selection_is_explicit_and_does_not_change_registry(self):
        self.wav()
        original = self.registry.read_bytes()
        request = json.loads(self.request.read_text()); request['language_mode'] = 'english'; self.request.write_text(json.dumps(request))
        self.run_worker()
        self.assertEqual(self.calls[0]['spec']['decoding'], {'language': 'en', 'mixed_code': False})
        self.assertEqual(self.registry.read_bytes(), original)
        request['model'] = 'apex'; request['language_mode'] = 'hinglish'; self.request.write_text(json.dumps(request))
        result = self.run_worker()
        self.assertEqual(result['model'], 'apex')
        self.assertEqual(self.calls[-1]['spec']['decoding'], {'language': 'en'})

    def test_model_failure_never_returns_partial_dictation(self):
        self.wav(seconds=21)
        calls = []
        def fail_second(*args):
            calls.append(1)
            return {'status': 'ok', 'text': 'partial'} if len(calls) == 1 else {'status': 'failed', 'text': 'unsafe partial', 'error': {'message': 'synthetic failure'}}
        with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
            self.run_worker(infer=fail_second)
        self.assertFalse((self.root / 'dictation-window.wav').exists())

    def test_audio_path_cannot_leave_its_request_directory(self):
        self.wav()
        sub = self.root / 'elsewhere'; sub.mkdir()
        outside = sub / 'microphone.wav'; outside.write_bytes(self.audio.read_bytes())
        request = json.loads(self.request.read_text()); request['audio_path'] = str(outside); self.request.write_text(json.dumps(request))
        with self.assertRaisesRegex(ValueError, 'temporary request'):
            self.run_worker()
        self.assertEqual(self.calls, [])

    def test_rejects_overlong_and_truncated_audio_before_inference(self):
        self.wav(seconds=121, rate=8000)
        with self.assertRaisesRegex(ValueError, '120 seconds'):
            self.run_worker()
        self.wav(); self.audio.write_bytes(self.audio.read_bytes()[:-200])
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.run_worker()
        self.assertEqual(self.calls, [])

    def test_nested_cli_backend_is_rejected_so_native_cancel_owns_one_process(self):
        self.wav()
        config = json.loads(self.config.read_text()); config['models']['trelis']['backend'] = 'whisper_cpp'; self.config.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'Transformers or OpenVINO'):
            self.run_worker()

    def test_worker_blocks_network_during_fake_inference_and_restores_test_process(self):
        self.wav()
        original = socket.create_connection
        def infer(*args):
            with self.assertRaisesRegex(OSError, 'offline'):
                socket.create_connection(('127.0.0.1', 1))
            return {'status': 'ok', 'text': 'offline'}
        self.assertEqual(self.run_worker(infer=infer)['text'], 'offline')
        self.assertIs(socket.create_connection, original)

    def test_watchdog_terminates_after_owner_death_without_waiting_for_inference(self):
        class Stop:
            def wait(self, _seconds):
                return False
        exits = []
        worker._watch_parent(Stop(), lambda: False, exits.append)
        self.assertEqual(exits, [3])

    def test_watchdog_stops_cleanly_after_normal_completion(self):
        class Stop:
            def wait(self, _seconds):
                return True
        worker._watch_parent(Stop(), lambda: self.fail('owner should not be queried'), lambda _: self.fail('normal completion must not terminate'))

    def synthetic_runtime(self, *, fail=False):
        """A real child process imports only these fixture adapters, never ASR."""
        runtime = self.root / 'fixture-runtime'
        package = runtime / 'sttbench'
        adapter = package / 'runtime'
        adapter.mkdir(parents=True)
        (runtime / 'worker.py').write_text('# fixture entry point\n')
        (package / '__init__.py').write_text('')
        (adapter / '__init__.py').write_text('from .api import transcribe\n')
        if fail:
            result = {'status': 'failed', 'text': 'must not escape', 'error': {'message': 'synthetic subprocess failure'}}
        else:
            result = {'status': 'ok', 'text': 'आज की notes are ready.'}
        (adapter / 'api.py').write_text(
            "warmups = 0\nrequests = 0\n"
            "def warmup(spec, runtime):\n"
            "    global warmups\n    warmups += 1\n"
            "    assert warmups == 1 and runtime['reuse_model'] is True\n"
            "    assert spec['decoding']['language'] == 'hi' and spec['decoding']['mixed_code'] is True\n"
            "    return {'status': 'ok', 'timing': {'load_seconds': 0.125}}\n"
            "def transcribe(*args):\n"
            "    global requests\n    requests += 1\n"
            "    result = " + repr(result) + "\n"
            "    result['provenance'] = {'model_reused': warmups == 1 or requests > 1}\n"
            "    result['timing'] = {'inference_seconds': 0.25, 'total_seconds': requests}\n"
            "    return result\n", encoding='utf-8')
        (package / 'speech_gate.py').write_text("def assess_window(*args):\n    return {'status': 'ok', 'skip_stt': False}\n")
        config = json.loads(self.config.read_text())
        config['worker_script'] = str(runtime / 'worker.py')
        self.config.write_text(json.dumps(config))

    def run_cli(self):
        environment = dict(os.environ, STTAPP_PARENT_PID=str(os.getpid()), PYTHONDONTWRITEBYTECODE='1')
        output = self.root / 'result.json'
        child = subprocess.run([sys.executable, '-B', str(SOURCE), '--config', str(self.config),
                                '--request', str(self.request), '--output', str(output)],
                               capture_output=True, text=True, encoding='utf-8', env=environment,
                               timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertFalse(output.with_suffix('.part').exists())
        self.assertFalse((self.root / 'dictation-window.wav').exists())
        return child, json.loads(output.read_text(encoding='utf-8'))

    def test_subprocess_protocol_preserves_unicode_id_and_has_success_exit(self):
        self.wav(rate=44100)
        self.synthetic_runtime()
        child, result = self.run_cli()
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['request_id'], json.loads(self.request.read_text())['request_id'])
        self.assertEqual(result['text'], 'आज की notes are ready.')
        self.assertEqual(json.loads(child.stdout), {'status': 'ok'})

    def test_subprocess_model_failure_has_failed_exit_and_never_partial_text(self):
        self.wav()
        self.synthetic_runtime(fail=True)
        child, result = self.run_cli()
        self.assertEqual(child.returncode, 1, child.stderr)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['text'], '')
        self.assertIn('synthetic subprocess failure', result['error'])
        self.assertEqual(json.loads(child.stdout), {'status': 'failed'})

    def warm_request(self, *, seconds=1, request_changes=None):
        self.wav(seconds=seconds)
        request_id = str(uuid.uuid4())
        directory = self.root / request_id
        directory.mkdir()
        audio = directory / 'input.wav'
        audio.write_bytes(self.audio.read_bytes())
        request = {'version': 1, 'request_id': request_id, 'audio_path': str(audio),
                   'model': 'trelis', 'language_mode': 'hinglish'}
        request.update(request_changes or {})
        (directory / 'request.json').write_text(json.dumps(request), encoding='utf-8')
        return request_id, directory

    def command(self, request_id):
        return (json.dumps({'version': 1, 'action': 'transcribe', 'request_id': request_id}) + '\n').encode()

    def serve(self, commands, *, infer=None, warmup=None):
        with mock.patch.object(worker, 'warm_gate', return_value=False):
            return worker.serve(self.config, io.BytesIO(commands), infer=infer or self.infer,
                                gate=self.gate, warmup=warmup or (lambda *_: {'status': 'ok'}))

    def test_warm_worker_loads_once_reuses_adapters_and_preserves_each_phrase(self):
        first, first_dir = self.warm_request()
        second, second_dir = self.warm_request(seconds=21)
        warmups = []
        def warm(spec, runtime):
            warmups.append((copy.deepcopy(spec), copy.deepcopy(runtime)))
            self.assertEqual(self.calls, [])
            with self.assertRaisesRegex(OSError, 'offline'):
                socket.create_connection(('127.0.0.1', 1))
            return {'status': 'ok', 'timing': {'load_seconds': .1, 'compile_seconds': .2}}
        self.assertEqual(self.serve(self.command(first) + self.command(second), warmup=warm), 0)
        self.assertEqual(len(warmups), 1)
        self.assertTrue(warmups[0][1]['reuse_model'])
        self.assertEqual(warmups[0][0]['decoding'], {'language': 'hi', 'mixed_code': True})
        self.assertEqual(len(self.calls), 3)
        for request_id, directory, pieces in ((first, first_dir, 1), (second, second_dir, 2)):
            result = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(result['request_id'], request_id)
            self.assertEqual(result['text'], ' '.join(['आज की notes are ready.'] * pieces))
            self.assertEqual(result['timing']['adapter_import_seconds'], 0)
            self.assertTrue(all(window['inference_seconds'] >= 0 for window in result['windows']))
            self.assertFalse((directory / 'result.part').exists())
        ready = json.loads((self.root / 'ready.json').read_text())
        self.assertEqual(ready['status'], 'ok')
        self.assertEqual(ready['timing'], {'load_seconds': .1, 'compile_seconds': .2})

    def test_warm_worker_eof_publishes_readiness_without_audio_or_inference(self):
        self.assertEqual(self.serve(b''), 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.gates, [])
        self.assertFalse(self.audio.exists())
        self.assertEqual(json.loads((self.root / 'ready.json').read_text())['status'], 'ok')

    def test_transformers_warmup_unsupported_is_deferred(self):
        config = json.loads(self.config.read_text())
        config['models']['trelis']['backend'] = 'transformers'
        self.config.write_text(json.dumps(config))
        request_id, directory = self.warm_request()
        result = self.serve(self.command(request_id), warmup=lambda *_: {
            'status': 'unavailable', 'error': {'code': 'warmup_unsupported'}})
        self.assertEqual(result, 0)
        self.assertEqual(json.loads((self.root / 'ready.json').read_text())['status'], 'deferred')
        self.assertEqual(json.loads((directory / 'result.json').read_text())['status'], 'ok')

    def test_failed_warmup_never_processes_a_request(self):
        request_id, directory = self.warm_request()
        result = self.serve(self.command(request_id), warmup=lambda *_: {
            'status': 'unavailable', 'error': {'code': 'model_assets_invalid', 'message': 'synthetic missing model'}})
        self.assertEqual(result, 1)
        self.assertEqual(json.loads((self.root / 'ready.json').read_text())['status'], 'failed')
        self.assertFalse((directory / 'result.json').exists())
        self.assertEqual(self.calls, [])

    def test_failed_phrase_publishes_matching_id_without_partial_text_then_continues(self):
        first, first_dir = self.warm_request(seconds=21)
        second, second_dir = self.warm_request()
        calls = []
        def infer(*_args):
            calls.append(1)
            if len(calls) == 2:
                return {'status': 'failed', 'text': 'unsafe partial', 'error': {'message': 'synthetic'}}
            return {'status': 'ok', 'text': 'complete'}
        self.assertEqual(self.serve(self.command(first) + self.command(second), infer=infer), 0)
        failed = json.loads((first_dir / 'result.json').read_text())
        self.assertEqual((failed['status'], failed['request_id'], failed['text']), ('failed', first, ''))
        self.assertEqual(json.loads((second_dir / 'result.json').read_text())['text'], 'complete')

    def test_duplicate_protocol_id_does_not_overwrite_a_completed_result(self):
        request_id, directory = self.warm_request()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.serve(self.command(request_id) * 2)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(json.loads((directory / 'result.json').read_text(encoding='utf-8'))['text'], 'आज की notes are ready.')

    def test_malformed_or_noncanonical_protocol_never_processes_audio(self):
        commands = [self.command('../escape'), self.command(str(uuid.uuid4()).upper()),
                    b'{"version":1,"action":"transcribe","request_id":false}\n',
                    b'{"version":1,"version":1}\n', b'[]\n',
                    b'{"version":NaN}\n', b'not json\n',
                    b'{"version":true,"action":"transcribe","request_id":"bad"}\n',
                    self.command(str(uuid.uuid4())).replace(b'transcribe', b'stop'),
                    b'x' * (worker.MAX_PROTOCOL_BYTES + 1) + b'\n',
                    self.command(str(uuid.uuid4())).rstrip(b'\n')]
        for command in commands:
            with self.subTest(command=command[:100]):
                with self.assertRaises((ValueError, UnicodeError)):
                    self.serve(command)
                (self.root / 'ready.json').unlink()
        self.assertEqual(self.calls, [])

    def test_command_and_request_identity_must_match(self):
        request_id, directory = self.warm_request(request_changes={'request_id': str(uuid.uuid4())})
        self.assertEqual(self.serve(self.command(request_id)), 0)
        result = json.loads((directory / 'result.json').read_text())
        self.assertEqual((result['status'], result['request_id'], result['text']), ('failed', request_id, ''))
        self.assertEqual(self.calls, [])

    def test_existing_result_and_scratch_files_are_never_replaced(self):
        request_id, directory = self.warm_request()
        result = directory / 'result.json'
        result.write_bytes(b'existing evidence')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.serve(self.command(request_id))
        self.assertEqual(result.read_bytes(), b'existing evidence')
        (self.root / 'ready.json').unlink()
        result.unlink()
        scratch = directory / 'dictation-window.wav'
        scratch.write_bytes(b'existing scratch')
        self.assertEqual(self.serve(self.command(request_id)), 0)
        self.assertEqual(scratch.read_bytes(), b'existing scratch')
        self.assertEqual(json.loads(result.read_text())['status'], 'failed')

    def test_oversized_result_becomes_bounded_failed_result_without_partial_text(self):
        request_id, directory = self.warm_request()
        self.assertEqual(self.serve(self.command(request_id), infer=lambda *_: {
            'status': 'ok', 'text': 'a' * worker.MAX_JSON_BYTES}), 0)
        result = directory / 'result.json'
        self.assertLess(result.stat().st_size, worker.MAX_JSON_BYTES)
        self.assertEqual(json.loads(result.read_text())['text'], '')
        self.assertEqual(json.loads(result.read_text())['status'], 'failed')

    def test_reparse_point_paths_are_rejected_before_audio_is_read(self):
        request_id, directory = self.warm_request()
        real_lstat = Path.lstat
        def replaced_lstat(path):
            info = real_lstat(path)
            if path == directory:
                return type('ReparseStat', (), {'st_mode': info.st_mode, 'st_file_attributes': 0x400})()
            return info
        with mock.patch.object(Path, 'lstat', replaced_lstat):
            with self.assertRaisesRegex(ValueError, 'reparse'):
                self.serve(self.command(request_id))
        self.assertEqual(self.calls, [])

    def test_timing_metadata_contains_only_allowed_finite_values(self):
        self.wav()
        result = self.run_worker(infer=lambda *_: {
            'status': 'ok', 'text': 'preserved',
            'timing': {'load_seconds': .2, 'inference_seconds': .3, 'compile_seconds': float('nan'),
                       'total_seconds': -1, 'verification_seconds': True, 'transcript': 'private'},
            'provenance': {'model_reused': True, 'transcript': 'private'}})
        self.assertEqual(result['windows'][0]['runtime_timing'], {'load_seconds': .2, 'inference_seconds': .3})
        self.assertTrue(result['windows'][0]['model_reused'])
        self.assertNotIn('private', json.dumps(result))

    def test_real_child_warms_once_handles_two_requests_and_exits_on_eof(self):
        first, first_dir = self.warm_request()
        second, second_dir = self.warm_request()
        self.synthetic_runtime()
        environment = dict(os.environ, STTAPP_PARENT_PID=str(os.getpid()), PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.run([sys.executable, '-B', str(SOURCE), '--config', str(self.config), '--serve'],
                               input=self.command(first) + self.command(second), capture_output=True,
                               env=environment, timeout=30,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(child.returncode, 0, child.stderr.decode(errors='replace'))
        self.assertEqual(child.stdout, b'')
        self.assertEqual(json.loads((self.root / 'ready.json').read_text())['status'], 'ok')
        for index, directory in enumerate((first_dir, second_dir), 1):
            result = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(result['text'], 'आज की notes are ready.')
            self.assertTrue(result['windows'][0]['model_reused'])
            self.assertEqual(result['windows'][0]['runtime_timing']['total_seconds'], index)

    def stream_run(self, cache, stream_id, *, seconds=20.1, final=False, rate=16000,
                   samples=None, infer=None, gate=None, language='hinglish', live=None, endpoint=None):
        if samples is None:
            self.wav(seconds=seconds, rate=rate)
        else:
            with wave.open(str(self.audio), 'wb') as target:
                target.setnchannels(1); target.setsampwidth(2); target.setframerate(rate)
                target.writeframes(samples.astype('<i2').tobytes())
        request = {'version': 1, 'request_id': str(uuid.uuid4()), 'audio_path': str(self.audio),
                   'model': 'trelis', 'language_mode': language,
                   'stream': {'id': stream_id, 'final': final}}
        if live is not None:
            request['stream']['live'] = live
        self.request.write_text(json.dumps(request), encoding='utf-8')
        return worker.run(self.config, self.request, infer=infer or self.infer, gate=gate or self.gate,
                          cache=cache, endpoint=endpoint)

    def test_stream_previews_skip_partial_tails_and_final_joins_each_window_once(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        for seconds, expected_calls, hits in ((19.9, 0, 0), (20.1, 1, 0), (39.9, 1, 1), (40.1, 2, 1)):
            result = self.stream_run(cache, identity, seconds=seconds)
            self.assertEqual(result['text'], '')
            self.assertNotIn('आज की', json.dumps(result, ensure_ascii=False))
            self.assertEqual(result['stream'], {'id': identity, 'final': False})
            self.assertEqual(len(self.calls), expected_calls)
            self.assertEqual(result['cache_hit_count'], hits)
        final = self.stream_run(cache, identity, seconds=45, final=True)
        self.assertEqual(final['cache_hit_count'], 2)
        self.assertEqual([item['reused'] for item in final['windows']], [True, True, False])
        self.assertEqual(final['text'], ' '.join(['आज की notes are ready.'] * 3))
        self.assertEqual([call['frames'] for call in self.calls], [320000, 320000, 80000])
        self.assertEqual(cache.windows, {})
        self.assertIsNone(cache.identity)

    def test_stream_identity_changes_and_normal_requests_clear_prior_phrase(self):
        cache = worker.StreamCache()
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        for identity, calls in ((first, 1), (second, 2), (first, 3)):
            result = self.stream_run(cache, identity)
            self.assertEqual(result['cache_hit_count'], 0)
            self.assertEqual(len(self.calls), calls)
            self.assertEqual(len(cache.windows), 1)
        request = json.loads(self.request.read_text())
        request.pop('stream')
        self.request.write_text(json.dumps(request))
        normal = worker.run(self.config, self.request, infer=self.infer, gate=self.gate, cache=cache)
        self.assertNotIn('stream', normal)
        self.assertEqual(len(self.calls), 5)
        self.assertEqual(cache.windows, {})
        final = self.stream_run(cache, first, seconds=20, final=True)
        self.assertEqual(final['cache_hit_count'], 0)
        self.assertEqual(len(self.calls), 6)

    def test_stream_settings_or_adapter_changes_recompute_the_same_pcm(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        self.stream_run(cache, identity)
        self.assertEqual(self.stream_run(cache, identity, language='english')['cache_hit_count'], 0)
        config = json.loads(self.config.read_text())
        config['speech_gate']['threshold'] = .1
        self.config.write_text(json.dumps(config))
        self.assertEqual(self.stream_run(cache, identity, language='english')['cache_hit_count'], 0)
        def alternate_infer(*args):
            return self.infer(*args)
        self.assertEqual(self.stream_run(cache, identity, language='english', infer=alternate_infer)['cache_hit_count'], 0)
        self.assertEqual(len(self.calls), 4)

    def test_stream_reuses_only_unchanged_normalized_windows(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        samples = np.random.default_rng(21).integers(-15000, 15000, 45 * 16000, dtype=np.int16)
        self.stream_run(cache, identity, samples=samples[:round(40.1 * 16000)])
        self.assertEqual(len(self.calls), 2)
        changed = samples.copy()
        changed[100] += 1
        final = self.stream_run(cache, identity, samples=changed, final=True)
        self.assertEqual(final['cache_hit_count'], 1)
        self.assertEqual([window['reused'] for window in final['windows']], [False, True, False])
        self.assertEqual(len(self.calls), 4)

    def test_cumulative_resampled_prefixes_match_whole_final_pcm_exactly(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                cache, identity = worker.StreamCache(), str(uuid.uuid4())
                original = np.random.default_rng(rate).integers(-15000, 15000, round(43.7 * rate), dtype=np.int16)
                inferred_pcm = []
                def infer(_spec, path, _runtime):
                    with wave.open(str(path), 'rb') as audio:
                        pcm = audio.readframes(audio.getnframes())
                    inferred_pcm.append(pcm)
                    return {'status': 'ok', 'text': hashlib.sha256(pcm).hexdigest()}
                for seconds in (20.1, 40.1):
                    preview = self.stream_run(cache, identity, rate=rate,
                                              samples=original[:round(seconds * rate)], infer=infer)
                    self.assertEqual(preview['text'], '')
                final = self.stream_run(cache, identity, rate=rate, samples=original, infer=infer, final=True)
                normalized, _duration = worker.normalized_audio(self.audio)
                expected = [normalized[offset:offset + 320000].tobytes()
                            for offset in range(0, len(normalized), 320000)]
                self.assertEqual(inferred_pcm, expected)
                self.assertEqual(final['cache_hit_count'], 2)
                self.assertEqual(final['text'], ' '.join(hashlib.sha256(pcm).hexdigest() for pcm in expected))
                self.assertEqual(cache.windows, {})

    def test_resampling_at_an_exact_prefix_boundary_invalidates_fir_tail(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                cache, identity = worker.StreamCache(), str(uuid.uuid4())
                original = np.random.default_rng(rate).integers(-15000, 15000, 21 * rate, dtype=np.int16)
                inferred = []
                def infer(_spec, path, _runtime):
                    with wave.open(str(path), 'rb') as audio:
                        pcm = audio.readframes(audio.getnframes())
                    inferred.append(pcm)
                    return {'status': 'ok', 'text': hashlib.sha256(pcm).hexdigest()}
                self.stream_run(cache, identity, rate=rate, samples=original[:20 * rate], infer=infer)
                final = self.stream_run(cache, identity, rate=rate, samples=original, infer=infer, final=True)
                self.assertEqual(final['cache_hit_count'], 0)
                self.assertEqual(len(inferred), 3)
                self.assertNotEqual(inferred[0], inferred[1])
                self.assertEqual(final['text'], ' '.join(hashlib.sha256(pcm).hexdigest() for pcm in inferred[1:]))

    def test_any_stream_error_discards_previously_successful_windows(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        fail = [False]
        def infer(*args):
            if fail[0]:
                return {'status': 'failed', 'error': {'message': 'synthetic stream failure'}}
            return self.infer(*args)
        self.stream_run(cache, identity, infer=infer)
        fail[0] = True
        with self.assertRaisesRegex(RuntimeError, 'synthetic stream failure'):
            self.stream_run(cache, identity, seconds=40.1, infer=infer)
        self.assertEqual(cache.windows, {})
        self.assertIsNone(cache.identity)
        fail[0] = False
        final = self.stream_run(cache, identity, seconds=40, final=True, infer=infer)
        self.assertEqual(final['cache_hit_count'], 0)
        self.assertEqual(len(self.calls), 3)
        self.stream_run(cache, identity)
        self.audio.unlink()
        with self.assertRaises(FileNotFoundError):
            worker.run(self.config, self.request, infer=self.infer, gate=self.gate, cache=cache)
        self.assertEqual(cache.windows, {})

    def test_stream_cache_is_bounded_to_six_windows_and_one_megabyte_text(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        self.stream_run(cache, identity, seconds=120)
        self.assertEqual(len(cache.windows), 6)
        with self.assertRaisesRegex(ValueError, '120 seconds'):
            self.stream_run(cache, identity, seconds=121)
        self.assertEqual(cache.windows, {})
        with self.assertRaisesRegex(ValueError, 'stream text is too large'):
            self.stream_run(cache, identity, seconds=40.1,
                            infer=lambda *_: {'status': 'ok', 'text': 'x' * 600000})
        self.assertEqual(cache.windows, {})

    def test_shortened_stream_discards_cached_windows_beyond_new_audio(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        self.stream_run(cache, identity, seconds=60.1)
        self.assertEqual(len(cache.windows), 3)
        shortened = self.stream_run(cache, identity, seconds=20.1)
        self.assertEqual(shortened['cache_hit_count'], 1)
        self.assertEqual(list(cache.windows), [0])

    def test_invalid_stream_identity_or_final_flag_rejects_and_clears_cache(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        malformed = [None, {'id': identity, 'final': 1}, {'id': identity},
                     {'id': '../escape', 'final': False}, {'id': identity.upper(), 'final': False},
                     {'id': identity, 'final': False, 'extra': True}]
        for stream in malformed:
            with self.subTest(stream=stream):
                self.stream_run(cache, identity)
                request = json.loads(self.request.read_text())
                request['stream'] = stream
                self.request.write_text(json.dumps(request))
                with self.assertRaises(ValueError):
                    worker.run(self.config, self.request, infer=self.infer, gate=self.gate, cache=cache)
                self.assertEqual(cache.windows, {})

    def test_serve_echoes_stream_failure_and_clears_cache_on_eof(self):
        identity = str(uuid.uuid4())
        preview, preview_dir = self.warm_request(seconds=20.1, request_changes={'stream': {'id': identity, 'final': False}})
        final, final_dir = self.warm_request(seconds=21, request_changes={'stream': {'id': identity, 'final': True}})
        cache = worker.StreamCache()
        calls = []
        def infer(*args):
            calls.append(1)
            if len(calls) == 2:
                return {'status': 'failed', 'text': 'private partial', 'error': {'message': 'synthetic stream failure'}}
            return self.infer(*args)
        with mock.patch.object(worker, 'StreamCache', return_value=cache):
            self.assertEqual(self.serve(self.command(preview) + self.command(final), infer=infer), 0)
        self.assertEqual(json.loads((preview_dir / 'result.json').read_text())['text'], '')
        failed = json.loads((final_dir / 'result.json').read_text())
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['stream'], {'id': identity, 'final': True})
        self.assertEqual(failed['text'], '')
        self.assertEqual(cache.windows, {})
        self.assertIsNone(cache.identity)

    def test_serve_clears_unfinished_stream_on_eof_or_protocol_failure(self):
        for malformed in (b'', b'bad protocol\n'):
            with self.subTest(malformed=malformed):
                identity = str(uuid.uuid4())
                preview, directory = self.warm_request(seconds=20.1, request_changes={'stream': {'id': identity, 'final': False}})
                cache = worker.StreamCache()
                with mock.patch.object(worker, 'StreamCache', return_value=cache):
                    if malformed:
                        with self.assertRaises(ValueError):
                            self.serve(self.command(preview) + malformed)
                    else:
                        self.assertEqual(self.serve(self.command(preview)), 0)
                self.assertEqual(cache.windows, {})
                self.assertIsNone(cache.identity)
                self.assertEqual(json.loads((directory / 'result.json').read_text())['text'], '')
                (self.root / 'ready.json').unlink()

    def endpoints_after(self, speech_ends):
        def endpoint(samples, start, _config):
            points = []
            for speech_end in speech_ends:
                if speech_end <= start or speech_end + 9600 > len(samples):
                    continue
                end = speech_end + 1600
                points.append({'end_sample': end, 'vad_speech_end_sample': speech_end,
                               'confirmed_silence_samples': 9600, 'padding_samples': 1600,
                               'normalization_guard_samples': len(samples) - end, 'vad_frame_samples': 512})
            return {'available': True, 'endpoints': points}
        return endpoint

    def assert_confirmed_coverage(self, result, samples):
        self.assertEqual(result['live_delivery'], 'confirmed_phrases')
        self.assertEqual(result['audio_sample_count'], len(samples))
        cursor = 0
        for phrase in result['confirmed_ranges']:
            self.assertEqual(phrase['start_sample'], cursor)
            self.assertGreater(phrase['end_sample'], cursor)
            self.assertEqual(phrase['pcm_sha256'], hashlib.sha256(
                samples[cursor:phrase['end_sample']].astype('<i2').tobytes()).hexdigest())
            cursor = phrase['end_sample']
        self.assertEqual(cursor, result['confirmed_samples'])
        self.assertEqual(len(result['confirmed_ranges']), result['confirmed_phrase_count'])

    def test_live_unresolved_speech_never_returns_or_decodes_partial_hypotheses(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        endpoint = self.endpoints_after([])
        for seconds in (2.1, 4.1, 22.1):
            preview = self.stream_run(cache, identity, seconds=seconds, live=True, endpoint=endpoint)
            self.assertEqual(preview['text'], '')
            self.assertEqual(preview['confirmed_phrase_count'], 0)
            self.assertEqual(preview['confirmed_samples'], 0)
            self.assertTrue(preview['live_endpoint_available'])
            self.assertEqual(preview['live_delivery'], 'confirmed_phrases')
        self.assertEqual(self.calls, [])
        self.assertEqual(cache.phrases, [])
        final = self.stream_run(cache, identity, seconds=22.1, live=True, final=True, endpoint=endpoint)
        self.assertEqual(final['confirmed_samples'], final['audio_sample_count'])
        self.assertEqual(final['confirmed_phrase_count'], 1)
        self.assertEqual(final['confirmed_ranges'][0]['boundary'], 'stop')
        self.assertEqual([call['frames'] for call in self.calls], [320000, 33600])
        self.assertEqual(cache.phrases, [])

    def test_live_pause_finalizes_once_and_stop_consumes_every_remaining_sample(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        endpoint = self.endpoints_after([16000, 48000])
        original = np.concatenate((np.ones(16000, dtype=np.int16) * 5000, np.zeros(16000, dtype=np.int16),
                                   np.ones(16000, dtype=np.int16) * 7000, np.zeros(16000, dtype=np.int16)))
        first = self.stream_run(cache, identity, samples=original[:32000], live=True, endpoint=endpoint)
        self.assertEqual(first['text'], 'आज की notes are ready.')
        self.assertEqual(first['confirmed_samples'], 17600)
        repeated = self.stream_run(cache, identity, samples=original[:40000], live=True, endpoint=endpoint)
        self.assertEqual(repeated['text'], first['text'])
        self.assertEqual(repeated['cache_hit_count'], 1)
        self.assertEqual(len(self.calls), 1)
        second = self.stream_run(cache, identity, samples=original, live=True, endpoint=endpoint)
        self.assertEqual(second['text'], 'आज की notes are ready. आज की notes are ready.')
        self.assertEqual(second['confirmed_phrase_count'], 2)
        self.assertEqual(len(self.calls), 2)
        final = self.stream_run(cache, identity, samples=original, live=True, final=True, endpoint=endpoint)
        self.assertEqual(final['text'], second['text'])
        self.assertEqual(final['confirmed_samples'], len(original))
        self.assertEqual(final['confirmed_ranges'][-1]['boundary'], 'stop')
        self.assert_confirmed_coverage(final, original)
        self.assertEqual(cache.phrases, [])
        self.assertEqual(cache.confirmed_samples, 0)

    def test_live_long_phrase_is_decoded_in_existing_windows_only_after_endpoint(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        endpoint = self.endpoints_after([25 * 16000])
        self.stream_run(cache, identity, seconds=24, live=True, endpoint=endpoint)
        self.assertEqual(self.calls, [])
        result = self.stream_run(cache, identity, seconds=26, live=True, endpoint=endpoint)
        self.assertEqual(result['confirmed_phrase_count'], 1)
        self.assertEqual([call['frames'] for call in self.calls], [320000, 81600])
        self.assertEqual(result['confirmed_samples'], 401600)

    def test_unavailable_endpoint_defers_all_audio_to_stop_canonical_path(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        calls = []
        def endpoint(*_args):
            calls.append(1)
            return {'available': False, 'endpoints': []}
        self.assertEqual(self.stream_run(cache, identity, seconds=4, live=True, endpoint=endpoint)['text'], '')
        preview = self.stream_run(cache, identity, seconds=22, live=True, endpoint=endpoint)
        self.assertFalse(preview['live_endpoint_available'])
        self.assertEqual(self.calls, [])
        self.assertEqual(len(calls), 1)
        final = self.stream_run(cache, identity, seconds=24, live=True, final=True, endpoint=endpoint)
        request = json.loads(self.request.read_text()); request.pop('stream'); self.request.write_text(json.dumps(request))
        baseline = self.run_worker()
        self.assertEqual(final['text'], baseline['text'])
        self.assertEqual(final['confirmed_samples'], final['audio_sample_count'])
        self.assertFalse(final['live_endpoint_available'])
        self.assertEqual(final['confirmed_phrase_count'], 1)

    def test_endpoint_failure_after_confirmation_preserves_prior_text_until_stop(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        healthy = self.endpoints_after([16000])
        count = [0]
        def endpoint(*args):
            count[0] += 1
            if count[0] > 1:
                raise RuntimeError('synthetic VAD error')
            return healthy(*args)
        first = self.stream_run(cache, identity, seconds=2, live=True, endpoint=endpoint)
        preview = self.stream_run(cache, identity, seconds=4, live=True, endpoint=endpoint)
        self.assertEqual(preview['text'], first['text'])
        self.assertFalse(preview['live_endpoint_available'])
        self.assertEqual(len(self.calls), 1)
        final = self.stream_run(cache, identity, seconds=4, live=True, final=True, endpoint=endpoint)
        self.assertEqual(final['text'], first['text'] + ' आज की notes are ready.')
        self.assertEqual(final['confirmed_samples'], 64000)
        self.assertEqual(count[0], 2)

    def test_invalid_endpoint_diagnostics_defer_without_exposing_partial_text(self):
        for malformed in (None, [None], [{'end_sample': 17600, 'vad_speech_end_sample': 16000,
                                        'confirmed_silence_samples': 999999}]):
            with self.subTest(malformed=malformed):
                cache, identity = worker.StreamCache(), str(uuid.uuid4())
                endpoint = lambda *_: {'available': True, 'endpoints': malformed}
                preview = self.stream_run(cache, identity, seconds=2, live=True, endpoint=endpoint)
                self.assertFalse(preview['live_endpoint_available'])
                self.assertEqual(preview['text'], '')
                final = self.stream_run(cache, identity, seconds=2, live=True, final=True, endpoint=endpoint)
                self.assertEqual(final['confirmed_samples'], 32000)
                self.assertEqual(final['text'], 'आज की notes are ready.')

    def test_live_confirmed_cache_is_cleared_on_eof_and_protocol_failure(self):
        for malformed in (b'', b'bad protocol\n'):
            with self.subTest(malformed=malformed):
                identity = str(uuid.uuid4())
                preview, directory = self.warm_request(seconds=2, request_changes={
                    'stream': {'id': identity, 'final': False, 'live': True}})
                cache = worker.StreamCache()
                with mock.patch.object(worker, 'StreamCache', return_value=cache), mock.patch.object(
                        worker, 'find_live_endpoints', side_effect=self.endpoints_after([16000])):
                    if malformed:
                        with self.assertRaises(ValueError):
                            self.serve(self.command(preview) + malformed)
                    else:
                        self.assertEqual(self.serve(self.command(preview)), 0)
                self.assertEqual(cache.phrases, [])
                self.assertEqual(cache.confirmed_samples, 0)
                self.assertIsNone(cache.identity)
                result = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
                self.assertEqual(result['confirmed_phrase_count'], 1)
                self.assertEqual(result['text'], 'आज की notes are ready.')
                (self.root / 'ready.json').unlink()

    def test_confirmed_live_ranges_have_exact_multirate_pcm_hashes_and_no_gaps(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                cache, identity = worker.StreamCache(), str(uuid.uuid4())
                endpoint = self.endpoints_after([16000, 48000])
                original = np.random.default_rng(rate).integers(-15000, 15000, round(4.7 * rate), dtype=np.int16)
                for seconds in (2.1, 4.1):
                    preview = self.stream_run(cache, identity, samples=original[:round(seconds * rate)],
                                              rate=rate, live=True, endpoint=endpoint)
                    self.assertGreater(preview['confirmed_phrase_count'], 0)
                final = self.stream_run(cache, identity, samples=original, rate=rate, live=True, final=True, endpoint=endpoint)
                normalized, _ = worker.normalized_audio(self.audio)
                self.assert_confirmed_coverage(final, normalized)
                self.assertEqual(final['cache_hit_count'], 2)
                self.assertEqual(final['confirmed_samples'], len(normalized))
                self.assertEqual(cache.phrases, [])

    def test_changed_confirmed_pcm_fails_closed_and_clears_phrase_cache(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        endpoint = self.endpoints_after([16000])
        original = np.ones(48000, dtype=np.int16) * 5000
        self.stream_run(cache, identity, samples=original[:32000], live=True, endpoint=endpoint)
        changed = original.copy(); changed[100] += 1
        with self.assertRaisesRegex(ValueError, 'Confirmed dictation audio changed'):
            self.stream_run(cache, identity, samples=changed, live=True, endpoint=endpoint)
        self.assertEqual(cache.phrases, [])
        self.assertEqual(cache.confirmed_samples, 0)

    def test_confirmed_live_session_settings_and_model_failure_clear_all_state(self):
        cache, first, second = worker.StreamCache(), str(uuid.uuid4()), str(uuid.uuid4())
        endpoint = self.endpoints_after([16000])
        self.stream_run(cache, first, seconds=2, live=True, endpoint=endpoint)
        self.assertEqual(self.stream_run(cache, second, seconds=2, live=True, endpoint=endpoint)['cache_hit_count'], 0)
        self.assertEqual(self.stream_run(cache, second, seconds=2, live=True, endpoint=endpoint, language='english')['cache_hit_count'], 0)
        self.assertEqual(len(self.calls), 3)
        with self.assertRaisesRegex(RuntimeError, 'synthetic confirmed failure'):
            self.stream_run(cache, second, seconds=4, live=True, final=True, endpoint=endpoint,
                            infer=lambda *_: {'status': 'failed', 'text': 'must not escape',
                                             'error': {'message': 'synthetic confirmed failure'}})
        self.assertEqual(cache.phrases, [])
        self.assertIsNone(cache.identity)

    def test_confirmed_live_phrase_count_and_shared_text_are_bounded(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        self.assertLessEqual(worker.MAX_LIVE_PHRASES, 256)
        endpoint = self.endpoints_after([512 + index * 10240 for index in range(3)])
        with mock.patch.object(worker, 'MAX_LIVE_PHRASES', 2):
            with self.assertRaisesRegex(ValueError, 'finalized phrase limit'):
                self.stream_run(cache, identity, seconds=3, live=True, endpoint=endpoint)
        self.assertEqual(cache.phrases, [])
        endpoint = self.endpoints_after([16000, 48000])
        with self.assertRaisesRegex(ValueError, 'stream text is too large'):
            self.stream_run(cache, identity, seconds=4, live=True, endpoint=endpoint,
                            infer=lambda *_: {'status': 'ok', 'text': 'x' * 600000})
        self.assertEqual(cache.phrases, [])

    def test_absent_false_or_invalid_live_flags_preserve_legacy_rules(self):
        cache, identity = worker.StreamCache(), str(uuid.uuid4())
        for live in (None, False):
            result = self.stream_run(cache, identity, seconds=4, live=live)
            self.assertEqual(result['text'], '')
            self.assertNotIn('live_delivery', result)
        for value in (None, 0, 1, 'true', [], {}):
            request = json.loads(self.request.read_text()); request['stream']['live'] = value
            self.request.write_text(json.dumps(request))
            with self.assertRaisesRegex(ValueError, 'live flag'):
                worker.run(self.config, self.request, infer=self.infer, gate=self.gate, cache=cache)
        self.assertEqual(self.calls, [])

    def mock_silero(self, raw, boosted=None):
        module = types.ModuleType('sttbench.speech_gate')
        module.FRAME_SAMPLES = 512
        module._load_session = lambda *_: (object(), 'state_512', '0' * 64)
        module._probabilities = lambda _session, _samples, gain, _interface: raw if gain == 1. else (boosted if boosted is not None else raw)
        model = self.root / 'synthetic-vad.onnx'; model.write_bytes(b'fixture')
        config = {'model_path': str(model), 'model_sha256': '0' * 64, 'model_version': '6.2.3'}
        return module, config

    def test_endpoint_requires_sustained_silence_and_preserves_padding_guard(self):
        raw = [.9] * 32 + [.01] * 19
        module, config = self.mock_silero(raw)
        samples = np.ones(len(raw) * 512, dtype=np.int16) * 100
        with mock.patch.dict(sys.modules, {'sttbench.speech_gate': module}):
            result = worker.find_live_endpoints(samples, 0, config)
        self.assertTrue(result['available'])
        point = result['endpoints'][0]
        self.assertEqual(point['vad_speech_end_sample'], 32 * 512)
        self.assertEqual(point['end_sample'], 32 * 512 + 1600)
        self.assertGreaterEqual(point['confirmed_silence_samples'], 9600)
        self.assertGreaterEqual(point['normalization_guard_samples'], 1600)
        module, config = self.mock_silero(raw[:-1])
        with mock.patch.dict(sys.modules, {'sttbench.speech_gate': module}):
            self.assertEqual(worker.find_live_endpoints(samples[:-512], 0, config)['endpoints'], [])

    def test_endpoint_quiet_speech_boost_and_padded_last_frame_prevent_early_cut(self):
        raw = [.9] * 32 + [.01] * 19
        boosted = [.9] * 32 + [.01] * 10 + [.8] + [.01] * 8
        module, config = self.mock_silero(raw, boosted)
        samples = np.ones(len(raw) * 512, dtype=np.int16) * 100
        with mock.patch.dict(sys.modules, {'sttbench.speech_gate': module}):
            self.assertEqual(worker.find_live_endpoints(samples, 0, config)['endpoints'], [])
        module, config = self.mock_silero(raw)
        with mock.patch.dict(sys.modules, {'sttbench.speech_gate': module}):
            self.assertEqual(worker.find_live_endpoints(samples[:-1], 0, config)['endpoints'], [])
        module._probabilities = lambda *_: [float('nan')]
        with mock.patch.dict(sys.modules, {'sttbench.speech_gate': module}):
            self.assertFalse(worker.find_live_endpoints(samples, 0, config)['available'])

    def test_confirmed_live_serve_defers_without_vad_and_echoes_contract_on_final(self):
        identity = str(uuid.uuid4())
        preview, preview_dir = self.warm_request(seconds=2, request_changes={
            'stream': {'id': identity, 'final': False, 'live': True}})
        final, final_dir = self.warm_request(seconds=4, request_changes={
            'stream': {'id': identity, 'final': True, 'live': True}})
        self.synthetic_runtime()
        environment = dict(os.environ, STTAPP_PARENT_PID=str(os.getpid()), PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.run([sys.executable, '-B', str(SOURCE), '--config', str(self.config), '--serve'],
                               input=self.command(preview) + self.command(final), capture_output=True,
                               env=environment, timeout=30,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(child.returncode, 0, child.stderr.decode(errors='replace'))
        self.assertEqual(child.stdout, b'')
        partial = json.loads((preview_dir / 'result.json').read_text(encoding='utf-8'))
        result = json.loads((final_dir / 'result.json').read_text(encoding='utf-8'))
        self.assertEqual(partial['text'], '')
        self.assertFalse(partial['live_endpoint_available'])
        self.assertEqual(partial['confirmed_samples'], 0)
        self.assertEqual(result['live_delivery'], 'confirmed_phrases')
        self.assertEqual(result['stream'], {'id': identity, 'final': True, 'live': True})
        self.assertEqual(result['text'], 'आज की notes are ready.')
        self.assertEqual(result['confirmed_samples'], 64000)
        self.assertFalse(result['live_endpoint_available'])


if __name__ == '__main__':
    unittest.main()
