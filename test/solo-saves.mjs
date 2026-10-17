import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, BLOCK, DEFAULT_HOTBAR } from '../src/world.js';
import { Player } from '../src/player.js';
import { Enemy } from '../src/enemies.js';
import { Animal } from '../src/animals.js';
import { Ragdolls } from '../src/ragdoll.js';
import { Tomatoes } from '../src/tomatoes.js';
import { captureSolo, restoreSolo, validateSolo, SoloSaveStore } from '../src/solo-saves.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

function environment() {
  const scene = new THREE.Scene();
  const world = new World(scene, { sizeX: 144, sizeY: 48, sizeZ: 144, seed: 47 });
  for (let z = 0; z < 144; z++) for (let x = 0; x < 144; x++) world.set(x, 0, z, BLOCK.BEDROCK);
  const player = new Player(new THREE.PerspectiveCamera(), world);
  player.pos.set(70.5, 1.01, 70.5);
  const state = {
    gameMode: 'wave', score: 350, kills: 13, wave: 7, elapsed: 212.25,
    waveRemaining: 8, intermission: 0, spawnTimer: 1.25, slot: 5,
    tomatoes: 2, throwCooldown: 0.18, swingCooldown: 0.2, placeCooldown: 0.1,
  };
  return { scene, world, player, state, hotbar: [...DEFAULT_HOTBAR], enemies: [], animals: [],
    ragdolls: new Ragdolls(scene, world), tomatoes: new Tomatoes(scene, world) };
}

test('Solo snapshots resume exact terrain, player, wave, creatures, named bodies and flying tomatoes', () => {
  const before = environment();
  before.world.set(4, 12, 7, BLOCK.GOLD);
  before.world.set(70, 1, 72, BLOCK.BLUE);
  before.player.health = 37;
  before.player.regenDelay = 3.1;
  before.player.yaw = 1.2;
  before.player.pitch = -0.3;
  before.player.vel.set(2, 3, -1);
  before.player.knock.set(0.2, 0, -0.5);
  before.hotbar[5] = BLOCK.PURPLE;
  const enemy = new Enemy('bomber', 69, 1.01, 73, 7);
  enemy.hp = 19; enemy.fuse = 2.3; enemy.state = 'chase'; enemy.windup = -1;
  enemy.vel.set(-1, 0.5, 2); enemy.detourDir.set(1, 0, 0); enemy.attackCooldown = 0.4;
  before.enemies.push(enemy); before.scene.add(enemy.group);
  const animal = new Animal('cat', 74, 1.01, 70);
  animal.state = 'sit'; animal.timer = 8.25; animal.dir.set(-1, 0, 0);
  before.animals.push(animal); before.scene.add(animal.group);
  const fallen = new Enemy('stalker', 73, 1.01, 70);
  before.scene.add(fallen.group);
  const body = before.ragdolls.add(fallen);
  body.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  body.up.set(0, 1, 0).applyQuaternion(body.q); body.com.set(73, 2, 70);
  body.vel.set(0.3, -1, 0.5); body.angVel.set(0.2, -0.4, 0.3);
  body.limbs[0].node.rotation.x = 0.6; body.limbs[0].vx = 0.3;
  body.pinned = false; body.age = 32;
  before.ragdolls.setName(body, 'Captain Blocks');
  before.ragdolls.grab(body, body.com);
  const tomato = before.tomatoes.throw(new THREE.Vector3(70, 4, 71), new THREE.Vector3(1, 0, 0));
  tomato.life = 3.25; tomato.mesh.rotation.set(0.2, 0.5, 0.1);
  const snapshot = JSON.parse(JSON.stringify(captureSolo(before)));

  const after = environment();
  // Restoration must not call a possibly changed world generator.
  after.world.regenerate = () => { throw new Error('Terrain was regenerated instead of restored'); };
  restoreSolo(snapshot, after);
  assert.deepEqual(after.world.data, before.world.data);
  assert.deepEqual(captureSolo(after), snapshot);
  assert.equal(after.world.dirty.size, after.world.meshes.length);
  assert.equal(after.ragdolls.bodies[0].name, 'Captain Blocks');
  assert.equal(after.ragdolls.carrying, null, 'a resumed game drops the previous grip');
  assert.equal(after.ragdolls.bodies[0].carried, false);
  assert.equal(after.enemies[0].path, null, 'route caches recalculate on the saved terrain');
  assert.equal(after.enemies[0].repathTimer, 0);
  // The reconstructed simulation objects remain usable, rather than plain JSON.
  after.animals[0].update(0.01, after.world, after.player);
  after.ragdolls.update(0.01, after.player);
  after.tomatoes.update(0.01, { onExplode() {} });
  assert.equal(after.tomatoes.items.length, 1);
});

