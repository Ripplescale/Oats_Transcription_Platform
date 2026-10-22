# Install oats on another Windows PC

Download **Oats-Setup.exe** from the [complete setup release](https://github.com/Ripplescale/Oats_Transcription_Platform/releases/tag/setup-90c87eedfa370799c4db).

1. Open Oats-Setup.exe and choose a folder for the downloaded components.
2. Choose **Download and install**. Leave setup open until it finishes.
3. Open **oats** from Start. Allow microphone access when Windows asks.

The setup downloads everything from GitHub release assets: the oats 0.8.8
installer, private Python and speech libraries, Trelis and Apex models, the
speech gate, and the offline Microsoft WebView2 installer. No Python, Git, Node,
terminal commands or Hugging Face account are needed on the new PC.
The small setup executable includes the full app-local Microsoft C++ runtime.
Its large model parts are shared from the immutable GitHub payload release;
setup follows those pinned links automatically.

The download is about **10.4 GiB**, and the runtime expands to **13.1 GiB**.
Allow **30 GiB free** when both are on the same drive. Keep the executable and
every numbered part together.
If a download is interrupted, open setup again and select the same folder to
resume. It verifies each downloaded part and each extracted file. Do not rename
the parts or combine them manually.

## Install without internet on the destination PC

On a connected Windows PC, open the same executable and choose **Save for
offline setup**. Once it says the download is complete, copy the **entire folder**
to the destination PC. Open Oats-Setup.exe there and choose **Download and
install**. When all parts are present and verified, it installs from that folder
without fetching anything else.

## Compatible PCs

This package targets Windows x64, with Windows 11 recommended. Windows ARM and
macOS are not supported. Trelis is a large model: allow substantial disk space
for both the saved download folder and extracted runtime, and use at least
16 GB RAM (32 GB recommended for live Trelis with shared GPU memory).

Live Trelis meeting transcription needs a supported Intel GPU and its driver.
The setup checks for the GPU and asks before choosing CPU mode on other PCs.
CPU mode can transcribe after recording; it may be too slow for useful live
dictation. Setup does not install GPU drivers, and a detected GPU does not
guarantee a particular transcription speed or accuracy.

Optional Community-1 speaker identification is not included in this package.
Its gated model setup remains separate. Recording, notes, Trelis transcription
and dictation, and Apex fallback use the bundled core runtime.

## Existing installations and updates

This complete setup is for a new PC. It stops before replacing an existing
speech configuration. Existing users should use **About → Check for updates**
or the automatic update notification. App updates remain small and preserve the
downloaded speech models, notes and recordings.

Release integrity uses the existing oats detached signing identity and SHA-256
hashes. This is separate from Windows Authenticode publisher signing.

## Validation status

The release notes distinguish automated tests, extraction/runtime checks on the
development laptop, and hands-on acceptance on a new PC. The first two do not
establish microphone capture or real-time performance on an arbitrary machine.
For a first test, record a short Hindi/English note, stop it, check its transcript
and playback, then try dictation into a text box in another application.
