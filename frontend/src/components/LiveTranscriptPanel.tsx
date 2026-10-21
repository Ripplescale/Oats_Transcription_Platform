'use client';
import { AudioLines, Check, Mic, NotebookPen } from 'lucide-react';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { recordingTime } from '@/lib/transcript-workspace';
import { isTerminalJob, profileChunkSeconds, trelisProfile } from '@/lib/local-transcription-workflow';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { PermissionWarning } from '@/components/PermissionWarning';
import { TranscriptProcessingChecks } from '@/components/TranscriptProcessingChecks';
import { useDisplayMode, useDisplayModeScroll } from '@/contexts/DisplayModeContext';

export function LiveTranscriptPanel() {
  const { isDev } = useDisplayMode();
  const scroll = useDisplayModeScroll<HTMLElement>();
  const { state } = useLocalWorkflow();
  const { isRecording, isPaused } = useRecordingState();
  const permissions = usePermissionCheck();
  const runs = state.runs.filter(item => item.capture.session_id === state.currentSession);
  const primary = runs.find(item => item.role === 'live-final');
  const run = (primary?.fallbackRequested ? runs.find(item => item.role === 'fallback') : primary)
    ?? runs.find(item => item.role === 'live-draft') ?? runs[0];
  const live = run?.preferences.timing === 'during-recording';
  const waitingForTranscription = run && (!run.recording || live) && !run.job && !run.error && !run.pausedByUser
    && state.runs.some(item => item.job && !isTerminalJob(item.job.state));
  const isFallback = run?.role === 'fallback';
  const isLegacyDraft = run?.role === 'live-draft';
  const chunkSeconds = profileChunkSeconds(trelisProfile(run?.preferences.profile ?? state.preferences.profile));
  const caption = isFallback ? 'Apex fallback · separate version · Roman Hinglish' : isLegacyDraft ? 'Apex live draft · Trelis final after the call' : `Trelis · ${chunkSeconds}-second windows plus processing · original Hindi + English script`;
  const failureMessage = `Transcription needs attention. ${isRecording ? 'Your recording continues independently.' : 'Your saved audio is kept.'} Open Recording options to retry or use Apex fallback.`;
  const segments = [...(run?.job?.segments ?? [])].filter(segment => segment.text.trim()).sort((a, b) => (a.start_seconds ?? 0) - (b.start_seconds ?? 0) || (a.source_track ?? '').localeCompare(b.source_track ?? ''));
  return <section ref={scroll} className="xx-live-panel custom-scrollbar" aria-label="Live transcript">
    {!segments.length ? <div className="xx-live-empty">
      <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--xx-canvas)] text-[var(--xx-accent)]">{isRecording ? <AudioLines size={23} /> : <NotebookPen size={23} />}</div>
      <p className="xx-eyebrow mb-3">{isRecording ? isPaused ? 'Take your time' : 'Listening, locally' : 'Less typing. More listening.'}</p>
      <h2 className="xx-heading text-[clamp(30px,3vw,44px)] leading-[1.12]">{isRecording ? isPaused ? 'A little pause.' : 'You talk. I’m all ears.' : <>Be here for the<br />conversation.</>}</h2>
      <p className="mt-5 max-w-[460px] text-[15px] leading-7 text-[var(--xx-muted)]">{isRecording ? isPaused ? 'Resume whenever you’re ready. Everything captured so far is saved.' : live ? !isDev ? 'Your audio is being saved. The transcript will appear here as you talk.' : isFallback ? 'Audio is being saved. Apex will replay it into a separate fallback version. Your Trelis text is kept.' : isLegacyDraft ? 'Audio is being saved. Apex adds a draft; Trelis prepares the final transcript after this call.' : `Audio is being saved. Trelis adds text in ${chunkSeconds}-second windows plus processing time, keeping the original Hindi + English script.` : 'Audio is being saved. Your transcript will be prepared when you stop recording.' : isDev ? 'A quiet place for your calls, transcripts and notes. Trelis listens while you talk and finishes any remaining audio after the call.' : 'A quiet place for your calls, transcripts and notes. Record a conversation and keep your own notes alongside it.'}</p>
      {(run?.error || run?.job?.error) && <p role="alert" className="mt-4 max-w-[460px] text-xs leading-5 text-amber-800">{failureMessage}</p>}
      {waitingForTranscription && <p role="status" className="mt-4 max-w-[460px] text-xs leading-5 text-[var(--xx-muted)]">Your audio is saved. Waiting for another transcription to finish.</p>}
      {!isRecording && <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--xx-muted)]"><span className="flex items-center gap-1.5"><Mic size={13} />Record on your laptop</span><span className="flex items-center gap-1.5"><Check size={13} />Review at your pace</span></div>}
      {!isRecording && !permissions.isChecking && <div className="mt-5"><PermissionWarning hasMicrophone={permissions.hasMicrophone} hasSystemAudio={permissions.hasSystemAudio} onRecheck={permissions.checkPermissions} isRechecking={permissions.isChecking} /></div>}
    </div> : <div className="mx-auto max-w-3xl">
      <header className="mb-5"><p className="xx-eyebrow">{isPaused ? 'Paused' : isFallback && isDev ? 'Apex fallback' : run?.job?.state === 'complete' ? 'Final transcript' : isRecording ? 'Live transcript' : 'Finishing transcript'}</p><h2 className="xx-heading text-3xl mt-2">The conversation so far</h2>{isDev && <><p className="mt-2 text-xs text-[var(--xx-muted)]">{caption}</p><p className="xx-transcript-source-help mt-2">Left: computer audio · Right: microphone. Labels identify audio sources, not people.</p></>}</header>
      {(run?.error || run?.job?.error) && <p role="alert" className="mb-4 text-xs leading-5 text-amber-800">{failureMessage}</p>}
      {segments.map(segment => {
        const channel = segment.source_track === 'system' || segment.source_track === 'microphone' ? segment.source_track : 'unknown';
        const sourceLabel = channel === 'system' ? 'Computer audio' : channel === 'microphone' ? 'Microphone' : 'Source unavailable';
        return <article key={segment.id} data-segment-id={segment.id} data-source-channel={channel} aria-label={`${sourceLabel} at ${recordingTime(segment.start_seconds)}`} className={`xx-transcript-message xx-transcript-message-${channel} space-y-2`}>
          <div className="xx-transcript-message-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--xx-muted)]">
            <span className="font-mono">{recordingTime(segment.start_seconds)}</span>
            {isDev && segment.recovery?.method === 'context_window_retry' && segment.end_seconds != null && <span className="font-mono -ml-2">–{recordingTime(segment.end_seconds)}</span>}
            {isDev && <span className="xx-transcript-source-label" title="Recording source; this label does not identify a person.">{sourceLabel}</span>}
            {isDev && (!!segment.quality_flags?.length || segment.recovery?.requires_review) && <span className="text-amber-800">Review suggested</span>}
          </div>
          <p className="xx-transcript-message-text whitespace-pre-wrap text-[15px] leading-[1.85]">{segment.text}</p>
          {isDev && <TranscriptProcessingChecks metadata={{ ...segment, original_recognition_text: segment.original_recognition_text ?? segment.recognition_original?.text }} startSeconds={segment.start_seconds} endSeconds={segment.end_seconds} />}
        </article>;
      })}
      {isDev && <p className="mt-5 text-xs leading-5 text-[var(--xx-muted)]">Times mark audio windows. Microphone and system labels identify tracks; individual speaker suggestions are prepared after the call.</p>}
    </div>}
  </section>;
}
