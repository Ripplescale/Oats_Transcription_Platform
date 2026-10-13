"""Safety and preservation checks for the one-time generated history pruner."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "frontend/src-tauri/scripts/prune-generated-history.py"
SPEC = importlib.util.spec_from_file_location("generated_history_retention", SCRIPT)
retention = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retention)


class GeneratedHistoryRetentionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("OATS_RETENTION_TEST_TMP"))
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "STTApp"
        self.note = self.root / "workspaces/meeting-capture-test"
        self.job = self.note / "job-metadata"
        self.speaker = self.note / "speaker-metadata"
        self.job.mkdir(parents=True)
        self.speaker.mkdir()
        for number in range(1, 7):
            self.revision(self.job, number)
        for number in range(1, 5):
            self.revision(self.speaker, number)
        self.notes = self.note / "revisions"
        self.notes.mkdir()
        for number in range(1, 8):
            self.revision(self.notes, number, {"note": "An intentional user edit"})
        self.recording = self.root / "recordings/session/tracks/microphone/00000000.wav"
        self.recording.parent.mkdir(parents=True)
        self.recording.write_bytes(b"protected source audio")

    def revision(self, bucket, number, extra=None):
        path = bucket / f"revision-{number:012}.json"
        path.write_text(json.dumps({"revision": number, "segments": {"id": "generated"}, **(extra or {})}), encoding="utf-8")
        return path

    def all_files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def assert_refused_without_deletion(self, plan):
        before = self.all_files()
        with self.assertRaises(retention.UnsafeCleanup):
            retention.apply_plan(self.root, plan)
        self.assertEqual(before, self.all_files())

    def test_dry_run_then_apply_prunes_only_old_generated_revisions(self):
        before = self.all_files()
        plan = retention.make_plan(self.root)
        self.assertEqual(before, self.all_files())
        summary = retention.summarize(plan)
        self.assertEqual(summary["eligible_files"], 4)
        self.assertEqual(summary["retained_files"], 6)
        report = retention.apply_plan(self.root, plan)
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["removed_files"], 4)
        self.assertEqual(report["removed_bytes"], summary["eligible_bytes"])
        removed = {entry["path"] for entry in report["removed"]}
        self.assertEqual(self.all_files(), {path: data for path, data in before.items() if path not in removed})
        self.assertEqual(len(list(self.job.glob("revision-*.json"))), 3)
        self.assertEqual(len(list(self.speaker.glob("revision-*.json"))), 3)
        self.assertEqual(len(list(self.notes.glob("revision-*.json"))), 7)
        self.assertEqual(self.recording.read_bytes(), b"protected source audio")

    def test_latest_three_can_have_gaps_without_renumbering(self):
        (self.job / "revision-000000000004.json").unlink()
        report = retention.apply_plan(self.root, retention.make_plan(self.root))
        self.assertEqual(report["removed_files"], 3)
        self.assertEqual([path.name for path in sorted(self.job.glob("*.json"))],
                         ["revision-000000000003.json", "revision-000000000005.json", "revision-000000000006.json"])

    def test_corrupt_old_revision_aborts_every_bucket(self):
        plan = retention.make_plan(self.root)
        (self.speaker / "revision-000000000001.json").write_text("{not JSON", encoding="utf-8")
        self.assert_refused_without_deletion(plan)

    def test_filename_mismatch_and_boolean_revision_are_rejected(self):
        path = self.job / "revision-000000000001.json"
        for revision in (2, True, "1", 1.0):
            with self.subTest(revision=revision):
                path.write_text(json.dumps({"revision": revision}), encoding="utf-8")
                with self.assertRaises(retention.UnsafeCleanup):
                    retention.make_plan(self.root)

    def test_invalid_revision_filename_is_rejected(self):
        (self.job / "revision-7.json").write_text('{"revision": 7}', encoding="utf-8")
        with self.assertRaises(retention.UnsafeCleanup):
            retention.make_plan(self.root)

    def test_changed_retained_metadata_aborts_before_any_deletion(self):
        plan = retention.make_plan(self.root)
        self.revision(self.speaker, 4, {"changed": True})
        self.assert_refused_without_deletion(plan)

    def test_changed_deletion_candidate_aborts_before_any_deletion(self):
        plan = retention.make_plan(self.root)
        self.revision(self.speaker, 1, {"changed": True})
        self.assert_refused_without_deletion(plan)

    def test_new_revision_new_file_and_new_bucket_invalidate_plan(self):
        for change in (lambda: self.revision(self.speaker, 5),
                       lambda: (self.job / "pending.part").write_bytes(b"pending"),
                       lambda: (self.root / "workspaces/another/job-metadata").mkdir(parents=True)):
            plan = retention.make_plan(self.root)
            change()
            self.assert_refused_without_deletion(plan)

    def test_unrelated_bucket_files_are_preserved_but_bound_to_plan(self):
        partial = self.job / "pending.part"
        partial.write_bytes(b"pending")
        plan = retention.make_plan(self.root)
        partial.write_bytes(b"changed")
        self.assert_refused_without_deletion(plan)
        retention.apply_plan(self.root, retention.make_plan(self.root))
        self.assertEqual(partial.read_bytes(), b"changed")

    def test_malicious_or_modified_plan_cannot_delete_note_history(self):
        plan = retention.make_plan(self.root)
        modified = copy.deepcopy(plan)
        modified["buckets"][0]["remove"][0]["path"] = "workspaces/meeting-capture-test/revisions/revision-000000000001.json"
        self.assert_refused_without_deletion(modified)
        for path in ("../outside.json", "workspaces/id/job-metadata/../../outside.json",
                     "workspaces/id/revisions/revision-000000000001.json",
                     "workspaces\\id\\job-metadata\\revision-000000000001.json"):
            with self.subTest(path=path), self.assertRaises(retention.UnsafeCleanup):
                retention._deletion_path(self.root, {"path": path})

    def test_zero_eligible_files_is_successful_noop(self):
        retention.apply_plan(self.root, retention.make_plan(self.root))
        before = self.all_files()
        report = retention.apply_plan(self.root, retention.make_plan(self.root))
        self.assertEqual(report["removed_files"], 0)
        self.assertEqual(before, self.all_files())

    def test_replaying_an_applied_plan_refuses_without_more_deletions(self):
        plan = retention.make_plan(self.root)
        retention.apply_plan(self.root, plan)
        self.assert_refused_without_deletion(plan)

    def test_duplicate_json_fields_are_rejected(self):
        (self.job / "revision-000000000001.json").write_text('{"revision": 1, "revision": 1}', encoding="utf-8")
        with self.assertRaises(retention.UnsafeCleanup):
            retention.make_plan(self.root)

    def test_nonstandard_json_constants_are_rejected(self):
        (self.job / "revision-000000000001.json").write_text('{"revision": 1, "time": NaN}', encoding="utf-8")
        with self.assertRaises(retention.UnsafeCleanup):
            retention.make_plan(self.root)

    def test_individual_deletion_failure_reports_exact_partial_result(self):
        plan = retention.make_plan(self.root)
        actual_unlink = Path.unlink
        blocked = self.job / "revision-000000000002.json"

        def fail_one(path, *args, **kwargs):
            if path == blocked:
                raise PermissionError("Synthetic locked candidate")
            return actual_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_one):
            with self.assertRaises(retention.PartialCleanup) as caught:
                retention.apply_plan(self.root, plan)
        report = caught.exception.report
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["removed_files"], 1)
        self.assertTrue(blocked.exists())
        self.assertEqual(len(list(self.notes.glob("revision-*.json"))), 7)

    def test_reparse_component_is_rejected_before_reading(self):
        actual_lstat = Path.lstat

        def fake_lstat(path):
            actual = actual_lstat(path)
            if path == self.job:
                wrapped = mock.Mock(wraps=actual)
                wrapped.st_mode = actual.st_mode
                wrapped.st_file_attributes = retention.REPARSE_POINT
                return wrapped
            return actual

        with mock.patch.object(Path, "lstat", fake_lstat):
            with self.assertRaisesRegex(retention.UnsafeCleanup, "reparse"):
                retention.make_plan(self.root)

    def test_symbolic_link_is_rejected_when_platform_permits_creation(self):
        link = self.job / "link.json"
        try:
            link.symlink_to(self.recording)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation requires permissions on this platform")
        with self.assertRaisesRegex(retention.UnsafeCleanup, "Link"):
            retention.make_plan(self.root)

    def test_cli_report_inside_protected_data_is_rejected(self):
        before = self.all_files()
        result = retention.main(["--data-root", str(self.root), "--report", str(self.note / "notes.json")])
        self.assertEqual(result, 2)
        self.assertEqual(before, self.all_files())

    def test_cli_writes_dry_run_and_apply_reports(self):
        plan = self.base / "plan.json"
        report = self.base / "report.json"
        self.assertEqual(retention.main(["--data-root", str(self.root), "--report", str(plan)]), 0)
        self.assertEqual(retention.main(["--data-root", str(self.root), "--apply-plan", str(plan), "--report", str(report)]), 0)
        result = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(result["removed_files"], 4)
        self.assertEqual(len(result["protected_current_metadata"]), 2)


if __name__ == "__main__":
    unittest.main()
