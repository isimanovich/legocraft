// Procedural sound effects and one bounded water loop; no audio downloads needed.
const STEP_SOUNDS = {
  grass: { dur: 0.085, noise: 0.22, filter: 'bandpass', frequency: 950, tone: 85, volume: 0.13 },
  dirt: { dur: 0.095, noise: 0.24, filter: 'lowpass', frequency: 650, tone: 100, volume: 0.12 },
  sand: { dur: 0.13, noise: 0.21, filter: 'highpass', frequency: 1250, tone: 0 },
  wood: { dur: 0.075, noise: 0.12, filter: 'lowpass', frequency: 450, tone: 180, type: 'triangle', volume: 0.2 },
  stone: { dur: 0.045, noise: 0.2, filter: 'highpass', frequency: 1800, tone: 280, type: 'triangle', volume: 0.14 },
  brick: { dur: 0.05, noise: 0.15, filter: 'bandpass', frequency: 1900, tone: 410, volume: 0.13 },
  soft: { dur: 0.1, noise: 0.15, filter: 'lowpass', frequency: 300, tone: 65, volume: 0.08 },
  metal: { dur: 0.06, noise: 0.1, filter: 'bandpass', frequency: 2200, tone: 800, type: 'triangle', volume: 0.1 },
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.waterLevel = 0;
    this.water = null;
    this.waterBuffer = null;
  }

  /** Must be called from a user gesture. Unsupported audio never blocks play. */
  init() {
    if (!this.enabled) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.25 : 0;
      this.master.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.setWaterLevel(this.waterLevel);
    } catch { this.ctx = null; }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.master) {
      const volume = this.enabled ? 0.25 : 0;
      // Set both the intrinsic value and the timeline: idle audio graphs can
      // otherwise retain the previous intrinsic gain until they render again.
      this.master.gain.cancelScheduledValues(0);
      this.master.gain.value = volume;
      this.master.gain.setValueAtTime(volume, this.ctx.currentTime);
    }
    if (!this.enabled) this.stopWater();
    else this.setWaterLevel(this.waterLevel);
  }

  stopWater() {
    if (!this.water) return;
    const { source, gain } = this.water;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, 0.025);
    source.stop(t + 0.12);
    this.water = null;
  }

  /** One quiet, filtered noise loop. Zero stops it; repeated updates never add loops. */
  setWaterLevel(level) {
    this.waterLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    if (!this.ctx || !this.enabled || this.waterLevel < 0.001) { this.stopWater(); return; }
    if (!this.water) {
      if (!this.waterBuffer) {
        this.waterBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
        const samples = this.waterBuffer.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < samples.length; i++) {
          brown = (brown + (Math.random() * 2 - 1) * 0.035) / 1.035;
          samples[i] = brown * 3;
        }
      }
      const source = this.ctx.createBufferSource();
      source.buffer = this.waterBuffer; source.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 1800; filter.Q.value = 0.5;
      const gain = this.ctx.createGain(); gain.gain.value = 0;
      source.connect(filter); filter.connect(gain); gain.connect(this.master);
      source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
      source.start();
      this.water = { source, filter, gain };
    }
    if (this.water.target !== this.waterLevel) {
      this.water.gain.gain.setTargetAtTime(this.waterLevel * 0.32, this.ctx.currentTime, 0.18);
      this.water.target = this.waterLevel;
    }
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
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  noise(dur = 0.1, vol = 0.6, { filter: filterType, frequency = 1000, q = 0.7 } = {}) {
    if (!this.ctx || !this.enabled) return;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    let filter;
    if (filterType) {
      filter = this.ctx.createBiquadFilter(); filter.type = filterType;
      filter.frequency.value = frequency; filter.Q.value = q;
      src.connect(filter); filter.connect(g);
    } else src.connect(g);
    g.connect(this.master);
    src.onended = () => { src.disconnect(); filter?.disconnect(); g.disconnect(); };
    src.start();
  }

  /** Short material-specific footsteps, with small natural pitch/strength changes. */
  footstep(surface, strength = 1) {
    const profile = STEP_SOUNDS[surface] ?? STEP_SOUNDS.brick;
    const pitch = 0.94 + Math.random() * 0.12;
    const volume = Math.max(0.5, Math.min(1.25, strength)) * (0.9 + Math.random() * 0.2);
    this.noise(profile.dur, profile.noise * volume, { filter: profile.filter, frequency: profile.frequency * pitch });
    if (profile.tone) this.tone({ type: profile.type ?? 'sine', from: profile.tone * pitch, to: profile.tone * 0.5 * pitch,
      dur: profile.dur, vol: profile.volume * volume });
  }

  swim(entry = false, strength = 1) {
    const scale = Math.max(0.4, Math.min(1.4, strength));
    this.noise(entry ? 0.28 : 0.17, (entry ? 0.42 : 0.2) * scale,
      { filter: 'bandpass', frequency: entry ? 650 : 950, q: 0.45 });
    this.tone({ type: 'sine', from: entry ? 170 : 250, to: 65, dur: entry ? 0.18 : 0.1, vol: 0.1 * scale });
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
