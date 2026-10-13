/* Synthetic saved-meeting state. No native process, recorder, clipboard, or cloud. */
async function installFixture(page) {
  const wav = Buffer.alloc(44 + 16000 * 2 * 240);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/qa-audio.wav', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
  await page.addInitScript(() => {
    window.qaBoot = Math.random();
    const calls = []; window.qaCalls = calls;
    const meetings = [
      { id: 'qa-meeting', title: 'Project Willow · Friday catch-up', created_at: '2026-10-07T09:30:00Z', updated_at: '2026-10-07T09:30:00Z', folder_path: 'C:/STTApp/recordings/qa-session' },
      { id: 'qa-planning', title: 'Planning for next month', created_at: '2026-10-06T12:00:00Z', updated_at: '2026-10-06T12:00:00Z' },
      { id: 'qa-design', title: 'Product catch-up', created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' },
      { id: 'qa-draft', title: 'Project Willow · Live draft', created_at: '2026-10-07T09:30:00Z', updated_at: '2026-10-07T09:30:00Z', folder_path: 'C:/STTApp/recordings/qa-session' },
    ];
    const segments = [
      { id: 'first', text: 'Welcome back, everyone. आज Project Willow की workshop plan करते हैं. Maya, would you like to walk us through the new sketchbook idea?', timestamp: '15:00', audio_start_time: 0, audio_end_time: 20, source_track: 'system' },
      { id: 'second', text: 'Sure. We could start with a short drawing exercise, then give everyone time to share. कोई perfect drawing नहीं चाहिए — just something that starts a conversation.', timestamp: '15:01', audio_start_time: 20, audio_end_time: 40, source_track: 'microphone' },
      { id: 'third', text: 'For the practice run, let us prepare 24 sketchbooks and 36 pencils. Arjun, can you check the room booking for half past three?', timestamp: '15:02', audio_start_time: 40, audio_end_time: 60, source_track: 'system' },
      { id: 'fourth', text: 'हाँ, मैं booking confirm कर दूँगा. The courtyard could work if the weather is nice; otherwise we have the small studio as a backup.', timestamp: '15:03', audio_start_time: 60, audio_end_time: 80, source_track: 'microphone' },
      { id: 'fifth', text: 'Lovely. I will put together the invitation and leave space for people to bring their own ideas. अगले Friday तक draft ready हो जाएगा.', timestamp: '15:04', audio_start_time: 80, audio_end_time: 100, source_track: 'system' },
    ];
    let workspace = { version: 1, meeting_id: 'qa-meeting', revision: 3, notes: 'A small workshop, a little room to play.\n\nThe idea\nStart with a short drawing exercise, then share what we made. Keep it relaxed.\n\nFor next Friday\n• Maya — draft the invitation.\n• Arjun — confirm the studio booking.\n• Bring 24 sketchbooks and 36 pencils.\n\nOpen question\nCould we move into the courtyard if the weather is good?', corrections: [], project_id: 'willow', profile: 'trelis-20', source_job_id: 'qa-job', source_meeting_id: 'qa-meeting',
      segment_metadata: { third: { source_track: 'system', timestamp_kind: 'audio_window', quality_flags: ['low_text_density'], alternative: { text: 'A shorter-window comparison is available for review.', requires_review: true } } },
      speaker_names: { 'speaker-0001': 'Maya', 'speaker-0002': 'Arjun' }, speaker_metadata: {
        speakers: [{ id: 'speaker-0001', active: true }, { id: 'speaker-0002', active: true }],
        turns: [{ id: 'turn1', start_seconds: 0, end_seconds: 18, speaker_id: 'speaker-0001' }, { id: 'turn2', start_seconds: 20, end_seconds: 39, speaker_id: 'speaker-0002' }],
        segment_assignments: { first: { speaker_candidates: ['speaker-0001'], turn_ids: ['turn1'], has_overlap: false, speaker_id: null }, second: { speaker_candidates: ['speaker-0002'], turn_ids: ['turn2'], has_overlap: false, speaker_id: null }, third: { speaker_candidates: ['speaker-0001', 'speaker-0002'], turn_ids: [], has_overlap: true, speaker_id: null } },
        reconciliation: { requires_review: false, word_alignment_available: false },
      } };
    workspace.workflow_role = 'final';
    let draftWorkspace = { ...structuredClone(workspace), meeting_id: 'qa-draft', profile: 'apex-20', workflow_role: 'live-draft', source_job_id: 'qa-draft-job', revision: 0, notes: 'A separate draft note, kept with this version.', segment_metadata: {}, speaker_metadata: null, speaker_names: {} };
    const draftSegments = [{ id: 'draft-first', text: 'Welcome back, everyone. Aaj Project Willow ki workshop plan karte hain. Maya, would you like to walk us through the new sketchbook idea?', timestamp: '15:00', audio_start_time: 0, audio_end_time: 20, source_track: 'system' }];
    let vault = { version: 1, id: 'willow', name: 'Project Willow Vault', revision: 0, entries: [{ id: 'ref1', kind: 'place', canonical: 'Willow Studio', aliases: [], source: 'Fictional workshop brief', verified: true, context: 'Invented demonstration venue', unit: '', valid_from: '', valid_to: '' }], relationships: [] };
    const callbacks = new Map(); let callbackId = 0;
    window.qaWorkspace = id => id === 'qa-draft' ? draftWorkspace : workspace;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'windows', arch: 'x86_64', family: 'windows', type: 'windows', version: '10' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Clipboard is disabled for this design fixture'); } } });
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: () => '/qa-audio.wav', transformCallback: fn => { callbacks.set(++callbackId, fn); return callbackId; }, unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'get_onboarding_status') return { version: '1', completed: true, current_step: 4, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' }, last_updated: '2026-10-07T00:00:00Z' };
        if (command === 'api_get_meetings') return meetings;
        if (command === 'list_project_library') return { projects: [{ id: 'willow', name: 'Project Willow Vault', revision: 0, entry_count: 1 }], meetings: meetings.filter(meeting => meeting.id !== 'qa-draft').map(meeting => ({ ...meeting, project_id: meeting.id === 'qa-meeting' ? 'willow' : null, notes_preview: '' })) };
        if (command === 'get_transcript_history') return [];
        if (command === 'get_recording_meeting_name') return 'Project Willow · Friday catch-up';
        if (command === 'api_search_transcripts') return meetings.filter(item => item.title.toLowerCase().includes(args.query.toLowerCase())).map(item => ({ ...item, matches: [] }));
        if (command === 'api_save_meeting_title') { const meeting = meetings.find(item => item.id === args.meetingId); if (meeting) meeting.title = args.title; return null; }
        if (command === 'api_get_meeting_metadata') return args.meetingId === 'qa-draft' ? { ...meetings[0], id: 'qa-draft' } : meetings.find(item => item.id === args.meetingId) || meetings[0];
        if (command === 'api_get_meeting_transcripts') { const current = args.meetingId === 'qa-draft' ? draftSegments : segments; return { transcripts: current.slice(args.offset, args.offset + args.limit), total_count: current.length, has_more: args.offset + args.limit < current.length }; }
        if (command === 'get_local_transcript_layers') return { source_meeting_id: 'qa-meeting', layers: [{ meeting_id: 'qa-meeting', title: meetings[0].title, profile: 'trelis-20', workflow_role: 'final', job_id: 'qa-job', state: 'complete', primary: true }, { meeting_id: 'qa-draft', title: meetings[0].title, profile: 'apex-20', workflow_role: 'live-draft', job_id: 'qa-draft-job', state: 'complete', primary: false }] };
        if (command === 'get_local_transcript_groups') return [{ meeting_id: 'qa-draft', source_meeting_id: 'qa-meeting', workflow_role: 'live-draft' }];
        if (command === 'api_get_summary') return { status: 'idle', data: null };
        if (command === 'load_transcript_workspace') return args.meetingId === 'qa-draft' ? draftWorkspace : workspace;
        if (command === 'save_transcript_workspace') {
          const current = args.meetingId === 'qa-draft' ? draftWorkspace : workspace;
          if (args.expectedRevision !== current.revision) throw Error('Revision conflict');
          const saved = { ...current, revision: current.revision + 1, notes: args.notes, notes_document: args.clearNotesDocument ? null : args.notesDocument ?? current.notes_document, corrections: args.corrections, project_id: args.projectId, speaker_names: args.speakerNames };
          if (args.meetingId === 'qa-draft') draftWorkspace = saved; else workspace = saved;
          return saved;
        }
        if (command === 'local_get_meeting_audio') return { path: '/qa-audio.wav' };
        if (command === 'get_local_stt_profiles') return ['trelis-5', 'trelis-10', 'trelis-20', 'apex-20'].map(id => ({ id, model: id.split('-')[0], chunk_seconds: Number(id.split('-')[1]), available: true, live_qualified: false }));
        if (command === 'get_speaker_setup_status') return { available: true, enabled: true };
        if (command === 'list_project_vaults') return [vault];
        if (command === 'load_project_vault') return vault;
        if (command === 'save_project_vault') { if (args.expectedRevision !== vault.revision) throw Error('Revision conflict'); vault = { ...vault, revision: vault.revision + 1, entries: args.entries }; return vault; }
        if (command === 'get_active_capture') return null;
        if (command === 'is_recording') return false;
        if (command === 'get_recording_state') return { is_recording: false, is_paused: false, is_active: false };
        if (command === 'list_local_transcription_jobs' || command === 'list_recoverable_captures') return [];
        if (command === 'get_audio_devices') return [{ name: 'Laptop microphone', device_type: 'Input' }, { name: 'Headphones', device_type: 'Output' }];
        if (command === 'api_get_transcript_config') return { provider: 'localWhisper', model: 'trelis' };
        if (command === 'check_first_launch') return false;
        if (command.startsWith('plugin:event|') || command.startsWith('plugin:store|load')) return 1;
        if (command.startsWith('plugin:store|get')) return [null, false];
        if (command.startsWith('plugin:store|has')) return false;
        if (command.startsWith('plugin:os|')) return 'windows';
        if (/start_.*(recording|transcription|identification)|open_claude|plugin:dialog/.test(command)) throw Error(`Side effect forbidden in design fixture: ${command}`);
        return null;
      } };
  });
}
module.exports = { installFixture };
