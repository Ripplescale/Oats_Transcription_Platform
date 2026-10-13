"""Timestamped synthetic decoder tests; no model loading, downloads, or microphone."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import types
import unittest
from unittest import mock
import uuid
import wave

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[2] / 'frontend/src-tauri/scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fw = load('faster_whisper_dictation')
worker = load('dictation_worker')


def hypothesis(entries):
    return [types.SimpleNamespace(word=' ' + text, start=start, end=end) for text, start, end in entries]


class FakeModel:
    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.calls = []
        self.consumed = 0

    def transcribe(self, audio, **kwargs):
        self.calls.append((len(audio), kwargs))
        if not self.scripts:
            raise AssertionError('Unexpected decoder call')
        script = self.scripts.pop(0)
        def segments():
            self.consumed += 1
            if isinstance(script, Exception):
                raise script
            yield types.SimpleNamespace(words=script)
        return segments(), object()


class FasterWhisperDictationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dictation-faster-synthetic-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assets = self.root / 'model'
        self.assets.mkdir()
        for name in ('model.bin', 'config.json', 'tokenizer.json'):
            (self.assets / name).write_bytes(b'fixture')
        self.settings = {'model_path': str(self.assets), 'model_id': 'synthetic/base',
                         'cpu_threads': 4, 'language': None, 'context_seconds': 1}
        self.identity = str(uuid.uuid4())

    def backend(self, scripts):
        model = FakeModel(scripts)
        constructor = mock.Mock(return_value=model)
        backend = fw.Backend(self.settings, model_factory=constructor)
        backend.fixture_model = model
        backend.fixture_constructor = constructor
        return backend

    def audio(self, seconds):
        return np.full(round(seconds * 16000), 5000, dtype='<i2')

    def stream(self, final=False, identity=None, live=True):
        return {'id': identity or self.identity, 'final': final, 'live': live}

    def test_continuous_speech_confirms_while_speaking_and_rolls_audio_with_overlap(self):
        backend = self.backend([
            hypothesis([('one', .2, .5), ('two', .6, .9), ('three', 1, 1.3), ('four', 1.5, 1.8)]),
            hypothesis([('one', .2, .5), ('two', .6, .9), ('three', 1, 1.3), ('four', 1.5, 1.8),
                        ('five', 2.2, 2.5), ('six', 3.2, 3.5)]),
            hypothesis([('three', .2, .5), ('four', .7, 1), ('five', 1.4, 1.7), ('six', 2.4, 2.7),
                        ('seven', 3.4, 3.7), ('eight', 4.4, 4.7)]),
            hypothesis([('six', .7, 1), ('seven', 1.7, 2), ('eight', 2.7, 3), ('nine', 3.3, 3.5)])])
        first = backend.transcribe(self.audio(2.1), self.stream())
        self.assertEqual(first['text'], '')
        self.assertEqual(first['draft_text'], 'one two three four')
        second = backend.transcribe(self.audio(4.1), self.stream())
        self.assertEqual(second['text'], 'one two three four')
        self.assertEqual(second['draft_text'], 'five six')
        self.assertEqual(second['confirmed_samples'], 12800)
        third = backend.transcribe(self.audio(6.1), self.stream())
        self.assertEqual(third['text'], 'one two three four five six')
        self.assertEqual(backend.fixture_model.calls[2][0], round(5.3 * 16000))
        final = backend.transcribe(self.audio(6.1), self.stream(True))
        self.assertEqual(final['text'], 'one two three four five six seven eight nine')
        self.assertEqual(final['draft_text'], '')
        self.assertEqual(final['confirmed_word_count'], 9)
        self.assertEqual(final['confirmed_samples'], final['audio_sample_count'])
        self.assertEqual(final['live_delivery'], 'stable_words')
        self.assertEqual(backend.confirmed, [])
        self.assertEqual(backend.fixture_model.consumed, 4)

    def test_default_context_retains_five_seconds_without_changing_confirmation(self):
        self.settings.pop('context_seconds')
        initial = hypothesis([('alpha', .5, 1), ('beta', 6, 6.4), ('gamma', 7, 7.4), ('delta', 7.6, 8)])
        backend = self.backend([initial, initial + hypothesis([('epsilon', 8.2, 8.5)]),
            hypothesis([('beta', 3, 3.4), ('gamma', 4, 4.4), ('delta', 4.6, 5),
                        ('epsilon', 5.2, 5.5), ('zeta', 6, 6.4), ('eta', 7, 7.4)])])
        self.assertEqual(backend.settings['context_seconds'], 5)
        self.assertEqual(backend.transcribe(self.audio(8.1), self.stream())['text'], '')
        second = backend.transcribe(self.audio(10.1), self.stream())
        self.assertEqual(second['text'], 'alpha beta gamma delta')
        self.assertEqual(second['confirmed_samples'], 3 * 16000)
        third = backend.transcribe(self.audio(12.1), self.stream())
        self.assertEqual(third['text'], 'alpha beta gamma delta epsilon')
        self.assertEqual(third['draft_text'], 'zeta eta')
        self.assertEqual(third['confirmed_samples'], round(3.5 * 16000))
        self.assertEqual(backend.fixture_model.calls[-1][0], round(9.1 * 16000))
        self.assertEqual(third['alignment_recovery_count'], 0)

    def test_context_configuration_has_integer_bounds_and_independent_session_state(self):
        for value in (None, True, 0, 11, 5.0, '5'):
            with self.subTest(value=value):
                factory = mock.Mock()
                with self.assertRaisesRegex(ValueError, 'context_seconds'):
                    fw.Backend({**self.settings, 'context_seconds': value}, model_factory=factory)
                factory.assert_not_called()
        for value in (1, 10):
            with self.subTest(value=value):
                self.settings['context_seconds'] = value
                backend = self.backend([hypothesis([('new', .1, .5), ('session', .6, 1)])])
                self.assertEqual(backend.settings['context_seconds'], value)
                result = backend.transcribe(self.audio(2), self.stream())
                self.assertEqual(result['text'], '')
                self.assertEqual(result['confirmed_samples'], 0)

    def test_revised_drafts_are_replaced_before_agreement(self):
        backend = self.backend([
            hypothesis([('send', .1, .4), ('fifteen', .5, 1)]),
            hypothesis([('send', .1, .4), ('fifty', .5, 1), ('today', 1.2, 1.6)]),
            hypothesis([('send', .1, .4), ('fifty', .5, 1), ('tomorrow', 1.2, 1.6)])])
        first = backend.transcribe(self.audio(2), self.stream())
        second = backend.transcribe(self.audio(3), self.stream())
        third = backend.transcribe(self.audio(4), self.stream())
        self.assertEqual(first['draft_text'], 'send fifteen')
        self.assertEqual(second['text'], 'send')
        self.assertEqual(second['draft_text'], 'fifty today')
        self.assertEqual(third['text'], 'send fifty')
        self.assertEqual(third['draft_text'], 'tomorrow')

    def test_context_punctuation_on_committed_frontier_does_not_stall_new_words(self):
        first = hypothesis([('hello', .1, .5), ('there', .6, 1)])
        refined = hypothesis([('HELLO,', .12, .52), ('there', .6, 1), ('friend', 1.2, 1.5)])
        backend = self.backend([first, first, refined])
        backend.transcribe(self.audio(2), self.stream())
        self.assertEqual(backend.transcribe(self.audio(3), self.stream())['text'], 'hello')
        result = backend.transcribe(self.audio(4), self.stream())
        self.assertEqual(result['text'], 'hello there')
        self.assertEqual(result['draft_text'], 'friend')
        self.assertTrue(result['alignment_available'])

    def test_lexical_and_timestamp_frontier_changes_resume_after_two_fresh_hypotheses(self):
        first = hypothesis([('alpha', .1, .5), ('beta', .6, 1)])
        revisions = [hypothesis([('altered', .1, .5), ('beta', .6, 1), ('gamma', 1.2, 1.5)]),
                     hypothesis([('alpha', .8, 1.2), ('beta', 1.3, 1.6), ('gamma', 1.7, 2)])]
        fresh = hypothesis([('beta', .1, .5), ('gamma', .7, 1), ('delta', 1.2, 1.5)])
        for changed in revisions:
            with self.subTest(changed=changed[0].word):
                backend = self.backend([first, first, changed, fresh,
                    fresh + hypothesis([('epsilon', 2, 2.2)]),
                    hypothesis([('delta', .7, 1), ('epsilon', 1.5, 1.7)])])
                backend.transcribe(self.audio(2), self.stream())
                backend.transcribe(self.audio(3), self.stream())
                rebased = backend.transcribe(self.audio(4), self.stream())
                self.assertEqual(rebased['text'], 'alpha')
                self.assertEqual(rebased['alignment_recovery_count'], 1)
                self.assertEqual(rebased['alignment_recovery_samples'], 8000)
                self.assertEqual(backend.recovery_floor, 8000)
                self.assertEqual(len(rebased['windows']), 2)
                unchanged = backend.transcribe(self.audio(4), self.stream())
                self.assertEqual(unchanged['text'], 'alpha')
                resumed = backend.transcribe(self.audio(5), self.stream())
                self.assertEqual(resumed['text'], 'alpha beta gamma delta')
                self.assertEqual(resumed['draft_text'], 'epsilon')
                self.assertEqual(backend.fixture_model.calls[-1][0], 72000)
                self.assertIsNone(backend.recovery_floor)
                final = backend.transcribe(self.audio(5), self.stream(True))
                self.assertEqual(final['text'], 'alpha beta gamma delta epsilon')
                self.assertEqual(final['confirmed_samples'], 80000)
                self.assertEqual(final['alignment_recovery_count'], 1)
                self.assertEqual(final['draft_text'], '')
                self.assertEqual(backend.recovery_count, 0)

    def test_frontier_equivalence_preserves_symbols_numbers_marks_and_repeat_ambiguity(self):
        word = lambda text, start=.1, end=.5: {'text': text, 'start': start, 'end': end}
        for left, right in (('20', '20%'), ('1.0', '1'), ('C++', 'C'), ('क', 'कि'), ("can't", 'cant')):
            self.assertFalse(fw._same_frontier(word(left), word(right)))
        self.assertFalse(fw._same(word('hello'), word('HELLO,')))
        backend = self.backend([])
        backend.confirmed = [word('yes', .4, .6)]
        ambiguous = [word('YES,', .3, .5), word('yes', .5, .7), word('next', .8, 1)]
        remaining, aligned = backend._uncommitted(ambiguous)
        self.assertFalse(aligned)
        self.assertEqual(remaining, [ambiguous[-1]])
        exact_repeats = [word('YES,', .4, .6), word('yes', 1, 1.2), word('next', 1.3, 1.5)]
        remaining, aligned = backend._uncommitted(exact_repeats)
        self.assertTrue(aligned)
        self.assertEqual(remaining, exact_repeats[1:])

    def test_actual_repeated_spoken_words_are_preserved_by_timestamp_alignment(self):
        words = hypothesis([('very', .1, .3), ('very', .4, .6), ('very', .7, .9), ('clear', 1, 1.3)])
        backend = self.backend([words, words, hypothesis([('clear', .1, .4)])])
        backend.transcribe(self.audio(2), self.stream())
        second = backend.transcribe(self.audio(3), self.stream())
        self.assertEqual(second['text'], 'very very very')
        final = backend.transcribe(self.audio(3), self.stream(True))
        self.assertEqual(final['text'], 'very very very clear')
        self.assertEqual(len(backend.fixture_model.calls), 3)

    def test_jittered_rapid_repeat_is_ambiguous_even_when_new_word_is_closer(self):
        backend = self.backend([])
        backend.confirmed = [{'text': ' very', 'start': .4, 'end': .6}]
        words = [{'text': ' very', 'start': .2, 'end': .4},
                 {'text': ' very', 'start': .55, 'end': .75},
                 {'text': ' clear', 'start': .8, 'end': 1}]
        _remaining, aligned = backend._uncommitted(words)
        self.assertFalse(aligned)
        self.assertEqual(len(backend.confirmed), 1)

    def test_repeat_ambiguity_recovery_keeps_new_spoken_repeat_before_stop(self):
        first = hypothesis([('very', .4, .6), ('clear', .8, 1)])
        ambiguous = hypothesis([('very', .2, .4), ('very', .55, .75), ('clear', .8, 1)])
        fresh = hypothesis([('very', 0, .15), ('clear', .2, .4), ('now', .5, .7)])
        backend = self.backend([first, first, ambiguous, fresh,
                                fresh + hypothesis([('again', .9, 1.1)])])
        backend.transcribe(self.audio(2), self.stream())
        backend.transcribe(self.audio(3), self.stream())
        rebased = backend.transcribe(self.audio(4), self.stream())
        self.assertEqual(rebased['text'], 'very')
        self.assertEqual(rebased['draft_text'], 'very clear now')
        self.assertEqual(rebased['alignment_recovery_samples'], 9600)
        resumed = backend.transcribe(self.audio(5), self.stream())
        self.assertEqual(resumed['text'], 'very very clear now')
        final = backend.transcribe(self.audio(5), self.stream(True))
        self.assertEqual(final['text'], 'very very clear now again')
        self.assertEqual(final['alignment_recovery_count'], 1)

    def test_recovery_state_resets_on_new_session_cancel_and_failure(self):
        first = hypothesis([('alpha', .1, .5), ('beta', .6, 1)])
        changed = hypothesis([('different', .1, .5), ('beta', .6, 1)])
        fresh = hypothesis([('beta', .1, .5), ('gamma', .7, 1)])
        for action in ('new_session', 'cancel', 'failure'):
            with self.subTest(action=action):
                scripts = [first, first, changed, fresh]
                scripts.append(RuntimeError('synthetic recovery failure') if action == 'failure' else first)
                backend = self.backend(scripts)
                backend.transcribe(self.audio(2), self.stream())
                backend.transcribe(self.audio(3), self.stream())
                backend.transcribe(self.audio(4), self.stream())
                self.assertEqual(backend.recovery_count, 1)
                if action == 'failure':
                    with self.assertRaisesRegex(RuntimeError, 'synthetic recovery failure'):
                        backend.transcribe(self.audio(5), self.stream())
                else:
                    if action == 'cancel':
                        backend.clear()
                    result = backend.transcribe(self.audio(2), self.stream(identity=str(uuid.uuid4())))
                    self.assertEqual(result['text'], '')
                    self.assertEqual(result['alignment_recovery_count'], 0)
                self.assertEqual(backend.recovery_count, 0)
                self.assertIsNone(backend.recovery_floor)

    def test_alignment_recovery_is_bounded_and_failure_clears_state(self):
        first = hypothesis([('alpha', .1, .5), ('beta', .6, 1)])
        changed = hypothesis([('different', .1, .5), ('beta', .6, 1)])
        backend = self.backend([first, first, changed])
        backend.transcribe(self.audio(2), self.stream())
        backend.transcribe(self.audio(3), self.stream())
        with mock.patch.object(fw, 'MAX_ALIGNMENT_RECOVERIES', 0):
            with self.assertRaisesRegex(ValueError, 'alignment recovery limit exceeded'):
                backend.transcribe(self.audio(4), self.stream())
        self.assertEqual(backend.confirmed, [])
        self.assertEqual(backend.recovery_count, 0)

    def test_numpy_scalar_timestamps_are_accepted_and_converted_to_plain_floats(self):
        words = hypothesis([('hello', np.float64(.1), np.float64(.5)),
                            ('world', np.float32(.6), np.float32(1))])
        backend = self.backend([words])
        result = backend.transcribe(self.audio(2), self.stream())
        self.assertEqual(result['draft_text'], 'hello world')
        self.assertTrue(all(type(word['start']) is float and type(word['end']) is float for word in backend.previous))
        backend = self.backend([hypothesis([('invalid', True, .5)])])
        with self.assertRaisesRegex(ValueError, 'invalid timestamped words'):
            backend.transcribe(self.audio(2), self.stream())

    def test_valid_zero_duration_formatting_entries_do_not_change_spoken_words(self):
        words = hypothesis([('आज', np.float64(.1), np.float64(.5)),
                            ('notes', np.float64(.6), np.float64(1))])
        words.extend([types.SimpleNamespace(word=' ', start=np.float64(1.98), end=np.float64(1.98)),
                      types.SimpleNamespace(word='', start=np.float64(1.98), end=np.float64(1.98))])
        backend = self.backend([words])
        preview = backend.transcribe(self.audio(2), self.stream())
        self.assertEqual(preview['draft_text'], 'आज notes')
        self.assertEqual(len(backend.previous), 2)
        self.assertEqual([(word['start'], word['end']) for word in backend.previous], [(.1, .5), (.6, 1)])
        final = backend.transcribe(self.audio(2), self.stream(True))
        self.assertEqual(final['text'], 'आज notes')
        self.assertEqual(final['confirmed_word_count'], 2)

    def test_whitespace_entries_still_require_valid_timestamps_and_remain_bounded(self):
        for start, end in ((float('nan'), 1), (1, float('inf')), (True, 1), (-.1, 0),
                           (1, .9), (1, 3)):
            backend = self.backend([[types.SimpleNamespace(word=' ', start=start, end=end)]])
            with self.assertRaisesRegex(ValueError, 'invalid timestamped words'):
                backend.transcribe(self.audio(2), self.stream())
            self.assertIsNone(backend.identity)
        words = hypothesis([('word', 1, 1.5)])
        words.append(types.SimpleNamespace(word=' ', start=.1, end=.2))
        backend = self.backend([words])
        with self.assertRaisesRegex(ValueError, 'invalid timestamped words'):
            backend.transcribe(self.audio(2), self.stream())
        spaces = [types.SimpleNamespace(word=' ', start=0, end=0)] * 3
        backend = self.backend([spaces])
        with mock.patch.object(fw, 'MAX_WORDS', 2):
            with self.assertRaisesRegex(ValueError, 'too many words'):
                backend.transcribe(self.audio(2), self.stream())

    def test_skipped_prefix_requests_do_not_drop_intervening_words(self):
        words = hypothesis([('alpha', .1, .5), ('beta', .6, 1)])
        more = words + hypothesis([('gamma', 3, 3.5), ('delta', 7, 7.5)])
        backend = self.backend([words, more])
        backend.transcribe(self.audio(2), self.stream())
        preview = backend.transcribe(self.audio(10), self.stream())
        self.assertEqual(preview['text'], 'alpha beta')
        final = backend.transcribe(self.audio(10), self.stream(True))
        self.assertEqual(final['text'], 'alpha beta gamma delta')

    def test_identical_audio_does_not_manufacture_second_agreement(self):
        backend = self.backend([hypothesis([('one', .1, .5), ('two', .6, 1)])])
        backend.transcribe(self.audio(2), self.stream())
        again = backend.transcribe(self.audio(2), self.stream())
        self.assertEqual(again['text'], '')
        self.assertEqual(again['cache_hit_count'], 1)
        final = backend.transcribe(self.audio(2), self.stream(True))
        self.assertEqual(final['text'], 'one two')

    def test_revision_of_committed_overlap_uses_timestamp_boundary_retry_at_stop(self):
        first = hypothesis([('alpha', .1, .5), ('beta', .6, 1)])
        changed = hypothesis([('altered', .1, .5), ('beta', .6, 1), ('gamma', 1.2, 1.5)])
        backend = self.backend([first, first, changed, hypothesis([('beta', .1, .5), ('gamma', .7, 1)])])
        backend.transcribe(self.audio(2), self.stream())
        self.assertEqual(backend.transcribe(self.audio(3), self.stream())['text'], 'alpha')
        final = backend.transcribe(self.audio(4), self.stream(True))
        self.assertEqual(final['text'], 'alpha beta gamma')
        self.assertEqual(backend.fixture_model.calls[-1][0], 56000)

    def test_no_vad_required_and_model_options_are_local_cpu_int8(self):
        backend = self.backend([hypothesis([('आज', .1, .5), ('notes', .6, 1)])])
        result = backend.transcribe(self.audio(2), self.stream(True))
        self.assertEqual(result['text'], 'आज notes')
        backend.fixture_constructor.assert_called_once_with(
            str(self.assets), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
        options = backend.fixture_model.calls[0][1]
        self.assertEqual(options, {'language': None, 'beam_size': 1, 'best_of': 1, 'temperature': 0.0,
                                  'condition_on_previous_text': False, 'word_timestamps': True, 'vad_filter': False})

    def test_session_and_language_changes_reset_agreement_but_keep_model(self):
        words = hypothesis([('hello', .1, .5), ('world', .6, 1)])
        backend = self.backend([words] * 4)
        backend.transcribe(self.audio(2), self.stream())
        changed = backend.transcribe(self.audio(3), self.stream(identity=str(uuid.uuid4())))
        self.assertEqual(changed['text'], '')
        changed = backend.transcribe(self.audio(4), self.stream(), 'english')
        self.assertEqual(changed['text'], '')
        self.assertEqual(backend.fixture_model.calls[-1][1]['language'], 'en')
        self.assertEqual(backend.fixture_constructor.call_count, 1)
        other = self.backend([words])
        self.assertEqual(other.transcribe(self.audio(5), self.stream())['text'], '')

    def test_cancel_and_inference_failure_clear_all_session_text(self):
        words = hypothesis([('private', .1, .5), ('draft', .6, 1)])
        backend = self.backend([words, words, RuntimeError('synthetic inference failure')])
        backend.transcribe(self.audio(2), self.stream())
        backend.clear()
        self.assertEqual(backend.previous, [])
        self.assertEqual(backend.last_words, [])
        self.assertEqual(backend.transcribe(self.audio(3), self.stream())['text'], '')
        with self.assertRaisesRegex(RuntimeError, 'synthetic inference failure'):
            backend.transcribe(self.audio(4), self.stream())
        self.assertEqual(backend.confirmed, [])
        self.assertIsNone(backend.identity)

    def test_confirmed_audio_changes_fail_closed_even_inside_retained_overlap(self):
        words = hypothesis([('one', .1, .5), ('two', .6, 1)])
        backend = self.backend([words, words])
        backend.transcribe(self.audio(2), self.stream())
        backend.transcribe(self.audio(3), self.stream())
        changed = self.audio(4); changed[100] += 1
        with self.assertRaisesRegex(ValueError, 'Confirmed faster-whisper audio changed'):
            backend.transcribe(changed, self.stream())
        self.assertEqual(backend.confirmed, [])

    def test_legacy_previews_remain_empty_and_stop_transcribes_all_audio(self):
        backend = self.backend([hypothesis([('all', .1, .5), ('words', .6, 1)])])
        preview = backend.transcribe(self.audio(2), self.stream(live=False))
        self.assertEqual(preview['text'], '')
        self.assertEqual(preview['draft_text'], '')
        self.assertEqual(backend.fixture_model.calls, [])
        self.assertNotIn('live_delivery', preview)
        self.assertEqual(backend.transcribe(self.audio(3), self.stream(True, live=False))['text'], 'all words')

    def test_silence_never_invokes_decoder(self):
        backend = self.backend([])
        result = backend.transcribe(np.zeros(32000, dtype='<i2'), self.stream(True))
        self.assertEqual(result['text'], '')
        self.assertEqual(result['confirmed_samples'], 32000)
        self.assertEqual(backend.fixture_model.calls, [])

    def test_invalid_timestamps_missing_words_and_session_bounds_fail_closed(self):
        for entries in (None, hypothesis([('bad', -1, .5)]), hypothesis([('bad', 0, float('nan'))]),
                        hypothesis([('bad', .5, 3)])):
            backend = self.backend([entries])
            with self.assertRaises(ValueError):
                backend.transcribe(self.audio(2), self.stream())
            self.assertIsNone(backend.identity)
        backend = self.backend([])
        with self.assertRaises(ValueError):
            backend.transcribe(self.audio(121), self.stream())
        with self.assertRaises(ValueError):
            backend.transcribe(self.audio(2).astype(np.float32), self.stream())
        with self.assertRaises(ValueError):
            backend.transcribe(self.audio(2), {'id': '../bad', 'final': False, 'live': True})

    def test_assets_and_settings_fail_before_model_construction(self):
        factory = mock.Mock()
        for change in ({'model_path': 'remote/repository'}, {'cpu_threads': True}, {'cpu_threads': 0},
                       {'cpu_threads': 65}, {'language': 'unsupported'}):
            with self.assertRaises(ValueError):
                fw.Backend({**self.settings, **change}, model_factory=factory)
        (self.assets / 'tokenizer.json').unlink()
        with self.assertRaisesRegex(ValueError, 'assets are incomplete'):
            fw.Backend(self.settings, model_factory=factory)
        factory.assert_not_called()

    def test_result_text_and_word_counts_are_bounded(self):
        backend = self.backend([hypothesis([('x' * 100, .1, .5)])])
        with mock.patch.object(fw, 'MAX_TEXT_BYTES', 50):
            with self.assertRaisesRegex(ValueError, 'draft is too large'):
                backend.transcribe(self.audio(2), self.stream(True))
        backend = self.backend([hypothesis([('one', .1, .5), ('two', .6, 1)])])
        with mock.patch.object(fw, 'MAX_WORDS', 1):
            with self.assertRaisesRegex(ValueError, 'too many words'):
                backend.transcribe(self.audio(2), self.stream())

    def request(self, seconds, final=False):
        identity = str(uuid.uuid4())
        directory = self.root / identity; directory.mkdir()
        audio = directory / 'input.wav'
        with wave.open(str(audio), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
            output.writeframes(self.audio(seconds).tobytes())
        descriptor = self.stream(final)
        (directory / 'request.json').write_text(json.dumps({'version': 1, 'request_id': identity,
            'audio_path': str(audio), 'model': 'trelis', 'language_mode': 'hinglish', 'stream': descriptor}))
        command = (json.dumps({'version': 1, 'action': 'transcribe', 'request_id': identity}) + '\n').encode()
        return directory, command

    def test_worker_selects_independent_backend_warms_once_and_clears_on_eof(self):
        words = hypothesis([('hello', .1, .5), ('world', .6, 1)])
        backend = self.backend([words, words])
        config = self.root / 'runtime.json'
        config.write_text(json.dumps({'version': 1, 'dictation_backend': 'faster_whisper', 'faster_whisper': self.settings}))
        first, command1 = self.request(2)
        second, command2 = self.request(3, True)
        def construct(_config):
            with self.assertRaisesRegex(OSError, 'offline'):
                socket.create_connection(('127.0.0.1', 1))
            return backend
        with mock.patch.object(worker, 'faster_whisper_backend', side_effect=construct) as factory, \
                mock.patch.object(worker, 'runtime_adapters', side_effect=AssertionError('meeting runtime imported')):
            self.assertEqual(worker.serve(config, io.BytesIO(command1 + command2)), 0)
        self.assertEqual(factory.call_count, 1)
        ready = json.loads((self.root / 'ready.json').read_text())
        self.assertEqual(ready['dictation_backend'], 'faster_whisper')
        preview = json.loads((first / 'result.json').read_text())
        result = json.loads((second / 'result.json').read_text())
        self.assertEqual(preview['draft_text'], 'hello world')
        self.assertEqual(result['text'], 'hello world')
        self.assertEqual(result['live_delivery'], 'stable_words')
        self.assertEqual(result['stream'], self.stream(True))
        self.assertEqual(backend.previous, [])

    def test_worker_error_never_publishes_draft_and_eof_clears_pending_state(self):
        config = self.root / 'runtime.json'
        config.write_text(json.dumps({'dictation_backend': 'faster_whisper', 'faster_whisper': self.settings}))
        backend = self.backend([hypothesis([('private', .1, .5)]), RuntimeError('synthetic failure')])
        first, command1 = self.request(2)
        second, command2 = self.request(3)
        with mock.patch.object(worker, 'faster_whisper_backend', return_value=backend):
            self.assertEqual(worker.serve(config, io.BytesIO(command1 + command2)), 0)
        result = json.loads((second / 'result.json').read_text())
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['text'], '')
        self.assertEqual(result['draft_text'], '')
        self.assertEqual(result['live_delivery'], 'stable_words')
        self.assertEqual(backend.last_words, [])
        self.assertIsNone(backend.identity)

    def test_sibling_module_resolves_from_importlib_loaded_worker(self):
        worker._FASTER_WHISPER_MODULE = None
        module = types.SimpleNamespace(WhisperModel=mock.Mock(return_value=FakeModel([])))
        import sys
        with mock.patch.dict(sys.modules, {'faster_whisper': module}):
            backend = worker.faster_whisper_backend({'faster_whisper': self.settings})
        self.assertEqual(backend.settings['model_id'], 'synthetic/base')


if __name__ == '__main__':
    unittest.main()
