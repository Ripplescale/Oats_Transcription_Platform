"""Synthetic data only; clocks, integrity and worker lifecycle without models."""
import importlib.util
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qualify_two_track_worker', Path(__file__).parents[1] / 'tools/qualify_two_track_worker.py')
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)
from sttbench import local_worker


def segment(track='microphone', start=0, end=20, text='यह एक test है'):
    return {'id': f'{track}-{start}', 'source_track': track, 'start_seconds': start,
            'end_seconds': end, 'text': text, 'recognition': {'text': text},
            'audio_provenance': {'audio_sha256': f'{track}-{start}'}}


class TwoTrackQualificationTests(unittest.TestCase):
    def test_pause_waits_through_cold_warmup_for_committed_prefix(self):
        # The elapsed threshold alone used to pause a still-loading model at
        # zero segments, providing no evidence of prefix-preserving resume.
        snapshots = [(20, 0), (45, 0), (65, 0), (72, 1), (76, 2)]
        self.assertEqual([replay.pause_is_due(now, 45, count, 2) for now, count in snapshots],
                         [False, False, False, False, True])
        self.assertFalse(replay.pause_is_due(44, 45, 3, 2))
        self.assertTrue(replay.pause_is_due(45, 45, 0))
        self.assertFalse(replay.pause_is_due(100, None, 10, 2))

    def test_future_audio_rejected_before_files_written(self):
        with self.assertRaisesRegex(ValueError, 'future'):
            replay.commit_second(Path('not-created'), {}, 0, .9)

    def test_distinct_track_pcm_and_committed_hashes(self):
        with tempfile.TemporaryDirectory(prefix='two-track-synthetic-', dir=Path(__file__).parents[1]) as tmp:
            root = Path(tmp)
            inputs = {'microphone': b'\x01\x00' * 16000, 'system': b'\x02\x00' * 16000}
            replay.commit_second(root, inputs, 0, 1.1)
            rows = [replay.json.loads(line) for line in (root / 'timeline.jsonl').read_text().splitlines()]
            self.assertEqual([r['track'] for r in rows], list(replay.TRACKS))
            self.assertNotEqual(rows[0]['sha256'], rows[1]['sha256'])
            for row in rows:
                self.assertEqual(replay.file_digest(root / row['file']), row['sha256'])

    def test_prefix_preserves_script_and_rejects_mutation_removal_and_duplicate(self):
        initial = segment()
        prefix = replay.check_prefix([], [initial])
        self.assertEqual(prefix, replay.check_prefix(prefix, [initial]))
        for items in ([], [{**initial, 'text': 'different'}], [initial, initial]):
            with self.assertRaises(ValueError):
                replay.check_prefix(prefix, items)
        with self.assertRaisesRegex(ValueError, 'recognition'):
            replay.check_prefix([], [{**initial, 'text': 'transliterated'}])

    def test_coverage_requires_both_sources_tail_and_no_duplicate(self):
        rows = [segment(track, start, end) for track in replay.TRACKS for start, end in ((0, 20), (20, 25))]
        status = {'segments': rows, 'cursors': dict.fromkeys(replay.TRACKS, 25)}
        self.assertTrue(replay.coverage(status, 25)['all_windows_covered'])
        self.assertFalse(replay.coverage({**status, 'segments': rows[:-1]}, 25)['all_windows_covered'])
        self.assertFalse(replay.coverage({**status, 'segments': rows + rows[:1]}, 25)['all_windows_covered'])

    def test_same_input_comparison_is_not_accuracy_or_transliteration(self):
        a = {'segments': [segment()]}
        self.assertTrue(replay.compare_status(a, a)['all_raw_text_identical'])
        b = {'segments': [segment(text='yah ek test hai')]}
        result = replay.compare_status(b, a)
        self.assertFalse(result['accuracy_qualified'])
        self.assertFalse(result['all_raw_text_identical'])
        b['segments'][0]['audio_provenance']['audio_sha256'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'different source'):
            replay.compare_status(b, a)

    def test_twenty_second_windows_separate_oldest_and_completion_deadlines(self):
        observations, segments = [], []
        for end in range(20, 121, 20):
            for index, track in enumerate(replay.TRACKS):
                observations.append({'source_track': track, 'start_seconds': end - 20,
                    'end_seconds': end, 'ready_elapsed_seconds': end + 2 + index,
                    'digital_silence': False, 'adapter_timing': {'total_seconds': 2},
                    'model_reused': end > 20 or index > 0, 'has_alternative': False,
                    'completed_window_backlog_seconds': 20 if index == 0 else 0,
                    'backlog_seconds': 22 if index == 0 else 3})
                segments.append(segment(track, end - 20, end))
        status = {'state': 'complete', 'segments': segments, 'cursors': dict.fromkeys(replay.TRACKS, 120)}
        args = (observations, status, 120, 0, .2, 120, 123, [], [])
        report = replay.summarize(*args)
        self.assertEqual(report['source_end_delay_p95_seconds'], 3)
        self.assertEqual(report['oldest_audio_delay_p95_seconds'], 23)
        self.assertTrue(report['bounded_paced_pass'])
        self.assertFalse(report['oldest_audio_15s_target_qualified'])
        self.assertFalse(replay.summarize(*args[:-1], [{'event': 'pause'}])['bounded_paced_pass'])
        observations[-1]['ready_elapsed_seconds'] += 12
        self.assertFalse(replay.summarize(*args)['bounded_paced_pass'])

    def test_retry_and_graceful_resume_keep_raw_prefix_in_real_worker(self):
        with tempfile.TemporaryDirectory(prefix='two-track-synthetic-', dir=Path(__file__).parents[1]) as tmp:
            root = Path(tmp); session = root / 'session'; session.mkdir()
            replay.write_json(session / 'session.json', {'id': 'synthetic'})
            sources = {'microphone': b'\x00\x10' * (25 * 16000), 'system': b'\x00\x20' * (25 * 16000)}
            for index in range(25):
                replay.commit_second(session, sources, index, index + 1)
            replay.append(session / 'timeline.jsonl', {'kind': 'capture_stopped', 'at_seconds': 25})
            replay.append(session / 'timeline.jsonl', {'kind': 'capture_finalized'})
            registry = root / 'models.json'
            replay.write_json(registry, {'models': [{'id': 'trelis', 'decoding': {}}]})
            config = root / 'config.json'
            replay.write_json(config, {'registry_path': str(registry), 'models': {'trelis': {}}})
            job = root / 'job'; job.mkdir(); request = job / 'request.json'
            replay.write_json(request, {'job_id': 'synthetic', 'session_dir': str(session),
                'profile': 'trelis-20', 'language_mode': 'hinglish'})
            calls = []
            def infer(spec, audio, runtime):
                calls.append(str(audio))
                if len(calls) == 3:
                    (job / 'stop.request').write_text('test pause')
                return {'status': 'ok', 'text': 'यह एक test है'}
            original = local_worker.evaluate_window
            def evaluate(*args, **kwargs):
                kwargs['infer'] = infer
                return original(*args, **kwargs)
            with patch.object(socket.socket, 'connect', socket.socket.connect), patch.object(socket.socket, 'connect_ex', socket.socket.connect_ex), patch.object(socket, 'create_connection', socket.create_connection), patch.object(local_worker, 'parent_alive', return_value=True), patch.object(local_worker, 'evaluate_window', side_effect=evaluate):
                first = local_worker.run(config, request)
                self.assertEqual(first['state'], 'stopped')
                self.assertEqual(len(first['segments']), 1)
                self.assertIsNotNone(first['segments'][0]['alternative'])
                prefix = replay.check_prefix([], first['segments'])
                (job / 'stop.request').unlink()
                final = local_worker.run(config, request)
            replay.check_prefix(prefix, final['segments'])
            self.assertEqual(final['state'], 'complete')
            self.assertTrue(replay.coverage(final, 25)['all_windows_covered'])
            self.assertTrue(all(row['text'] == 'यह एक test है' for row in final['segments']))


if __name__ == '__main__':
    unittest.main()