test('newer and damaged Solo saves are rejected before changing the current world', () => {
  const env = environment();
  const original = captureSolo(env);
  const tests = [
    [Object.assign(structuredClone(original), { version: 99 }), /newer game version/],
    [Object.assign(structuredClone(original), { dimensions: [96, 48, 96] }), /dimensions/],
    [Object.assign(structuredClone(original), { hotbar: ['sword'] }), /hotbar/],
  ];
  const invalidProgress = structuredClone(original);
  invalidProgress.state.tomatoes = 100;
  tests.push([invalidProgress, /progress/]);
  const invalidBody = structuredClone(original);
  invalidBody.bodies.push({ kind: 'stalker', name: 'broken' });
  tests.push([invalidBody, /body/]);
  const invalidTerrain = structuredClone(original);
  invalidTerrain.terrain.data = 'AAAA';
  tests.push([invalidTerrain, /terrain|run|length|size|RLE/i]);
  for (const [snapshot, expected] of tests) {
    assert.throws(() => restoreSolo(snapshot, env), expected);
    assert.deepEqual(captureSolo(env), original, 'failed restore left the live game intact');
  }
});

test('additive Solo save fields are tolerated without losing existing progress', () => {
  const env = environment();
  const saved = captureSolo(env);
  saved.futureAdditiveField = { weather: 'clear' };
  saved.state.extraCounter = 10;
  assert.equal(validateSolo(saved).length, env.world.data.length);
  restoreSolo(saved, env);
  assert.equal(env.state.score, 350);
  assert.equal(env.state.wave, 7);
});

test('missing browser storage reports a clear error instead of pretending to save', async () => {
  const store = new SoloSaveStore({ indexedDB: null });
  await assert.rejects(store.list(), /need browser storage/);
  await assert.rejects(store.put({ id: 'aabbccddeeff0011', name: 'My bricks', snapshot: captureSolo(environment()) }), /need browser storage/);
});

test('IndexedDB commits survive reopening and refuse to overwrite a newer save', { skip: !process.env.PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>');
      return;
    }
    if (!/^\/(src|vendor)\/[a-zA-Z0-9.-]+\.js$/.test(req.url)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL(`..${req.url}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async (snapshot) => {
      const { SoloSaveStore } = await import('/src/solo-saves.js');
      const store = new SoloSaveStore();
      const record = await store.put({ id: 'abcdef0123456789', name: 'First world', snapshot });
      await store.close();
      const reopened = new SoloSaveStore();
      const saved = await reopened.get(record.id);
      const list = await reopened.list();
      const db = await reopened.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('worlds', 'readwrite');
        tx.objectStore('worlds').put({ ...record, id: 'aabbccdd00112233', version: 99, snapshot: { ...snapshot, version: 99 } });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
      let getRejected = false, putRejected = false;
      try { await reopened.get('aabbccdd00112233'); } catch (error) { getRejected = error.message.includes('newer game version'); }
      try { await reopened.put({ id: 'aabbccdd00112233', name: 'Overwrite newer', snapshot }); } catch (error) { putRejected = error.message.includes('kept'); }
      const beforeDelete = await reopened.list();
      await reopened.delete(record.id);
      const afterDelete = await reopened.list();
      await reopened.close();
      return { name: saved.name, health: saved.snapshot.player.health, list: list.length, getRejected, putRejected,
        newerPreserved: beforeDelete.find((r) => r.id === 'aabbccdd00112233')?.version, remaining: afterDelete.length };
    }, captureSolo(environment()));
    assert.deepEqual(result, { name: 'First world', health: 100, list: 1, getRejected: true, putRejected: true, newerPreserved: 99, remaining: 1 });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
