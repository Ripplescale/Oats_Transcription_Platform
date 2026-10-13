# User mode and notes

The notes interface uses Settings and About controls, with folder and note actions on Home. **User** mode is the default; **Dev** mode adds transcript diagnostics, source labels and review flags. Errors and correction conflicts remain visible in both modes.

Transcript bubbles fit their content. Switching modes preserves recording, note and correction drafts, playback and reading position.

Notes support multiple tags and filtering within a folder. Existing tag spelling is reused across folders. Removing a folder leaves its notes under Unfiled and preserves reference history. Saved meeting titles can be edited from the notes page: Enter or leaving the editor saves, while Escape cancels. Failed or invalid saves retain the draft.

Live and saved notes share formatting controls for bold, italic, underline, strike, highlight, links, headings, lists, checklists, quotes, horizontal lines and code blocks, with undo/redo and keyboard shortcuts.

## Persistence

Plain text remains available for search, exports and existing clients. Structured formatting is stored alongside it in `notes_document`. Opening a legacy note does not rewrite it. Unknown or stale formatting falls back to saved text with a notice before editing replaces that formatting.

Autosaves are serialized. Recovery drafts survive failed saves, and conflicting newer changes are retained. Native metadata commands update only their owned fields, preserving unrelated note content, formatting and corrections. Existing recordings require no migration.

Update installation flushes registered editors and refuses unresolved local drafts or unapplied forms. See [update safety](UPDATES.md).

## Validation

Unit and component tests cover formatting serialization, legacy content, autosave conflicts, recovery, native metadata merging, title validation and display preferences. Browser fixtures exercise Home actions, rich formatting, delayed loading, recording transitions, transcript correction/playback and narrow layouts.

Fixtures use synthetic notes and mocked native capture. Production frontend and Windows native checks have passed for the implemented release paths; device-specific dictation and meeting-call acceptance are separate.

Notes and User mode were introduced in [0.7.5](releases/0.7.5.md); saved-title editing and update save guards were added in [0.8.3](releases/0.8.3.md). Versioned notes describe the relevant source behavior, not the version currently installed on a reader's device.
