import type { TranscriptWorkspace } from './transcript-workspace';
import { stableNotesValue, type NotesDocument } from './rich-notes';

export interface NoteDraft { notes: string; notesDocument?: NotesDocument | null; projectId: string | null }
export interface NoteState extends NoteDraft { loaded: boolean; dirty: boolean; saving: boolean; error: string | null }
export interface NoteJournal extends NoteDraft { baseNotes: string; baseDocument?: NotesDocument | null; baseProject: string | null }
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const sameDocument = (left?: NotesDocument | null, right?: NotesDocument | null) => stableNotesValue(left) === stableNotesValue(right);

/** Serializes note edits independently of worker transcript/correction revisions. */
export class NoteAutosaver {
  state: NoteState = { notes: '', projectId: null, loaded: false, dirty: false, saving: false, error: null };
  private base?: TranscriptWorkspace;
  private pending?: Promise<void>;
  private loading?: Promise<void>;
  private loadOptions?: { initialProject?: string | null; draft?: NoteJournal };
  private conflict: string | null = null;
  private conflictBase?: { baseNotes: string; baseDocument?: NotesDocument | null; baseProject: string | null };
  constructor(readonly meetingId: string, private invoke: Invoke, private changed: (state: NoteState) => void,
    private journal: (draft: NoteJournal | null) => void = () => {}) {}
  private emit() { this.changed({ ...this.state }); }
  private remember() { this.journal(this.state.dirty && this.base ? { notes: this.state.notes, notesDocument: this.state.notesDocument, projectId: this.state.projectId,
    ...(this.conflictBase ?? { baseNotes: this.base.notes, baseDocument: this.base.notes_document, baseProject: this.base.project_id }) } : null); }
  load(initialProject?: string | null, draft?: NoteJournal): Promise<void> {
    // StrictMode and repeated project props may request the same load twice.
    // A late second read must never replace edits made after the first read.
    if (this.state.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loadOptions ??= { initialProject, draft };
    this.loading = this.open(this.loadOptions.initialProject, this.loadOptions.draft).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async open(initialProject?: string | null, draft?: NoteJournal) {
    try {
      const workspace = await this.invoke<TranscriptWorkspace>('load_transcript_workspace', { meetingId: this.meetingId });
      this.base = workspace;
      this.state = { notes: workspace.notes, notesDocument: workspace.notes_document, projectId: workspace.project_id, loaded: true, dirty: false, saving: false, error: null };
      if (draft) {
        this.state.notes = draft.notes; this.state.notesDocument = draft.notesDocument; this.state.projectId = draft.projectId;
        this.state.dirty = draft.notes !== workspace.notes || !sameDocument(draft.notesDocument, workspace.notes_document) || draft.projectId !== workspace.project_id;
        if (this.state.dirty && (workspace.notes !== draft.baseNotes || !sameDocument(workspace.notes_document, draft.baseDocument) || workspace.project_id !== draft.baseProject)) {
          this.conflict = 'Newer saved notes were found. Your recovered draft is kept here; copy it before reloading to compare. Retry will not replace the newer notes.';
          this.conflictBase = { baseNotes: draft.baseNotes, baseDocument: draft.baseDocument, baseProject: draft.baseProject };
          this.state.error = this.conflict;
        }
      } else if (initialProject !== undefined && workspace.project_id === null && !workspace.notes) {
        this.state.projectId = initialProject; this.state.dirty = initialProject !== null;
      }
      this.remember(); this.emit();
    } catch (error) { this.state.error = `Could not open notes. ${String(error)}`; this.emit(); }
  }
  update(patch: Partial<NoteDraft>) {
    if (!this.base) return;
    Object.assign(this.state, patch);
    this.state.dirty = this.state.notes !== this.base.notes || !sameDocument(this.state.notesDocument, this.base.notes_document) || this.state.projectId !== this.base.project_id;
    this.remember(); this.emit();
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.state.loaded || !this.base || !this.state.dirty) return Promise.resolve();
    if (this.state.error) return Promise.reject(new Error(this.state.error));
    this.pending = this.persist().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async retry() {
    if (this.conflict) { this.state.error = this.conflict; this.emit(); throw new Error(this.conflict); }
    if (!this.state.loaded) {
      await this.load();
      if (!this.state.loaded || this.conflict) throw new Error(this.state.error ?? 'Notes have not loaded.');
    }
    this.state.error = null; this.emit(); return this.flush();
  }
  private async persist() {
    this.state.saving = true; this.emit();
    try {
      while (this.state.dirty && this.base) {
        const draft = { notes: this.state.notes, notesDocument: this.state.notesDocument, projectId: this.state.projectId };
        let saved: TranscriptWorkspace;
        try {
          saved = await this.invoke<TranscriptWorkspace>('save_meeting_note', { meetingId: this.meetingId, expectedRevision: this.base.revision, ...draft });
        } catch (reason) {
          // Worker imports can advance the revision without changing the user's notes.
          const latest = await this.invoke<TranscriptWorkspace>('load_transcript_workspace', { meetingId: this.meetingId });
          if (latest.notes !== this.base.notes || !sameDocument(latest.notes_document, this.base.notes_document) || latest.project_id !== this.base.project_id) {
            this.conflict = 'Saved notes or their project changed elsewhere. Your draft is kept here; copy it before reloading to compare. Retry will not replace the newer notes.';
            this.conflictBase = { baseNotes: this.base.notes, baseDocument: this.base.notes_document, baseProject: this.base.project_id };
            throw new Error(this.conflict);
          }
          if (latest.revision <= this.base.revision) throw reason;
          this.base = latest;
          saved = await this.invoke<TranscriptWorkspace>('save_meeting_note', { meetingId: this.meetingId, expectedRevision: latest.revision, ...draft });
        }
        this.base = saved;
        this.state.dirty = this.state.notes !== saved.notes || !sameDocument(this.state.notesDocument, saved.notes_document) || this.state.projectId !== saved.project_id;
        this.remember(); this.emit();
      }
    } catch (error) { this.state.error = `Notes could not be saved. Your draft is kept on this device. ${String(error)}`; this.remember(); throw error; }
    finally { this.state.saving = false; this.emit(); }
  }
}
