'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { Button } from '@/components/ui/button';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';

interface Capture { session_id: string; session_dir: string; meeting_name: string; created_at: string; audio_removal_pending?: boolean }
interface Recovered { capture: { session_id: string; session_dir: string }; verification: { verified: boolean }; meeting_name: string }
export function CaptureRecoveryPanel() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState<Capture | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(false);
  const listRevision = useRef(0);
  const router = useRouter();
  const { refetchMeetings } = useSidebar();
  const { workflow } = useLocalWorkflow();
  const refresh = useCallback(async () => {
    const revision = ++listRevision.current;
    try {
      const result = await invoke<Capture[]>('list_recoverable_captures');
      if (mounted.current && revision === listRevision.current && !actionPending.current) setCaptures(result);
    } catch (reason) {
      if (mounted.current && revision === listRevision.current) setError(String(reason));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const onInterrupted = () => { if (!actionPending.current) void refresh(); };
    void refresh();
    window.addEventListener('xx-capture-interrupted', onInterrupted);
    return () => { mounted.current = false; listRevision.current++; window.removeEventListener('xx-capture-interrupted', onInterrupted); };
  }, [refresh]);
  const recover = async (capture: Capture) => {
    if (actionPending.current || capture.audio_removal_pending) return;
    actionPending.current = true;
    listRevision.current++;
    setBusy(capture.session_id); setError(null);
    try {
      // Recheck source files on every retry, including after a failed database
      // link. A previously verified result does not authenticate later changes.
      const result = await invoke<Recovered>('recover_local_capture', { sessionDir: capture.session_dir });
      if (!result.verification.verified) throw new Error('Recovered audio did not pass verification. Source chunks remain saved.');
      const meeting = await invoke<{ meeting_id: string }>('ensure_capture_meeting', { sessionDir: result.capture.session_dir });
      await workflow.captureStopped(result.capture);
      const run = workflow.state.runs.find(item => item.capture.session_id === result.capture.session_id && item.role !== 'live-draft');
      if (run?.job && ['stopped', 'failed'].includes(run.job.state)) await workflow.retry(run);
      await refetchMeetings();
      setCaptures(items => items.filter(item => item.session_id !== capture.session_id));
      router.push(`/meeting-details?id=${encodeURIComponent(meeting.meeting_id)}`);
    } catch (reason) { setError(`Recovery did not finish. ${String(reason)}`); }
    finally { actionPending.current = false; setBusy(null); }
  };
  const deleteAudio = async () => {
    if (!discard || actionPending.current) return;
    actionPending.current = true;
    listRevision.current++;
    const capture = discard;
    setBusy(capture.session_id); setError(null);
    let failed = false;
    try {
      await workflow.deleteRecoveredAudio(capture);
      setCaptures(items => items.filter(item => item.session_id !== capture.session_id));
      setDiscard(null);
    } catch (reason) { failed = true; setError(`Saved audio could not be deleted. ${String(reason)}`); }
    finally { actionPending.current = false; setBusy(null); }
    if (failed) await refresh();
  };
  if (!captures.length && !error) return null;
  return <><details className="rounded-lg border bg-white p-3"><summary className="text-sm font-medium cursor-pointer">Saved audio recovery ({captures.length})</summary><div className="mt-3 space-y-3"><p className="text-xs text-gray-600">Recover audio from an interrupted recording, or delete audio you no longer need.</p>{error && <p role="alert" className="text-xs text-red-700">{error}</p>}{captures.map(capture => <div key={capture.session_id} className="flex flex-wrap items-center gap-2"><span className="text-sm flex-1">{capture.meeting_name}</span>{!capture.audio_removal_pending && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void recover(capture)}>{busy === capture.session_id ? 'Working…' : 'Recover saved audio'}</Button>}<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setDiscard(capture)}>{capture.audio_removal_pending ? 'Retry deleting audio' : 'Delete saved audio'}</Button></div>)}</div></details>
    <Dialog open={!!discard} onOpenChange={open => { if (!open && !busy) setDiscard(null); }}><DialogContent className="max-w-sm"><DialogTitle>Delete this saved audio?</DialogTitle><DialogDescription>Delete the recoverable audio for “{discard?.meeting_name}”? Notes and transcript text already saved in oats will stay. The deleted audio cannot be recovered.</DialogDescription>{error && <p role="alert" className="text-xs text-red-700">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy !== null} onClick={() => setDiscard(null)}>Keep audio</Button><Button variant="destructive" disabled={busy !== null} onClick={() => void deleteAudio()}>{busy ? 'Deleting…' : 'Delete saved audio'}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
