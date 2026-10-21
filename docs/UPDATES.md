# Signed Windows updates

## Normal release process

Publishing an app update means publishing a complete signed GitHub Release,
not just pushing source. Commit the reviewed changes and release notes, use a
stable version higher than installed and published versions, then push its
matching `vX.Y.Z` tag. The Windows workflow runs regression checks, builds and
signs the installer, verifies the feed, uploads all assets to a draft, and makes
the complete release latest. Verify the public feed and signed bytes before
reporting that the update is available. Ordinary branch pushes remain development
work; they do not distribute an installer. Installing locally is a separate user
action and is not part of publishing.

The repository is now `Ripplescale/Oats_Transcription_Platform`. The workflow is
bound to repository ID `1398488057`, so another rename does not disable releases.
Existing 0.8.3–0.8.5 clients accept only the previous repository's download path.
The shared feed keeps that redirected asset URL for compatibility; new clients
accept both names for the same signed installer and check the current feed URL.
Keep the same signing identity. GitHub Actions stores its encrypted key and
password as separate encrypted repository secrets, not in source or logs.

oats checks the public `Ripplescale/Oats_Transcription_Platform` GitHub release feed after startup and roughly once a day while open. About → Check for updates checks immediately. Checks fetch release metadata only. A notification offers details; **Download update** explicitly downloads and verifies the installer; **Install now** is a separate action. The app does not install on startup or automatically restart during work.

Installation flushes mounted note/title editors and refuses unresolved draft journals, pending transcript corrections, reference entries or edited earlier summaries. Reviewed forms must be explicitly saved, applied or cancelled. The modal blocks new editor interaction during handoff. Native code checks meeting capture, dictation, retained dictation text, local transcription/speaker work and recording storage again, under an interlock that also blocks new work from starting. Copy or save a pending dictation result and dismiss its popup before installing. Busy or failed installation retains the staged package for retry. Staging is memory-only and is lost when oats closes. Successful Windows installer handoff closes the app; the installer controls its return.

The main window alone can call the update commands. No WebView receives direct updater download/install permissions. Native code accepts only the expected Windows installer in this repository, limits downloads to 512 MiB, verifies Tauri's Minisign signature and authenticated version, and verifies again before installation. Missing or invalid `OATS_UPDATER_PUBLIC_KEY` leaves updates visibly unconfigured. Development builds do not invent a signing identity.

## What makes an update

A source commit or GitHub push is not an app update. Publish a reviewed **stable GitHub Release** tagged `vX.Y.Z` with the complete signed asset set:

- `oats_X.Y.Z_x64-setup.exe`
- `oats_X.Y.Z_x64-setup.exe.sig`
- `latest.json`
- `SHA256SUMS.txt` and `SOURCE-COMMIT.txt` for review

The current feed is `https://github.com/Ripplescale/Oats_Transcription_Platform/releases/latest/download/latest.json`; the previous repository name redirects there for older clients. Its `windows-x86_64` entry points to that tag's exact installer and contains the signature text, not a signature URL. New versions must exceed the installed version. Draft or prerelease uploads do not become the stable latest feed. Before the first signed release is published, this endpoint may return HTTP 404; a configured app cannot offer an update from an empty feed.

The old `.github/workflows/*.disabled`, `scripts/generate-update-manifest-github.js` and local updater demo retain upstream assumptions. They are not this release path and must not be enabled unchanged. The new packaging script does not push, create a tag, upload files, publish a release or install anything.

The new `.github/workflows/oats-windows-release.yml` intentionally publishes on **stable `vX.Y.Z` tag pushes only**, after one-time setup. Ordinary branch pushes do not publish. It is gated by repository variable `OATS_RELEASES_ENABLED=true` and the stable repository ID. Set repository variable `OATS_UPDATER_PUBLIC_KEY` to the public `.pub` contents, and secrets `OATS_UPDATER_PRIVATE_KEY` / `OATS_UPDATER_PRIVATE_KEY_PASSWORD` to the protected signing credentials. Merge the reviewed workflow and source, supply those values, enable the variable, and push a reviewed version tag with matching committed release notes. No extra per-release approval is introduced; the deliberate tag is the publishing trigger, subject to any existing repository protections.

