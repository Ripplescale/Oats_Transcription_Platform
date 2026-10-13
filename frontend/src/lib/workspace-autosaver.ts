import { emptyWorkspace, mergeSavedWorkspace, sameWorkspaceEdits, workspaceEdits, type TranscriptWorkspace } from './transcript-workspace';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Editable = ReturnType<typeof workspaceEdits>;
export interface WorkspaceJournal { version: 1; base: Editable; draft: Editable }
export interface WorkspaceState { workspace: TranscriptWorkspace; loaded: boolean; dirty: boolean; saving: boolean; error: string | null }

export function parseWorkspaceJournal(value: unknown): WorkspaceJournal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const journal = value as WorkspaceJournal;
  const valid = (item: Editable) => !!item && typeof item.notes === 'string' &&
    (item.project_id === null || typeof item.project_id === 'string') &&
    (item.profile === null || typeof item.profile === 'string') &&
    Array.isArray(item.corrections) && item.corrections.every(row => !!row && typeof row.segment_id === 'string' && typeof row.original_text === 'string' && typeof row.text === 'string' && typeof row.updated_at === 'string') &&
    !!item.speaker_names && typeof item.speaker_names === 'object' && Object.values(item.speaker_names).every(name => typeof name === 'string');
  // Keep raw optional formatting even if this editor cannot read it. Dropping the
  // journal would also discard recoverable plain text; rendering validates it.
  return journal.version === 1 && valid(journal.base) && valid(journal.draft) ? journal : undefined;
}

/** Keeps rich notes and applied review edits together across worker revisions. */
export class WorkspaceAutosaver {
  state: WorkspaceState;
  private base?: TranscriptWorkspace;
  private pending?: Promise<void>;
  private loading?: Promise<void>;
  private recoveredDraft?: WorkspaceJournal;
  private generation = 0;
  private conflict?: string;
  private journalBase?: Editable;
  constructor(readonly meetingId: string, private invoke: Invoke, private changed: (state: WorkspaceState) => void, private journal: (draft: WorkspaceJournal | null) => void = () => {}) {
    this.state = { workspace: emptyWorkspace(meetingId), loaded: false, dirty: false, saving: false, error: null };
  }
  private emit() { this.changed({ ...this.state }); }
  private remember() { this.journal(this.base && this.state.dirty ? { version: 1, base: this.journalBase ?? workspaceEdits(this.base), draft: workspaceEdits(this.state.workspace) } : null); }
  load(draft?: WorkspaceJournal): Promise<void> {
    if (this.state.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.recoveredDraft ??= draft;
    this.loading = this.open(this.recoveredDraft).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async open(draft?: WorkspaceJournal) {
    try {
      const saved = await this.invoke<TranscriptWorkspace>('load_transcript_workspace', { meetingId: this.meetingId });
      this.base = saved;
      this.state = { workspace: saved, loaded: true, dirty: false, saving: false, error: null };
      if (draft) {
        this.state.workspace = { ...saved, ...draft.draft };
        this.state.dirty = !sameWorkspaceEdits(this.state.workspace, saved);
        if (this.state.dirty && !sameWorkspaceEdits({ ...saved, ...draft.base }, saved)) {
          this.conflict = 'Newer saved notes or review edits were found. Your recovered draft is kept here. Copy it before reloading to compare; retry will not replace the newer edits.';
          this.journalBase = draft.base; this.state.error = this.conflict;
        }
      }
      this.remember(); this.emit();
    } catch (reason) { this.state.error = `Could not open notes. ${String(reason)}`; this.emit(); }
  }
  update(patch: Partial<TranscriptWorkspace>) {
    if (!this.base) return;
    this.generation += 1;
    this.state.workspace = { ...this.state.workspace, ...patch };
    this.state.dirty = !sameWorkspaceEdits(this.state.workspace, this.base);
    this.remember(); this.emit();
  }
  discardDraft(): boolean {
    // A native write already in flight cannot be cancelled. The navigation UI
    // waits for it before offering to discard any remaining local changes.
    if (this.state.saving || this.pending) return false;
    this.generation += 1; this.conflict = undefined; this.journalBase = undefined; this.recoveredDraft = undefined;
    if (this.base) this.state.workspace = this.base;
    this.state.dirty = false; this.state.error = null;
    this.journal(null); this.emit(); return true;
  }
  async refresh() {
    if (!this.state.loaded || this.state.dirty || this.state.saving) return;
    const generation = this.generation;
    try {
      const result = await this.invoke<TranscriptWorkspace>('load_transcript_workspace', { meetingId: this.meetingId });
      if (generation !== this.generation || this.state.dirty || this.state.saving || result.revision < (this.base?.revision ?? 0)) return;
      this.base = result; this.state.workspace = result; this.emit();
    } catch (reason) { if (generation === this.generation) { this.state.error = String(reason); this.emit(); } }
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.state.loaded || !this.state.dirty || !this.base) return Promise.resolve();
    if (this.state.error) return Promise.reject(new Error(this.state.error));
    this.pending = this.persist().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async retry() {
    if (this.conflict) { this.state.error = this.conflict; this.emit(); throw new Error(this.conflict); }
    if (!this.state.loaded) { await this.load(); if (!this.state.loaded || this.conflict) throw new Error(this.state.error ?? 'Notes have not loaded.'); }
    this.state.error = null; this.emit(); return this.flush();
  }
  private async persist() {
    this.state.saving = true; this.emit();
    try {
      while (this.state.dirty && this.base) {
        const draft = this.state.workspace;
        const generation = this.generation;
        const save = (revision: number) => this.invoke<TranscriptWorkspace>('save_transcript_workspace', {
          meetingId: this.meetingId, expectedRevision: revision, notes: draft.notes, notesDocument: draft.notes_document,
          corrections: draft.corrections, projectId: draft.project_id, profile: draft.profile, speakerNames: draft.speaker_names ?? {},
        });
        let saved: TranscriptWorkspace;
        try { saved = await save(this.base.revision); }
        catch (reason) {
          const latest = await this.invoke<TranscriptWorkspace>('load_transcript_workspace', { meetingId: this.meetingId });
          if (!sameWorkspaceEdits(latest, this.base)) {
            this.conflict = 'Saved notes, formatting, or review edits changed elsewhere. Your draft is kept here. Copy it before reloading to compare; retry will not replace the newer edits.';
            this.journalBase = workspaceEdits(this.base); throw new Error(this.conflict);
          }
          if (latest.revision <= this.base.revision) throw reason;
          this.base = latest; saved = await save(latest.revision);
        }
        this.base = saved;
        this.state.workspace = mergeSavedWorkspace(this.state.workspace, saved, generation !== this.generation);
        this.state.dirty = !sameWorkspaceEdits(this.state.workspace, saved);
        this.remember(); this.emit();
      }
    } catch (reason) { this.state.error = `Could not save. Your draft is kept on this device. ${String(reason)}`; this.remember(); throw reason; }
    finally { this.state.saving = false; this.emit(); }
  }
}
