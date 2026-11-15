/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Dictation's microphone, on the audio thread: the input mixed down to one channel, brought to 16 kHz (averaging the
 * samples each output sample stands for, which also keeps out what 16 kHz can't carry) and posted as 16-bit PCM 50 ms
 * at a time, with how loud those 50 ms were (0 to 1) for the waveform.
 */
const RATE = 16000;
const CHUNK = 800;

class DictationPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE;
    this.sum = 0;
    this.count = 0;
    this.pos = 0;
    this.out = new Int16Array(CHUNK);
    this.length = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels.length; c++) sample += channels[c][i];
      this.sum += sample / channels.length;
      this.count++;
      this.pos += 1;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.out[this.length++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.energy += v * v;
      if (this.length === CHUNK) {
        const level = Math.sqrt(this.energy / CHUNK);
        this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.length = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}

registerProcessor('atelier-dictation-pcm', DictationPcm);
