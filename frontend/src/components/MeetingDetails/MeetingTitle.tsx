'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { registerUpdateSaveGuard } from '@/lib/update-safety';

export interface TitleEditState { dirty: boolean; saving: boolean }

export function MeetingTitle({ title, onSave, onStateChange }: {
  title: string;
  onSave: (title: string) => Promise<void>;
  onStateChange: (state: TitleEditState) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editingNow = useRef(false);
  const savingNow = useRef(false);
  const errorNow = useRef<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveBeforeUpdate = useRef<() => Promise<void>>(async () => {});
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  useEffect(() => {
    onStateChange({ dirty: editing && draft.trim() !== title, saving });
  }, [draft, editing, onStateChange, saving, title]);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
  }, [editing]);
  useEffect(() => {
    if (editing || saving) return registerUpdateSaveGuard(() => saveBeforeUpdate.current());
  }, [editing, saving]);

  const showError = (message: string | null) => { errorNow.current = message; setError(message); };
  const finish = (returnFocus: boolean) => {
    editingNow.current = false;
    setEditing(false);
    showError(null);
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const cancel = () => {
    if (savingNow.current) return;
    setDraft(title);
    finish(true);
  };
  const save = (returnFocus: boolean): Promise<void> => {
    // Enter followed by blur must never submit the rename twice.
    if (inFlight.current) return inFlight.current;
    if (!editingNow.current) return Promise.resolve();
    const next = draft.trim();
    if (!next) {
      showError('Enter a meeting title.');
      return Promise.reject(new Error('Enter a meeting title before installing an update.'));
    }
    if (next === title) { finish(returnFocus); return Promise.resolve(); }
    savingNow.current = true;
    setSaving(true);
    showError(null);
    const operation = Promise.resolve().then(async () => {
      try {
        await onSave(next);
        const stillFocused = !!editor.current?.contains(document.activeElement);
        finish(returnFocus && stillFocused);
      } catch (reason) {
        showError(`Title not saved. ${String(reason)}`);
        throw reason;
      } finally {
        inFlight.current = null;
        savingNow.current = false;
        setSaving(false);
      }
    });
    inFlight.current = operation;
    return operation;
  };
  saveBeforeUpdate.current = () => {
    if (inFlight.current) return inFlight.current;
    if (errorNow.current) return Promise.reject(new Error(errorNow.current));
    return save(false);
  };
  // The editor presents failures inline; update installation receives the rejection.
  const saveFromEditor = (returnFocus: boolean) => { void save(returnFocus).catch(() => {}); };

  return <div className="xx-saved-note-title-editor">
    {editing ? <div ref={editor} className="xx-saved-note-title-form" aria-busy={saving}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null) || error) return;
        saveFromEditor(false);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); saveFromEditor(true); }
        else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}>
      <input ref={input} className="xx-heading xx-saved-note-title xx-saved-note-title-input" aria-label="Meeting title"
        aria-invalid={!!error} aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        value={draft} maxLength={200} readOnly={saving}
        onChange={event => { setDraft(event.target.value); showError(null); }} />
      <div className="xx-saved-note-title-controls">
        <span id={hintId}>{saving ? 'Saving title…' : 'Enter to save · Escape to cancel'}</span>
        <button type="button" className="xx-icon-button" aria-label="Save meeting title" title="Save title" disabled={saving} onClick={() => saveFromEditor(true)}><Check size={15} aria-hidden="true" /></button>
        <button type="button" className="xx-icon-button" aria-label="Cancel renaming" title="Cancel renaming" disabled={saving} onClick={cancel}><X size={15} aria-hidden="true" /></button>
      </div>
      {error && <p id={errorId} role="alert" className="xx-saved-note-title-error">{error}</p>}
    </div> : <h1 className="xx-heading xx-saved-note-title" aria-label={title}>
      <button ref={trigger} type="button" className="xx-saved-note-title-button" aria-label="Rename meeting title" title="Rename meeting title"
        onClick={() => { setDraft(title); showError(null); editingNow.current = true; setEditing(true); }}>
        <span>{title}</span><Pencil className="xx-saved-note-title-pencil" size={15} aria-hidden="true" />
      </button>
    </h1>}
  </div>;
}
