"""Fixture checks for transport, provenance, relocation and no-clobber setup."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import build_bundle as builder
import configure


class BundleTests(unittest.TestCase):
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
