import {analyzeSamples} from './analysis.js?v=88e0687b343dbe25';

self.onmessage = event => {
  const {id, samples, sampleRate, options} = event.data ?? {};
  try {
    const pcm = samples instanceof Float32Array ? samples : samples instanceof ArrayBuffer ? new Float32Array(samples) : samples;
    const result = analyzeSamples(pcm, sampleRate, options);
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : 'BPMを解析できませんでした。'});
  }
};
