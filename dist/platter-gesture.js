const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// A finger passing through the spindle has no reliable angle. Test the segment,
// too: a fast move can cross the centre without producing a sample inside it.
function crossesCentre(from, to, radius) {
  if (!from) return true;
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(-(from.x * dx + from.y * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(from.x + t * dx, from.y + t * dy) < radius;
}

/**
 * One independently captured pointer per platter; other fingers remain available
 * for the second deck and mixer. Audio callbacks run in the input event, without
 * a requestAnimationFrame or promise round trip on the movement path.
 */
export function bindPlatterGesture(element, {
  getState, onBegin, onMove, onEnd, onRotate,
  onChange = () => {}, onError = () => {},
}) {
  let gesture = null, disposed = false;
  const listeners = [];
  const listen = (target, name, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  };
  const report = error => onError(error);
  const point = (event, active) => ({x: event.clientX - active.cx, y: event.clientY - active.cy});

  function release(active) {
    // Explicit release can synchronously dispatch lostpointercapture in test
    // hosts. Clear ownership first so that the end callback runs exactly once.
    if (element.hasPointerCapture?.(active.pointerId)) {
      try { element.releasePointerCapture(active.pointerId); } catch { /* Already released by the browser. */ }
    }
  }

  function finish() {
    const active = gesture;
    if (!active) return;
    gesture = null;
    release(active);
    try { Promise.resolve(onEnd()).catch(report); } catch (error) { report(error); }
    onChange(false);
  }

  function move(event, active) {
    let samples;
    try { samples = event.getCoalescedEvents?.(); } catch { /* Older browser implementation. */ }
    if (!samples?.length) samples = [event];
    let timestamp = active.timestamp;
    for (const sample of samples) {
      if (!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) continue;
      if (sample.pointerId != null && sample.pointerId !== active.pointerId) continue;
      const next = point(sample, active);
      const angle = Math.atan2(next.y, next.x);
      if (Math.hypot(next.x, next.y) >= active.deadZone &&
          active.angle != null && !crossesCentre(active.point, next, active.deadZone)) {
        let delta = angle - active.angle;
        if (delta > Math.PI) delta -= TAU;
        if (delta < -Math.PI) delta += TAU;
        // Clamp each sample, rather than the accumulated gesture, so reversing
        // from a track boundary responds immediately instead of unwinding it.
        active.position = clamp(active.position + delta / TAU * 1.8, 0, active.duration);
        active.rotation += delta * 180 / Math.PI;
      }
      active.angle = Math.hypot(next.x, next.y) >= active.deadZone ? angle : null;
      active.point = next;
      if (Number.isFinite(sample.timeStamp)) timestamp = sample.timeStamp;
    }
    active.timestamp = timestamp;
    onRotate(active.rotation);
    // beginScratch establishes its pending state synchronously. Sending targets
    // while preparation finishes also preserves a quick touch-and-release.
    onMove(active.position, timestamp);
  }

  function down(event) {
    if (disposed || gesture || event.button !== 0) return;
    const state = getState();
    if (!state.loaded || !Number.isFinite(state.duration) || state.duration <= 0) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    const active = {
      pointerId: event.pointerId,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
      deadZone: Math.max(12, Math.min(rect.width, rect.height) * .08),
      duration: state.duration, position: clamp(state.position || 0, 0, state.duration),
      rotation: state.rotation || 0, timestamp: event.timeStamp,
      angle: null, point: null,
    };
    active.point = point(event, active);
    if (Math.hypot(active.point.x, active.point.y) >= active.deadZone) {
      active.angle = Math.atan2(active.point.y, active.point.x);
    }
    try { element.setPointerCapture(event.pointerId); }
    catch (error) { report(error); return; }
    gesture = active;
    try {
      // Do not defer this call: iPad audio resume must retain user activation.
      const begun = onBegin();
      Promise.resolve(begun).catch(error => {
        if (gesture !== active) return;
        finish();
        report(error);
      });
      onMove(active.position, active.timestamp);
      onChange(true);
    } catch (error) {
      finish();
      report(error);
    }
  }

  function moving(event) {
    const active = gesture;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    try { move(event, active); } catch (error) { finish(); report(error); }
  }

  function up(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    try { move(event, gesture); } catch (error) { report(error); }
    finish();
  }

  function cancelPointer(event) {
    if (gesture && event.pointerId === gesture.pointerId) finish();
  }

  listen(element, 'pointerdown', down, {passive: false});
  listen(element, 'pointermove', moving, {passive: false});
  listen(element, 'pointerup', up, {passive: false});
  listen(element, 'pointercancel', cancelPointer);
  listen(element, 'lostpointercapture', cancelPointer);
  listen(element, 'contextmenu', event => event.preventDefault());
  const document = element.ownerDocument;
  const host = document?.defaultView;
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  for (const name of ['blur', 'pagehide', 'resize']) listen(host, name, finish);
  // Bounds are intentionally read once per gesture. Scrolling an ancestor can
  // move them without resizing the platter, so release before reusing them.
  listen(host, 'scroll', finish, {capture: true, passive: true});

  return {
    get active() { return !!gesture; },
    cancel: finish,
    dispose() {
      if (disposed) return;
      disposed = true;
      finish();
      for (const remove of listeners) remove();
    },
  };
}
