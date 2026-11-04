/* Continuous resampling to 16kHz, 16-bit little-endian PCM, 20ms frames. */
class RealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.previous = 0; this.sum = 0; this.count = 0; this.phase = 0;
    this.frame = new Int16Array(320); this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Area averaging keeps resampling continuous across render quanta.
    for (const value of channel) {
      this.sum += value; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0; this.count = 0;
        this.frame[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
        if (this.offset === 320) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320); this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("jarvis-realtime-capture", RealtimeCapture);
