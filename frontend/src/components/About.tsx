import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Brand } from './Brand';
import { Headphones, HardDrive, Languages } from 'lucide-react';
import { useUpdateCheckContext } from './UpdateCheckProvider';

export function About() {
  const [version, setVersion] = useState('0.5.0');
  const { updateInfo, showUpdateDialog, checkForUpdates } = useUpdateCheckContext();
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return <div className="p-4 text-[var(--xx-ink)]">
    <Brand tagline />
    <p className="mt-7 text-sm leading-7 text-[var(--xx-muted)]">A little space to listen, keep your recordings, and turn Hindi–English conversations into words you can work with.</p>
    <div className="my-7 space-y-4 text-sm">
      <p className="flex items-center gap-3"><HardDrive size={17} className="text-[var(--xx-accent)]" />Recordings and transcription stay on this device.</p>
      <p className="flex items-center gap-3"><Languages size={17} className="text-[var(--xx-accent)]" />Trelis for mixed script. Apex for Roman Hinglish.</p>
      <p className="flex items-center gap-3"><Headphones size={17} className="text-[var(--xx-accent)]" />Listen, correct, and keep your own notes.</p>
    </div>
    <p className="border-t border-[var(--xx-border)] pt-4 text-xs leading-6 text-[var(--xx-muted)]">Version {version} · Local Windows workspace<br />You choose when to send an exported transcript to Claude.</p>
    <button type="button" className="xx-button-secondary mt-4 text-sm" onClick={() => { showUpdateDialog(); void checkForUpdates(true); }}>Check for updates</button>
    <p className="mt-2 text-xs leading-5 text-[var(--xx-muted)]">{updateInfo?.state === 'unconfigured' ? 'In-app updates are not configured in this build.' : 'oats notifies you first. Download and install only when you choose.'}</p>
  </div>;
}
