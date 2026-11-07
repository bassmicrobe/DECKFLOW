// Presentation-only enhancements: sliding tab indicator, filled slider tracks
// and a pointer-following spotlight. Nothing here touches audio or app state.
const clamp = value => Math.min(100, Math.max(0, value));

export function rangeFill(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  if (!(max > min) || !Number.isFinite(value)) return {lo: 0, hi: 0};
  const pct = clamp((value - min) / (max - min) * 100);
  // Bipolar controls (EQ, tempo) fill outward from their zero point.
  const origin = min < 0 && max > 0 ? clamp(-min / (max - min) * 100) : 0;
  return {lo: Math.min(origin, pct), hi: Math.max(origin, pct)};
}

function syncRange(input) {
  const {lo, hi} = rangeFill(input);
  const key = lo.toFixed(2) + ':' + hi.toFixed(2);
  if (input.dataset.fill === key) return;
  input.dataset.fill = key;
  input.style.setProperty('--lo', lo.toFixed(2) + '%');
  input.style.setProperty('--hi', hi.toFixed(2) + '%');
}

function installTabIndicator(root) {
  const nav = root.querySelector('.workspace-tabs');
  if (!nav) return;
  const place = () => {
    const active = nav.querySelector('.tab.active');
    if (!active || !active.offsetWidth) return;
    nav.style.setProperty('--ind-x', active.offsetLeft + 'px');
    nav.style.setProperty('--ind-y', active.offsetTop + 'px');
    nav.style.setProperty('--ind-w', active.offsetWidth + 'px');
    nav.style.setProperty('--ind-h', active.offsetHeight + 'px');
    // classList.add always records a mutation, even for a present class.
    if (!nav.classList.contains('has-indicator')) nav.classList.add('has-indicator');
  };
  // Watch only the tabs, never the nav itself, so placing cannot re-trigger.
  const observer = new MutationObserver(place);
  for (const tab of nav.querySelectorAll('.tab')) observer.observe(tab, {attributes: true, attributeFilter: ['class']});
  if ('ResizeObserver' in globalThis) new ResizeObserver(place).observe(nav);
  addEventListener('resize', place);
  place();
  // Re-place once web fonts and layout have settled.
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function installRanges(root) {
  const all = () => root.querySelectorAll('input[type=range]');
  all().forEach(syncRange);
  root.addEventListener('input', event => { if (event.target?.type === 'range') syncRange(event.target); }, true);
  // MIDI, SYNC and resets change values programmatically without input events.
  setInterval(() => { if (!document.hidden) all().forEach(syncRange); }, 200);
}

function installSpotlight(root) {
  if (!globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
  root.addEventListener('pointermove', event => {
    const surface = event.target?.closest?.('.deck, .library-main, .library-sidebar, .mixer, .profile-card');
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    surface.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
    surface.style.setProperty('--my', (event.clientY - rect.top) + 'px');
  }, {passive: true});
}

export function installMotion(root = document) {
  try {
    installTabIndicator(root);
    installRanges(root);
    installSpotlight(root);
    root.documentElement?.classList.add('motion-ready');
  } catch (error) {
    console.warn('UI motion unavailable', error);
  }
}
