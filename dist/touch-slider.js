const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Native ranges can reject secondary touches. Give each mixer control its own
 * captured touch/pen while leaving native mouse and keyboard behavior intact. */
export function bindTouchSlider(element, {thumbSize = 24} = {}) {
  let gesture = null, disposed = false;
  const document = element.ownerDocument, host = document?.defaultView;
  const EventClass = host?.Event || Event;
  const listeners = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const disabled = () => element.disabled || element.matches?.(':disabled');
  const dispatch = type => element.dispatchEvent(new EventClass(type, {bubbles: true}));
  const number = (attribute, fallback) => {
    const raw = element.getAttribute(attribute);
    return raw != null && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
  };

  function finish() {
    const active = gesture;
    if (!active) return;
    gesture = null;
    if (element.hasPointerCapture?.(active.pointerId)) {
      try { element.releasePointerCapture(active.pointerId); } catch { /* Browser already released it. */ }
    }
    if (element.value !== active.initialValue) dispatch('change');
  }

  function update(event, active) {
    if (!Number.isFinite(event.clientX)) return;
    let ratio = clamp((event.clientX - active.left) / active.travel, 0, 1);
    if (active.rtl) ratio = 1 - ratio;
    let value = active.min + ratio * (active.max - active.min);
    if (active.step) {
      const maxSteps = Math.floor((active.max - active.min) / active.step + 1e-9);
      const steps = clamp(Math.round((value - active.min) / active.step), 0, maxSteps);
      value = active.min + steps * active.step;
    }
    // Remove floating-point tails before the browser sanitizes the range value.
    const next = String(Number(clamp(value, active.min, active.max).toPrecision(12)));
    const previous = element.value;
    element.value = next;
    if (element.value !== previous) dispatch('input');
  }

  function down(event) {
    if (disposed || gesture || disabled() || !['touch', 'pen'].includes(event.pointerType) || event.button !== 0) return;
    if (!Number.isFinite(event.clientX)) return;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const thumb = clamp(Number(thumbSize) || 0, 0, rect.width);
    const travel = rect.width - thumb;
    if (!(travel > 0)) return;
    const min = number('min', 0), max = Math.max(min, number('max', 100));
    if (max === min) return;
    const configuredStep = number('step', 1);
    const active = {
      pointerId: event.pointerId, left: rect.left + thumb / 2, travel, min, max,
      step: element.getAttribute('step') === 'any' ? 0 : configuredStep > 0 ? configuredStep : 1,
      rtl: host?.getComputedStyle?.(element).direction === 'rtl',
      initialValue: element.value,
    };
    try { element.setPointerCapture(event.pointerId); } catch { return; }
    event.preventDefault();
    gesture = active;
    update(event, active);
  }

  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    if (disabled()) { finish(); return; }
    update(event, gesture);
  }

  function up(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    if (!disabled()) update(event, gesture);
    finish();
  }

  function canceled(event) {
    if (gesture && event.pointerId === gesture.pointerId) finish();
  }

  listen(element, 'pointerdown', down, {passive: false});
  listen(element, 'pointermove', move, {passive: false});
  listen(element, 'pointerup', up, {passive: false});
  listen(element, 'pointercancel', canceled);
  listen(element, 'lostpointercapture', canceled);
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  for (const type of ['blur', 'pagehide', 'resize']) listen(host, type, finish);
  listen(host, 'scroll', finish, {capture: true, passive: true});

  return {
    cancel: finish,
    dispose() {
      if (disposed) return;
      disposed = true;
      finish();
      for (const remove of listeners) remove();
    },
  };
}