CI uses Windows 2022, verified official GitHub Actions revisions, pnpm 9.15.9, a Rust MSVC toolchain, the runner's Microsoft C++ Build Tools, and a pinned SHA-256-checked public libclang wheel. The same packaging helper supplies Microsoft CRT and stages native build dependencies. It uploads every verified file to a draft before making it the latest release. Failed uploads remain unpublished, and existing releases are not overwritten automatically. The first complete public CI run and installer smoke test remain release qualification steps; source validation alone does not establish end-to-end publication and installation.

## One-time signing and first upgrade

1. Provision a Tauri signing identity outside the repository using the official signer. Store the encrypted private key and password in a secure backup; future releases need the same identity. Do not paste either into source, logs, issue bodies or chat. Only its `.pub` file is safe to distribute. The portable release helper does not generate these files; the Windows local-signing helper described below can provision and verify an identity.
2. Use the pinned released Tauri CLI **2.12.0**, which embeds `version:X.Y.Z` in the authenticated signature comment. The helper refuses older signers and rejects signatures with missing, duplicate or different versions. Native installation uses `tauri-plugin-updater` 2.13.3 or the exact reviewed lockfile version, including its Windows launch-error handling.
3. Build the first release with the public key injected as `OATS_UPDATER_PUBLIC_KEY`. Provision `TAURI_SIGNING_PRIVATE_KEY` and, when applicable, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` privately in the build process. The script does not print their values. Keep that same public key in later builds unless carrying out a separately planned key migration.
4. Existing 0.8.2 installations need **one manual installation** of an updater-enabled build. They cannot acquire this feature from a code push. Save notes and fully close oats before that manual upgrade. Test it first against a disposable copy of a legacy installation/data directory, then confirm the chosen real data location is retained.

For manual upgrades, the custom NSIS template preserves the legacy `sttapp-local-install.json` pointer as `%LOCALAPPDATA%\STTApp\data-location.json` when no saved choice exists. Preservation runs after resolving the installation location in `.onInit` and again **before** the reinstall page invokes the previous uninstaller. The standard Tauri `PREINSTALL` hook would be too late. Copy failure aborts before removal, and an existing saved choice is never overwritten. In-app installation also persists the current chosen location before handoff. The resolver order is explicit environment override, saved choice, legacy installed marker, then the default directory; an invalid saved choice blocks instead of silently opening empty notes.

The identity remains `com.sttapp.local`, main binary `xx`, and the previous `xx` registry identity. The installer preserves the location; it does not move/delete recordings, notes, models or runtime snapshots. Data already stored inside another application's cache remains exposed to that application's cache removal. Keep independent data backups.

## Prepare a release locally

### Local signing identity on Windows

`scripts/local-release-signing.ps1` provides `Ensure`, `Build` and `Sign` modes under PowerShell 7. Its default identity directory is the current Windows user's ordinary `%LOCALAPPDATA%\oats-release-signing`, outside the repository and application data. The directory permits only that user and SYSTEM. The private Tauri key is encrypted with a randomly generated password; that password is saved only as Windows CurrentUser DPAPI-protected bytes. The helper never prints a private key or password, refuses links/broad permissions/incomplete identities, and reuses an existing verified identity without replacing it. It signs and verifies a disposable challenge before use.

```powershell
# Use the reviewed released CLI 2.12.0; its dependency may be installed separately.
./scripts/local-release-signing.ps1 -Mode Ensure -TauriCliPath C:\BuildTools\tauri-2.12.0\node_modules\@tauri-apps\cli\tauri.js

# Build only: this command never installs or publishes anything.
./scripts/local-release-signing.ps1 -Mode Build `
  -TauriCliPath C:\BuildTools\tauri-2.12.0\node_modules\@tauri-apps\cli\tauri.js `
  -DataRoot C:\ExistingLocalData\STTApp `
  -TargetRoot C:\OatsLocalBuild
```

`Build` calls the existing local packaging helper with its existing data-root marker, injects signing/public-key variables only for that process, enables updater artifacts through a temporary CLI config overlay, and verifies the resulting installer signature/version. It returns only public-key identity and build paths. This local installer retains the existing workstation configuration; use `package-windows-release.ps1` for public distribution without that marker.

`Sign` recovers a completed local installer when compilation and NSIS packaging succeeded but automatic signing failed. Pass the same CLI and target directory as the build; it signs only the exact versioned release installer, requires matching Windows version metadata, and verifies the result. It never compiles, rebundles, installs, or replaces an existing signature. An existing signature must already verify. The installer stays open with writes/deletion denied during signing and verification.

