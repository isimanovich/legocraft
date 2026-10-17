// Tiny procedural sound effects (no audio assets needed).

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.enabled = false;
      return;
    }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.25;
    this.master.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  tone({ type = 'square', from = 440, to = 220, dur = 0.12, vol = 1, delay = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise(dur = 0.1, vol = 0.6) {
    if (!this.ctx || !this.enabled) return;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.master);
    src.start();
  }

  breakBlock() { this.noise(0.12, 0.5); this.tone({ type: 'triangle', from: 300, to: 120, dur: 0.1, vol: 0.5 }); }
  placeBlock() { this.tone({ type: 'square', from: 500, to: 700, dur: 0.07, vol: 0.4 }); }
  hitEnemy() { this.tone({ type: 'sawtooth', from: 700, to: 200, dur: 0.1, vol: 0.5 }); }
  killEnemy() {
    this.noise(0.25, 0.7);
    this.tone({ type: 'square', from: 220, to: 880, dur: 0.18, vol: 0.5 });
    this.tone({ type: 'square', from: 440, to: 1320, dur: 0.2, vol: 0.4, delay: 0.08 });
  }
  hurt() { this.tone({ type: 'sawtooth', from: 180, to: 60, dur: 0.25, vol: 0.8 }); }
  tick() { this.tone({ type: 'square', from: 1800, to: 1200, dur: 0.04, vol: 0.35 }); }
  explosion() {
    this.noise(0.6, 1.2);
    this.tone({ type: 'sawtooth', from: 120, to: 25, dur: 0.7, vol: 1.0 });
    this.tone({ type: 'square', from: 60, to: 20, dur: 0.9, vol: 0.6, delay: 0.05 });
  }
  jump() { this.tone({ type: 'sine', from: 300, to: 500, dur: 0.1, vol: 0.25 }); }
  /** Ragdoll body landing; `k` 0..1 scales with impact speed. */
  thud(k = 0.5) { this.noise(0.08 + 0.1 * k, 0.3 + 0.5 * k); this.tone({ type: 'sine', from: 140, to: 50, dur: 0.12 + 0.1 * k, vol: 0.3 + 0.5 * k }); }
  grab() { this.tone({ type: 'triangle', from: 200, to: 420, dur: 0.09, vol: 0.35 }); }
  /** Wolf bark / cat meow; `startled` makes it a yelp or a hiss. */
  animal(kind, startled = false) {
    if (kind === 'wolf') {
      if (startled) this.tone({ type: 'sawtooth', from: 700, to: 1100, dur: 0.18, vol: 0.4 });
      else {
        this.tone({ type: 'sawtooth', from: 220, to: 160, dur: 0.1, vol: 0.45 });
        this.tone({ type: 'sawtooth', from: 240, to: 150, dur: 0.12, vol: 0.4, delay: 0.14 });
      }
    } else if (startled) {
      this.noise(0.25, 0.4);
    } else {
      this.tone({ type: 'triangle', from: 600, to: 900, dur: 0.35, vol: 0.3 });
    }
  }
  throwTomato() { this.noise(0.06, 0.25); this.tone({ type: 'sine', from: 350, to: 900, dur: 0.12, vol: 0.3 }); }
  /** Tomato burst: a wet splat over a short low thump. */
  splat() {
    this.noise(0.22, 0.9);
    this.tone({ type: 'triangle', from: 420, to: 90, dur: 0.16, vol: 0.7 });
    this.tone({ type: 'sawtooth', from: 110, to: 35, dur: 0.35, vol: 0.6, delay: 0.02 });
  }
  blink() {
    this.tone({ type: 'sine', from: 900, to: 1800, dur: 0.14, vol: 0.35 });
    this.tone({ type: 'sine', from: 1800, to: 500, dur: 0.18, vol: 0.3, delay: 0.1 });
  }
  die() {
    this.tone({ type: 'square', from: 400, to: 100, dur: 0.6, vol: 0.7 });
    this.tone({ type: 'square', from: 300, to: 60, dur: 0.8, vol: 0.5, delay: 0.2 });
  }
  wave() {
    this.tone({ type: 'square', from: 523, to: 523, dur: 0.12, vol: 0.4 });
    this.tone({ type: 'square', from: 659, to: 659, dur: 0.12, vol: 0.4, delay: 0.13 });
    this.tone({ type: 'square', from: 784, to: 784, dur: 0.2, vol: 0.4, delay: 0.26 });
  }
}
