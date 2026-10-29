/* Separate popup: read-only status on load; capture and clipboard actions always require a user command. */
(() => {
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['dictation', 'grip', 'title', 'processing', 'elapsed', 'level', 'stop', 'cancel', 'dismiss', 'hint', 'result-panel', 'message', 'result', 'copy', 'copy-status', 'error'].map(id => [id, byId(id)]));
  const bars = Array.from(ui.level.children);
  const samples = Array(bars.length).fill(0);
  const labels = { idle: 'Ready to dictate', starting: 'Getting ready…', listening: 'Listening', transcribing: 'Transcribing…', ready: 'Ready to copy', inserted: 'Text inserted', cancelled: 'Cancelled', error: 'Couldn’t finish' };
  const active = phase => ['starting', 'listening', 'transcribing'].includes(phase);
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  let status = null, pending = false, stopped = false, pollTimer, request = 0;
  let actionError = '';
  let layoutKey = '', drag = null;
  function requestLayout(sessionId, expanded) {
    const key = JSON.stringify([sessionId, expanded]);
    if (layoutKey === key || stopped) return;
    layoutKey = key;
    void invoke('dictation_popup_layout', { sessionId, expanded }).catch(reason => {
      ui.error.textContent = `The popup could not resize. ${String(reason)}`; ui.error.hidden = false;
    });
  }
  function time(seconds) { const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
  function render(next) {
    if (!next || !labels[next.phase]) throw Error('Dictation status is unavailable.');
    if (drag && drag.sessionId !== next.session_id) finishDrag('cancel', true);
    if (status && status.session_id !== next.session_id) actionError = '';
    if (status?.session_id !== next.session_id || status?.phase !== next.phase) { samples.fill(0); ui['copy-status'].textContent = ''; }
    status = next;
    const level = next.phase === 'listening' && Number.isFinite(next.level) ? Math.max(0, Math.min(1, next.level)) : 0;
    samples.push(level); samples.shift();
    bars.forEach((bar, i) => { bar.style.height = `${2 + Math.round(Math.sqrt(samples[i]) * 12)}px`; });
    ui.level.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    ui.level.setAttribute('aria-valuetext', next.phase === 'listening' ? level === 0 ? 'No microphone input' : `${Math.round(level * 100)} percent` : 'Microphone is not listening');
    ui.level.hidden = next.phase !== 'listening';
    ui.processing.hidden = !['starting', 'transcribing'].includes(next.phase);
    ui.dictation.dataset.phase = next.phase;
    ui.title.textContent = actionError && active(next.phase) ? 'Action needs retry'
      : next.phase === 'listening' && next.delivery_message ? 'Listening for copy'
      : next.phase === 'listening' && next.streaming_message ? 'Listening · check Settings'
      : next.phase === 'listening' && next.live_typing && next.inserted_characters > 0 ? 'Typing live' : labels[next.phase];
    ui.elapsed.textContent = time(next.elapsed_seconds);
    ui.elapsed.hidden = !active(next.phase);
    ui.stop.hidden = next.phase !== 'listening';
    ui.stop.disabled = pending || next.phase !== 'listening';
    ui.cancel.hidden = !active(next.phase); ui.cancel.disabled = pending;
    ui.dismiss.hidden = active(next.phase); ui.dismiss.disabled = pending;
    const shortcut = next.shortcuts?.copilot?.registered && next.shortcuts.copilot.observed ? 'Copilot' : next.shortcuts?.fallback?.registered ? next.shortcuts.fallback.label : next.shortcuts?.copilot?.registered ? next.shortcuts.copilot.label : null;
    ui.hint.textContent = next.phase === 'listening' ? shortcut ? `${shortcut} again to finish` : 'Choose Stop when you’re done.'
      : next.phase === 'starting' ? 'Opening your default microphone…'
      : next.phase === 'transcribing' ? 'Finishing your last words…'
      : next.phase === 'ready' ? 'Your words are ready. Copy them when you want.'
      : next.phase === 'inserted' ? 'Done. Back to your words.'
      : next.phase === 'cancelled' ? 'Any words already typed are kept.'
      : next.phase === 'error' ? 'Your result stays here if text is available.'
      : shortcut ? `Use ${shortcut} in the app where you want to type.` : 'Start dictation from oats Settings.';
    const draft = next.session_id && ['listening', 'transcribing'].includes(next.phase) && typeof next.draft_text === 'string' && next.draft_text.trim() ? next.draft_text : '';
    ui.hint.dataset.draft = 'false';
    ui.hint.removeAttribute('aria-label');
    if (actionError && active(next.phase)) ui.hint.textContent = actionError;
    else if (active(next.phase) && next.delivery_message) ui.hint.textContent = next.phase === 'listening' ? 'Listening. Finish to copy your text.' : 'Finishing. Your text will be ready to copy.';
    else if (active(next.phase) && next.streaming_message) ui.hint.textContent = next.streaming_message;
    else if (draft) {
      ui.hint.textContent = `Draft: ${draft}`;
      ui.hint.dataset.draft = 'true';
      ui.hint.setAttribute('aria-label', `Draft, may change before typing: ${draft}`);
    }
    ui.cancel.title = 'Cancel remaining dictation; words already typed stay in place';
    ui.hint.title = ui.hint.dataset.draft === 'true' ? `Draft, may change before typing: ${draft}` : ui.hint.textContent;
    ui.title.title = ui.hint.title;
    const expanded = next.phase === 'ready' || next.phase === 'error' || !!actionError;
    ui.dictation.dataset.expanded = String(expanded);
    requestLayout(next.session_id, expanded);
    ui['result-panel'].hidden = !expanded;
    ui.message.textContent = actionError || next.message || (next.phase === 'ready' ? 'No text cursor was available. Copy the result and paste it where you need it.' : 'Try again from oats Settings.');
    ui.result.textContent = next.text || '';
    ui.result.hidden = !next.text || active(next.phase);
    ui.copy.hidden = !next.text || active(next.phase);
    ui.copy.disabled = pending;
    ui.error.textContent = actionError; ui.error.hidden = !actionError;
  }
  async function refresh() {
    const current = ++request;
    try { const next = await invoke('dictation_status'); if (!stopped && current === request) render(next); }
    catch (reason) {
      if (stopped || current !== request) return;
      ui.title.textContent = 'Unavailable';
      ui.level.hidden = ui.processing.hidden = ui.stop.hidden = true;
      ui.hint.textContent = 'Open oats Settings to check dictation.';
      ui.hint.dataset.draft = 'false';
      ui.hint.removeAttribute('aria-label');
      ui.hint.title = String(reason);
      ui.title.title = String(reason);
      ui.dictation.dataset.expanded = 'true'; ui['result-panel'].hidden = false;
      ui.message.textContent = `Open oats Settings to check dictation. ${String(reason)}`;
      ui.result.hidden = ui.copy.hidden = true;
      ui.stop.disabled = ui.cancel.disabled = ui.dismiss.disabled = true;
      requestLayout(status?.session_id ?? null, true);
    }
  }
  async function act(command) {
    if (!status || pending) return;
    pending = true; actionError = ''; render(status);
    try {
      await invoke(command, { sessionId: status.session_id });
      await refresh();
      if (command === 'dictation_copy') ui['copy-status'].textContent = 'Copied';
    } catch (reason) { actionError = String(reason); }
    finally { pending = false; if (status) render(status); }
  }
  ui.stop.addEventListener('click', () => { if (status?.phase === 'listening') void act('dictation_toggle'); });
  ui.cancel.addEventListener('click', () => { if (status && active(status.phase)) void act('dictation_cancel'); });
  ui.dismiss.addEventListener('click', () => { if (status && !active(status.phase)) void act('dictation_dismiss'); });
  ui.copy.addEventListener('click', () => { if (status?.text && !active(status.phase)) void act('dictation_copy'); });
  // Only the dedicated grip moves the popup. Native code uses the physical
  // cursor and SWP_NOACTIVATE; screen deltas are session-bound gesture metadata.
  function pumpDrag(gesture) {
    if (gesture.running || gesture.finished) return;
    gesture.running = true;
    void (async () => {
      if (!gesture.started) {
        await invoke('dictation_popup_drag', { sessionId: gesture.sessionId, phase: 'start', deltaX: 0, deltaY: 0 });
        gesture.started = true;
      }
      while (gesture.latest || gesture.ending) {
        if (!gesture.ending) await new Promise(resolve => window.setTimeout(resolve, Math.max(0, 34 - (performance.now() - gesture.sentAt))));
        const point = gesture.latest || gesture.last;
        gesture.latest = null;
        const phase = gesture.ending || 'move';
        await invoke('dictation_popup_drag', { sessionId: gesture.sessionId, phase, deltaX: point.x, deltaY: point.y });
        gesture.sentAt = performance.now();
        if (phase !== 'move') { gesture.finished = true; break; }
      }
    })().catch(async reason => {
      gesture.finished = true;
      if (gesture.started) {
        try { await invoke('dictation_popup_drag', { sessionId: gesture.sessionId, phase: 'cancel', deltaX: gesture.last.x, deltaY: gesture.last.y }); }
        catch { /* Native session changes also discard its old gesture. */ }
      }
      // A session transition invalidates its old gesture; never blame the new one.
      if (!gesture.silent && status?.session_id === gesture.sessionId) {
        actionError = `Could not move the popup. ${String(reason)}`; render(status);
      }
    }).finally(() => {
      gesture.running = false;
      if (gesture.finished) {
        if (drag === gesture) { drag = null; ui.grip.dataset.dragging = 'false'; }
        if (ui.grip.hasPointerCapture(gesture.pointerId)) ui.grip.releasePointerCapture(gesture.pointerId);
      } else if (gesture.latest || gesture.ending) pumpDrag(gesture);
    });
  }
  function finishDrag(phase, silent = false) {
    if (!drag || drag.ending) return;
    drag.ending = phase; drag.silent = silent;
    if (ui.grip.hasPointerCapture(drag.pointerId)) ui.grip.releasePointerCapture(drag.pointerId);
    pumpDrag(drag);
  }
  ui.grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !status) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, sessionId: status.session_id, x: event.screenX, y: event.screenY,
      last: { x: 0, y: 0 }, latest: null, ending: null, sentAt: 0, started: false, running: false, finished: false, silent: false };
    ui.grip.setPointerCapture(event.pointerId); ui.grip.dataset.dragging = 'true';
    pumpDrag(drag);
  });
  ui.grip.addEventListener('pointermove', event => {
    if (!drag || drag.ending || drag.pointerId !== event.pointerId) return;
    drag.last = { x: event.screenX - drag.x, y: event.screenY - drag.y };
    drag.latest = drag.last; pumpDrag(drag);
  });
  ui.grip.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.last = { x: event.screenX - drag.x, y: event.screenY - drag.y }; drag.latest = drag.last;
    finishDrag('end');
  });
  ui.grip.addEventListener('pointercancel', () => finishDrag('cancel'));
  ui.grip.addEventListener('lostpointercapture', () => finishDrag('cancel'));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !status || event.repeat) return;
    event.preventDefault(); void act(active(status.phase) ? 'dictation_cancel' : 'dictation_dismiss');
  });
  async function poll() { await refresh(); if (!stopped) pollTimer = window.setTimeout(poll, 250); }
  window.addEventListener('pagehide', () => { finishDrag('cancel', true); stopped = true; request++; window.clearTimeout(pollTimer); }, { once: true });
  void poll();
})();
