'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
export interface Project { id: string; name: string; revision: number; entry_count: number }
export interface LibraryNote { id: string; title: string; created_at: string; project_id: string | null; notes_preview: string; tags: string[] }
export interface ProjectLibrary { projects: Project[]; meetings: LibraryNote[] }
export const projectLabel = (name: string) => name.replace(/\s+Vault$/i, '');
export function useProjectLibrary() {
  const [library, setLibrary] = useState<ProjectLibrary>({ projects: [], meetings: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try { const result = await invoke<ProjectLibrary>('list_project_library'); if (request === sequence.current) { setLibrary({ ...result, meetings: result.meetings.map(note => ({ ...note, tags: note.tags ?? [] })) }); setError(null); } }
    catch (reason) { if (request === sequence.current) setError(String(reason)); }
    finally { if (request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener('xx-projects-updated', changed); window.addEventListener('xx-meeting-renamed', changed);
    return () => { sequence.current++; window.removeEventListener('xx-projects-updated', changed); window.removeEventListener('xx-meeting-renamed', changed); };
  }, [refresh]);
  return { ...library, error, loading, refresh };
}
