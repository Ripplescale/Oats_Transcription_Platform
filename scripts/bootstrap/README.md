# Complete Windows setup (maintainers)

Recipients download **Oats-Setup.exe** from the complete-setup GitHub release.
They choose **Download and install**, or **Save for offline setup**. The latter
keeps the executable and every numbered part in the chosen folder; copy that
whole folder to an offline PC and run the same executable there.

This is separate from the small app-only updater. Publish a complete bundle with
a `setup-<20 hex digits>` tag and `--latest=false`. Never give it a `v...` tag,
replace `latest.json`, or mark it as the latest app release.

## Build

Use Windows x64 with Python 3.12.14 and .NET Framework 4.8. The compiler is the
Windows Framework64 C# compiler; no compiler is needed on recipient PCs. Keep all
generated files under ignored `target/bootstrap`. Building never activates a
runtime or installs oats.

1. Download the pinned app 0.8.8 assets (`oats_0.8.8_x64-setup.exe`, its `.sig`,
   and `latest.json`) from GitHub. Verify with `scripts/windows-update-feed.cjs`
   using the release public key. `build_bundle.py` additionally pins its hash.
2. Run `prepare-inputs.ps1 -Output <absolute input directory>` to fetch public
   licenses and redistributables and verify Microsoft signatures.
3. Run `python -B -m unittest discover -s scripts/bootstrap -p test_bundle.py`.
   Compile `PackageCore.cs` plus `CoreChecks.cs` as a console executable, with
   references to System.Net.Http, System.Web.Extensions, System.IO.Compression,
   and System.IO.Compression.FileSystem from Framework64/v4.0.30319. Run it with
   no arguments for the C# transport/path fixture checks.
4. Run `build_bundle.py --runtime <existing verified runtime.json>
   --python-base <private Python 3.12.14 directory> --inputs <input directory>
   --output <output directory>`. These are maintainer inputs, never recipient
   instructions. The tool explicitly selects components, not the app data tree.
5. Run `CoreChecks.exe extract <bundle.json> <disposable root>/packages/<id>`.
   Run that package's `python/python.exe -I -B setup/configure.py --root
   <disposable root> --probe`, then `--prepare --device GPU` or `CPU`. Never run
   `--activate` or the included installers during development validation.
6. Run `sign-setup.ps1 -BundleDirectory <bundle directory>` with the existing
   private updater identity. Retain the generated detached signature and
   publish SHA256SUMS, source commit and bundle.json.
   The embedded manifest pins every part; it pins an inner manifest that lists
   every payload file. Independently verify signatures and hashes before publish.
7. Upload to a draft GitHub release, verify every asset digest/size, then publish
   with `--latest=false`. Confirm the ordinary app feed still resolves to its
   existing signed app release. Do not install locally as part of publishing.

Model original and converted hashes are checked while building, extracting, and
preparing. ZIP64 is streamed into parts of at most 1500 MiB and read directly
across those parts; no joined multi-gigabyte archive is created. Completed
downloads work offline. Interrupted `.partial` downloads resume via HTTP Range.
Changes to existing completed parts or extracted files stop setup and preserve
the existing content. GitHub URLs, identities, file paths and sizes are bounded.

The destination environment is created using its own private Python. Developer
venv executables, pyvenv.cfg, source paths, credentials, recordings, jobs,
databases, and account-specific pip provenance are not copied. Original package
licenses remain in place. The runtime becomes active only after preparation,
WebView2 (if needed), and the oats app installer succeed; publication refuses an
existing runtime rather than replacing it. A failed installation can retain an
inactive package for retry. No model download occurs on the offline PC.

## Acceptance on another PC

Source tests, transport tests and relocation probes do not establish clean-PC
acceptance. On a Windows 11 x64 PC without Python, Git, Node, oats or prepared
models, check:

- Download/install using only Oats-Setup.exe, including one cancelled download
  resumed in the same folder. All downloads must come from GitHub release assets.
- Copy the complete saved folder to a second account/PC, disable networking,
  install and open oats. Test both a folder containing spaces and a longer user
  profile path. Missing parts must report what is missing and resume when online.
- Record and play back microphone and system audio. Confirm saved notes and a
  transcript survive app restart. Test Apex fallback on a saved recording.
- On a supported Intel GPU/driver, check Trelis live meeting transcription and
  dictation into another application, including Hindi/English input. Measure
  real latency separately; detection of a GPU is not a performance qualification.
- On other hardware, check the explicit CPU-mode prompt and after-recording
  transcription. The existing live-Trelis GPU requirement remains in force.
- Check ordinary signed app updates and preservation of the packaged runtime.
- Rerun setup against an existing installation and verify its configuration,
  recordings and notes are preserved.

Optional Community-1 speaker identification is not bundled. No AMD/NVIDIA
acceleration, ARM support, driver installation, or Windows Authenticode publisher
certificate is provided by this package. Detached release signatures use the
existing oats updater identity; they are not an Authenticode certificate.
