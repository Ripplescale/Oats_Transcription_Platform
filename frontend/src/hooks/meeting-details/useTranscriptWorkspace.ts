'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Transcript } from '@/types';
import { emptyWorkspace, setCorrection } from '@/lib/transcript-workspace';
import type { NotesDocument } from '@/lib/rich-notes';
import { parseWorkspaceJournal, WorkspaceAutosaver, type WorkspaceState } from '@/lib/workspace-autosaver';
import { registerUpdateSaveGuard } from '@/lib/update-safety';

export function useTranscriptWorkspace(meetingId: string) {
  const [state, setState] = useState<WorkspaceState>(() => ({ workspace: emptyWorkspace(meetingId), loaded: false, dirty: false, saving: false, error: null }));
  const activeStore = useRef<WorkspaceAutosaver | null>(null);
  const store = useMemo(() => {
    const current = new WorkspaceAutosaver(meetingId, invoke, next => { if (activeStore.current === current) setState(next); }, draft => {
      try { const key = `xx.workspace-draft.${meetingId}`; if (draft) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); } catch { /* Native autosave remains available when browser storage is full. */ }
    });
    return current;
  }, [meetingId]);
  useEffect(() => {
    activeStore.current = store; setState({ ...store.state });
    let draft;
    try { const value = localStorage.getItem(`xx.workspace-draft.${meetingId}`); if (value) draft = parseWorkspaceJournal(JSON.parse(value)); } catch { /* Invalid recovery data must not replace saved notes. */ }
    void store.load(draft);
    const update = (event: Event) => { if ((event as CustomEvent<{ meetingId: string }>).detail?.meetingId === meetingId) void store.refresh(); };
    window.addEventListener('local-transcript-updated', update);
    return () => { if (activeStore.current === store) activeStore.current = null; window.removeEventListener('local-transcript-updated', update); };
  }, [store, meetingId]);
  useEffect(() => registerUpdateSaveGuard(async () => {
    await store.flush();
    if (!store.state.loaded || store.state.dirty || store.state.saving || store.state.error) {
      throw new Error(store.state.error || 'Save your notes and transcript edits before installing the update.');
    }
  }), [store]);
  useEffect(() => {
    const preventClose = (event: BeforeUnloadEvent) => { if (store.state.dirty || store.state.saving) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [store]);
  const updateNotes = (notes: string, notes_document?: NotesDocument) => store.update({ notes, ...(notes_document ? { notes_document } : {}) });
  const updateProject = (project_id: string | null) => store.update({ project_id });
  const updateSpeakerName = (speakerId: string, name: string) => store.update({ speaker_names: { ...store.state.workspace.speaker_names, [speakerId]: name } });
  const updateCorrection = (segment: Transcript, text: string) => store.update({ corrections: setCorrection(store.state.workspace.corrections, segment, text, new Date().toISOString()) });
  const save = useCallback(() => store.retry(), [store]);
  return { ...state, updateNotes, updateProject, updateCorrection, updateSpeakerName, save, discardDraft: () => store.discardDraft() };
}
