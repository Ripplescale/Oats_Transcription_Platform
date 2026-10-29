export type DictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'ready' | 'inserted' | 'cancelled' | 'error';
export interface DictationShortcut { label: string; registered: boolean; observed?: boolean; error?: string | null }
export interface DictationStatus {
  phase: DictationPhase;
  session_id: string | null;
  elapsed_seconds: number;
  level: number;
  text: string | null;
  backend?: 'trelis' | 'faster_whisper';
  draft_text?: string | null;
  live_typing?: boolean;
  inserted_characters?: number;
  delivery_message?: string | null;
  streaming_message?: string | null;
  message: string | null;
  microphone: string | null;
  available: boolean;
  shortcuts: { fallback: DictationShortcut; copilot: DictationShortcut };
}

export function dictationTime(seconds: number) {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}

export function dictationIsActive(phase: DictationPhase) {
  return phase === 'starting' || phase === 'listening' || phase === 'transcribing';
}

export const dictationPhaseLabel: Record<DictationPhase, string> = {
  idle: 'Ready to dictate', starting: 'Getting ready…', listening: 'Listening', transcribing: 'Transcribing…',
  ready: 'Ready to copy', inserted: 'Text inserted', cancelled: 'Cancelled', error: 'Couldn’t finish',
};
