/** Coordinates durable native jobs; capture and model inference stay outside this class. */
import type { TranscriptSegmentMetadata, TranscriptArchivedSegment } from './transcript-workspace';
export type WorkflowRole = 'live-draft' | 'final' | 'live-final' | 'fallback';
export type TrelisProfileId = 'trelis-5' | 'trelis-10' | 'trelis-20';
export type LocalProfileId = TrelisProfileId | 'apex-20';
export interface LocalProfile { id: string; model: string; chunk_seconds: number; available: boolean; reason?: string; live_qualified: boolean; recommended_timing?: LocalPreferences['timing'] }
export interface LocalSegment extends TranscriptSegmentMetadata { id: string; text: string; source_track: string; start_seconds?: number; end_seconds?: number; recognition_original?: { text?: string } }
export interface LocalJob { job_id: string; session_dir: string; profile: string; final_profile?: TrelisProfileId; state: string; phase?: string; workflow_role?: WorkflowRole; capture_session_id?: string; language_mode?: 'hinglish' | 'english'; processed_audio_seconds?: number; available_audio_seconds?: number; backlog_seconds?: number; segments?: LocalSegment[]; segments_revision?: number; superseded_segments?: TranscriptArchivedSegment[]; error?: string }
export interface LocalPreferences { profile: LocalProfileId; languageMode: 'hinglish' | 'english'; timing: 'after-recording' | 'during-recording' }
export interface SpeakerJob { job_id: string; state: string; error?: string; result?: unknown }
export interface SpeakerSetup { available: boolean; enabled?: boolean; reason?: string }
export interface CaptureSession { session_id: string; session_dir: string }
export interface WorkflowRun {
  capture: CaptureSession; meetingId?: string; transcriptMeetingId?: string; preferences: LocalPreferences;
  recording: boolean; job?: LocalJob; error?: string; importedCount?: number; importedState?: string; importedRevision?: number;
  primary: boolean; role?: WorkflowRole; speakerJob?: SpeakerJob; speakerError?: string; needsRecovery?: boolean;
  draftSkipped?: boolean; stopRequested?: boolean; stopAttempted?: boolean; stopError?: string;
  pausedByUser?: boolean; resumeRequested?: boolean; captureEnded?: boolean; stopNotified?: boolean;
  fallbackRequested?: boolean;
  finalProfile?: TrelisProfileId;
}
export interface WorkflowState { preferences: LocalPreferences; runs: WorkflowRun[]; currentSession?: string; speakerSetup?: SpeakerSetup }
export const DEFAULT_LOCAL_PREFERENCES: LocalPreferences = { profile: 'trelis-10', languageMode: 'hinglish', timing: 'during-recording' };
export const isTrelisProfile = (profile: unknown): profile is TrelisProfileId => ['trelis-5', 'trelis-10', 'trelis-20'].includes(String(profile));
export const trelisProfile = (profile: unknown): TrelisProfileId => isTrelisProfile(profile) ? profile : 'trelis-10';
export const profileChunkSeconds = (profile: LocalProfileId): number => Number(profile.split('-')[1]);
export const profileLabel = (profile: unknown): string | null => profile === 'apex-20' ? 'Apex · 20s' : isTrelisProfile(profile) ? `Trelis · ${profileChunkSeconds(profile)}s` : null;
export const isTerminalJob = (state: string) => ['complete', 'failed', 'stopped'].includes(state);
export const pathKey = (value: string) => value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
/** Global settings describe new recordings. Existing run settings are never migrated. */
export function readPreferences(value: unknown): LocalPreferences {
  const source = value && typeof value === 'object' ? value as Partial<LocalPreferences> : {};
  return { ...DEFAULT_LOCAL_PREFERENCES, profile: trelisProfile(source.profile), languageMode: source.languageMode === 'english' ? 'english' : 'hinglish' };
}
function jobPreferences(job: LocalJob, languageMode: LocalPreferences['languageMode']): LocalPreferences {
  return { profile: isTrelisProfile(job.profile) ? job.profile : 'apex-20', languageMode: job.language_mode ?? languageMode,
    timing: ['live-draft', 'live-final', 'fallback'].includes(job.workflow_role ?? '') ? 'during-recording' : 'after-recording' };
}
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Dependencies { invoke: Invoke; changed: (state: WorkflowState) => void; imported: (meetingId: string) => void; stopped: (meetingId?: string, error?: string) => void }

