'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { registerUpdateSaveGuard } from '@/lib/update-safety';

interface VaultEntry {
  id: string;
  kind: 'person' | 'organization' | 'place' | 'acronym' | 'term' | 'quantity';
  canonical: string;
  aliases: string[];
  source: string;
  verified: boolean;
  context: string;
  unit: string;
  valid_from: string;
  valid_to: string;
}
interface Vault { version: 1; id: string; name: string; revision: number; entries: VaultEntry[]; relationships: unknown[]; updated_at?: string }
const blank = (): VaultEntry => ({ id: crypto.randomUUID(), kind: 'term', canonical: '', aliases: [], source: '', verified: false, context: '', unit: '', valid_from: '', valid_to: '' });

export function ProjectVaultPanel({ selectedProject, onSelectProject, disabled }: { selectedProject: string | null; onSelectProject: (id: string | null) => void; disabled: boolean }) {
  const [opened, setOpened] = useState(false);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vault, setVault] = useState<Vault | null>(null);
  const [entry, setEntry] = useState<VaultEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (entry !== null || saving) return registerUpdateSaveGuard(async () => {
      throw new Error('Save or cancel your project reference before installing the update.');
    });
  }, [entry, saving]);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    invoke<Vault[]>('list_project_vaults').then(value => { if (!cancelled) setVaults(value); }).catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [opened]);
  useEffect(() => {
    setVault(null);
    setEntry(null);
    if (!opened || !selectedProject) return;
    let cancelled = false;
    invoke<Vault>('load_project_vault', { projectId: selectedProject }).then(value => { if (!cancelled) setVault(value); }).catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [opened, selectedProject]);
  const saveEntry = async () => {
    if (!vault || !entry || !entry.canonical.trim() || (entry.verified && !entry.source.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const result = await invoke<Vault>('save_project_vault', { projectId: vault.id, expectedRevision: vault.revision, name: vault.name, entries: [...vault.entries.filter(item => item.id !== entry.id), entry], relationships: vault.relationships });
      setVault(result);
      setEntry(null);
    } catch (reason) { setError(`Entry was not saved. ${String(reason)}`); }
    finally { setSaving(false); }
  };
  return <details className="rounded-xl border border-[var(--xx-border)] p-3" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary className="text-sm font-medium cursor-pointer">Project vault · optional</summary>
    <div className="space-y-3 mt-3 text-sm">
      <p className="text-xs leading-5 text-[var(--xx-muted)]">An optional reference shelf for checked names and facts. It suggests checks without replacing spoken numbers.</p>
      <label className="block">Project<select aria-label="Project vault" className="block w-full rounded border p-2 mt-1" disabled={disabled || saving} value={selectedProject ?? ''} onChange={event => onSelectProject(event.target.value || null)}><option value="">No project vault</option>{vaults.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {vault && <><p className="text-xs text-gray-500">{vault.entries.length} references · revision {vault.revision}</p><div className="space-y-2">{vault.entries.map(item => <button key={item.id} className="block w-full border rounded p-2 text-left" disabled={saving} onClick={() => setEntry({ ...item })}><strong>{item.canonical}</strong><span className="text-xs ml-2 text-gray-500">{item.verified ? 'Verified source' : 'Unverified'}</span></button>)}</div>{!entry && <Button size="sm" variant="outline" onClick={() => setEntry(blank())}>Add reference</Button>}</>}
      {entry && <fieldset data-separate-save disabled={saving} className="space-y-3 border border-[var(--xx-border)] rounded-lg p-3 text-xs"><legend className="text-xs px-1">Reference</legend>
        <label className="block">Name or value<input className="block w-full border rounded p-2" value={entry.canonical} onChange={event => setEntry({ ...entry, canonical: event.target.value })} /></label>
        <label className="block">Kind<select className="block w-full border rounded p-2" value={entry.kind} onChange={event => setEntry({ ...entry, kind: event.target.value as VaultEntry['kind'] })}>{['person', 'organization', 'place', 'acronym', 'term', 'quantity'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
        <label className="block">Aliases (comma separated)<input className="block w-full border rounded p-2" value={entry.aliases.join(', ')} onChange={event => setEntry({ ...entry, aliases: event.target.value.split(',').map(value => value.trim()) })} /></label>
        <label className="block">Source or document reference<input className="block w-full border rounded p-2" value={entry.source} onChange={event => setEntry({ ...entry, source: event.target.value })} /></label>
        <label className="block">Context<textarea className="block w-full border rounded p-2" value={entry.context} onChange={event => setEntry({ ...entry, context: event.target.value })} /></label>
        {entry.kind === 'quantity' && <label className="block">Unit<input className="block w-full border rounded p-2" value={entry.unit} onChange={event => setEntry({ ...entry, unit: event.target.value })} /></label>}
        <label className="flex gap-2 items-center"><input type="checkbox" checked={entry.verified} onChange={event => setEntry({ ...entry, verified: event.target.checked })} />I checked this against the source</label>
        <div className="flex gap-2"><Button size="sm" disabled={!entry.canonical.trim() || (entry.verified && !entry.source.trim())} onClick={() => void saveEntry()}>{saving ? 'Saving…' : 'Save reference'}</Button><Button size="sm" variant="outline" onClick={() => setEntry(null)}>Cancel</Button></div>
      </fieldset>}
    </div>
  </details>;
}
