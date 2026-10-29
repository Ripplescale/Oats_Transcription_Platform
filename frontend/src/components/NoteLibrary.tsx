'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, BookOpen, ChevronRight, FileText, Folder, FolderInput, MoreHorizontal, Pencil, Plus, Search, Tag, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useProjectLibrary, projectLabel, type Project, type LibraryNote } from '@/hooks/useProjectLibrary';
import { useSidebar } from './Sidebar/SidebarProvider';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { Brand } from './Brand';
import './note-library-actions.css';

type NoteAction = { kind: 'rename' | 'move' | 'tags' | 'delete'; note: LibraryNote };
export function NoteLibrary({ onNewNote, busy, recovery }: { onNewNote: (projectId: string | null) => void; busy: boolean; recovery?: React.ReactNode }) {
  const library = useProjectLibrary();
  const router = useRouter();
  const { currentMeeting, setCurrentMeeting, transcriptGroups, refetchMeetings } = useSidebar();
  const { isRecording } = useRecordingState();
  const { workflow } = useLocalWorkflow();
  const [selected, setSelected] = useState('all');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [memory, setMemory] = useState(false);
  const [projectDialog, setProjectDialog] = useState<'new' | Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<NoteAction | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [destination, setDestination] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [references, setReferences] = useState<{ canonical: string; source: string; verified: boolean; context: string }[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const project = library.projects.find(item => item.id === selected);
  const folderNotes = useMemo(() => library.meetings.filter(note => selected === 'all' || (note.project_id ?? 'unfiled') === selected), [library.meetings, selected]);
  const allTags = useMemo(() => [...new Set(library.meetings.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b)), [library.meetings]);
  const folderTags = useMemo(() => [...new Set(folderNotes.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b)), [folderNotes]);
  const notes = useMemo(() => folderNotes.filter(note => (!tagFilter || note.tags.includes(tagFilter)) && `${note.title} ${note.notes_preview} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [folderNotes, tagFilter, query]);
  const selectFolder = (id: string) => { setSelected(id); setMemory(false); setTagFilter(''); };
  useEffect(() => {
    const pending = sessionStorage.getItem('xx.open-project');
    if (pending) { setSelected(pending); sessionStorage.removeItem('xx.open-project'); }
    const select = (event: Event) => selectFolder((event as CustomEvent<string>).detail);
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[role="dialog"]')) { event.preventDefault(); searchInput.current?.focus(); }
    };
    window.addEventListener('xx-select-project', select); window.addEventListener('keydown', focus);
    return () => { window.removeEventListener('xx-select-project', select); window.removeEventListener('keydown', focus); };
  }, []);
  useEffect(() => { if (tagFilter && !folderTags.includes(tagFilter)) setTagFilter(''); }, [folderTags, tagFilter]);
  useEffect(() => {
    if (!project || !memory) return;
    let alive = true; setReferences([]); setReferenceError(null);
    void invoke<{ entries: typeof references }>('load_project_vault', { projectId: project.id }).then(value => { if (alive) setReferences(value.entries); }).catch(reason => { if (alive) setReferenceError(String(reason)); });
    return () => { alive = false; };
  }, [project?.id, memory]);
  const open = (note: Pick<LibraryNote, 'id' | 'title'>) => {
    const href = `/meeting-details?id=${encodeURIComponent(note.id)}`;
    if (!window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) return;
    setCurrentMeeting({ id: note.id, title: note.title }); router.push(href);
  };
  const changed = async () => { window.dispatchEvent(new Event('xx-projects-updated')); await Promise.all([library.refresh(), refetchMeetings()]); };
  const saveProject = async () => {
    if (!name.trim() || saving || !projectDialog) return;
    setSaving(true);
    try {
      const saved = await invoke<Project>(projectDialog === 'new' ? 'create_project' : 'rename_project', projectDialog === 'new' ? { name: name.trim() } : { projectId: projectDialog.id, expectedRevision: projectDialog.revision, name: name.trim() });
      await changed(); selectFolder(saved.id); setProjectDialog(null);
    } catch (reason) { toast.error('Folder could not be saved', { description: String(reason) }); }
    finally { setSaving(false); }
  };
  const removeProject = async () => {
    if (!deleteProject || saving || isRecording) return;
    setSaving(true);
    try {
      await invoke('archive_project', { projectId: deleteProject.id, expectedRevision: deleteProject.revision });
      if (selected === deleteProject.id) selectFolder('unfiled');
      await changed(); setDeleteProject(null); toast.success('Folder deleted. Its notes are in Unfiled.');
    } catch (reason) { toast.error('Folder could not be deleted', { description: String(reason) }); }
    finally { setSaving(false); }
  };
  const startAction = (kind: NoteAction['kind'], note: LibraryNote) => {
    setAction({ kind, note }); setDraftTitle(note.title);
    setDestination(library.projects.find(project => project.id === note.project_id)?.id ?? '');
    setDraftTags([...note.tags]); setTagInput(''); setActionError(null);
  };
  const addTag = (): string[] | null => {
    const input = tagInput.trim().replace(/\s+/g, ' ');
    if (!input) return draftTags;
    if ([...input].length > 50 || /[\u0000-\u001f\u007f]/.test(input)) { setActionError('Use a tag of 1–50 characters without control characters.'); return null; }
    const canonical = allTags.find(tag => tag.toLocaleLowerCase() === input.toLocaleLowerCase()) ?? input;
    const next = draftTags.some(tag => tag.toLocaleLowerCase() === canonical.toLocaleLowerCase()) ? draftTags : [...draftTags, canonical];
    if (next.length > 30) { setActionError('Use at most 30 tags per note.'); return null; }
    setDraftTags(next); setTagInput(''); setActionError(null); return next;
  };
  const saveAction = async () => {
    if (!action || saving || (action.kind === 'delete' && isRecording)) return;
    const nextTags = action.kind === 'tags' ? addTag() : draftTags;
    if (!nextTags || (action.kind === 'rename' && !draftTitle.trim())) return;
    setSaving(true); setActionError(null);
    try {
      const meetingId = action.note.id;
      if (action.kind === 'rename') {
        const title = draftTitle.trim();
        await invoke('api_save_meeting_title', { meetingId, title });
        if (currentMeeting?.id === meetingId) setCurrentMeeting({ id: meetingId, title });
        window.dispatchEvent(new CustomEvent('xx-meeting-renamed', { detail: { id: meetingId, title } }));
      } else if (action.kind === 'move') {
        await invoke('move_meeting_to_project', { meetingId, expectedProjectId: action.note.project_id, projectId: destination || null });
      } else if (action.kind === 'tags') {
        await invoke('set_meeting_tags', { meetingId, expectedTags: action.note.tags, tags: nextTags });
      } else {
        await workflow.deleteMeeting(meetingId);
        if ((transcriptGroups[currentMeeting?.id ?? ''] ?? currentMeeting?.id) === meetingId) setCurrentMeeting(null);
      }
      await changed(); setAction(null);
    } catch (reason) { setActionError(String(reason)); }
    finally { setSaving(false); }
  };
  const folderMenu = (item: Project) => <DropdownMenu><DropdownMenuTrigger asChild><button className="xx-icon-button xx-folder-menu" aria-label={`Actions for folder ${projectLabel(item.name)}`}><MoreHorizontal size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setName(projectLabel(item.name)); setProjectDialog(item); }}><Pencil />Rename folder</DropdownMenuItem><DropdownMenuItem disabled={isRecording} onSelect={() => setDeleteProject(item)}><Trash2 />Delete folder</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
  const missingProjects = [...new Set(notes.map(note => note.project_id).filter((id): id is string => !!id && !library.projects.some(item => item.id === id)))];
  const groups = selected === 'all' ? [...library.projects.map(item => ({ id: item.id, name: projectLabel(item.name) })), ...missingProjects.map(id => ({ id, name: 'Unavailable folder' })), { id: 'unfiled', name: 'Unfiled' }].filter(group => notes.some(note => (note.project_id ?? 'unfiled') === group.id)) : [{ id: selected, name: project ? projectLabel(project.name) : 'Unfiled' }];
  return <div className="xx-library">
    <header className="xx-library-header"><div className="xx-library-intro"><Brand icon={false} /><p className="xx-library-kicker">A little space to think</p><h1>{project ? projectLabel(project.name) : selected === 'unfiled' ? 'Unfiled notes' : 'Your notes'}</h1></div><img className="xx-library-illustration" src="/oats-listening.png" alt="" width={170} height={140} /></header>
    <div className="xx-library-toolbar"><label className="xx-library-search"><Search size={17} /><input ref={searchInput} aria-label="Search notes" placeholder="Find a note…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear note search" onClick={() => setQuery('')}><X size={14} /></button>}</label><button className="xx-icon-button" title="New folder" aria-label="New folder" onClick={() => { setName(''); setProjectDialog('new'); }}><Folder size={18} /><Plus size={10} /></button><button className="xx-button-primary" title={isRecording ? 'Finish the current recording before starting another' : 'Create a note and start recording'} disabled={busy || isRecording} onClick={() => onNewNote(project?.id ?? null)}><Plus size={17} />New note</button></div>
    <nav className="xx-project-tabs" aria-label="Folders"><button aria-pressed={selected === 'all'} onClick={() => selectFolder('all')}>All notes</button>{library.projects.map(item => <span className="xx-folder-tab" key={item.id}><button aria-pressed={selected === item.id} onClick={() => selectFolder(item.id)}><Folder size={13} />{projectLabel(item.name)}</button>{folderMenu(item)}</span>)}<button aria-pressed={selected === 'unfiled'} onClick={() => selectFolder('unfiled')}>Unfiled</button></nav>
    {!!folderTags.length && <nav className="xx-tag-filters" aria-label="Filter notes by tag"><Tag size={14} /><button aria-pressed={!tagFilter} onClick={() => setTagFilter('')}>All tags</button>{folderTags.map(tag => <button key={tag} aria-pressed={tagFilter === tag} onClick={() => setTagFilter(tag)}>{tag}</button>)}</nav>}
    {recovery}
    {project && <div className="xx-project-actions"><button className="xx-memory-link" onClick={() => setMemory(!memory)} aria-expanded={memory}><BookOpen size={15} />{memory ? 'Back to notes' : 'Folder memory'}<ChevronRight size={13} /></button></div>}
    {library.error && <div role="alert" className="xx-inline-error">Your notes could not be loaded. <button onClick={() => void library.refresh()}>Try again</button></div>}
    <div className="xx-library-list custom-scrollbar">
      {memory && project ? <section aria-label="Folder memory" className="xx-project-memory"><h2>A thread through your conversations</h2><p className="xx-memory-intro">Revisit what you wrote and the references you kept for {projectLabel(project.name)}. Each note opens its original recording and transcript.</p>
        <h3>From your notes</h3>{notes.filter(note => note.notes_preview).map(note => <button key={note.id} className="xx-memory-note" onClick={() => open(note)}><strong>{note.title}<ArrowUpRight size={14} /></strong><p>{note.notes_preview}</p></button>)}{!notes.some(note => note.notes_preview) && <p className="xx-empty-hint">Notes from your folder’s meetings will collect here as you write.</p>}
        <h3>Folder references</h3>{referenceError && <p role="alert">References could not be loaded.</p>}{references.map((item, index) => <article key={index} className="xx-reference"><strong>{item.canonical}</strong><span>{item.verified ? 'Checked reference' : 'Unverified reference'}</span><p>{item.context}</p>{item.source && <p className="text-xs">Source: {item.source}</p>}</article>)}{!references.length && !referenceError && <p className="xx-empty-hint">No references yet. You can keep a checked reference in a note’s project vault.</p>}
        <p className="xx-memory-footnote">A source shelf, built from your saved notes. No generated claims or automatic name corrections.</p>
      </section> : <>{groups.map(group => <section className="xx-library-group" key={group.id}><h2><Folder size={14} />{group.name}<span>{notes.filter(note => (note.project_id ?? 'unfiled') === group.id).length}</span></h2>{notes.filter(note => (note.project_id ?? 'unfiled') === group.id).map(note => <div key={note.id} className="xx-note-item"><button className="xx-note-row" onClick={() => open(note)}><FileText size={17} /><span><strong>{note.title}</strong><small>{note.notes_preview || 'Open notes and transcript'}</small>{!!note.tags.length && <span className="xx-note-tags">{note.tags.map(tag => <span key={tag}>{tag}</span>)}</span>}</span><time>{new Date(note.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><ChevronRight size={14} /></button><DropdownMenu><DropdownMenuTrigger asChild><button className="xx-icon-button xx-note-menu" aria-label={`Actions for note ${note.title}`}><MoreHorizontal size={18} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => startAction('rename', note)}><Pencil />Rename</DropdownMenuItem><DropdownMenuItem onSelect={() => startAction('move', note)}><FolderInput />Move to folder</DropdownMenuItem><DropdownMenuItem onSelect={() => startAction('tags', note)}><Tag />Edit tags</DropdownMenuItem><DropdownMenuItem disabled={isRecording} onSelect={() => startAction('delete', note)}><Trash2 />Delete note</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>)}</section>)}
      {!notes.length && !library.error && <div className="xx-library-empty"><FileText size={28} /><h2>{library.loading ? 'Opening your notes…' : query || tagFilter ? 'No matching notes' : 'Room for your next conversation'}</h2><p>{query || tagFilter ? 'Try a different search or tag.' : 'Start a new note. oats listens while you write.'}</p></div>}</>}
    </div>
    <footer className="xx-library-footer">{library.meetings.length} notes · saved on this laptop<span>New note starts recording</span></footer>
    <Dialog open={projectDialog !== null} onOpenChange={open => { if (!open && !saving) setProjectDialog(null); }}><DialogContent className="max-w-sm"><DialogTitle>{projectDialog === 'new' ? 'New folder' : 'Rename folder'}</DialogTitle><DialogDescription>Keep related notes and references together.</DialogDescription><form onSubmit={event => { event.preventDefault(); void saveProject(); }}><input autoFocus className="xx-project-name-input" aria-label="Folder name" value={name} maxLength={160} onChange={event => setName(event.target.value)} placeholder="Folder name" /><div className="xx-library-dialog-actions"><button type="button" className="xx-button-secondary" disabled={saving} onClick={() => setProjectDialog(null)}>Cancel</button><button className="xx-button-primary" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save folder'}</button></div></form></DialogContent></Dialog>
    <Dialog open={!!deleteProject} onOpenChange={open => { if (!open && !saving) setDeleteProject(null); }}><DialogContent className="max-w-sm"><DialogTitle>Delete this folder?</DialogTitle><DialogDescription>Notes in “{deleteProject && projectLabel(deleteProject.name)}” will move to Unfiled. Recordings and notes stay saved. Its reference history is retained in the local archive.</DialogDescription><div className="xx-library-dialog-actions"><button className="xx-button-secondary" disabled={saving} onClick={() => setDeleteProject(null)}>Keep folder</button><button className="xx-button-primary" disabled={saving || isRecording} onClick={() => void removeProject()}>{saving ? 'Deleting…' : 'Delete folder'}</button></div></DialogContent></Dialog>
    <Dialog open={!!action} onOpenChange={open => { if (!open && !saving) setAction(null); }}><DialogContent className="max-w-md"><DialogTitle>{action?.kind === 'rename' ? 'Rename note' : action?.kind === 'move' ? 'Move note' : action?.kind === 'tags' ? 'Edit tags' : 'Delete this note?'}</DialogTitle><DialogDescription>{action?.kind === 'delete' ? `“${action.note.title}” and its saved transcript versions and notes will be removed from the workspace. This cannot be undone.` : action?.kind === 'tags' ? 'Use the same tags across folders, then filter notes within each folder.' : action?.note.title}</DialogDescription><form onSubmit={event => { event.preventDefault(); void saveAction(); }}>
      {action?.kind === 'rename' && <input autoFocus aria-label="Note title" className="xx-project-name-input" value={draftTitle} maxLength={200} onChange={event => setDraftTitle(event.target.value)} />}
      {action?.kind === 'move' && <label className="xx-library-field">Folder<select autoFocus aria-label="Destination folder" value={destination} onChange={event => setDestination(event.target.value)}><option value="">Unfiled</option>{library.projects.map(item => <option key={item.id} value={item.id}>{projectLabel(item.name)}</option>)}</select></label>}
      {action?.kind === 'tags' && <div className="xx-tags-editor"><div className="xx-tag-drafts">{draftTags.map(tag => <button key={tag} type="button" disabled={saving} aria-label={`Remove tag ${tag}`} onClick={() => setDraftTags(draftTags.filter(item => item !== tag))}>{tag}<X size={12} /></button>)}</div><div className="xx-tag-input-row"><input autoFocus aria-label="New tag" placeholder="Add a tag…" value={tagInput} maxLength={100} onChange={event => setTagInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} /><button type="button" className="xx-button-secondary" disabled={!tagInput.trim() || saving} onClick={() => addTag()}>Add</button></div>{!!allTags.filter(tag => !draftTags.includes(tag)).length && <div className="xx-tag-suggestions" aria-label="Existing tags">{allTags.filter(tag => !draftTags.includes(tag)).map(tag => <button type="button" key={tag} disabled={saving || draftTags.length >= 30} onClick={() => setDraftTags([...draftTags, tag])}><Plus size={11} />{tag}</button>)}</div>}</div>}
      {actionError && <p role="alert" className="xx-inline-error">{actionError}</p>}
      <div className="xx-library-dialog-actions"><button type="button" className="xx-button-secondary" disabled={saving} onClick={() => setAction(null)}>{action?.kind === 'delete' ? 'Keep note' : 'Cancel'}</button><button className="xx-button-primary" disabled={saving || (action?.kind === 'delete' && isRecording) || (action?.kind === 'rename' && !draftTitle.trim())}>{saving ? 'Saving…' : action?.kind === 'delete' ? 'Delete note' : action?.kind === 'move' ? 'Move note' : action?.kind === 'tags' ? 'Save tags' : 'Save title'}</button></div>
    </form></DialogContent></Dialog>
  </div>;
}
