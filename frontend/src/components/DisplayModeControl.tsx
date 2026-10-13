'use client';

import { useDisplayMode } from '@/contexts/DisplayModeContext';

export function DisplayModeControl({ className = '' }: { className?: string }) {
  const { mode, setMode } = useDisplayMode();
  return <div className={`xx-display-mode ${className}`} role="group" aria-label="Display mode">
    <button type="button" aria-pressed={mode === 'user'} onClick={() => setMode('user')} title="User mode: notes and transcript">User</button>
    <button type="button" aria-pressed={mode === 'dev'} onClick={() => setMode('dev')} title="Dev mode: include processing and source details">Dev</button>
  </div>;
}
