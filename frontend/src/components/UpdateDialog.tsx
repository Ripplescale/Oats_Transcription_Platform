import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { updateService, type UpdateInfo } from '@/services/updateService';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
  checkError?: string | null;
  onCheck: () => Promise<void>;
}
export function UpdateDialog({ open, onOpenChange, updateInfo: info, checkError, onCheck }: UpdateDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const acting = useRef(false);
  useEffect(() => { if (open) setError(null); }, [open]);
  const downloading = info?.state === 'downloading';
  const installing = info?.state === 'installing';
  const downloaded = info?.state === 'downloaded';
  const busy = pending || downloading || installing;
  const problem = error || checkError || info?.blocked_reason || info?.error;
  const run = async (action: () => Promise<unknown>) => {
    if (acting.current) return;
    acting.current = true; setPending(true); setError(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      acting.current = false; setPending(false);
      void updateService.getStatus().catch(() => {});
    }
  };
  const progress = info?.total_bytes && info.total_bytes > 0
    ? Math.min(100, Math.round(info.downloaded_bytes / info.total_bytes * 100)) : null;
  const title = installing ? 'Installing update…' : downloading ? 'Downloading update…'
    : downloaded ? 'Update ready to install' : 'oats updates';
  const description = info?.state === 'unconfigured' ? 'In-app updates are not configured in this build.'
    : info?.state === 'checking' ? 'Checking GitHub for a newer release…'
    : info?.state === 'idle' ? 'Check for a newer published version of oats.'
    : downloaded ? 'Your download is verified. Install when you are ready to close oats.'
    : info?.version ? 'Version ' + info.version + ' is available.' : 'Check for a newer published version of oats.';
  return <Dialog open={open} modal onOpenChange={value => { if (!busy && !acting.current) onOpenChange(value); }}>
    <DialogContent className={'max-w-md rounded-2xl border-[var(--xx-border)] bg-[var(--xx-paper)] text-[var(--xx-ink)]' + (busy ? ' [&>button.absolute]:hidden' : '')}
      onEscapeKeyDown={event => { if (busy || acting.current) event.preventDefault(); }}
      onInteractOutside={event => { if (busy || acting.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="text-[var(--xx-muted)]">{description}</DialogDescription></DialogHeader>
      <div className="space-y-3 text-sm">
        {info?.current_version && <p className="text-[var(--xx-muted)]">Installed version {info.current_version}</p>}
        {info?.notes && <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--xx-canvas)] p-3 text-sm">{info.notes}</div>}
        {downloading && <div role="status" aria-live="polite">
          <p>{progress === null ? Math.round((info?.downloaded_bytes ?? 0) / 1024 / 1024) + ' MB downloaded' : progress + '% downloaded'}</p>
          {progress !== null && <progress aria-label="Update download" className="mt-2 w-full" value={progress} max={100} />}
        </div>}
        <p className="text-xs leading-5 text-[var(--xx-muted)]">You choose when to download and install. Installation closes oats and is blocked while recording, dictation or speech processing is active.</p>
        {downloaded && <p className="text-xs leading-5 text-[var(--xx-muted)]">Save your notes first. If you quit before installing, download the update again next time.</p>}
        {pending && downloaded && <p role="status">Saving your work and checking that it is safe to install…</p>}
        {problem && <p role="alert" className="rounded-xl border border-[var(--xx-border)] bg-[var(--xx-canvas)] p-3">{problem}</p>}
      </div>
      <DialogFooter className="gap-2">
        <button type="button" className="xx-button-secondary text-sm" disabled={busy} onClick={() => onOpenChange(false)}>{info?.version ? 'Later' : 'Close'}</button>
        {downloaded && info.version
          ? <button type="button" className="xx-button-primary text-sm" disabled={busy} onClick={() => void run(() => updateService.install(info.version!))}>Install now</button>
          : info?.version && ['available', 'error'].includes(info.state)
            ? <button type="button" className="xx-button-primary text-sm" disabled={busy} onClick={() => void run(() => updateService.download(info.version!))}>Download update</button>
            : <button type="button" className="xx-button-primary text-sm" disabled={busy || info?.state === 'checking' || info?.state === 'unconfigured'} onClick={() => void run(onCheck)}>Check for updates</button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
