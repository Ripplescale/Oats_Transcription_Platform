'use client';
import { Check, Loader2 } from 'lucide-react';
import { useLiveNote } from '@/hooks/useLiveNote';
import { useProjectLibrary, projectLabel } from '@/hooks/useProjectLibrary';
import { RichNotesEditor } from '@/components/RichNotesEditor';

export function LiveNoteEditor({ meetingId, initialProject }: { meetingId: string; initialProject?: string | null }) {
  const note = useLiveNote(meetingId, initialProject);
  const { projects } = useProjectLibrary();
  return <section className="xx-live-notepad" aria-label="Live meeting notes">
    <div className="xx-live-note-meta"><select aria-label="Note project" value={note.projectId ?? ''} disabled={!note.loaded} onChange={event => note.update({ projectId: event.target.value || null })}><option value="">Unfiled</option>{note.projectId && !projects.some(project => project.id === note.projectId) && <option value={note.projectId}>Unavailable project</option>}{projects.map(project => <option value={project.id} key={project.id}>{projectLabel(project.name)}</option>)}</select><span role="status">{note.error ? 'Not saved yet' : !note.loaded ? 'Opening note…' : note.saving ? <><Loader2 size={12} className="animate-spin" />Saving…</> : note.dirty ? 'Saving shortly…' : <><Check size={12} />Saved</>}</span></div>
    {note.error && <div role="alert" className="xx-inline-error">{note.error}<button onClick={() => void note.retry().catch(() => {})}>Retry save</button></div>}
    <RichNotesEditor key={meetingId} autoFocus ariaLabel="Live meeting notes" placeholder="What's on your mind?" notes={note.notes} document={note.notesDocument} disabled={!note.loaded} onChange={(notes, notesDocument) => note.update({ notes, notesDocument })} />
  </section>;
}
