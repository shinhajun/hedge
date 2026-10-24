// Audio thread: mixes to mono, downsamples to `rate` and posts 16-bit PCM chunks with their loudness.
class Pcm16 extends AudioWorkletProcessor {
  constructor({ processorOptions: { rate, chunkMs } }) {
    super();
    this.ratio = sampleRate / rate;
    this.size = Math.round((rate * chunkMs) / 1000);
    this.out = new Int16Array(this.size);
    this.n = 0;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const len = channels[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      this.acc += v / channels.length;
      this.count++;
      if (++this.pos < this.ratio) continue;
      // Average the input samples that fall into one output sample (a box filter is enough for speech).
      this.pos -= this.ratio;
      const s = Math.max(-1, Math.min(1, this.acc / this.count));
      this.acc = 0;
      this.count = 0;
      this.energy += s * s;
      this.out[this.n++] = s * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage({ pcm: this.out, rms: Math.sqrt(this.energy / this.size) }, [this.out.buffer]);
        this.out = new Int16Array(this.size);
        this.n = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm16', Pcm16);
