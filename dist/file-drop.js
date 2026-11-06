const AUDIO_EXTENSION = /\.(?:mp3|wav|wave|aif|aiff|m4a|aac|flac|ogg|opus|oga)$/i;

export function isAudioFile(file) {
  return !!file && (String(file.type || '').startsWith('audio/') || AUDIO_EXTENSION.test(file.name || ''));
}

export function isFileDrag(transfer) {
  if (!transfer) return false;
  return Array.from(transfer.types || []).includes('Files') ||
    Array.from(transfer.items || []).some(item => item.kind === 'file') ||
    (transfer.files?.length || 0) > 0;
}

// Only OS file drags participate. Pointer gestures and text/link drags keep
// their normal behavior. The depth counter avoids flicker across child nodes.
export function installFileDrop({target, host, onFiles, onActive}) {
  let depth = 0;
  let active = false;
  const listeners = [];
  const setActive = next => {
    if (active === next) return;
    active = next;
    onActive(next);
  };
  const reset = () => { depth = 0; setActive(false); };
  const listen = (element, event, handler) => {
    const options = {capture:true};
    element.addEventListener(event, handler, options);
    listeners.push(() => element.removeEventListener(event, handler, options));
  };
  listen(target, 'dragenter', event => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    depth++;
    setActive(true);
  });
  listen(target, 'dragover', event => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  });
  listen(target, 'dragleave', event => {
    if (!active) return;
    depth = Math.max(0, depth - 1);
    if (!depth) reset();
  });
  listen(target, 'drop', event => {
    if (!isFileDrag(event.dataTransfer)) { reset(); return; }
    event.preventDefault();
    // Files must be copied synchronously: browsers clear the transfer after
    // the drop dispatch. Ignore directory entries, which may look like files.
    const transfer = event.dataTransfer;
    const items = Array.from(transfer.items || []).filter(item => item.kind === 'file');
    const files = items.length ? items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory)
      .map(item => item.getAsFile()).filter(Boolean) : Array.from(transfer.files || []);
    reset();
    onFiles(files);
  });
  listen(target, 'dragend', reset);
  listen(target, 'keydown', event => { if (event.key === 'Escape') reset(); });
  listen(host, 'blur', reset);
  listen(host, 'pagehide', reset);
  return () => { reset(); listeners.forEach(remove => remove()); };
}
