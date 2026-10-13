"""Gate policy and ONNX recurrent contracts without downloading speech models."""
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import numpy as np
from sttbench import speech_gate


class SyntheticSilero:
    def __init__(self, modern=False):
        self.modern = modern
        self.calls = []

    def get_inputs(self):
        names = ('input', 'sr', 'state') if self.modern else ('input', 'sr', 'h', 'c')
        return [SimpleNamespace(name=name) for name in names]

    def run(self, outputs, inputs):
        self.calls.append({key: value.copy() for key, value in inputs.items()})
        self.assert_frame(inputs)
        frame = inputs['input'][0, -512:] if self.modern else inputs['input'][0]
        # Ignore padded zeros in this synthetic classifier, so a constant quiet
        # signal stays nonspeech when the last incomplete frame is padded.
        active = frame[frame != 0]
        spread = float(np.std(active)) if len(active) else 0
        probability = np.array([[.95 if spread > .001 else .01]], dtype=np.float32)
        if self.modern:
            return probability, inputs['state'] + 1
        return probability, inputs['h'] + 1, inputs['c'] + 1

    def assert_frame(self, inputs):
        # The official v4 contract rejects 16 kHz input shorter than 512;
        # the modern interface includes 64 context samples before the frame.
        assert inputs['input'].shape == (1, 576 if self.modern else 512)
        assert inputs['sr'].dtype == np.int64 and int(inputs['sr']) == 16000


class SpeechGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='silero-gate-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.model = self.root / 'model.onnx'
        self.model.write_bytes(b'synthetic-placeholder-no-inference-weights')
        self.sha = hashlib.sha256(self.model.read_bytes()).hexdigest()
        self.config = {'model_path': str(self.model), 'model_sha256': self.sha,
                       'threshold': .15, 'boost_peak': .25, 'max_gain': 1000}
        speech_gate._load_session.cache_clear()
        self.addCleanup(speech_gate._load_session.cache_clear)

    def audio(self, samples):
        path = self.root / 'input.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
            out.writeframes(np.asarray(samples, dtype='<i2').tobytes())
        return path

    def assess(self, samples, session=None):
        session = session or SyntheticSilero()
        path = self.audio(samples)
        before = path.read_bytes()
        interface = 'state_512' if session.modern else 'h_c_512'
        with patch.object(speech_gate, '_load_session', return_value=(session, interface, self.sha)):
            report = speech_gate.assess_window(path, self.config)
        self.assertEqual(path.read_bytes(), before)
        return report, session

    def test_nonzero_quiet_classifier_nonspeech_can_skip_but_not_by_energy(self):
        report, session = self.assess(np.ones(20 * 16000) * 8)
        self.assertTrue(report['skip_stt'])
        self.assertEqual(report['status'], 'ok')
        self.assertLess(report['raw_max_probability'], .15)
        self.assertLess(report['boosted_max_probability'], .15)
        self.assertEqual(report['analysis_gain'], 1000)
        self.assertEqual(len(session.calls), 2 * report['frame_count'])
        self.assertEqual(report['model_sha256'], self.sha)
        self.assertGreaterEqual(report['elapsed_seconds'], 0)

    def test_one_second_of_speech_anywhere_preserves_full_twenty_second_window(self):
        voice = np.sin(np.arange(16000) * .13) * 4000
        for position in (0, 9, 19):
            with self.subTest(position=position):
                samples = np.zeros(20 * 16000)
                samples[position * 16000:(position + 1) * 16000] = voice
                report, _ = self.assess(samples)
                self.assertFalse(report['skip_stt'])
                self.assertEqual(report['duration_seconds'], 20)
                self.assertGreater(report['raw_max_probability'], .9)

    def test_analysis_gain_keeps_faint_speech_despite_low_raw_score(self):
        samples = np.sin(np.arange(16000) * .13) * 8
        for modern in (False, True):
            with self.subTest(modern=modern):
                report, session = self.assess(samples, SyntheticSilero(modern))
                self.assertGreater(report['analysis_gain'], 1)
                self.assertEqual(len(session.calls), 2 * report['frame_count'])
                self.assertLess(report['raw_max_probability'], .15)
                self.assertGreater(report['boosted_max_probability'], .9)
                self.assertFalse(report['skip_stt'])

    def test_unity_gain_preserves_full_diagnostics_with_one_pass(self):
        # Include a padded tail and speech in the middle: a keep decision must
        # not stop the pass before its full-window statistics are collected.
        cases = (
            ('speech', np.concatenate((np.zeros(512), np.sin(np.arange(512) * .13) * 12000,
                                       [12000])), [.01, .95, .01], False, 1000),
            ('peak_at_boost_target', np.ones(1025) * 8192, [.01] * 3, True, 1000),
            ('gain_capped_at_one', np.ones(1025) * 8, [.01] * 3, True, 1),
        )
        for modern in (False, True):
            for name, samples, probabilities, skip, max_gain in cases:
                with self.subTest(modern=modern, signal=name):
                    self.config['max_gain'] = max_gain
                    with patch.object(speech_gate.time, 'perf_counter', side_effect=[7., 7.25]):
                        report, session = self.assess(samples, SyntheticSilero(modern))
                    self.assertEqual(len(session.calls), 3)
                    expected = [float(np.float32(value)) for value in probabilities]
                    self.assertEqual(report, {
                        'classifier': 'silero_onnx', 'status': 'ok', 'skip_stt': skip,
                        'audio_for_stt_is_unchanged': True, 'decision': 'skip' if skip else 'keep',
                        'model_sha256': self.sha, 'threshold': .15, 'boost_peak': .25,
                        'max_gain': float(max_gain), 'interface': 'state_512' if modern else 'h_c_512',
                        'frame_samples': 512, 'context_samples': 64 if modern else 0,
                        'duration_seconds': 1025 / 16000, 'frame_count': 3, 'analysis_gain': 1.,
                        'raw_max_probability': max(expected), 'boosted_max_probability': max(expected),
                        'raw_mean_probability': float(np.mean(expected)),
                        'boosted_mean_probability': float(np.mean(expected)),
                        'speech_evidence_seconds': 0. if skip else 512 / 16000,
                        'elapsed_seconds': .25,
                    })

    def test_official_frame_contract_pads_tail_and_carries_recurrent_state(self):
        samples = np.ones(513) * 8
        for modern in (False, True):
            with self.subTest(modern=modern):
                report, session = self.assess(samples, SyntheticSilero(modern))
                self.assertEqual(report['frame_samples'], 512)
                self.assertEqual(report['frame_count'], 2)
                self.assertEqual(report['duration_seconds'], 513 / 16000)
                self.assertEqual(len(session.calls), 4)
                tail = session.calls[1]['input'][0, -512:]
                self.assertEqual(tail[0], 8 / 32768)
                self.assertFalse(tail[1:].any())
                state_key = 'state' if modern else 'h'
                self.assertFalse(session.calls[0][state_key].any())
                self.assertTrue((session.calls[1][state_key] == 1).all())
                self.assertFalse(session.calls[2][state_key].any())
                if modern:
                    self.assertEqual(report['context_samples'], 64)
                    self.assertTrue((session.calls[1]['input'][0, :64] == 8 / 32768).all())
                    self.assertFalse(session.calls[2]['input'][0, :64].any())
                else:
                    self.assertEqual(report['context_samples'], 0)
                    self.assertTrue((session.calls[1]['c'] == 1).all())
                    self.assertFalse(session.calls[2]['c'].any())

    def test_twenty_seconds_has_625_frames_with_measured_evidence_duration(self):
        with patch.object(speech_gate, '_probabilities', return_value=[.2] * 625):
            report, _ = self.assess(np.ones(20 * 16000) * 8)
        self.assertEqual(report['frame_samples'], 512)
        self.assertEqual(report['frame_count'], 625)
        self.assertEqual(report['speech_evidence_seconds'], 20)
        self.assertFalse(report['skip_stt'])

    def test_threshold_equality_and_invalid_probability_both_keep_audio(self):
        with patch.object(speech_gate, '_probabilities', return_value=[.15]):
            report, _ = self.assess(np.ones(16000))
        self.assertFalse(report['skip_stt'])
        class InvalidSilero(SyntheticSilero):
            def run(self, outputs, inputs):
                return np.array([[np.nan]]), inputs['h'], inputs['c']
        report, _ = self.assess(np.ones(16000), InvalidSilero())
        self.assertFalse(report['skip_stt'])
        self.assertEqual(report['warning'], 'speech_gate_unavailable')

    def test_legacy_and_modern_reset_state_between_raw_and_gain_passes(self):
        for modern in (False, True):
            with self.subTest(modern=modern):
                report, session = self.assess(np.sin(np.arange(16000) * .13) * 8, SyntheticSilero(modern))
                first_gain_frame = session.calls[report['frame_count']]
                state_key = 'state' if modern else 'h'
                self.assertFalse(first_gain_frame[state_key].any())
                if modern:
                    self.assertFalse(first_gain_frame['input'][0, :64].any())
                self.assertEqual(report['interface'], 'state_512' if modern else 'h_c_512')
                self.assertFalse(report['skip_stt'])

    def test_versioned_modern_model_reports_version_and_keeps_on_wrong_interface(self):
        self.config['model_version'] = '6.2.3'
        report, _ = self.assess(np.sin(np.arange(512) * .13) * 8, SyntheticSilero(True))
        self.assertEqual(report['model_version'], '6.2.3')
        self.assertEqual(report['interface'], 'state_512')
        self.assertEqual(report['context_samples'], 64)
        self.assertFalse(report['skip_stt'])
        report, _ = self.assess(np.ones(512), SyntheticSilero(False))
        self.assertEqual(report['status'], 'unavailable')
        self.assertFalse(report['skip_stt'])
        self.assertIn('modern state/context', report['error'])

    def test_modern_invalid_recurrent_state_keeps_original(self):
        class InvalidState(SyntheticSilero):
            def run(self, outputs, inputs):
                return np.array([[.01]], dtype=np.float32), np.full((2, 1, 128), np.nan, dtype=np.float32)
        report, _ = self.assess(np.ones(512), InvalidState(True))
        self.assertEqual(report['status'], 'unavailable')
        self.assertFalse(report['skip_stt'])
        self.assertIn('invalid recurrent state', report['error'])

    def test_missing_model_digest_mismatch_and_bad_config_keep_original(self):
        path = self.audio(np.ones(16000) * 8)
        for config in (None, {}, {**self.config, 'model_path': str(self.root / 'missing.onnx')},
                       {**self.config, 'model_sha256': 'b' * 64},
                       {**self.config, 'threshold': .5}):
            with self.subTest(config=config):
                report = speech_gate.assess_window(path, config)
                self.assertFalse(report['skip_stt'])
                self.assertEqual(report['status'], 'unavailable')
                self.assertEqual(report['warning'], 'speech_gate_unavailable')

    def test_session_is_cached_uses_cpu_one_thread_and_revalidates_changed_model(self):
        handles = []
        def create_session(path, sess_options, providers):
            self.assertEqual(providers, ['CPUExecutionProvider'])
            self.assertEqual(sess_options.intra_op_num_threads, 1)
            self.assertEqual(sess_options.inter_op_num_threads, 1)
            self.assertEqual(sess_options.execution_mode, 'sequential')
            session = SyntheticSilero(); handles.append(session)
            return session
        fake_ort = SimpleNamespace(SessionOptions=SimpleNamespace,
                                   ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL='sequential'),
                                   InferenceSession=create_session)
        path = self.audio(np.ones(16000) * 8)
        with patch.dict('sys.modules', {'onnxruntime': fake_ort}):
            first = speech_gate.assess_window(path, self.config)
            second = speech_gate.assess_window(path, self.config)
            self.assertTrue(first['skip_stt'])
            self.assertTrue(second['skip_stt'])
            self.assertEqual(len(handles), 1)
            self.model.write_bytes(b'changed model')
            third = speech_gate.assess_window(path, self.config)
            self.assertFalse(third['skip_stt'])
            self.assertEqual(third['status'], 'unavailable')
            self.assertEqual(len(handles), 1)


if __name__ == '__main__':
    unittest.main()
