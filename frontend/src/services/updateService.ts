import { invoke } from '@tauri-apps/api/core';
import { prepareForUpdateInstall } from '@/lib/update-safety';

export type UpdateState = 'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
export interface UpdateInfo {
  state: UpdateState;
  current_version: string;
  configured?: boolean;
  version?: string | null;
  notes?: string | null;
  published_at?: string | null;
  downloaded_bytes: number;
  total_bytes?: number | null;
  error?: string | null;
  blocked_reason?: string | null;
}
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_KEY = 'oats.updates.last-successful-check';
const unavailable = (): UpdateInfo => ({ state: 'unconfigured', configured: false, current_version: '', downloaded_bytes: 0 });

/** Metadata checks never download, install, relaunch, or change speech settings. */
export class UpdateService {
  private current: UpdateInfo | null = null;
  private checking?: Promise<UpdateInfo>;
  private acting = false;
  private listeners = new Set<(snapshot: UpdateInfo) => void>();
  private lastCheckTime = 0;
  private lastOpenCheckTime = 0;
  constructor(private call: Invoke = invoke, private prepare = prepareForUpdateInstall, private now = Date.now) {}

  subscribe(listener: (snapshot: UpdateInfo) => void): () => void {
    this.listeners.add(listener);
    if (this.current) listener(this.current);
    return () => { this.listeners.delete(listener); };
  }
  accept(snapshot: UpdateInfo): UpdateInfo {
    if (!snapshot || typeof snapshot.state !== 'string') snapshot = unavailable();
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
  async getStatus(): Promise<UpdateInfo> {
    return this.accept(await this.call<UpdateInfo>('updates_status'));
  }
  wasCheckedRecently(): boolean {
    let checked = this.lastCheckTime;
    try { checked = Math.max(checked, Number(window.localStorage.getItem(CHECK_KEY)) || 0); } catch {}
    const elapsed = this.now() - checked;
    return checked > 0 && elapsed >= 0 && elapsed < CHECK_INTERVAL_MS;
  }
  /** Each new app process checks again; repeated focus events share a short
   * in-memory debounce rather than yesterday's persisted background throttle. */
  async checkOnOpen(): Promise<UpdateInfo> {
    const elapsed = this.now() - this.lastOpenCheckTime;
    if (this.lastOpenCheckTime > 0 && elapsed >= 0 && elapsed < 60_000) {
      return this.current ?? this.getStatus();
    }
    // Only a successful metadata check earns the focus debounce. In particular,
    // an offline launch must not suppress the following network-restored event.
    try {
      const result = await this.checkForUpdates(true);
      this.lastOpenCheckTime = ['idle', 'available'].includes(result.state) ? this.now() : 0;
      return result;
    } catch (error) {
      this.lastOpenCheckTime = 0;
      throw error;
    }
  }
  async checkForUpdates(force = false): Promise<UpdateInfo> {
    if (this.checking) return this.checking;
    if (this.acting || ['downloading', 'downloaded', 'installing'].includes(this.current?.state ?? '')) {
      return this.current ?? this.getStatus();
    }
    if (!force && this.wasCheckedRecently()) return this.current ?? this.getStatus();
    this.checking = this.call<UpdateInfo>('updates_check').then(snapshot => {
      if (!snapshot || typeof snapshot.state !== 'string') snapshot = unavailable();
      if (['idle', 'available'].includes(snapshot.state)) {
        this.lastCheckTime = this.now();
        try { window.localStorage.setItem(CHECK_KEY, String(this.lastCheckTime)); } catch {}
      }
      return this.accept(snapshot);
    }).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  async download(version: string): Promise<UpdateInfo> {
    if (this.acting) throw Error('An update action is already running.');
    this.acting = true;
    try { return this.accept(await this.call<UpdateInfo>('updates_download', { version })); }
    finally { this.acting = false; }
  }
  async install(version: string): Promise<void> {
    if (this.acting) throw Error('An update action is already running.');
    if (this.current?.state !== 'downloaded' || this.current.version !== version) {
      throw Error('Download this update before installing it.');
    }
    this.acting = true;
    try {
      await this.prepare();
      // Native code repeats busy checks under its recording-start lock.
      // The Windows installer can exit oats; no JS relaunch is used.
      const result = await this.call<UpdateInfo>('updates_install', { version });
      if (result) {
        this.accept(result);
        if (result.blocked_reason || result.error) throw Error(result.blocked_reason || result.error!);
      }
    } finally { this.acting = false; }
  }
}
export const updateService = new UpdateService();
