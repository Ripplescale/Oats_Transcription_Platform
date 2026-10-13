'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Mic, Square, X } from 'lucide-react';
import { dictationIsActive, dictationPhaseLabel, dictationTime, type DictationStatus } from '@/lib/dictation';

export function DictationSettings() {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const actionPending = useRef(false);
  const sequence = useRef(0);
  const refresh = async () => {
    const request = ++sequence.current;
    try {
      const next = await invoke<DictationStatus>('dictation_status');
      if (mounted.current && request === sequence.current) { setStatus(next); setLoadError(null); }
    } catch (reason) { if (mounted.current && request === sequence.current) setLoadError(String(reason)); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); };
  }, []);
  useEffect(() => { setError(null); setNotice(null); }, [status?.session_id]);
  async function act(command: 'dictation_toggle' | 'dictation_cancel' | 'dictation_copy' | 'dictation_dismiss') {
    if (!status || actionPending.current) return;
    actionPending.current = true; setBusy(true); setNotice(null); setError(null);
    try {
      await invoke(command, { sessionId: status.session_id });
      if (mounted.current && command === 'dictation_copy') setNotice('Copied. Paste it where you need it.');
      await refresh();
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }
  const active = status && dictationIsActive(status.phase);
  const fasterWhisper = status?.backend === 'faster_whisper';
  const draft = status?.session_id && (status.phase === 'listening' || status.phase === 'transcribing') && status.draft_text?.trim() ? status.draft_text : null;
  const shortcut = status?.shortcuts.copilot.registered && status.shortcuts.copilot.observed ? 'the Copilot key' : status?.shortcuts.fallback.registered ? status.shortcuts.fallback.label : status?.shortcuts.copilot.registered ? status.shortcuts.copilot.label : null;
  return <section aria-labelledby="dictation-settings-title" className="space-y-4 rounded-xl border border-[var(--xx-border)] bg-[var(--xx-paper)] p-4 text-[var(--xx-ink)]">
    <div><h3 id="dictation-settings-title" className="flex items-center gap-2 font-medium"><Mic size={16} aria-hidden="true" />Dictation</h3>
      <p className="mt-1 text-sm leading-6 text-[var(--xx-muted)]">Place the cursor where you want to type, press {shortcut || 'a registered shortcut'}, and speak. {fasterWhisper ? 'Text appears as you speak. Draft words may change before they are typed.' : 'Text appears in short phrases as you pause.'} Press again to finish your last words. Keep oats running.</p></div>
    <dl className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><dt>Model / mode</dt><dd className="text-xs text-[var(--xx-muted)]">{status ? fasterWhisper ? 'faster-whisper · live words' : 'Trelis · confirmed phrases' : 'Checking…'}</dd></div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><dt>Copilot key <span className="text-xs text-[var(--xx-muted)]">(Win + Shift + F23)</span></dt><dd className="text-xs text-[var(--xx-muted)]">{status ? status.shortcuts.copilot.registered ? status.shortcuts.copilot.observed ? 'Key detected' : 'Shortcut ready; key untested' : 'Unavailable on this setup' : 'Checking…'}</dd></div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><dt><kbd className="text-xs">{status?.shortcuts.fallback.label || 'Ctrl + Alt + Shift + D'}</kbd></dt><dd className="text-xs text-[var(--xx-muted)]">{status ? status.shortcuts.fallback.registered ? 'Registered' : 'Unavailable on this setup' : 'Checking…'}</dd></div>
    </dl>
    <p className="text-xs leading-5 text-[var(--xx-muted)]">Copilot support depends on the key signal your laptop sends. If Windows opens Copilot instead, use {status?.shortcuts.fallback.label || 'Ctrl + Alt + Shift + D'} when that shortcut is registered.</p>
    {status && !status.shortcuts.fallback.registered && !status.shortcuts.copilot.registered && <p role="status" className="text-xs leading-5 text-amber-800">A keyboard shortcut could not be registered. You can still start here and copy the result.</p>}
    <p className="text-xs leading-5 text-[var(--xx-muted)]">Uses your default microphone and {fasterWhisper ? 'local faster-whisper engine' : 'local Trelis model'}.{status?.microphone ? ` Microphone: ${status.microphone}.` : ''}</p>
    {status && !status.available && <p role="status" className="text-xs leading-5 text-amber-800">{status.message || 'Dictation is unavailable. Check microphone access and the local transcription model.'}</p>}
    {status && status.phase !== 'idle' && <p role="status" className="text-sm">{dictationPhaseLabel[status.phase]}{active ? ` · ${dictationTime(status.elapsed_seconds)}` : ''}</p>}
    {draft && <div><p className="mb-1 text-xs text-[var(--xx-muted)]">Draft · may change before typing</p><div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--xx-border)] bg-[var(--xx-canvas)] p-3 text-sm leading-6" role="region" aria-label="Tentative dictation draft">{draft}</div></div>}
    {status?.text && !active && <div><p className="mb-1 text-xs text-[var(--xx-muted)]">{status.phase === 'ready' || status.phase === 'error' ? 'Dictation result' : 'Last dictation'}</p><div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--xx-border)] bg-[var(--xx-canvas)] p-3 text-sm leading-6" role="region" aria-label="Dictation result">{status.text}</div></div>}
    {status?.message && status.available && <p className="text-xs leading-5 text-[var(--xx-muted)]">{status.message}</p>}
    {active && status?.delivery_message && <p role="status" className="text-xs leading-5 text-[var(--xx-muted)]">{status.delivery_message} Any words already typed stay in place.</p>}
    <div className="flex flex-wrap gap-2">
      {status?.phase === 'listening' ? <button type="button" title="Finish this dictation" disabled={busy} className="xx-button-primary text-sm" onClick={() => void act('dictation_toggle')}><Square size={13} aria-hidden="true" />Stop dictation</button>
        : !active && <button type="button" title="Start here, then copy the result" disabled={!status?.available || busy} className="xx-button-primary text-sm" onClick={() => void act('dictation_toggle')}><Mic size={14} aria-hidden="true" />Start dictation</button>}
      {active && <button type="button" title="Cancel remaining dictation; words already typed stay in place" disabled={busy} className="xx-button-secondary text-sm" onClick={() => void act('dictation_cancel')}><X size={14} aria-hidden="true" />Cancel</button>}
      {!active && !!status?.text && <button type="button" title="Copy the dictation result to your clipboard" disabled={busy} className="xx-button-secondary text-sm" onClick={() => void act('dictation_copy')}><Copy size={14} aria-hidden="true" />{status.phase === 'ready' || status.phase === 'error' ? 'Copy result' : 'Copy last dictation'}</button>}
    </div>
    {!active && <p className="text-xs leading-5 text-[var(--xx-muted)]">Starting here keeps the text as a result to copy. For insertion into another app, use the shortcut while its text cursor is active.</p>}
    {notice && <p role="status" className="text-xs text-[var(--xx-accent)]">{notice}</p>}
    {(error || loadError) && <p role="alert" className="break-words text-xs leading-5 text-red-700">Dictation needs attention: {error || loadError}</p>}
  </section>;
}
