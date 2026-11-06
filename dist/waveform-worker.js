import {createWaveformAccumulator, WAVEFORM_FIELDS} from './waveform-data.js?v=15d483d12b5c45ed';
let active = null;
self.onmessage = ({data}) => {
  const {type, id} = data ?? {};
  try {
    if (type === 'start') {
      if (active) throw new Error('Another waveform is being generated.');
      active = {id, builder: createWaveformAccumulator(data.dimensions, data.options)};
      self.postMessage({type: 'ready', id});
      return;
    }
    if (!active || active.id !== id) throw new Error('Waveform request is no longer active.');
    if (type === 'chunk') {
      active.builder.append(data.channels);
      self.postMessage({type: 'ack', id});
    } else if (type === 'finish') {
      const waveform = active.builder.finish();
      active = null;
      self.postMessage({type: 'result', id, waveform}, WAVEFORM_FIELDS.map(name => waveform[name].buffer));
    } else throw new Error('Waveform message is invalid.');
  } catch (error) {
    active = null;
    self.postMessage({type: 'error', id, message: error instanceof Error ? error.message : '波形を生成できませんでした。'});
  }
};
