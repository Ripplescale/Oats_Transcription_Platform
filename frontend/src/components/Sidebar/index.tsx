'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { FileText, Home, Search, Plus, Settings, PanelLeftClose, PanelLeftOpen, MoreHorizontal, Pencil, Trash2, HardDrive, Info, X, AudioLines, Folder } from 'lucide-react';
import { useSidebar, type CurrentMeeting } from './SidebarProvider';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Logo from '../Logo';
import { About } from '../About';
import { useProjectLibrary, projectLabel } from '@/hooks/useProjectLibrary';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { currentMeeting, setCurrentMeeting, isCollapsed, toggleCollapse, searchTranscripts, searchResults, isSearching, meetings, setMeetings, transcriptGroups, handleRecordingToggle } = useSidebar();
  const { projects } = useProjectLibrary();
  const activeMeetingId = transcriptGroups[currentMeeting?.id ?? ''] ?? currentMeeting?.id;
  const { isRecording } = useRecordingState();
  const { workflow } = useLocalWorkflow();
  const [query, setQuery] = useState('');
  const [about, setAbout] = useState(false);
  const [rename, setRename] = useState<CurrentMeeting | null>(null);
  const [title, setTitle] = useState('');
  const [remove, setRemove] = useState<CurrentMeeting | null>(null);
  const [busy, setBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchAction = useRef(searchTranscripts);
  const collapseAction = useRef(toggleCollapse);
  searchAction.current = searchTranscripts;
  collapseAction.current = toggleCollapse;
  const navigate = (href: string, meeting?: CurrentMeeting) => {
    if (!window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) return;
    if (meeting) setCurrentMeeting(meeting);
    router.push(href);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void searchAction.current(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (isCollapsed) collapseAction.current();
        requestAnimationFrame(() => searchInput.current?.focus());
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [isCollapsed]);
  useEffect(() => {
    (window as any).openSettings = () => navigate('/settings');
    return () => { delete (window as any).openSettings; };
  });
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return meetings;
    const matches = new Set(searchResults.map(result => result.id));
    return meetings.filter(meeting => meeting.title.toLowerCase().includes(needle) || matches.has(meeting.id));
  }, [meetings, query, searchResults]);
  const saveTitle = async () => {
    if (!rename || !title.trim()) return;
    setBusy(true);
    try {
      const nextTitle = title.trim();
      await invoke('api_save_meeting_title', { meetingId: rename.id, title: nextTitle });
      setMeetings(meetings.map(meeting => meeting.id === rename.id ? { ...meeting, title: nextTitle } : meeting));
      if (currentMeeting?.id === rename.id) setCurrentMeeting({ ...rename, title: nextTitle });
      window.dispatchEvent(new CustomEvent('xx-meeting-renamed', { detail: { id: rename.id, title: nextTitle } }));
      setRename(null);
      toast.success('Conversation renamed');
    } catch (error) { toast.error('Could not rename conversation', { description: String(error) }); }
    finally { setBusy(false); }
  };
  const deleteMeeting = async () => {
    if (!remove || isRecording) return;
    setBusy(true);
    try {
      await workflow.deleteMeeting(remove.id);
      setMeetings(meetings.filter(meeting => meeting.id !== remove.id));
      window.dispatchEvent(new Event('xx-projects-updated'));
      if (activeMeetingId === remove.id) { setCurrentMeeting(null); router.push('/'); }
      setRemove(null);
      toast.success('Conversation removed');
    } catch (error) { toast.error('Could not remove conversation', { description: String(error) }); }
    finally { setBusy(false); }
  };

  return <>
    <aside className={`xx-sidebar ${isCollapsed ? 'is-collapsed' : ''}`} aria-label="Workspace navigation">
      <div className={`xx-sidebar-top ${isCollapsed ? 'flex-col items-center gap-5' : ''}`}>
        <Logo isCollapsed={isCollapsed} />
        <button className="xx-icon-button" onClick={toggleCollapse} title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {isCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <nav className="w-full space-y-1" aria-label="Main">
        <button className="xx-nav-button" aria-current={pathname === '/' ? 'page' : undefined} onClick={() => navigate('/')} title="Home"><Home />{!isCollapsed && 'Home'}</button>
        <button className={`xx-nav-button ${isRecording ? 'text-rose-800' : ''}`} onClick={() => {
          if (isRecording) { navigate('/'); return; }
          if (window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href: '/' } }))) handleRecordingToggle();
        }} title={isRecording ? 'Return to recording' : 'New note · starts recording'} aria-label={isRecording ? 'Return to recording' : 'New note'}>
          {isRecording ? <AudioLines /> : <Plus />}{!isCollapsed && (isRecording ? 'Recording in progress' : 'New note')}
        </button>
      </nav>
      {!isCollapsed && <>
        <div className="xx-search"><Search size={14} className="shrink-0" /><input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a conversation" aria-label="Search conversations" />{query ? <button className="shrink-0" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button> : <kbd className="xx-key">Ctrl K</kbd>}</div>
        {!query && projects.length > 0 && <div className="xx-sidebar-projects"><span className="xx-eyebrow">Projects</span>{projects.map(project => <button className="xx-nav-button" key={project.id} onClick={() => {
          if (!window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href: '/' } }))) return;
          if (pathname === '/') window.dispatchEvent(new CustomEvent('xx-select-project', { detail: project.id }));
          else { sessionStorage.setItem('xx.open-project', project.id); router.push('/'); }
        }}><Folder size={14} /><span className="truncate">{projectLabel(project.name)}</span></button>)}</div>}
        <div className="flex items-center justify-between px-3 pt-5 pb-3"><span className="xx-eyebrow">{query ? 'Search results' : 'Recent notes'}</span><span className="text-[10px] text-[var(--xx-muted)]">{filtered.length}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar" aria-label="Conversations">
          {(query ? filtered : filtered.slice(0, 12)).map(meeting => <div key={meeting.id} className={`xx-meeting-row ${pathname === '/meeting-details' && activeMeetingId === meeting.id ? 'is-current' : ''}`}>
            <button onClick={() => navigate(`/meeting-details?id=${encodeURIComponent(meeting.id)}`, meeting)} title={meeting.title} aria-current={pathname === '/meeting-details' && activeMeetingId === meeting.id ? 'page' : undefined}>
              <FileText size={15} className="mt-0.5 shrink-0 text-[var(--xx-muted)]" /><span className="text-[13px] leading-5 line-clamp-2 break-words">{meeting.title}</span>
            </button>
            <DropdownMenu><DropdownMenuTrigger asChild><button className="xx-icon-button xx-row-menu mr-1" aria-label={`Options for ${meeting.title}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="start" side="right">
              <DropdownMenuItem onSelect={() => { setRename(meeting); setTitle(meeting.title); }}><Pencil size={14} className="mr-2" />Rename</DropdownMenuItem>
              <DropdownMenuItem disabled={isRecording} className="text-red-700" onSelect={() => setRemove(meeting)}><Trash2 size={14} className="mr-2" />Remove conversation</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu>
          </div>)}
          {!filtered.length && <p className="px-3 py-4 text-xs leading-6 text-[var(--xx-muted)]">{isSearching ? 'Searching…' : query ? 'No conversations found. Try a name or a phrase.' : 'Your conversations will collect here.'}</p>}
        </div>
      </>}
      <div className="xx-sidebar-footer w-full">
        <button className="xx-nav-button" aria-label="Settings" title="Settings" aria-current={pathname === '/settings' ? 'page' : undefined} onClick={() => navigate('/settings')}><Settings />{!isCollapsed && 'Settings'}</button>
        <button className="xx-nav-button" aria-label="About oats" title="About oats" onClick={() => setAbout(true)}><Info />{!isCollapsed && 'About oats'}</button>
        {!isCollapsed && <p className="xx-local-status"><HardDrive size={12} />Saved on your laptop</p>}
      </div>
    </aside>
    <Dialog open={about} onOpenChange={setAbout}><DialogContent className="max-w-md"><DialogTitle className="sr-only">About oats</DialogTitle><About /></DialogContent></Dialog>
    <Dialog open={!!rename} onOpenChange={open => { if (!open && !busy) setRename(null); }}><DialogContent className="max-w-md"><DialogTitle>Rename conversation</DialogTitle><DialogDescription>A title that makes it easy to find later.</DialogDescription><form onSubmit={event => { event.preventDefault(); void saveTitle(); }} className="space-y-5"><input autoFocus aria-label="Conversation title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} className="w-full rounded-lg border bg-transparent p-3 text-sm" /><DialogFooter><button type="button" className="xx-button-secondary" disabled={busy} onClick={() => setRename(null)}>Cancel</button><button className="xx-button-primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save title'}</button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!remove} onOpenChange={open => { if (!open && !busy) setRemove(null); }}><DialogContent className="max-w-md"><DialogTitle>Remove this conversation?</DialogTitle><DialogDescription>“{remove?.title}” and its saved transcript versions and notes will be removed from the workspace. This cannot be undone.</DialogDescription><DialogFooter><button className="xx-button-secondary" disabled={busy} onClick={() => setRemove(null)}>Keep conversation</button><button className="xx-button-primary" disabled={busy || isRecording} onClick={() => void deleteMeeting()}>{busy ? 'Removing…' : 'Remove conversation'}</button></DialogFooter></DialogContent></Dialog>
  </>;
}
