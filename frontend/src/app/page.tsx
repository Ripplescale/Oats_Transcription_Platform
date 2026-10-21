'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter, useSearchParams } from 'next/navigation';
import { LocalTranscriptionPanel } from '@/components/LocalTranscriptionPanel';
import { CaptureRecoveryPanel } from '@/components/CaptureRecoveryPanel';
import { LiveTranscriptPanel } from '@/components/LiveTranscriptPanel';
import { ChevronUp, ChevronDown, ArrowLeft, SlidersHorizontal, Mic } from 'lucide-react';
import { NoteLibrary } from '@/components/NoteLibrary';
import { LiveNoteEditor } from '@/components/LiveNoteEditor';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { invoke } from '@tauri-apps/api/core';

function HomeContent() {
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const barHeights = ['10px', '18px', '12px'];
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const noteOpen = useSearchParams().get('view') === 'recording';
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [initialProject, setInitialProject] = useState<string | null | undefined>(undefined);
  const [noteSession, setNoteSession] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('Untitled note');
  const titleDirty = useRef(false);
  const titleGeneration = useRef(0);
  const [startError, setStartError] = useState<string | null>(null);
  const { state: workflowState } = useLocalWorkflow();

  // Use contexts for state management
  const { meetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

  // Hooks
  const { hasMicrophone } = usePermissionCheck();
  const { setIsMeetingActive, isCollapsed: sidebarCollapsed, refetchMeetings, meetings, setCurrentMeeting } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();
  const navigate = (href: string) => {
    if (window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) router.push(href);
  };
  const run = workflowState.runs.find(item => item.primary && item.capture.session_id === workflowState.currentSession && (item.recording || item.capture.session_id === noteSession));
  const titleMeeting = useRef<string | undefined>(undefined);
  titleMeeting.current = run?.meetingId;
  useEffect(() => {
    const saved = meetings.find(meeting => meeting.id === run?.meetingId);
    if (saved && !titleDirty.current) setNoteTitle(saved.title);
  }, [run?.meetingId, meetings]);
  useEffect(() => {
    if (recordingState.isRecording) {
      if (workflowState.currentSession) setNoteSession(workflowState.currentSession);
    }
  }, [recordingState.isRecording, workflowState.currentSession]);
  const newNote = async (projectId: string | null) => {
    if (recordingState.isRecording || recordingState.isStartingRecording) { navigate('/?view=recording'); return; }
    titleDirty.current = false; titleGeneration.current += 1;
    navigate('/?view=recording'); setTranscriptOpen(false); setInitialProject(projectId); setNoteSession(null); setNoteTitle('Untitled note'); setStartError(null);
    try { await handleRecordingStart(); }
    catch (reason) { setStartError(`Recording could not start. Check your microphone and recording settings, then try again. ${String(reason)}`); }
  };
  const renameNote = async () => {
    if (!run?.meetingId || !titleDirty.current || !noteTitle.trim()) return;
    const meetingId = run.meetingId;
    const generation = titleGeneration.current;
    try {
      await invoke('api_save_meeting_title', { meetingId, title: noteTitle.trim() });
      if (titleMeeting.current === meetingId && titleGeneration.current === generation) titleDirty.current = false;
      await refetchMeetings(); window.dispatchEvent(new Event('xx-projects-updated'));
    } catch (reason) { toast.error('Title could not be saved', { description: String(reason) }); }
  };

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('home');
  }, []);

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('Meeting recovered successfully!', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? 'Transcripts and audio recovered'
            : 'Transcripts recovered (no audio available)',
          action: result.meetingId ? {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting-details?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        // If no more recoverable meetings, clear session flag so dialog can show again
        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        // Auto-navigate after a short delay
        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting-details?id=${result.meetingId}`);
          }, 2000);
        }
      }
    } catch (error) {
      toast.error('Failed to recover meeting', {
        description: error instanceof Error ? error.message : 'Unknown error occurred',
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <div className="xx-home xx-notes-home">
      <SettingsModals modals={modals} messages={messages} onClose={hideModal} />
      <TranscriptRecovery isOpen={showRecoveryDialog} onClose={handleDialogClose} recoverableMeetings={recoverableMeetings} onRecover={handleRecovery} onDelete={deleteRecoverableMeeting} onLoadPreview={loadMeetingTranscripts} />
      {!noteOpen ? <NoteLibrary onNewNote={projectId => void newNote(projectId)} busy={recordingState.isStartingRecording || isStopping || isSaving} recovery={<CaptureRecoveryPanel />} /> : <div className="xx-compose">
        <header className="xx-compose-header"><div className="xx-compose-crumb"><button className="xx-icon-button" aria-label="Back to notes" disabled={recordingState.isStartingRecording} title="Back to notes" onClick={() => navigate('/')}><ArrowLeft size={17} /></button><span>{new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span></div><input className="xx-note-title" aria-label="Note title" value={noteTitle} disabled={!run?.meetingId} maxLength={200} onChange={event => { titleDirty.current = true; titleGeneration.current += 1; setNoteTitle(event.target.value); }} onBlur={() => void renameNote()} placeholder="Untitled note" /></header>
        {startError && <p role="alert" className="xx-inline-error">{startError}</p>}
        {(run?.error || run?.job?.error) && <div role="alert" className="xx-inline-error">Audio is still being saved. Transcription needs attention; open Recording options to retry or use Apex fallback.</div>}
        {run?.meetingId ? <LiveNoteEditor key={run.meetingId} meetingId={run.meetingId} initialProject={initialProject} /> : <div className="xx-opening-note"><p>{recordingState.isStartingRecording ? 'Opening your note…' : 'Your note opens when recording starts.'}</p>{startError && <button className="xx-button-secondary" onClick={() => void newNote(initialProject ?? null)}>Try recording again</button>}</div>}
        <div className="xx-transcript-drawer" id="live-transcript-drawer" hidden={!transcriptOpen}><div className="xx-drawer-label"><span>Transcript</span><button className="xx-icon-button" aria-label="Hide transcript" onClick={() => setTranscriptOpen(false)}><ChevronDown size={16} /></button></div><LiveTranscriptPanel /></div>
        {status !== RecordingStatus.PROCESSING_TRANSCRIPTS && status !== RecordingStatus.SAVING && <div className="xx-recording-dock xx-note-dock">
          <RecordingControls isRecording={recordingState.isRecording} onRecordingStop={(callApi = true) => handleRecordingStop(callApi)} onRecordingStart={handleRecordingStart} onTranscriptReceived={() => {}} onStopInitiated={() => setIsStopping(true)} barHeights={barHeights} onTranscriptionError={message => showModal('errorAlert', message)} isRecordingDisabled={isRecordingDisabled} isParentProcessing={isProcessingStop} selectedDevices={selectedDevices} meetingName={meetingTitle} />
          <button className="xx-transcript-toggle" aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'} aria-controls="live-transcript-drawer" aria-expanded={transcriptOpen} onClick={() => setTranscriptOpen(!transcriptOpen)}><Mic size={15} />Transcript{transcriptOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
          <span className="xx-recording-status" title="Audio is saved while Trelis prepares the transcript. The first text can take about a minute.">{recordingState.isPaused ? 'Paused' : recordingState.isRecording ? run?.job?.segments?.length ? 'Listening' : 'Listening · preparing transcript' : run?.meetingId ? 'Audio saved' : 'Not recording'}</span>
          <details className="xx-recording-options xx-dock-options"><summary aria-label="Recording options" title="Recording options"><SlidersHorizontal size={16} /></summary><div><LocalTranscriptionPanel /></div></details>
        </div>}
        <StatusOverlays isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording} isSaving={status === RecordingStatus.SAVING} sidebarCollapsed={sidebarCollapsed} />
      </div>}
    </div>
  );
}

export default function Home() {
  return <Suspense><HomeContent /></Suspense>;
}
