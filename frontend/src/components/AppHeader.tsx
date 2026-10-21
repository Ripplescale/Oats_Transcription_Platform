'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, AudioLines, Info, Pause, Settings } from 'lucide-react';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { About } from './About';
import { DisplayModeControl } from './DisplayModeControl';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/** The settings popover changes display mode without leaving the current editor. */
export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isRecording, isPaused } = useRecordingState();
  const showingRecording = pathname === '/' && searchParams.get('view') === 'recording';
  const [about, setAbout] = useState(false);
  const [settings, setSettings] = useState(false);
  const navigate = useCallback((href: string) => {
    if (window.dispatchEvent(new CustomEvent('xx-before-navigate', { cancelable: true, detail: { href } }))) router.push(href);
  }, [router]);
  useEffect(() => {
    const openSettings = () => navigate('/settings');
    Object.assign(window, { openSettings });
    return () => { delete (window as Window & { openSettings?: () => void }).openSettings; };
  }, [navigate]);

  return <><header className="xx-app-header" aria-label="App controls">
    {pathname !== '/' && <button type="button" className="xx-home-link" onClick={() => navigate('/')}><ArrowLeft size={16} aria-hidden="true" />Home</button>}
    <div className="xx-app-actions">
      <Popover open={settings} onOpenChange={setSettings}>
        <PopoverTrigger asChild><button type="button" className="xx-icon-button" aria-label="Settings" title="Settings"><Settings size={18} aria-hidden="true" /></button></PopoverTrigger>
        <PopoverContent align="end" className="xx-settings-menu">
          <p className="mb-3 text-sm font-medium">Display mode</p>
          <DisplayModeControl />
          <button type="button" className="xx-button-secondary mt-4 w-full" onClick={() => { setSettings(false); navigate('/settings'); }}>All settings</button>
        </PopoverContent>
      </Popover>
      <button type="button" className="xx-icon-button" aria-label="About oats" title="About oats" onClick={() => setAbout(true)}><Info size={18} aria-hidden="true" /></button>
    </div>
    <Dialog open={about} onOpenChange={setAbout}><DialogContent className="max-w-md"><DialogTitle className="sr-only">About oats</DialogTitle><DialogDescription className="sr-only">About this local notes and transcription app.</DialogDescription><About /></DialogContent></Dialog>
  </header>
    {isRecording && !showingRecording && <aside className="xx-active-recording" aria-label="Current recording">
      <span role="status">{isPaused ? <Pause size={16} aria-hidden="true" /> : <AudioLines size={16} aria-hidden="true" />}{isPaused ? 'Recording paused' : 'Recording in progress'}</span>
      <button type="button" onClick={() => navigate('/?view=recording')}>Return to recording<ArrowUpRight size={15} aria-hidden="true" /></button>
    </aside>}
  </>;
}
