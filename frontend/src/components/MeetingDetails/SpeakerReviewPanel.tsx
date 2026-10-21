'use client';
import { useEffect } from 'react';
import { useLocalWorkflow } from '@/contexts/LocalWorkflowContext';
import type { useTranscriptWorkspace } from '@/hooks/meeting-details/useTranscriptWorkspace';
import { recordingTime } from '@/lib/transcript-workspace';
import { Button } from '@/components/ui/button';

export function SpeakerReviewPanel({ meetingId, review }: { meetingId: string; review: ReturnType<typeof useTranscriptWorkspace> }) {
  const { workflow, state } = useLocalWorkflow();
  const run = state.runs.find(item => item.transcriptMeetingId === meetingId);
  const metadata = review.workspace.speaker_metadata;
  useEffect(() => { if (!state.speakerSetup) void workflow.checkSpeakerSetup(); }, [workflow, state.speakerSetup]);
  return <details className="rounded-xl border border-[var(--xx-border)] p-3"><summary className="cursor-pointer text-sm font-medium">Speakers <span className="text-xs font-normal text-[var(--xx-muted)]">{metadata?.speakers.length ? `· ${metadata.speakers.filter(speaker => speaker.active).length} identified` : '· after the call'}</span></summary><div className="mt-3 space-y-3">
    <p className="text-xs leading-5 text-[var(--xx-muted)]">Add names after listening. These are estimated speakers in each audio window, not word-by-word assignments.</p>
    {!state.speakerSetup?.available && <div className="text-xs text-amber-800"><p>{state.speakerSetup?.reason || 'Checking local speaker setup…'}</p><button type="button" className="mt-1 underline" onClick={() => void workflow.checkSpeakerSetup()}>Check setup again</button></div>}
    {state.speakerSetup?.available && !run?.speakerJob && !metadata && <p className="text-xs text-gray-500">Speaker labeling starts after this call’s transcript is complete and earlier speaker labeling has finished. It can continue while another call is transcribed.</p>}
    {run?.speakerJob && <p className="text-xs" role="status">Speaker processing: {run.speakerJob.state.replaceAll('_', ' ')}</p>}
    {(run?.speakerError || run?.speakerJob?.error) && <p role="alert" className="text-xs text-amber-800">{run.speakerError || run.speakerJob?.error}</p>}
    {run && (run.speakerError || ['failed', 'stopped'].includes(run.speakerJob?.state ?? '')) && <Button size="sm" variant="outline" onClick={() => void workflow.retrySpeakers(run)}>Retry speaker identification</Button>}
    {metadata?.reconciliation?.requires_review && <p className="text-xs text-amber-800">Some speaker groups changed between runs. Earlier manual names have been retained for review.</p>}
    {metadata?.speakers.map((speaker, index) => <label key={speaker.id} className="block text-xs text-[var(--xx-muted)]">Speaker {index + 1}{!speaker.active ? ' · earlier assignment' : ''}<input aria-label={`Name for ${speaker.id}`} className="mt-1.5 w-full rounded-lg border border-[var(--xx-border)] bg-[var(--xx-paper)] p-2 text-sm text-[var(--xx-ink)] focus:outline-[var(--xx-accent)]" disabled={!review.loaded || review.saving} value={review.workspace.speaker_names?.[speaker.id] ?? speaker.display_name ?? ''} placeholder="Add a name" onChange={event => review.updateSpeakerName(speaker.id, event.target.value)} /></label>)}
    {!!metadata?.speakers.length && <p className="text-[11px] text-[var(--xx-muted)]">Use Save changes to keep these names.</p>}
    {!!metadata?.turns.length && <details className="text-xs"><summary className="cursor-pointer">Speaker timeline ({metadata.turns.length} turns)</summary><div className="mt-2 max-h-56 overflow-y-auto space-y-2">{metadata.turns.map(turn => <p key={turn.id}><span className="font-mono">{recordingTime(turn.start_seconds)}–{recordingTime(turn.end_seconds)}</span> · {review.workspace.speaker_names?.[turn.speaker_id] || turn.speaker_id}</p>)}</div></details>}
  </div></details>;
}
