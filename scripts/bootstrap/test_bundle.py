"""Fixture checks for transport, provenance, relocation and no-clobber setup."""
import hashlib
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_bundle as builder
import configure


class BundleTests(unittest.TestCase):
    def signed_app_fixture(self, directory, version=None):
        node = os.environ.get("OATS_BOOTSTRAP_TEST_NODE") or shutil.which("node")
        if not node:
            self.skipTest("Maintainer Node is required for real signature integration tests")
        version = version or builder.source_app_version()
        directory.mkdir()
        subprocess.run([node, str(Path(__file__).with_name("make_signed_fixture.cjs")), str(directory), version], check=True, capture_output=True)
        return directory / f"oats_{version}_x64-setup.exe", directory / "latest.json", directory / "ephemeral.pub", node

    def test_current_signed_app_overlay_verifies_real_signature_and_source_version(self):
        with tempfile.TemporaryDirectory() as directory:
            installer, feed, key, node = self.signed_app_fixture(Path(directory) / "current")
            result = builder.verify_app_installer(installer, feed, key, node)
            self.assertEqual(result['version'], builder.source_app_version())
            self.assertEqual(result['sha256'], builder.digest(installer))
            installer.write_bytes(installer.read_bytes()[:-1] + b'!')
            with self.assertRaisesRegex(ValueError, 'signature verification'):
                builder.verify_app_installer(installer, feed, key, node)

    def test_signed_app_overlay_rejects_wrong_key_and_signed_old_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            installer, feed, key, node = self.signed_app_fixture(root / "current")
            other = self.signed_app_fixture(root / "other")
            with self.assertRaisesRegex(ValueError, 'signature verification'):
                builder.verify_app_installer(installer, feed, other[2], node)
            old = self.signed_app_fixture(root / "old", '0.8.1')
            with self.assertRaisesRegex(ValueError, 'current source app version'):
                builder.verify_app_installer(*old)

    def test_overlay_compilation_refuses_missing_or_tampered_installer_before_compiler(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaisesRegex(ValueError, 'requires the current signed installer'):
                builder.compile_setup({'app_version':'0.8.8'}, root)
            installer, feed, key, node = self.signed_app_fixture(root / "current")
            def tamper(source, output, size):
                output.write(b'MZ changed after verification')
            with patch.object(builder.shutil, 'copyfileobj', side_effect=tamper), self.assertRaisesRegex(ValueError, 'changed before embedding'):
                builder.compile_setup({'app_version':'0.8.8'}, root, app_installer=installer, update_feed=feed, public_key=key, node=node)

    def test_overlay_bounds_and_relabelled_feed_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            installer, feed, key, node = self.signed_app_fixture(Path(directory) / "current")
            with patch.object(builder, 'MAX_INSTALLER', installer.stat().st_size - 1), self.assertRaisesRegex(ValueError, '512 MiB'):
                builder.verify_app_installer(installer, feed, key, node)
            manifest=builder.read(feed)
            manifest['version']='0.8.99'
            feed.write_bytes(builder.encoded(manifest))
            with self.assertRaisesRegex(ValueError, 'signature verification'):
                builder.verify_app_installer(installer, feed, key, node)

    def test_overlay_embeds_verified_current_app_without_relabelling_immutable_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            installer, feed, key, node = self.signed_app_fixture(root / "current")
            folder=root / 'build'; folder.mkdir()
            immutable=[{'name':'untouched.part001','sha256':'a'*64}]
            manifest={'app_version':'0.8.8','parts':immutable}
            actual_run=subprocess.run
            compiler=[]
            def commands(args, **kwargs):
                if str(args[0]).endswith('csc.exe'):
                    compiler.append(args)
                    return subprocess.CompletedProcess(args,0)
                return actual_run(args,**kwargs)
            with patch.object(builder.subprocess,'run',side_effect=commands):
                builder.compile_setup(manifest,folder,app_installer=installer,update_feed=feed,public_key=key,node=node)
            emitted=builder.read(folder / 'bundle.json')
            self.assertEqual(emitted['app_version'],builder.source_app_version())
            self.assertEqual(emitted['payload_app_version'],'0.8.8')
            self.assertEqual(emitted['parts'],immutable)
            self.assertEqual(builder.digest(folder / '.build/app-installer.exe'),emitted['app_installer_sha256'])
            self.assertTrue(any(arg.endswith(',app-installer.exe') for arg in compiler[0]))
            self.assertFalse(any(arg.endswith(',app-installer.exe') for arg in compiler[1]),'Repair remains a small folder-only utility')
    def smoke_fixture(self, bundle):
        (bundle / "cache").mkdir()
        candidate = {"models": {"trelis": {"device": "GPU"}}}
        (bundle / "candidate-runtime.json").write_bytes(builder.encoded(candidate))
        return candidate

    def test_smoke_runs_both_engines_and_removes_generated_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            self.smoke_fixture(bundle)
            with patch.object(configure, "isolated", return_value='{"status":"ok","timing":{}}') as runner:
                result = configure.smoke(bundle)
            self.assertTrue(result["passed"])
            self.assertEqual(set(result["models"]), {"trelis", "apex"})
            self.assertEqual(runner.call_count, 2)
            self.assertTrue(all(call.kwargs["timeout"] == 300 for call in runner.call_args_list))
            self.assertTrue(all("transcribe" in call.args[1][1] for call in runner.call_args_list))
            self.assertEqual(list((bundle / "cache").iterdir()), [])
            self.assertEqual(result["candidate_sha256"], builder.digest(bundle / "candidate-runtime.json"))

    def test_failed_smoke_never_publishes_success(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            self.smoke_fixture(bundle)
            with patch.object(configure, "isolated", return_value='{"status":"failed","error":{"code":"gpu_failed"}}'):
                with self.assertRaisesRegex(RuntimeError, "speech test failed"):
                    configure.smoke(bundle)
            self.assertFalse((bundle / "speech-check.json").exists())
            self.assertEqual(configure.read(bundle / "speech-check-failure.json")["model"], "apex")
            self.assertEqual(list((bundle / "cache").iterdir()), [])

    def test_failed_gpu_inference_identifies_trelis_and_invalidates_old_success(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            self.smoke_fixture(bundle)
            (bundle / "speech-check.json").write_text('{"passed":true}')
            with patch.object(configure, "isolated", side_effect=['{"status":"ok"}', '{"status":"failed","error":"GPU compile failed"}']):
                with self.assertRaisesRegex(RuntimeError, "Trelis"):
                    configure.smoke(bundle)
            self.assertFalse((bundle / "speech-check.json").exists())
            self.assertEqual(configure.read(bundle / "speech-check-failure.json")["model"], "trelis")

    def test_smoke_receipt_cannot_activate_a_different_device_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bundle = root / "packages" / ("e" * 20)
            bundle.mkdir(parents=True)
            self.smoke_fixture(bundle)
            with patch.object(configure, "isolated", return_value='{"status":"ok"}'):
                configure.smoke(bundle)
            (bundle / "candidate-runtime.json").write_bytes(builder.encoded({"models": {"trelis": {"device": "CPU"}}}))
            with self.assertRaisesRegex(ValueError, "speech check"):
                configure.activate(bundle, root)
            self.assertFalse((root / "runtime.json").exists())

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