Keep the same signing identity for subsequent versions. DPAPI is bound to this Windows account: copying these files alone to another machine does not provide a usable signing password. Preserve the identity and appropriate Windows-profile recovery/backup material; a future move or CI-secret setup needs an explicitly authorized secure credential transfer. The helper does not upload GitHub secrets, enable the release workflow, or display credentials for copying. Preparing a local identity does not activate GitHub publication.

### Portable public release

Use a clean, reviewed commit with matching stable three-part versions in `frontend/package.json`, `frontend/src-tauri/Cargo.toml` and `tauri.conf.json`. The script archives only committed source into a **new, short, local staging directory**; it never packages this developer's ignored installation marker. It changes configuration only in that stage, enables signed updater artifacts, keeps the installer identity/hooks, and substitutes public installation notes. The optional legacy PowerShell launcher is omitted from public assets; Start menu launches the executable normally.

Build prerequisites: Windows x64, supported Node.js and pnpm 9, Rust/MSVC (at least the current dependency requirement, 1.90), Visual Studio C++ Build Tools, and LLVM `libclang.dll`. Use a fresh build shell. Package dependencies and native build dependencies may download from their configured public sources. Model weights, private runtime configuration and user data are neither inputs nor outputs. ONNX Runtime is pinned/hash-checked by the existing build script; the existing FFmpeg build helper performs its own platform download/validation.

```powershell
# Signing variables are already provisioned securely in this process.
./scripts/package-windows-release.ps1 `
  -Version X.Y.Z `
  -PublicKeyPath C:\ReleaseKeys\oats.pub `
  -ReleaseNotesPath C:\ReleaseNotes\X.Y.Z.md `
  -BuildToolsPath C:\BuildTools `
  -LibClangPath C:\LLVM\bin `
  -StageRoot C:\OatsBuild\rXYZ `
  -OutputDirectory C:\OatsReleases\X.Y.Z
```

Both output directories must be new, separate and outside the source checkout/OneDrive. Existing directories or release metadata are never overwritten. Stage files remain for review; remove the specific generated stage after release acceptance to avoid retaining build caches. No automatic recursive cleanup runs.

Before producing `latest.json`, `scripts/windows-update-feed.cjs` verifies the installer and trusted comment against the supplied public key using Ed25519 and the Minisign prehash format, confirms the exact version/repository/platform/filename, and produces checksums. It never reads a private key. An independent repeat check is:

```powershell
node scripts/windows-update-feed.cjs verify C:\OatsReleases\X.Y.Z\latest.json C:\OatsReleases\X.Y.Z\oats_X.Y.Z_x64-setup.exe C:\ReleaseKeys\oats.pub
```

Review the packaged files and smoke-test the installer and update handoff on a disposable Windows installation (including cancelled installer launch, notes saving, active recording/dictation rejection and retained history). For manual publication, upload the complete asset set to a draft release and publish after validation; a half-uploaded public feed should not become latest. A reviewed version tag runs the configured automated release path. Do not reuse a published version for different bytes. If a bad release is withdrawn, publish a fixed higher version; do not relabel an old signed binary as a new version.

## Current delivery limits

An updater-enabled build must contain the same public key used to verify future releases. Repository variables/secrets, workflow activation and a complete published signed release are required before an update can be offered. An empty feed can report a check error. Existing 0.8.2 and earlier installations need a manual updater-enabled upgrade once; subsequent source commits alone do not update the installed app.

This is a Windows x64 **desktop application updater**, not automatic provisioning of Python, Trelis model weights or GPU drivers for a new laptop. Existing local speech runtimes remain configured independently. Fresh users need the local speech-runtime setup before recording/transcription works. Cross-machine first-run setup and actual end-to-end public update installation still require qualification. Local identity/build preparation does not publish a GitHub release or perform installation.

Tauri update signatures are separate from Windows Authenticode signing; they do not remove SmartScreen warnings. A private repository would not provide a credential-free public feed: use a reviewed public release repository or per-user authentication, never an embedded shared GitHub token.

Primary references: [Tauri updater/signing](https://v2.tauri.app/plugin/updater/), [released CLI version-bound signer](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-cli/src/signer/sign.rs), [Windows installer hooks](https://v2.tauri.app/distribute/windows-installer/), [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
