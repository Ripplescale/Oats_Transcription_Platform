# Install oats

You only need **Oats-Setup.exe**. It downloads the app and everything needed for speech recognition from GitHub.

## On the PC where you want to use oats

1. Download **[Oats-Setup.exe](https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-90c87eedfa370799c4dc/Oats-Setup.exe)**.
2. Open it and click **Install oats**. If your copy says **Download and install**, that is the same option.
3. Wait for setup to finish, then open **oats** from the Windows Start menu.
4. In oats, open **About → Check for updates** and install any available update.

Allow microphone access if Windows asks. You do not need to install Python, use a terminal, or create an account.

The first download is about **11 GB**. Keep about **30 GB free** for the download and installation. Setup needs internet for this first download. Once installed, recording and speech recognition work without internet.

If the download stops, reopen setup and choose the **same download folder**. It can continue from the files already there.

The linked setup is the currently published version. The new button wording and additional speech check below take effect when the updated setup is published.

## Only if the other PC has no internet

Skip this section if you can run setup on the PC where you will use oats.

1. On a PC with internet, open **Oats-Setup.exe**.
2. Click **Download for another PC**. Older setup calls this **Save for offline setup**.
3. When the download finishes, copy the **whole download folder** to the other PC using a USB drive or another transfer method.
4. On that PC, open **Oats-Setup.exe** from the copied folder and click **Install oats** (or **Download and install**).

Use the same setup program in both cases. Do not rename or manually join the numbered download files.

## If oats is already installed

Open **About → Check for updates**, then choose to download and install the update. You do not need to download the large setup again. App updates keep your notes, recordings and speech models.

## Before using it for a long meeting

Record a short test, click **Finish recording**, and check that you can play the audio and read the transcript. Then try dictation into a text box in another app.

The updated setup also tests both speech engines using a short generated audio clip. If the GPU test fails, it asks whether to try CPU mode. CPU mode can be slower, particularly for live dictation. This check does not test your microphone or guarantee transcription accuracy.

## What kind of PC do I need

- Windows x64; Windows 11 recommended. This installer does not support Windows ARM or macOS.
- At least 16 GB RAM; 32 GB recommended for live Trelis transcription.
- A compatible Intel GPU and current driver for useful live Trelis performance. CPU mode prepares meeting transcripts after you finish recording; dictation can be slow.

Optional speaker identification is separate. You do not need it for recording, notes, transcription or dictation.

## If transcription says needs attention

1. Update oats through **About → Check for updates**.
2. Open the saved meeting, then **Tools → Transcription & versions**.
3. Retry the transcription. You do not need to record the meeting again.

For an older complete installation where both models fail, **[Oats-Repair.exe](https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-90c87eedfa370799c4dc/Oats-Repair.exe)** can repair missing working folders. Click **Check / repair folders**, then retry the meeting. If it still fails, use **Copy report** to share the error details.

Building oats from source? Use the separate [developer guide](DEVELOPER_SETUP.md).
