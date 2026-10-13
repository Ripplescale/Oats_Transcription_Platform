'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Folder, Mic, Settings2 } from 'lucide-react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { Portal as ToolsPortal, Content as ToolsContent } from '@radix-ui/react-popover';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { MeetingSummary, SummaryProcessResponse } from '@/types';
import { TranscriptWorkspacePanel } from '@/components/MeetingDetails/TranscriptWorkspacePanel';
import { BlockNoteSummaryView } from '@/components/AISummary/BlockNoteSummaryView';
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useTranscriptWorkspace } from '@/hooks/meeting-details/useTranscriptWorkspace';
import { hasVisibleSummaryContent } from '@/lib/summary-content';
import { Button } from '@/components/ui/button';
import { ProjectVaultPanel } from '@/components/ProjectVaultPanel';
import { LocalTranscriptionPanel } from '@/components/LocalTranscriptionPanel';
import { SpeakerReviewPanel } from '@/components/MeetingDetails/SpeakerReviewPanel';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { projectLabel, useProjectLibrary } from '@/hooks/useProjectLibrary';
import { isTerminalJob } from '@/lib/local-transcription-workflow';
import { RichNotesEditor } from '@/components/RichNotesEditor';
import { MeetingTitle, type TitleEditState } from '@/components/MeetingDetails/MeetingTitle';
import { registerUpdateSaveGuard } from '@/lib/update-safety';
import './saved-note.css';

