'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { NoteAutosaver, type NoteState } from '@/lib/note-autosaver';
import { registerUpdateSaveGuard } from '@/lib/update-safety';

export function useLiveNote(meetingId: string, initialProject?: string | null) {
  const router = useRouter();
  const [state, setState] = useState<NoteState>({ notes: '', projectId: null, loaded: false, dirty: false, saving: false, error: null });
  const activeStore = useRef<NoteAutosaver | null>(null);
  const navigationRequest = useRef(0);
  const store = useMemo(() => {
    const current = new NoteAutosaver(meetingId, invoke, next => {
      if (activeStore.current === current) setState(next);
    }, draft => {
      try { const key = `xx.note-draft.${meetingId}`; if (draft) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); } catch { /* Native saves still run when browser storage is full. */ }
    });
    return current;
  }, [meetingId]);
  useEffect(() => {
    activeStore.current = store;
    setState({ ...store.state });
    let draft;
    try { const value = localStorage.getItem(`xx.note-draft.${meetingId}`); if (value) { const parsed = JSON.parse(value); if (typeof parsed.notes === 'string' && typeof parsed.baseNotes === 'string' && (parsed.projectId === null || typeof parsed.projectId === 'string') && (parsed.baseProject === null || typeof parsed.baseProject === 'string')) draft = parsed; } } catch { /* Ignore invalid draft metadata. */ }
    void store.load(initialProject, draft);
    return () => { if (activeStore.current === store) activeStore.current = null; };
  }, [store, meetingId, initialProject]);
  useEffect(() => registerUpdateSaveGuard(async () => {
    await store.flush();
    if (!store.state.loaded || store.state.dirty || store.state.saving || store.state.error) {
      throw new Error(store.state.error || 'Save your meeting notes before installing the update.');
    }
  }), [store]);
  useEffect(() => {
    if (!state.dirty || state.error || state.saving) return;
    const timer = setTimeout(() => { void store.flush().then(() => window.dispatchEvent(new Event('xx-projects-updated'))).catch(() => {}); }, 650);
    return () => clearTimeout(timer);
  }, [store, state.notes, state.notesDocument, state.projectId, state.dirty, state.error, state.saving]);
  useEffect(() => {
    const navigate = (event: Event) => {
      if (!store.state.dirty && !store.state.saving) return;
      const intent = (event as CustomEvent<{ href: string; onProceed?: () => void }>).detail;
      const href = intent?.href;
      if (!href) return;
      event.preventDefault();
      const request = ++navigationRequest.current;
      void (async () => {
        do { await store.flush(); } while (store.state.dirty || store.state.saving);
        if (activeStore.current === store && navigationRequest.current === request) {
          if (typeof intent.onProceed === 'function') intent.onProceed();
          else router.push(href);
        }
      })().catch(() => {});
    };
    const unload = (event: BeforeUnloadEvent) => { if (store.state.dirty || store.state.saving) { event.preventDefault(); event.returnValue = ''; } };
    const save = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void store.retry().catch(() => {}); } };
    window.addEventListener('xx-before-navigate', navigate); window.addEventListener('beforeunload', unload); window.addEventListener('keydown', save);
    return () => { navigationRequest.current += 1; window.removeEventListener('xx-before-navigate', navigate); window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', save); void store.flush().catch(() => {}); };
  }, [store, router]);
  return { ...state, update: (patch: Parameters<NoteAutosaver['update']>[0]) => store.update(patch), retry: () => store.retry() };
}
