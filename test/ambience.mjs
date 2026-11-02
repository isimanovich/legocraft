import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK } from '../src/world.js';
import { Ambience, surfaceForBlock } from '../src/ambience.js';
import { Sfx } from '../src/sfx.js';

function environment() {
  const blocks = new Map();
  const world = { get: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? BLOCK.AIR };
  const set = (x, y, z, block) => blocks.set(`${x},${y},${z}`, block);
  const calls = [];
  const sfx = { enabled: true, water: 0, setWaterLevel(level) { this.water = level; },
    footstep(...args) { calls.push(['step', ...args]); }, swim(...args) { calls.push(['swim', ...args]); } };
  const player = { pos: { x: 0.5, y: 1, z: 0.5 }, vel: { x: 0, y: 0, z: 0 },
    halfW: 0.3, onGround: true, sitting: false, climbing: false, health: 100, touch: { jump: false }, keys: new Set() };
  const ambience = new Ambience(sfx, world);
  return { world, set, calls, sfx, player, ambience };
}

const walk = (env, count = 15, distance = 0.2) => {
  for (let i = 0; i < count; i++) { env.player.pos.x += distance; env.ambience.update(0.05, env.player, true); }
};

test('footsteps follow the actual ground material and distance, with faster cadence while running', () => {
  const env = environment();
  for (let x = 0; x < 40; x++) env.set(x, 0, 0, x < 5 ? BLOCK.GRASS : BLOCK.PLANKS);
  env.ambience.update(0.05, env.player, true);
  walk(env);
  assert.ok(env.calls.some(([kind, surface]) => kind === 'step' && surface === 'grass'));
  walk(env, 30);
  assert.equal(env.calls.at(-1)[1], 'wood', 'crossing onto a different block changes the sound');
  const cadence = distance => {
    const e = environment();
    for (let x = 0; x < 40; x++) e.set(x, 0, 0, BLOCK.STONE);
    e.ambience.update(0.05, e.player, true); walk(e, 60, distance);
    return e.calls.filter(([kind]) => kind === 'step').length;
  };
  assert.ok(cadence(0.3) > cadence(0.1), 'covering ground faster produces more footsteps per second');
  assert.notEqual(surfaceForBlock(BLOCK.SAND), surfaceForBlock(BLOCK.STONE));
  assert.notEqual(surfaceForBlock(BLOCK.COUCH), surfaceForBlock(BLOCK.WOOD));
});

test('idle, airborne, seated, paused and teleported players do not produce footsteps', () => {
  const env = environment();
  for (let x = 0; x < 100; x++) env.set(x, 0, 0, BLOCK.STONE);
  env.ambience.update(0.05, env.player, true);
  env.player.vel.x = 5;
  for (let i = 0; i < 60; i++) env.ambience.update(0.05, env.player, true);
  env.player.onGround = false; walk(env, 20);
  env.player.onGround = true; env.player.sitting = true; walk(env, 20);
  env.player.sitting = false;
  env.player.pos.x = 80;
  env.ambience.update(0.05, env.player, true);
  env.ambience.update(0.05, env.player, false);
  assert.equal(env.sfx.water, 0);
  assert.deepEqual(env.calls, []);
});

test('water rush fades with distance, entry and swim strokes replace ground footsteps', () => {
  const env = environment();
  for (let x = 2; x < 15; x++) env.set(x, 1, 0, BLOCK.WATER);
  env.ambience.update(0.05, env.player, true);
  const nearby = env.sfx.water;
  assert.ok(nearby > 0, 'nearby exposed water is audible from shore');
  walk(env, 10);
  assert.equal(env.calls.filter(([kind, entry]) => kind === 'swim' && entry).length, 1);
  walk(env, 15);
  assert.ok(env.calls.some(([kind, entry]) => kind === 'swim' && entry === false));
  assert.equal(env.calls.filter(([kind]) => kind === 'step').length, 0);
  const count = env.calls.length;
  for (let i = 0; i < 20; i++) { env.player.pos.y += i % 2 ? 0.01 : -0.01; env.ambience.update(0.05, env.player, true); }
  assert.equal(env.calls.length, count, 'passive buoyancy does not play swimming strokes');
  env.player.pos.x = 40;
  for (let i = 0; i < 10; i++) env.ambience.update(0.05, env.player, true);
  assert.equal(env.sfx.water, 0);
  env.player.pos.x = 2.5; env.player.pos.y = 4;
  for (let i = 0; i < 10; i++) env.ambience.update(0.05, env.player, true);
  assert.ok(env.sfx.water > 0, 'water remains audible below a raised shore');
  env.sfx.enabled = false;
  env.ambience.update(0.05, env.player, true);
  assert.equal(env.sfx.water, 0);
  env.sfx.enabled = true; env.player.health = 0;
  env.ambience.update(0.05, env.player, true);
  assert.equal(env.sfx.water, 0);
});

function fakeAudio() {
  const param = value => ({ value, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  return class FakeContext {
    constructor() { this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.destination = node(); this.sources = []; this.filters = []; }
    createGain() { return { ...node(), gain: param(1) }; }
    createBuffer(channels, size) { const data = new Float32Array(size); return { getChannelData: () => data }; }
    createBufferSource() {
      const source = { ...node(), start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
      this.sources.push(source); return source;
    }
    createBiquadFilter() { const filter = { ...node(), frequency: param(0), Q: param(0) }; this.filters.push(filter); return filter; }
    createOscillator() { return { ...node(), frequency: param(0), start() {}, stop() {} }; }
    resume() { return Promise.resolve(); }
  };
}

test('one reusable water loop fades, stops on mute/pause and reconnects without duplicates', () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = fakeAudio();
  try {
    const sfx = new Sfx(); sfx.init();
    sfx.setWaterLevel(0.7);
    const first = sfx.water.source;
    for (let i = 0; i < 50; i++) sfx.setWaterLevel(0.3 + i / 100);
    assert.equal(sfx.ctx.sources.length, 1, 'continuous proximity changes reuse the same loop');
    assert.ok(sfx.water.gain.gain.value > 0);
    // An idle graph may retain its intrinsic value despite scheduled automation.
    let scheduledVolume;
    sfx.master.gain.setValueAtTime = value => { scheduledVolume = value; };
    sfx.setEnabled(false);
    assert.equal(sfx.master.gain.value, 0);
    assert.equal(scheduledVolume, 0, 'mute updates both intrinsic and automated gain');
    assert.equal(sfx.water, null);
    assert.equal(first.stopped, true);
    sfx.setWaterLevel(0);
    sfx.setEnabled(true);
    assert.equal(sfx.master.gain.value, 0.25);
    assert.equal(scheduledVolume, 0.25);
    assert.equal(sfx.water, null, 'muted/paused water is not restarted in the background');
    sfx.setWaterLevel(0.5);
    assert.equal(sfx.ctx.sources.length, 2);
    const resumed = sfx.water.source;
    sfx.setWaterLevel(0);
    assert.equal(resumed.stopped, true);
    assert.equal(sfx.water, null);
    sfx.footstep('grass'); const grass = sfx.ctx.filters.at(-1);
    sfx.footstep('wood'); const wood = sfx.ctx.filters.at(-1);
    assert.notEqual(grass.type, wood.type);
    assert.notEqual(grass.frequency.value, wood.frequency.value, 'materials generate different audible spectra');
  } finally {
    if (original === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = original;
  }
});
