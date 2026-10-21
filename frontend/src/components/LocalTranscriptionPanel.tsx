'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { isTerminalJob, isTrelisProfile, pathKey, profileChunkSeconds, trelisProfile, type LocalJob, type LocalPreferences, type LocalProfile, type TrelisProfileId } from '@/lib/local-transcription-workflow';

export function LocalTranscriptionPanel({ sessionDir, meetingId, projectId = null }: { sessionDir?: string; meetingId?: string; projectId?: string | null }) {
  const { state, workflow } = useLocalWorkflow();
  const { isRecording } = useRecordingState();
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [previousJobs, setPreviousJobs] = useState<LocalJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedJob, setSelectedJob] = useState<string>();
  const router = useRouter();
  const { preferences } = state;
  const [rerunProfile, setRerunProfile] = useState<LocalPreferences['profile']>(trelisProfile(preferences.profile));
  const [rerunTrelisProfile, setRerunTrelisProfile] = useState<TrelisProfileId>(trelisProfile(preferences.profile));
  const [rerunLanguage, setRerunLanguage] = useState<LocalPreferences['languageMode']>(preferences.languageMode);
  const matchingRuns = sessionDir ? state.runs.filter(item => pathKey(item.capture.session_dir) === pathKey(sessionDir)) : state.runs.filter(item => item.capture.session_id === state.currentSession);
  const run = (selectedJob ? matchingRuns.find(item => item.job?.job_id === selectedJob) : undefined) ?? matchingRuns.find(item => meetingId && item.transcriptMeetingId === meetingId) ?? matchingRuns.find(item => item.job && !isTerminalJob(item.job.state)) ?? matchingRuns.find(item => item.role === 'live-final' || item.role === 'final') ?? matchingRuns[0];
  const job = run?.job;
  const trelisRun = matchingRuns.find(item => item.role === 'live-final');
  const fallbackRun = matchingRuns.find(item => item.role === 'fallback');
  const selectedProfile = meetingId ? rerunProfile : trelisProfile(isRecording ? trelisRun?.preferences.profile ?? preferences.profile : preferences.profile);
  const selectedLanguage = meetingId ? rerunLanguage : isRecording ? trelisRun?.preferences.languageMode ?? preferences.languageMode : preferences.languageMode;
  const activeTranscription = state.runs.some(item => item.job && !isTerminalJob(item.job.state));
  const currentProfile = profiles.find(profile => profile.id === selectedProfile);
  const update = (patch: Partial<LocalPreferences>) => {
    if (meetingId) {
      if (patch.profile) {
        setRerunProfile(patch.profile);
        if (isTrelisProfile(patch.profile)) setRerunTrelisProfile(patch.profile);
      }
      if (patch.languageMode) setRerunLanguage(patch.languageMode);
    } else workflow.setPreferences({ ...preferences, ...patch });
  };
  const openTranscript = (id: string) => {
    const href = `/meeting-details?id=${encodeURIComponent(id)}`;
    if (window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) router.push(href);
  };
  const loadProfiles = () => invoke<LocalProfile[]>('get_local_stt_profiles').then(result => { setProfiles(result.filter(profile => isTrelisProfile(profile.id) || profile.id === 'apex-20')); setError(null); }).catch(reason => setError(String(reason)));

  useEffect(() => { void loadProfiles(); }, []);
  useEffect(() => {
    if (!sessionDir) return;
    let cancelled = false;
    invoke<LocalJob[]>('list_local_transcription_jobs', { sessionDir }).then(result => { if (!cancelled) setPreviousJobs(result); }).catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [sessionDir, job?.state]);

  const rerun = async () => {
    if (!sessionDir || !meetingId) return;
    setBusy(true); setError(null);
    try {
      const result = await invoke<LocalJob>('start_local_transcription', { sessionDir, profile: rerunProfile, languageMode: rerunLanguage, projectId });
      await workflow.adopt({ ...result, session_dir: sessionDir, profile: rerunProfile }, meetingId, false);
      setSelectedJob(result.job_id);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  return <section className={`${meetingId ? '' : 'xx-paper rounded-2xl p-5'} space-y-3 text-[var(--xx-ink)]`} aria-label="Local transcription">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{meetingId ? 'For another version' : 'Every recording, taken care of'}</h2><span className="text-[11px] text-[var(--xx-muted)]">On this device</span></div>
    {!meetingId && <p className="text-sm leading-6">Trelis live transcript <span className="mx-1 text-[var(--xx-muted)]">·</span> Apex available as a fallback</p>}
    <div className="flex flex-wrap gap-3">
      {meetingId && <label className="min-w-0 flex-[1_1_220px] text-xs text-[var(--xx-muted)] space-y-1.5"><span className="block">Model for this version</span><select aria-label="Local transcription profile" className="w-full min-w-0 rounded-lg border border-[var(--xx-border)] bg-[var(--xx-paper)] p-2 text-sm text-[var(--xx-ink)] focus:outline-[var(--xx-accent)]" disabled={isRecording || busy} value={selectedProfile === 'apex-20' ? 'apex-20' : rerunTrelisProfile} onChange={event => update({ profile: event.target.value as LocalPreferences['profile'] })}><option value={rerunTrelisProfile}>Trelis · Hindi + English script</option><option value="apex-20">Apex · 20s · Roman Hinglish</option></select></label>}
      {isTrelisProfile(selectedProfile) && <label className="min-w-0 flex-[1_1_130px] text-xs text-[var(--xx-muted)] space-y-1.5"><span className="block">Trelis chunk length</span><select aria-label="Trelis chunk length" aria-describedby={meetingId ? 'rerun-chunk-help' : 'recording-chunk-help'} className="w-full rounded-lg border border-[var(--xx-border)] bg-[var(--xx-paper)] p-2 text-sm text-[var(--xx-ink)] focus:outline-[var(--xx-accent)]" disabled={isRecording || busy} value={selectedProfile} onChange={event => update({ profile: event.target.value as TrelisProfileId })}><option value="trelis-5">5 seconds</option><option value="trelis-10">10 seconds (default)</option><option value="trelis-20">20 seconds</option></select></label>}
      <label className="flex-[1_1_100px] text-xs text-[var(--xx-muted)] space-y-1.5"><span className="block">Language</span><select aria-label="Recording language" className="w-full rounded-lg border border-[var(--xx-border)] bg-[var(--xx-paper)] p-2 text-sm text-[var(--xx-ink)] focus:outline-[var(--xx-accent)]" disabled={isRecording || busy} value={selectedLanguage} onChange={event => update({ languageMode: event.target.value as LocalPreferences['languageMode'] })}><option value="hinglish">Hinglish</option><option value="english">English</option></select></label>
    </div>
    {isTrelisProfile(selectedProfile) && <p id={meetingId ? 'rerun-chunk-help' : 'recording-chunk-help'} className="text-xs leading-5 text-[var(--xx-muted)]">Shorter chunks give the model less context and require more processing calls. Repetitive chunks longer than 5 seconds are retried in 5-second windows.</p>}
    {!meetingId && <p className="text-xs leading-5 text-[var(--xx-muted)]">Trelis adds text in {profileChunkSeconds(selectedProfile)}-second windows, plus processing time, in its original Hindi + English script. After you stop, it finishes the remaining audio. This choice applies to your next recording. You can switch to an Apex fallback version if Trelis needs attention.</p>}
    {profiles.filter(profile => !profile.available && (profile.id === selectedProfile || (!meetingId && profile.id === 'apex-20'))).map(profile => <div key={profile.id} className="text-xs text-amber-800"><p>{profile.id === 'apex-20' ? 'Apex' : 'Trelis'}: {profile.reason || 'The model is not installed. You can still record and transcribe later.'}</p><button type="button" className="underline mt-1" onClick={() => void loadProfiles()}>Check model setup again</button></div>)}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {run?.error && <p role="alert" className="text-xs text-amber-800">{run.error}</p>}
    {job?.phase === 'loading_model' && !isTerminalJob(job.state) && <p role="status" className="text-xs leading-5 text-[var(--xx-muted)]">Loading Trelis. Your audio is being saved while the model gets ready; the first transcript can take about a minute.</p>}
    {run && !job && <p className="text-xs text-gray-600" role="status">{run.pausedByUser ? 'Transcription paused. Your saved audio is retained.' : run.recording && run.preferences.timing === 'after-recording' ? 'Recording audio. Transcription starts when you stop.' : run.error ? 'Transcription needs attention.' : activeTranscription ? 'Audio is saved. Waiting for another transcription to finish.' : 'Audio is saved. Preparing transcription.'}</p>}
    {job && <div className="space-y-2 text-xs"><p role="status">{run?.role === 'fallback' ? 'Apex fallback' : run?.role === 'live-final' ? job.state === 'complete' ? 'Final transcript' : !run.recording && !isTerminalJob(job.state) ? 'Finishing transcript' : 'Live transcript' : job.profile}: {job.state.replaceAll('_', ' ')} · {Math.round(job.processed_audio_seconds ?? 0)}s processed · {Math.round(job.backlog_seconds ?? 0)}s waiting</p>{job.error && <p className="text-red-700">{job.error}</p>}<div className="flex flex-wrap gap-2">{!isTerminalJob(job.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => workflow.stopWorker(run!))}>Pause transcription</Button>}{run?.transcriptMeetingId && run.transcriptMeetingId !== meetingId && <Button size="sm" variant="outline" onClick={() => openTranscript(run.transcriptMeetingId!)}>Open transcript</Button>}</div></div>}
    {run && !run.needsRecovery && (run.error || run.pausedByUser || (job && ['failed', 'stopped'].includes(job.state))) && <Button size="sm" variant="outline" disabled={busy || (activeTranscription && isTerminalJob(job?.state ?? 'stopped'))} onClick={() => void action(() => workflow.retry(run))}>{run.role === 'live-final' ? 'Retry Trelis' : 'Retry saved transcription'}</Button>}
    {trelisRun && !trelisRun.needsRecovery && trelisRun.job?.state !== 'complete' && <div className="space-y-2 border-t border-[var(--xx-border)] pt-3"><p className="text-xs leading-5 text-[var(--xx-muted)]">Apex replays the saved audio as a separate version. Trelis stops after its current window; its raw text and your corrections stay available.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || fallbackRun?.job?.state === 'complete' || (!!fallbackRun?.job && !isTerminalJob(fallbackRun.job.state))} onClick={() => void action(() => workflow.useApexFallback(trelisRun))}>{trelisRun.fallbackRequested && !trelisRun.stopError && !fallbackRun?.error ? 'Apex fallback requested' : 'Use Apex fallback'}</Button>{fallbackRun?.job && !isTerminalJob(fallbackRun.job.state) && fallbackRun !== run && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => workflow.stopWorker(fallbackRun))}>Pause Apex fallback</Button>}{trelisRun !== run && trelisRun.fallbackRequested && <Button size="sm" variant="outline" disabled={busy || activeTranscription} onClick={() => void action(() => workflow.retry(trelisRun))}>Retry Trelis</Button>}{fallbackRun?.transcriptMeetingId && fallbackRun.transcriptMeetingId !== meetingId && <Button size="sm" variant="outline" onClick={() => openTranscript(fallbackRun.transcriptMeetingId!)}>Open Apex fallback</Button>}</div>{trelisRun.stopError && run !== trelisRun && <p role="alert" className="text-xs text-amber-800">{trelisRun.stopError}</p>}</div>}
    {meetingId && sessionDir && <details className="text-xs"><summary className="cursor-pointer">Another transcript version</summary><p className="mt-2 text-gray-600">Run the selected model against the same recording. Each version keeps its own corrections.</p><Button size="sm" variant="outline" className="mt-2" disabled={activeTranscription || busy || !currentProfile?.available || isRecording} onClick={() => void rerun()}>Create another version</Button></details>}
    {previousJobs.length > 0 && <details className="text-xs"><summary className="cursor-pointer">Saved runs ({previousJobs.length})</summary><div className="mt-2 flex flex-wrap gap-2">{previousJobs.map(previous => <button type="button" key={previous.job_id} disabled={busy} className="rounded border px-2 py-1" onClick={() => void action(async () => { setSelectedJob(previous.job_id); if (meetingId) await workflow.adopt(previous, meetingId); })}>{previous.profile} · {previous.state}</button>)}</div></details>}
  </section>;
}
