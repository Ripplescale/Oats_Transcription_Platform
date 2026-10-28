"""Fixture checks for transport, provenance, relocation and no-clobber setup."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_bundle as builder
import configure


class BundleTests(unittest.TestCase):
    def test_work_directories_preserve_existing_files_and_reject_other_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory).resolve()
            config = {"models": {"trelis": {"backend": "openvino", "cache_dir": str(bundle / "cache/openvino")},
                                 "apex": {"work_dir": str(bundle / "cache/apex")}}}
            configure.ensure_working_directories(config, bundle)
            sentinel = bundle / "cache/openvino/existing-cache"
            sentinel.write_bytes(b"preserved")
            configure.ensure_working_directories(config, bundle)
            self.assertEqual(sentinel.read_bytes(), b"preserved")
            config["models"]["apex"]["work_dir"] = str(bundle / "recordings")
            with self.assertRaises(ValueError):
                configure.ensure_working_directories(config, bundle)
            self.assertFalse((bundle / "recordings").exists())

    def test_prepare_creates_backend_work_directories_before_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory).resolve()
            (bundle / "setup").mkdir()
            gate = bundle / "gate.onnx"
            gate.write_bytes(b"synthetic gate")
            template = {"models": {
                "trelis": {"backend": "openvino", "cache_dir": "@PACKAGE@/cache/openvino", "export_path": "@PACKAGE@/models/export"},
                "apex": {"backend": "whisper_cpp", "work_dir": "@PACKAGE@/cache/apex"}},
                "speech_gate": {"model_path": "@PACKAGE@/gate.onnx", "model_sha256": builder.digest(gate)}}
            (bundle / "setup/runtime-template.json").write_bytes(builder.encoded(template))
            def check_before_model_validation(*args):
                self.assertTrue((bundle / "cache/openvino").is_dir(), "Trelis cache missing on fresh setup")
                self.assertTrue((bundle / "cache/apex").is_dir(), "Apex workspace missing on fresh setup")
                return "verified"
            with patch.object(configure, "isolated", side_effect=check_before_model_validation):
                configure.prepare(bundle, "GPU")
            self.assertEqual(list((bundle / "cache/apex").iterdir()), [])
            self.assertEqual(list((bundle / "cache/openvino").iterdir()), [])

    def test_embedded_crt_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs, output = root / "inputs", root / "output"
            (inputs / "msvc").mkdir(parents=True)
            output.mkdir()
            verified = {}
            for name in ["msvcp140_1.dll"] + [f"runtime{i}.dll" for i in range(9)]:
                data = b"MZ test fixture " + name.encode()
                (inputs / "msvc" / name).write_bytes(data)
                verified["msvc/" + name] = {"sha256": hashlib.sha256(data).hexdigest()}
            (inputs / "verified-inputs.json").write_bytes(builder.encoded({"files": verified}))
            manifest = {}
            builder.embed_msvc(manifest, output, inputs)
            with zipfile.ZipFile(output / "msvc-runtime.zip") as zipped:
                raw = zipped.read("payload-manifest.json")
                files = json.loads(raw)["files"]
                self.assertEqual(len(files), 20)
                self.assertEqual(manifest["runtime_manifest_sha256"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(manifest["runtime_bytes"], sum(f["size"] for f in files))
                for entry in files:
                    self.assertEqual(hashlib.sha256(zipped.read(entry["path"])).hexdigest(), entry["sha256"])

    def test_split_zip64_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            sources = builder.Sources()
            data = bytes(range(256)) * 31
            sources.add("models/test.bin", data=data)
            sources.add("setup/example.json", data=builder.encoded({"public": True}))
            manifest = builder.archive(sources, folder, "a" * 20, limit=1700)
            self.assertGreater(len(manifest["parts"]), 3)
            for part in manifest["parts"]:
                self.assertLessEqual(part["size"], 1700)
                self.assertEqual(builder.digest(folder / part["name"]), part["sha256"])
            joined = b"".join((folder / p["name"]).read_bytes() for p in manifest["parts"])
            with zipfile.ZipFile(io.BytesIO(joined)) as zipped:
                self.assertEqual(zipped.read("models/test.bin"), data)
                payload = zipped.read("payload-manifest.json")
                self.assertEqual(hashlib.sha256(payload).hexdigest(), manifest["payload_manifest_sha256"])

    def test_private_paths_and_names_rejected(self):
        for name in ("../x", "C:/x", "/x", "a\\b", "python/CON.txt", "python/a."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                builder.safe_name(name)
        with self.assertRaises(ValueError):
            builder.scan_public_text("metadata.json", b'{"source":"C:\\\\Users\\\\74463\\\\secret"}')

    def test_inputs_are_case_insensitive_and_integrity_checked(self):
        sources = builder.Sources()
        sources.add("setup/a.txt", data=b"verified", expected="0" * 64)
        with self.assertRaises(ValueError):
            sources.add("setup/A.txt", data=b"duplicate")
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(ValueError):
            builder.archive(sources, folder, "b" * 20, limit=100)

    def test_relocation_and_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder).resolve()
            self.assertEqual(configure.rebase({"path": "@PACKAGE@/worker/worker.py"}, bundle), {"path": str(bundle / "worker/worker.py")})
            with self.assertRaises(ValueError):
                configure.rebase("@PACKAGE@/../outside", bundle)

    def test_atomic_publication_preserves_existing_data(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "runtime.json"
            configure.write_new(path, {"original": True})
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                configure.write_new(path, {"overwrite": True})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(folder).iterdir()), [path])
            with self.assertRaises(ValueError):
                configure.activate(Path(folder) / "packages/test", Path(folder))


if __name__ == "__main__":
    unittest.main()
