# Recording storage retention

Completed recordings keep their original audio, playback WAVs, transcripts,
corrections and note history. Storage cleanup removes reproducible working files
and consolidates original audio without changing its samples.

- A completed transcription or speaker status check schedules cleanup after a
  15-second quiet period. Once capture and workers are idle, committed source
  fragments are compressed into `source-chunks.zip`. This is not a periodic sweep.
- The archive contains every original WAV byte and a manifest bound to the
  existing session and timeline hashes. All entries are read back and verified
  before any loose fragment is removed. An interrupted cleanup can be retried.
- Historical transcription workers keep their original runtime snapshots. The
  native launcher restores their exact original fragment paths before running
  them. Recovery uses the same restoration step. Playback files stay available.
- Completed transcription jobs discard generated `windows/*.wav` caches. Their
  status, raw results, hashes and runtime identity remain unchanged. Failed or
  interrupted jobs keep their caches.
- Generated job/speaker metadata keeps its latest three snapshots after each
  successful save. User note, correction and folder histories are not pruned.

Cleanup is deferred while capture, dictation or a known worker is active. The
native worker launch gate and exclusive worker-file handles protect maintenance.
Archive failures are logged and leave original audio recoverable from loose
fragments or a verified archive; they do not invalidate successful note saves.
Recording, dictation and transcription requests interrupt source compaction
between chunks. An already-started completed-job cache cleanup finishes its
current batch. Retrying an archived recording temporarily restores its source
fragments and requires space for them.

For existing data, `frontend/src-tauri/scripts/prune-generated-history.py` creates a dry-run plan
and applies only unchanged, validated generated metadata candidates. The
`capture-core-tests` maintenance binary uses the production archive and cache
code (`storage-retention compact|restore|prune-windows <data-root> <id>`).
These maintenance tools require oats and its workers to be closed. Install the
archive-compatible app before compacting existing recordings. Standalone older
Python workers, or downgrading to an older app, require restoring source chunks
first. Do not point old workers directly at compacted sessions.

Validation covers exact source restoration, partial operations, archive
corruption, changed journals, unsafe paths, active worker exclusion, immutable
current metadata, and preservation of user histories.