export class LocalWorkflow {
  state: WorkflowState;
  private locks = new Map<string, Promise<void>>();
  private ticking = false;
  // Serialize launch commands; running transcription and speaker processes have separate slots.
  private startInFlight = false;
  private startingRun?: WorkflowRun;
  private notifiedStopped = new Set<string>();
  private deleting = false;
  private tickCompletion = Promise.resolve();
  private finishTick?: () => void;
  private profileTiming = new Map<string, LocalPreferences['timing']>();
  private profilesConfigured = false;
  private profileProbe?: Promise<void>;
  constructor(private dependencies: Dependencies, previous?: Partial<WorkflowState>) {
    this.state = { preferences: readPreferences(previous?.preferences), runs: Array.isArray(previous?.runs) ? previous.runs : [], currentSession: previous?.currentSession };
  }
  private changed() { this.state = { ...this.state, runs: [...this.state.runs] }; this.dependencies.changed(this.state); }
  setPreferences(preferences: LocalPreferences) { this.state.preferences = readPreferences(preferences); this.changed(); }
  configureProfiles(profiles: LocalProfile[]) {
    this.profileTiming = new Map(profiles.filter(profile => ['during-recording','after-recording'].includes(profile.recommended_timing ?? ''))
      .map(profile => [profile.id, profile.recommended_timing!] as const));
    this.profilesConfigured = true;
  }
  prepareProfiles(): Promise<void> {
    if (this.profilesConfigured) return Promise.resolve();
    this.profileProbe ??= this.dependencies.invoke<LocalProfile[]>('get_local_stt_profiles')
      .then(profiles => this.configureProfiles(profiles))
      .catch(() => {
        // A readiness read failure must not guess live GPU support and leave
        // a fresh CPU recording with a permanent startup error. Record first.
        for (const profile of ['trelis-5','trelis-10','trelis-20']) this.profileTiming.set(profile,'after-recording');
        this.profilesConfigured = true;
      });
    return this.profileProbe;
  }
  private async serialize(key: string, operation: () => Promise<void>) {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    this.locks.set(key, pending);
    try { await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }
  private sameCapture(run: WorkflowRun, capture: CaptureSession) {
    return run.capture.session_id === capture.session_id || (!!run.role && pathKey(run.capture.session_dir) === pathKey(capture.session_dir));
  }
  private legacy(capture: CaptureSession) {
    if (this.state.runs.some(run => run.role && this.sameCapture(run, capture))) return undefined;
    return this.state.runs.find(run => !run.role && run.capture.session_id === capture.session_id);
  }
  private hasLegacyPair(capture: CaptureSession) {
    return this.state.runs.some(run => ['live-draft', 'final'].includes(run.role ?? '') && this.sameCapture(run, capture));
  }
  private liveRun(capture: CaptureSession, recording: boolean) {
    let run = this.state.runs.find(item => item.role === 'live-final' && this.sameCapture(item, capture));
    if (!run) {
      const fallback = this.state.runs.find(item => item.role === 'fallback' && this.sameCapture(item, capture));
      run = { capture, role: 'live-final', primary: true, recording, captureEnded: !recording,
        // Old fallback jobs predate selectable chunk lengths and used Trelis20.
        preferences: { profile: trelisProfile(fallback ? fallback.finalProfile ?? fallback.job?.final_profile ?? 'trelis-20' : this.state.preferences.profile), timing: fallback ? fallback.preferences.timing : this.profileTiming.get(this.state.preferences.profile) ?? 'during-recording', languageMode: fallback?.preferences.languageMode ?? this.state.preferences.languageMode },
        meetingId: fallback?.meetingId, pausedByUser: !!fallback, fallbackRequested: !!fallback };
      this.state.runs.push(run);
    }
    return run;
  }
  private pair(capture: CaptureSession, recording: boolean): [WorkflowRun, WorkflowRun] {
    const existing = this.state.runs.filter(run => run.role && this.sameCapture(run, capture));
    const languageMode = existing[0]?.preferences.languageMode ?? this.state.preferences.languageMode;
    const finalProfile = trelisProfile(existing.find(run => isTrelisProfile(run.preferences.profile))?.preferences.profile ?? existing[0]?.finalProfile ?? this.state.preferences.profile);
    const ended = existing.some(run => run.captureEnded) || !recording;
    let draft = existing.find(run => run.role === 'live-draft');
    let final = existing.find(run => run.role === 'final');
    if (!draft) {
      draft = { capture, role: 'live-draft', primary: false, recording: !ended,
        preferences: { profile: 'apex-20', timing: 'during-recording', languageMode }, finalProfile, captureEnded: ended };
      this.state.runs.push(draft);
    }
    if (!final) {
      final = { capture, role: 'final', primary: true, recording: !ended,
        preferences: { profile: finalProfile, timing: 'after-recording', languageMode }, captureEnded: ended };
      this.state.runs.push(final);
    }
    const meetingId = final.meetingId ?? draft.meetingId;
    if (meetingId) { draft.meetingId = meetingId; final.meetingId = meetingId; }
    return [draft, final];
  }
  private async ensurePairMeeting(draft: WorkflowRun, final: WorkflowRun) {
    await this.ensureMeeting(draft);
    if (draft.meetingId) {
      final.meetingId = draft.meetingId;
      if (final.error?.startsWith('Audio is saved, but its meeting could not be linked.')) final.error = final.stopError;
      this.changed();
    }
  }
  async captureStarted(capture: CaptureSession) {
    await this.prepareProfiles();
    await this.serialize(capture.session_id, async () => {
      const legacy = this.legacy(capture);
      if (legacy) {
        legacy.recording = true; this.state.currentSession = capture.session_id; this.changed();
        await this.ensureMeeting(legacy);
        return;
      }
      if (!this.hasLegacyPair(capture)) {
        const run = this.liveRun(capture, true);
        this.state.currentSession = capture.session_id;
        for (const item of this.state.runs.filter(item => item.role && this.sameCapture(item, capture))) {
          if (!item.captureEnded) item.recording = true;
        }
        this.changed();
        await this.ensureMeeting(run);
        return;
      }
      const [draft, final] = this.pair(capture, true);
      this.state.currentSession = capture.session_id;
      // A delayed duplicate start event cannot reopen an already ended capture.
      if (!draft.captureEnded && !final.captureEnded) { draft.recording = true; final.recording = true; }
      this.changed();
      await this.ensurePairMeeting(draft, final);
    });
    await this.tick();
  }
  async captureStopped(capture: CaptureSession) {
    await this.prepareProfiles();
    await this.serialize(capture.session_id, async () => {
      const legacy = this.legacy(capture);
      if (legacy) {
        if (legacy.needsRecovery) legacy.error = legacy.stopError;
        legacy.recording = false; legacy.needsRecovery = false; this.state.currentSession = capture.session_id;
        await this.ensureMeeting(legacy);
        this.notifyStopped(legacy, legacy.transcriptMeetingId ?? legacy.meetingId);
        this.changed();
        return;
      }
      if (!this.hasLegacyPair(capture)) {
        const run = this.liveRun(capture, false);
        for (const item of this.state.runs.filter(item => item.role && this.sameCapture(item, capture))) {
          if (item.needsRecovery) item.error = item.stopError;
          item.recording = false; item.captureEnded = true; item.needsRecovery = false;
        }
        this.state.currentSession = capture.session_id;
        await this.ensureMeeting(run);
        this.notifyStopped(run, run.meetingId);
        this.changed();
        // The same worker drains the durable recording; stopping capture never starts another pass.
        return;
      }
      const [draft, final] = this.pair(capture, false);
      for (const run of [draft, final]) {
        if (run.needsRecovery) run.error = run.stopError;
        run.recording = false; run.captureEnded = true; run.needsRecovery = false;
      }
      draft.resumeRequested = false;
      if (!draft.job && this.startingRun !== draft) draft.draftSkipped = true;
      this.state.currentSession = capture.session_id;
      this.changed();
      await this.ensurePairMeeting(draft, final);
      this.notifyStopped(final, final.meetingId);
      if (draft.job && !isTerminalJob(draft.job.state)) await this.requestStop(draft);
    });
    await this.tick();
  }
  async captureInterrupted(capture: CaptureSession, error: string) {
    await this.serialize(capture.session_id, async () => {
      if (!this.state.runs.some(run => this.sameCapture(run, capture))) this.liveRun(capture, false);
      for (const run of this.state.runs.filter(run => this.sameCapture(run, capture))) {
        run.recording = false; run.captureEnded = true; run.needsRecovery = true;
        run.resumeRequested = false;
        run.error = `The recording was interrupted. Recover its saved audio before resuming transcription. ${error}`;
        if (run.job && !isTerminalJob(run.job.state)) await this.requestStop(run);
      }
      if (this.state.currentSession === capture.session_id) this.state.currentSession = undefined;
      this.changed();
    });
  }
  private notifyStopped(run: WorkflowRun, meetingId?: string) {
    const id = run.capture.session_id;
    if (!run.stopNotified && !this.notifiedStopped.has(id)) {
      run.stopNotified = true; this.notifiedStopped.add(id); this.changed();
      this.dependencies.stopped(meetingId, run.error);
    }
  }
  private async ensureMeeting(run: WorkflowRun) {
    if (run.meetingId) return;
    try {
      const result = await this.dependencies.invoke<{ meeting_id: string }>('ensure_capture_meeting', { sessionDir: run.capture.session_dir });
      run.meetingId = result.meeting_id; run.error = run.stopError; this.changed();
    } catch (error) { run.error = `Audio is saved, but its meeting could not be linked. ${String(error)}`; this.changed(); }
  }
  private activeTranscription() {
    return this.state.runs.some(run => run.job && !isTerminalJob(run.job.state));
  }
  private activeSpeaker() {
    return this.state.runs.some(run => run.speakerJob && !isTerminalJob(run.speakerJob.state));
  }
  private draftSettled(run: WorkflowRun) {
    const draft = this.state.runs.find(item => item.role === 'live-draft' && this.sameCapture(item, run.capture));
    if (!draft) return true; // A durably adopted Final does not invent a missing Draft.
    if (this.startingRun === draft) return false;
    if (!draft.job) return !!draft.draftSkipped;
    return isTerminalJob(draft.job.state) && Array.isArray(draft.job.segments)
      && draft.importedCount === draft.job.segments.length && draft.importedState === draft.job.state
      && draft.importedRevision === draft.job.segments_revision;
  }
  private checkpointSettled(run?: WorkflowRun) {
    if (!run) return true;
    if (this.startingRun === run) return false;
    if (!run.job) return true;
    return isTerminalJob(run.job.state) && Array.isArray(run.job.segments)
      && run.importedCount === run.job.segments.length && run.importedState === run.job.state
      && run.importedRevision === run.job.segments_revision;
  }
  private speakerSourceReady(run: WorkflowRun) {
    return run.role !== 'live-draft' && !run.recording && !run.pausedByUser && !run.needsRecovery
      && run.job?.state === 'complete' && !!run.transcriptMeetingId && this.checkpointSettled(run);
  }
  private eligible(run: WorkflowRun) {
    if (run.pausedByUser || run.needsRecovery || run.error || !run.meetingId) return false;
    if (run.role === 'live-final' && run.recording && run.preferences.timing === 'after-recording') return false;
    if (run.role === 'live-draft' && (!run.recording || run.captureEnded || run.draftSkipped)) return false;
    if (run.role === 'final' && (run.recording || !run.captureEnded || !this.draftSettled(run))) return false;
    if (run.role === 'fallback' && !this.checkpointSettled(this.state.runs.find(item => item.role === 'live-final' && this.sameCapture(item, run.capture)))) return false;
    if (run.role === 'live-final' && run.fallbackRequested) return false;
    if (!run.role && run.recording && run.preferences.timing !== 'during-recording') return false;
    return !run.job || (!!run.resumeRequested && ['failed', 'stopped'].includes(run.job.state));
  }
  private async start(run: WorkflowRun) {
    if (run.job || this.startInFlight || this.activeTranscription() || !this.eligible(run)) return;
    this.startInFlight = true; this.startingRun = run;
    try {
      const args: Record<string, unknown> = { sessionDir: run.capture.session_dir, profile: run.preferences.profile, languageMode: run.preferences.languageMode, projectId: null };
      if (run.role) args.workflowRole = run.role;
      if (run.finalProfile) args.finalProfile = run.finalProfile;
      const job = await this.dependencies.invoke<LocalJob>('start_local_transcription', args);
      run.job = { ...job, session_dir: run.capture.session_dir, profile: run.preferences.profile, ...(run.role ? { workflow_role: run.role } : {}) };
      run.error = undefined;
    } catch (error) {
      run.error = `Transcription did not start. Audio remains saved. ${String(error)}`;
      if (run.role === 'live-draft' && !run.recording) run.draftSkipped = true;
    } finally { this.startInFlight = false; this.startingRun = undefined; this.changed(); }
  }
  private async resume(run: WorkflowRun) {
    if (!run.job || this.startInFlight || this.activeTranscription() || !this.eligible(run)) return;
    this.startInFlight = true; run.resumeRequested = false;
    try {
      const next = await this.dependencies.invoke<Partial<LocalJob>>('resume_local_transcription', { jobId: run.job.job_id });
      run.job = { ...run.job, ...next }; run.stopRequested = false; run.stopAttempted = false; run.stopError = undefined;
    } catch (error) { run.error = String(error); }
    finally { this.startInFlight = false; this.changed(); }
  }
  private async requestStop(run: WorkflowRun) {
    if (!run.job || isTerminalJob(run.job.state) || run.stopAttempted) return;
    run.stopAttempted = true;
    try {
      await this.dependencies.invoke('stop_local_transcription', { jobId: run.job.job_id });
      run.stopRequested = true; run.stopError = undefined;
    } catch (error) { run.stopError = `Could not request the worker to stop. Audio remains saved; retry the handoff. ${String(error)}`; run.error = run.stopError; }
    this.changed();
  }
  async retry(run: WorkflowRun) {
    if (run.role === 'live-final') {
      const fallback = this.state.runs.find(item => item.role === 'fallback' && this.sameCapture(item, run.capture));
      if (!this.checkpointSettled(fallback) || (fallback && !fallback.job && !fallback.pausedByUser && !fallback.error)) {
        throw new Error('Pause Apex and wait for its saved checkpoint before retrying Trelis.');
      }
      if (fallback) { fallback.pausedByUser = true; fallback.resumeRequested = false; }
      run.fallbackRequested = false;
    }
    run.pausedByUser = false; run.error = undefined; run.stopError = undefined; run.stopAttempted = false;
    await this.ensureMeeting(run);
    if (run.role === 'live-draft' && !run.recording) {
      // Post-call retry repairs import/handoff, never restarts an obsolete preview.
      run.resumeRequested = false;
      if (!run.job) run.draftSkipped = true;
      else if (!isTerminalJob(run.job.state)) await this.requestStop(run);
      run.importedState = undefined;
    } else if (run.job && ['failed', 'stopped'].includes(run.job.state)) {
      run.resumeRequested = true;
    } else if (run.job && run.stopRequested && !isTerminalJob(run.job.state)) {
      run.resumeRequested = true; // An explicit retry may wait for an acknowledged pause to finish.
    } else if (run.job) run.importedState = undefined;
    this.changed();
    await this.tick();
  }
  async stopWorker(run: WorkflowRun) {
    run.pausedByUser = true; run.resumeRequested = false;
    await this.requestStop(run);
    this.changed();
    await this.tick();
  }
  async useApexFallback(run: WorkflowRun) {
    if (run.role !== 'live-final') throw new Error('Apex fallback is available for a Trelis live transcript.');
    if (run.needsRecovery) throw new Error('Recover the saved recording before switching transcription.');
    await this.serialize(run.capture.session_id, async () => {
      run.pausedByUser = true; run.resumeRequested = false; run.fallbackRequested = true;
      // This explicit action may retry a failed stop request, but polling never floods it.
      if (run.stopError) { run.stopAttempted = false; run.stopError = undefined; run.error = undefined; }
      let fallback = this.state.runs.find(item => item.role === 'fallback' && this.sameCapture(item, run.capture));
      if (!fallback) {
        fallback = { capture: run.capture, meetingId: run.meetingId, role: 'fallback', primary: false,
          recording: run.recording, captureEnded: run.captureEnded,
          preferences: { profile: 'apex-20', timing: 'during-recording', languageMode: run.preferences.languageMode }, finalProfile: trelisProfile(run.preferences.profile) };
        this.state.runs.push(fallback);
      } else {
        fallback.pausedByUser = false; fallback.error = undefined;
        if (fallback.job && ['failed', 'stopped'].includes(fallback.job.state)) fallback.resumeRequested = true;
      }
      this.changed();
      await this.requestStop(run);
    });
    await this.tick();
  }
  async adopt(job: LocalJob, meetingId: string, primary = false) {
    let run = this.state.runs.find(item => item.job?.job_id === job.job_id);
    if (!run && job.workflow_role) run = this.state.runs.find(item => item.role === job.workflow_role && pathKey(item.capture.session_dir) === pathKey(job.session_dir) && !item.job);
    if (!run) {
      run = { capture: { session_id: job.capture_session_id ?? `job-${job.job_id}`, session_dir: job.session_dir }, meetingId,
        recording: false, captureEnded: !!job.workflow_role, primary: ['final', 'live-final'].includes(job.workflow_role ?? '') ? true : job.workflow_role === 'fallback' ? false : primary,
        role: job.workflow_role, preferences: jobPreferences(job, this.state.preferences.languageMode), finalProfile: job.final_profile, job };
      this.state.runs.push(run);
    } else if (!run.job) run.job = job;
    this.changed();
    await this.tick();
  }
  private async restoreNativeJobs(capture: CaptureSession) {
    // Missing browser pointers are not permission to replace a durable legacy
    // job or resume a paused/failed process. Discover identities first.
    const jobs = await this.dependencies.invoke<LocalJob[]>('list_local_transcription_jobs', { sessionDir: capture.session_dir });
    const matching = jobs.filter(job => pathKey(job.session_dir) === pathKey(capture.session_dir));
    if (!matching.length) return;
    const base = await this.dependencies.invoke<{ meeting_id: string }>('ensure_capture_meeting', { sessionDir: capture.session_dir });
    const hasRoles = matching.some(job => !!job.workflow_role);
    let legacyPrimary = false;
    for (const job of matching) {
      if (this.state.runs.some(run => run.job?.job_id === job.job_id)) continue;
      const role = job.workflow_role;
      const primary = role === 'final' || role === 'live-final' || (!hasRoles && !legacyPrimary);
      if (!role && primary) legacyPrimary = true;
      this.state.runs.push({ capture, meetingId: base.meeting_id, role, primary,
        recording: !!role || primary, captureEnded: role ? false : undefined,
        preferences: jobPreferences(job, this.state.preferences.languageMode), finalProfile: job.final_profile, job });
    }
    if (matching.some(job => job.workflow_role === 'fallback')) {
      const live = this.state.runs.find(run => run.role === 'live-final' && this.sameCapture(run, capture));
      const fallbackActive = matching.some(job => job.workflow_role === 'fallback' && !isTerminalJob(job.state));
      // A running primary with a terminal fallback means the user already retried
      // Trelis. Native process state wins over the mere existence of an old fallback.
      if (live && (fallbackActive || !live.job || isTerminalJob(live.job.state))) {
        live.pausedByUser = true; live.fallbackRequested = true; live.resumeRequested = false;
      }
    }
    this.changed();
  }
  async refreshAfterReload(active: CaptureSession | null) {
    if (active && !this.state.runs.some(run => this.sameCapture(run, active))) await this.restoreNativeJobs(active);
    for (const run of this.state.runs) {
      if (run.recording && (!active || !this.sameCapture(run, active))) {
        run.needsRecovery = true;
        run.error = 'The recording was interrupted. Recover its saved audio before resuming transcription.';
      }
      run.recording = !!active && this.sameCapture(run, active) && !run.captureEnded;
    }
    if (active) await this.captureStarted(active);
    this.changed();
    await this.tick();
  }
  async checkSpeakerSetup() {
    try { const result = await this.dependencies.invoke<SpeakerSetup>('get_speaker_setup_status'); this.state.speakerSetup = result && typeof result.available === 'boolean' ? result : { available: false, reason: 'Speaker setup is not configured.' }; }
    catch (error) { this.state.speakerSetup = { available: false, reason: String(error) }; }
    this.changed();
  }
  async retrySpeakers(run: WorkflowRun) {
    if (!this.speakerSourceReady(run) || this.startInFlight || this.activeSpeaker()) return;
    this.startInFlight = true; run.speakerError = undefined;
    try {
      if (run.speakerJob) run.speakerJob = await this.dependencies.invoke<SpeakerJob>('retry_speaker_identification', { jobId: run.speakerJob.job_id });
      else if (run.job && run.transcriptMeetingId) run.speakerJob = await this.dependencies.invoke<SpeakerJob>('start_speaker_identification', { transcriptionJobId: run.job.job_id, meetingId: run.transcriptMeetingId });
    } catch (error) { run.speakerError = String(error); }
    finally { this.startInFlight = false; this.changed(); }
  }
  /** Quiesce imports/launches before the native stop + database transaction. */
  async deleteMeeting(meetingId: string) {
    if (this.deleting) throw new Error('A conversation is already being removed.');
    this.deleting = true;
    try {
      // A poll may already be importing or awaiting a launch. Let that bounded
      // command finish before the native deletion lease takes ownership.
      await this.tickCompletion;
      await Promise.all([...this.locks.values()]);
      const affected = this.state.runs.filter(run => run.meetingId === meetingId || run.transcriptMeetingId === meetingId);
      if (affected.some(run => run.recording)) throw new Error('Finish recording before removing this conversation.');
      const sessions = new Set(affected.map(run => pathKey(run.capture.session_dir)));
      const removed = this.state.runs.filter(run => affected.includes(run) || sessions.has(pathKey(run.capture.session_dir)));
      for (const run of removed) { run.pausedByUser = true; run.resumeRequested = false; }
      this.changed();
      // Native code stops only the matching owned workers, waits for their
      // checkpoint locks, and guards new launches through database deletion.
      await this.dependencies.invoke('api_delete_meeting', { meetingId });
      this.state.runs = this.state.runs.filter(run => !removed.includes(run));
      if (removed.some(run => run.capture.session_id === this.state.currentSession)) this.state.currentSession = undefined;
      this.changed();
    } finally {
      this.deleting = false;
    }
  }
  /** Remove only explicitly selected recovery audio; notes/transcripts survive. */
  async deleteRecoveredAudio(capture: CaptureSession) {
    if (this.deleting) throw new Error('A conversation or recovery recording is already being removed.');
    this.deleting = true;
    try {
      await this.tickCompletion;
      await this.serialize(capture.session_id, async () => {
        const removed = this.state.runs.filter(run => this.sameCapture(run, capture));
        if (removed.some(run => run.recording)) throw new Error('Finish recording before deleting its audio.');
        for (const run of removed) { run.pausedByUser = true; run.resumeRequested = false; }
        this.changed();
        await this.dependencies.invoke('delete_recoverable_capture', { sessionDir: capture.session_dir });
        this.state.runs = this.state.runs.filter(run => !removed.includes(run));
        if (this.state.currentSession === capture.session_id) this.state.currentSession = undefined;
        this.changed();
      });
    } finally { this.deleting = false; }
  }
  async tick() {
    if (this.ticking || this.deleting) return;
    this.ticking = true;
    this.tickCompletion = new Promise(resolve => { this.finishTick = resolve; });
    try {
      for (const run of this.state.runs) {
        if (!run.meetingId) {
          const paired = run.role && this.state.runs.find(item => item !== run && item.role && this.sameCapture(item, run.capture) && item.meetingId);
          if (paired) run.meetingId = paired.meetingId;
          else await this.ensureMeeting(run);
        }
        if (run.job) {
          try {
            if (!run.job.segments || !isTerminalJob(run.job.state)) {
              const next = await this.dependencies.invoke<LocalJob>('get_local_transcription_status', { jobId: run.job.job_id });
              run.job = { ...run.job, ...next };
            }
            if (isTerminalJob(run.job.state)) run.stopError = undefined;
            const count = run.job.segments?.length ?? 0;
            // A recovered range can replace text without changing the segment count.
            if (run.meetingId && run.job.segments && (count !== (run.importedCount ?? -1) || run.job.state !== run.importedState || run.job.segments_revision !== run.importedRevision)) {
              const result = await this.dependencies.invoke<{ meeting_id: string }>('import_local_transcription', { jobId: run.job.job_id, meetingId: run.meetingId, primary: run.primary });
              run.transcriptMeetingId = result.meeting_id; run.importedCount = count; run.importedState = run.job.state; run.importedRevision = run.job.segments_revision;
              run.error = run.needsRecovery ? 'The recording was interrupted. Recover its saved audio before resuming transcription.' : run.stopError;
              this.dependencies.imported(result.meeting_id);
            }
          } catch (error) { run.error = `Saved audio and completed chunks are retained. ${String(error)}`; }
        }
        if (run.role === 'live-draft' && !run.recording && run.captureEnded) {
          run.resumeRequested = false;
          if (!run.job && this.startingRun !== run) run.draftSkipped = true;
          else if (run.job && !isTerminalJob(run.job.state)) await this.requestStop(run);
        }
        if (run.pausedByUser && run.job && !isTerminalJob(run.job.state)) await this.requestStop(run);
        if (run.speakerJob && !isTerminalJob(run.speakerJob.state)) {
          try {
            run.speakerJob = await this.dependencies.invoke<SpeakerJob>('get_speaker_job_status', { jobId: run.speakerJob.job_id });
            if (run.speakerJob.state === 'complete' && run.transcriptMeetingId) this.dependencies.imported(run.transcriptMeetingId);
          } catch (error) { run.speakerError = String(error); }
        }
      }
      const priority = (run: WorkflowRun) => run.role === 'fallback' ? 0 : run.role === 'live-final' ? 1 : run.role === 'final' ? 2 : run.role === 'live-draft' ? 4 : 3;
      const queued = this.state.runs.filter(run => this.eligible(run)).sort((a, b) => priority(a) - priority(b))[0];
      if (queued) { if (queued.job) await this.resume(queued); else await this.start(queued); }
      if (!this.activeSpeaker()) {
        if (!this.state.speakerSetup) await this.checkSpeakerSetup();
        if (this.state.speakerSetup?.available && this.state.speakerSetup.enabled !== false) {
          const next = this.state.runs.find(run => this.speakerSourceReady(run) && !run.speakerJob && !run.speakerError && !run.error);
          if (next) await this.retrySpeakers(next);
        }
      }
      this.changed();
    } finally { this.ticking = false; this.finishTick?.(); this.finishTick = undefined; }
  }
}