export default function PageContent({ meeting, summaryData, onMeetingUpdated, hasMore, isLoadingMore, totalCount, onLoadMore }: {
  meeting: any;
  summaryData: MeetingSummary | null;
  initialSummary?: SummaryProcessResponse | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(meeting.title);
  const [titleEdit, setTitleEdit] = useState<TitleEditState>({ dirty: false, saving: false });
  const { projects, error: projectError } = useProjectLibrary();
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [correctionDraft, setCorrectionDraft] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ href: string; historyDelta?: number } | null>(null);
  const router = useRouter();
  const review = useTranscriptWorkspace(meeting.id);
  const { state } = useLocalWorkflow();
  const run = state.runs.find(item => item.transcriptMeetingId === meeting.id) ?? state.runs.find(item => item.primary && item.meetingId === meeting.id);
  const recording = run?.recording;
  const transcriptionError = run?.error || run?.job?.error;
  const finishing = !!run?.job && !isTerminalJob(run.job.state) && !recording;
  const draftNotes = 'workflow_role' in review.workspace && review.workspace.workflow_role === 'live-draft';
  const fallbackNotes = review.workspace.workflow_role === 'fallback';
  const legacy = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  useEffect(() => {
    if (legacy.isSummaryDirty || legacy.isSaving) return registerUpdateSaveGuard(async () => {
      throw new Error('Save your summary changes before installing the update.');
    });
  }, [legacy.isSummaryDirty, legacy.isSaving]);
  const renameTitle = async (title: string) => {
    await invoke('api_save_meeting_title', { meetingId: meeting.id, title });
    setDisplayTitle(title);
    legacy.updateMeetingTitle(title);
    window.dispatchEvent(new CustomEvent('xx-meeting-renamed', { detail: { id: meeting.id, title } }));
  };
  const save = async () => {
    try { await review.save(); window.dispatchEvent(new Event('xx-projects-updated')); toast.success('Notes and corrections saved'); }
    catch { /* The persistent error retains unsaved edits in the workspace. */ }
  };
  useEffect(() => {
    setDisplayTitle(meeting.title);
  }, [meeting.id, meeting.title]);
  useEffect(() => {
    const renamed = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; title: string }>).detail;
      if (detail.id === meeting.id || detail.id === review.workspace.source_meeting_id) setDisplayTitle(detail.title);
    };
    window.addEventListener('xx-meeting-renamed', renamed);
    return () => window.removeEventListener('xx-meeting-renamed', renamed);
  }, [meeting.id, review.workspace.source_meeting_id]);
  useEffect(() => {
    let cancelled = false;
    setAudioPath(null); setAudioError(null);
    invoke<{ path: string | null }>('local_get_meeting_audio', { meetingId: meeting.id })
      .then(result => { if (!cancelled) setAudioPath(result.path); })
      .catch(reason => { if (!cancelled) setAudioError(`Recording unavailable: ${String(reason)}`); });
    return () => { cancelled = true; };
  }, [meeting.id, recording]);
  useEffect(() => {
    // Correction drafts live inside the transcript panel until explicitly applied.
    // The workspace save merges edits typed during a save and stops on revision conflicts.
    if (!review.loaded || !review.dirty || review.saving || review.error || correctionDraft) return;
    const timer = window.setTimeout(() => { void review.save().then(() => window.dispatchEvent(new Event('xx-projects-updated'))).catch(() => { /* Persistent error + explicit retry. */ }); }, 1000);
    return () => window.clearTimeout(timer);
  }, [review.loaded, review.dirty, review.saving, review.error, review.workspace, review.save, correctionDraft]);
  const saveCurrent = useRef(save);
  saveCurrent.current = save;
  const saveEnabled = useRef(false);
  saveEnabled.current = review.loaded && review.dirty && !review.saving;
  const needsSave = useRef(false);
  needsSave.current = review.dirty || review.saving || correctionDraft || titleEdit.dirty || titleEdit.saving;
  const allowHistory = useRef(false);
  const pageIndex = useRef<number>();
  useEffect(() => {
    // Next can mount a restored page before committing its URL to history.
    if (window.location.pathname === '/meeting-details' && new URLSearchParams(window.location.search).get('id') === meeting.id) {
      pageIndex.current = (window as unknown as { navigation?: { currentEntry?: { index?: number } } }).navigation?.currentEntry?.index;
    }
  });
  useEffect(() => {
    const currentHref = new URL(`/meeting-details?id=${encodeURIComponent(meeting.id)}`, window.location.origin).href;
    const navIndex = () => (window as unknown as { navigation?: { currentEntry?: { index?: number } } }).navigation?.currentEntry?.index;
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    let restoring = false;
    const beforeTraverse = (event: Event) => {
      const transition = event as Event & { navigationType: string; canIntercept: boolean; destination: { url: string; index: number; sameDocument: boolean } };
      if (transition.navigationType !== 'traverse') return;
      if (allowHistory.current) { allowHistory.current = false; return; }
      if (!needsSave.current || !transition.cancelable || !transition.canIntercept || !transition.destination.sameDocument || new URL(transition.destination.url).origin !== window.location.origin || transition.destination.url === currentHref) return;
      const delta = transition.destination.index - (navIndex() ?? pageIndex.current ?? transition.destination.index + 1);
      // Cancel before the router receives popstate, so the editor never unmounts.
      transition.preventDefault();
      setPendingNavigation({ href: transition.destination.url, historyDelta: delta || -1 });
    };
    const beforeNavigation = (event: Event) => {
      const href = (event as CustomEvent<{ href: string }>).detail?.href;
      if (!needsSave.current || !href || new URL(href, currentHref).href === currentHref) return;
      event.preventDefault(); setPendingNavigation({ href });
    };
    const beforeLink = (event: MouseEvent) => {
      if (!needsSave.current || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as HTMLElement)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank' || link.download || link.origin !== window.location.origin || link.href === currentHref) return;
      event.preventDefault(); event.stopPropagation(); setPendingNavigation({ href: link.href });
    };
    const beforeHistory = (event: PopStateEvent) => {
      if (restoring) { event.stopImmediatePropagation(); restoring = false; return; }
      if (allowHistory.current) { allowHistory.current = false; return; }
      if (!needsSave.current || window.location.href === currentHref) return;
      const href = window.location.href;
      const destinationIndex = navIndex();
      const calculated = pageIndex.current != null && destinationIndex != null ? destinationIndex - pageIndex.current : -1;
      const delta = calculated || -1;
      // Restore this entry before displaying a dialog; keep Next's route and edits intact.
      event.stopImmediatePropagation(); restoring = true;
      window.history.go(-delta);
      setPendingNavigation({ href, historyDelta: delta });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!needsSave.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('xx-before-navigate', beforeNavigation);
    document.addEventListener('click', beforeLink, true);
    if (navigation) navigation.addEventListener('navigate', beforeTraverse);
    else window.addEventListener('popstate', beforeHistory, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('xx-before-navigate', beforeNavigation);
      document.removeEventListener('click', beforeLink, true);
      if (navigation) navigation.removeEventListener('navigate', beforeTraverse);
      else window.removeEventListener('popstate', beforeHistory, true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [meeting.id]);
  useEffect(() => {
    const keyboardSave = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      // A reference has a separate save action and must not appear saved by Ctrl+S.
      event.preventDefault();
      const separate = (event.target as HTMLElement)?.closest('[data-separate-save]');
      if (separate) { toast.info(separate.getAttribute('data-separate-save') || 'Use Save reference to save this reference.'); return; }
      if (saveEnabled.current) void saveCurrent.current();
    };
    window.addEventListener('keydown', keyboardSave);
    return () => window.removeEventListener('keydown', keyboardSave);
  }, [meeting.id]);
  return <div className="xx-saved-note">
    <section className="xx-saved-note-sheet" aria-label="Meeting notes">
        <header className="xx-saved-note-header">
          <div className="xx-saved-note-title-row"><MeetingTitle key={meeting.id} title={displayTitle} onSave={renameTitle} onStateChange={setTitleEdit} />
            <Popover><PopoverTrigger asChild><button type="button" className="xx-button-secondary !min-h-8 !px-2 text-xs"><Settings2 size={13} aria-hidden="true" />Tools<ChevronDown size={12} aria-hidden="true" /></button></PopoverTrigger>
              <ToolsPortal forceMount><ToolsContent forceMount align="end" sideOffset={10} aria-label="Meeting tools" className="data-[state=closed]:hidden z-50 border shadow-lg outline-none w-[380px] max-w-[calc(100vw-32px)] max-h-[min(680px,calc(100vh-120px))] overflow-y-auto rounded-2xl border-[var(--xx-border)] bg-[var(--xx-paper)] p-4 text-[var(--xx-ink)] space-y-3">
                <div><h3 className="font-medium text-sm">Meeting tools</h3><p className="mt-1 text-xs text-[var(--xx-muted)]">Fine-tune this meeting when you need to.</p></div>
                <details className="rounded-xl border border-[var(--xx-border)] p-3"><summary className="cursor-pointer text-sm font-medium">Transcription &amp; versions</summary><div className="mt-3"><LocalTranscriptionPanel sessionDir={meeting.folder_path} meetingId={meeting.id} projectId={review.workspace.project_id} /></div></details>
                <SpeakerReviewPanel meetingId={meeting.id} review={review} />
                <ProjectVaultPanel selectedProject={review.workspace.project_id} onSelectProject={review.updateProject} disabled={!review.loaded || review.saving} />
                {hasVisibleSummaryContent(legacy.aiSummary) && <details className="rounded-xl border border-[var(--xx-border)] p-3"><summary className="cursor-pointer text-sm font-medium">Previously saved summary</summary><p className="text-xs text-[var(--xx-muted)] my-3">Preserved from the earlier workflow.</p><BlockNoteSummaryView ref={legacy.blockNoteSummaryRef} summaryData={legacy.aiSummary} onSave={legacy.handleSaveSummary} onSummaryChange={legacy.handleSummaryChange} onDirtyChange={legacy.setIsSummaryDirty} status="idle" meeting={{ id: meeting.id, title: meeting.title, created_at: meeting.created_at }} /><Button size="sm" variant="outline" className="mt-3" disabled={!legacy.isSummaryDirty || legacy.isSaving} onClick={() => void legacy.saveAllChanges()}>{legacy.isSaving ? 'Saving…' : 'Save earlier summary changes'}</Button></details>}
              </ToolsContent></ToolsPortal>
            </Popover>
          </div>
          <div className="xx-saved-note-meta">
            <label className="xx-saved-note-project"><Folder size={13} aria-hidden="true" /><select aria-label="Meeting project" title={projectError ?? 'Organize this note by project'} disabled={!review.loaded || review.saving || !!projectError} value={review.workspace.project_id ?? ''} onChange={event => review.updateProject(event.target.value || null)}><option value="">No project</option>{review.workspace.project_id && !projects.some(project => project.id === review.workspace.project_id) && <option value={review.workspace.project_id}>{review.workspace.project_id}</option>}{projects.map(project => <option key={project.id} value={project.id}>{projectLabel(project.name)}</option>)}</select></label>
            <span className="xx-saved-note-layer">{fallbackNotes ? 'Notes for this fallback' : draftNotes ? 'Notes for this draft' : 'My notes'}</span>
            <span role="status" className="xx-saved-note-status">{titleEdit.saving ? 'Saving title…' : titleEdit.dirty ? 'Unsaved title' : !review.loaded ? 'Loading…' : review.saving ? 'Saving…' : review.error ? 'Not saved' : correctionDraft ? 'Correction in progress' : review.dirty ? 'Unsaved changes' : <><Check size={12} aria-hidden="true" />Saved</>}</span>
            {(review.error || (review.dirty && correctionDraft)) && <button type="button" className="xx-button-secondary !min-h-7 !py-1 !px-2 text-xs" title="Save notes and applied corrections (Ctrl+S)" disabled={!review.loaded || review.saving || !review.dirty} onClick={() => void save()}>Save changes</button>}
          </div>
        </header>
        {review.error && <p role="alert" className="mx-5 mt-3 max-h-28 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 break-words">{review.error}</p>}
        {transcriptionError && !transcriptOpen && <p role="alert" className="mx-5 mb-2 text-xs text-amber-800">Audio is saved. Transcription needs attention. <button type="button" className="underline underline-offset-2" onClick={() => setTranscriptOpen(true)}>View transcript</button></p>}
        <div className={`xx-saved-note-body${transcriptOpen ? ' has-transcript' : ''}`}>
          <div className="xx-saved-note-canvas"><RichNotesEditor key={meeting.id} notes={review.workspace.notes} document={review.workspace.notes_document} onChange={review.updateNotes} disabled={!review.loaded} ariaLabel="Meeting notes" placeholder="What would you like to remember?" /></div>
          <div id="saved-note-transcript" role="region" aria-label="Transcript" className="xx-saved-note-transcript" hidden={!transcriptOpen}>
            <TranscriptWorkspacePanel compact playback={{ audio, path: audioPath, onError: setAudioError }} meeting={meeting} review={review} hasMore={hasMore} isLoadingMore={isLoadingMore} totalCount={totalCount} onLoadMore={onLoadMore} onDraftChange={setCorrectionDraft} />
          </div>
        </div>
        <footer className="xx-saved-note-dock">
          <div className="xx-saved-note-playback">
            {audioPath ? <audio ref={audio} key={audioPath} aria-label="Meeting recording" controls preload="metadata" src={convertFileSrc(audioPath)} onError={() => setAudioError('The saved audio could not be played. Open its recording folder to inspect it.')} /> : <span>{recording ? 'Recording in progress' : 'No recording attached'}</span>}
          </div>
          <button type="button" className="xx-saved-note-transcript-toggle" aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'} aria-expanded={transcriptOpen} aria-controls="saved-note-transcript" onClick={() => setTranscriptOpen(open => !open)} title={transcriptOpen ? 'Hide transcript' : 'Show transcript'}><Mic size={16} aria-hidden="true" /><span>{finishing ? 'Finishing transcript…' : 'Transcript'}</span>{transcriptOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}</button>
        </footer>
        {audioError && <p role="alert" className="xx-saved-note-audio-error">{audioError}</p>}
    </section>
    <Dialog open={pendingNavigation !== null} onOpenChange={open => { if (!open) setPendingNavigation(null); }}><DialogContent className="rounded-2xl border-[var(--xx-border)] bg-[var(--xx-paper)] text-[var(--xx-ink)] max-w-sm"><DialogHeader><DialogTitle>Keep your changes?</DialogTitle><DialogDescription className="text-[var(--xx-muted)]">This meeting has an unsaved title, notes, or corrections. Stay here to save them before leaving.</DialogDescription></DialogHeader><DialogFooter className="gap-2"><button className="xx-button-secondary text-sm" disabled={review.saving || titleEdit.saving} onClick={() => {
      if (!review.discardDraft()) return;
      const next = pendingNavigation; setPendingNavigation(null);
      if (!next) return;
      needsSave.current = false;
      if (next.historyDelta != null) { allowHistory.current = true; window.history.go(next.historyDelta); }
      else router.push(next.href);
    }}>Leave without saving</button><button className="xx-button-primary text-sm" onClick={() => setPendingNavigation(null)}>Stay here</button></DialogFooter></DialogContent></Dialog>
  </div>;
}
