export function wavHeader({dataBytes = 16, sampleRate = 48000, channels = 2, bits = 16, format = 1, extensible = false, validBits = bits, extraBytes = 0} = {}) {
  const fmtSize = extensible ? 40 : 16;
  const header = new Uint8Array(12 + 8 + fmtSize + (extraBytes ? 8 + extraBytes + extraBytes % 2 : 0) + 8);
  const view = new DataView(header.buffer);
  const text = (offset, value) => header.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF'); view.setUint32(4, header.length - 8 + dataBytes, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : format, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * bits / 8, true);
  view.setUint16(32, channels * bits / 8, true); view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true); view.setUint16(38, validBits, true);
    view.setUint32(40, channels === 2 ? 3 : 0, true); view.setUint32(44, format, true);
    header.set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 48);
  }
  const next = 20 + fmtSize;
  if (extraBytes) { text(next, 'JUNK'); view.setUint32(next + 4, extraBytes, true); }
  text(header.length - 8, 'data'); view.setUint32(header.length - 4, dataBytes, true);
  return header;
}

/** A sparse Blob-like fixture; allocates only explicitly requested byte ranges. */
export function sparseWave(options = {}, valueAt = () => 0) {
  const header = wavHeader(options), blockAlign = (options.channels ?? 2) * (options.bits ?? 16) / 8;
  const size = header.length + (options.dataBytes ?? 16), reads = [];
  return {
    size, reads, header,
    async arrayBuffer() { throw new Error('A whole-file read is forbidden in this fixture.'); },
    slice(start, end) {
      reads.push([start, end]);
      return {async arrayBuffer() {
        const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
        for (let offset = 0; offset < bytes.length; offset++) {
          const absolute = start + offset;
          bytes[offset] = absolute < header.length ? header[absolute] : valueAt(absolute - header.length, blockAlign);
        }
        return bytes.buffer;
      }};
    },
  };
}
