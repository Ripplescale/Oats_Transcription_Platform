'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState, RecordingStatus } from './RecordingStateContext';
import { LocalWorkflow, DEFAULT_LOCAL_PREFERENCES, type CaptureSession, type WorkflowState } from '@/lib/local-transcription-workflow';

const STORAGE_KEY = 'sttapp.local-workflow.v1';
const Context = createContext<{ workflow: LocalWorkflow; state: WorkflowState } | null>(null);
export function useLocalWorkflow() {
  const value = useContext(Context);
  if (!value) throw new Error('LocalWorkflowProvider is missing');
  return value;
}
export function LocalWorkflowProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { refetchMeetings, setIsMeetingActive } = useSidebar();
  const { setStatus } = useRecordingState();
  const callbacks = useRef({ router, refetchMeetings, setIsMeetingActive, setStatus });
  callbacks.current = { router, refetchMeetings, setIsMeetingActive, setStatus };
  const [state, setState] = useState<WorkflowState>({ preferences: DEFAULT_LOCAL_PREFERENCES, runs: [] });
  const [workflow] = useState(() => new LocalWorkflow({
    invoke,
    changed: next => {
      setState(next);
      // Text is already durably stored by the worker. Keep only small workflow pointers here.
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, speakerSetup: undefined, runs: next.runs.map(run => ({ ...run, job: run.job ? { ...run.job, segments: undefined, superseded_segments: undefined } : undefined, speakerJob: run.speakerJob ? { ...run.speakerJob, result: undefined } : undefined })) })); } catch { /* Recording and native jobs do not depend on browser storage. */ }
    },
    imported: meetingId => {
      void callbacks.current.refetchMeetings();
      window.dispatchEvent(new CustomEvent('local-transcript-updated', { detail: { meetingId } }));
    },
    stopped: (meetingId, error) => {
      callbacks.current.setIsMeetingActive(false);
      callbacks.current.setStatus(RecordingStatus.IDLE);
      void callbacks.current.refetchMeetings();
      if (meetingId) {
        const href = `/meeting-details?id=${encodeURIComponent(meetingId)}`;
        const openNote = () => {
          if (window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) callbacks.current.router.push(href);
        };
        const showingRecording = window.location.pathname === '/' && new URLSearchParams(window.location.search).get('view') === 'recording';
        if (showingRecording) openNote();
        toast.success('Recording saved. Your transcript will appear as processing finishes.', showingRecording ? undefined : { action: { label: 'Open note', onClick: openNote } });
      } else toast.warning('Audio is saved. The meeting needs recovery.', { description: error });
    },
  }));
  useEffect(() => {
    let alive = true;
    const unlisteners: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const setup = async () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) { const parsed = JSON.parse(saved) as Partial<WorkflowState>; workflow.state = { ...workflow.state, ...parsed, runs: Array.isArray(parsed.runs) ? parsed.runs : [] }; workflow.setPreferences(workflow.state.preferences); }
      } catch { localStorage.removeItem(STORAGE_KEY); }
      await workflow.prepareProfiles();
      const attach = async <T,>(eventName: string, callback: (payload: T) => void) => {
        const off = await listen<T>(eventName, event => { if (alive) callback(event.payload); });
        if (alive) unlisteners.push(off); else off();
      };
      try {
        await attach<{ capture?: CaptureSession }>('recording-started', payload => { if (payload.capture) void workflow.captureStarted(payload.capture); });
        await attach<{ capture?: CaptureSession }>('recording-stopped', payload => { if (payload.capture) void workflow.captureStopped(payload.capture); });
        await attach<{ capture?: CaptureSession; error?: string }>('recording-interrupted', payload => {
          if (payload.capture) void workflow.captureInterrupted(payload.capture, payload.error ?? 'Audio capture stopped unexpectedly.');
          callbacks.current.setIsMeetingActive(false);
          callbacks.current.setStatus(RecordingStatus.ERROR);
          window.dispatchEvent(new Event('xx-capture-interrupted'));
          toast.warning('Recording interrupted. Saved audio needs recovery.', { description: payload.error });
        });
        const active = await invoke<CaptureSession | null>('get_active_capture');
        if (alive) await workflow.refreshAfterReload(active);
      } catch (error) { if (alive) toast.error('Could not connect the local workflow', { description: String(error) }); }
      const poll = async () => { if (!alive) return; await workflow.tick(); if (alive) timer = setTimeout(poll, 3000); };
      if (alive) timer = setTimeout(poll, 1000);
    };
    void setup();
    return () => { alive = false; clearTimeout(timer); unlisteners.forEach(off => off()); };
  }, [workflow]);
  return <Context.Provider value={{ workflow, state }}>{children}</Context.Provider>;
}
