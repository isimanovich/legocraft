import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Room } from './room.mjs';
import { createEnemy, createAnimal } from './headless.mjs';
import { BLOCK, DEFAULT_HOTBAR } from '../src/world.js';
import { BLOCK_PALETTE, WORLD_SIZE, encodeTerrain, decodeTerrain } from '../src/save-format.js';

const aliceId = 'aabbccdd-1234-4567-8888-123456789abc';
const makeRoom = saved => new Room('ABCDEF', saved?.gameMode ?? 'wave', () => {}, () => {}, saved ?? { seed: 12345 });
const diskRoundTrip = room => JSON.parse(JSON.stringify(room.persisted()));
const vector = p => ({ x: p.x, y: p.y, z: p.z });

test('full terrain palette codec preserves every block and validates future/corrupt saves', () => {
  const data = new Uint8Array(WORLD_SIZE.sizeX * WORLD_SIZE.sizeY * WORLD_SIZE.sizeZ);
  data.fill(BLOCK.STONE, 100000, 800000);
  for (const [name, id] of Object.entries(BLOCK)) {
    assert.equal(BLOCK_PALETTE[id], name, 'stable IDs must remain compatible with existing worlds');
    data[id * 1703] = id;
  }
  const terrain = encodeTerrain(data);
  assert.deepEqual(decodeTerrain(JSON.parse(JSON.stringify(terrain))), data);
  assert.ok(terrain.data.length < data.length / 20, 'long terrain runs compress without platform dependencies');
  assert.throws(() => decodeTerrain({ ...terrain, version: 999 }), /Unsupported/);
  assert.throws(() => decodeTerrain({ ...terrain, sizeX: 100000 }), /dimensions/);
  assert.throws(() => decodeTerrain({ ...terrain, palette: ['FUTURE_BRICK'] }), /Unknown saved block/);
  assert.throws(() => decodeTerrain({ ...terrain, data: btoa('\0\0\0') }), /Invalid terrain run/);
  assert.throws(() => decodeTerrain({ ...terrain, data: btoa(String.fromCharCode(1, 0, 0)) }), /Incomplete/);
  assert.throws(() => decodeTerrain({ ...terrain, data: '!!!!' }), /Invalid encoded/);
  assert.throws(() => makeRoom({ formatVersion: 999, seed: 12345 }), /Unsupported world save version/);
});

test('terrain palette names translate saved IDs instead of relying on palette ordering', () => {
  const data = new Uint8Array(WORLD_SIZE.sizeX * WORLD_SIZE.sizeY * WORLD_SIZE.sizeZ).fill(BLOCK.GOLD);
  const terrain = encodeTerrain(data);
  const binary = Uint8Array.from(atob(terrain.data), c => c.charCodeAt(0));
  terrain.palette.reverse();
  for (let i = 2; i < binary.length; i += 3) binary[i] = terrain.palette.indexOf('GOLD');
  terrain.data = btoa(String.fromCharCode(...binary));
  assert.deepEqual(decodeTerrain(terrain), data);
});

test('a disk round trip resumes terrain, wave progress, actors, named bodies and player inventory', () => {
  const room = makeRoom();
  room.name = 'Family castle';
  const p = room.addPlayer({}, 'Alice', aliceId);
  p.pos.set(62.5, 49, 71.5); p.yaw = 1.25; p.pitch = -0.3;
  p.health = 46; p.regenDelay = 3.25; p.tomatoes = 2;
  p.hotbar = ['sword', BLOCK.GOLD, ...DEFAULT_HOTBAR.slice(2)]; p.slot = 1;
  room.wave = 7; room.score = 4321; room.kills = 27;
  room.remaining = 2; room.intermission = 2.75; room.spawnTimer = 0.42;
  room.edit(4, 41, 7, BLOCK.PINK);
  // This deliberate non-delta terrain change represents an older generator.
  // A seed+delta restore would lose it when future terrain generation changes.
  room.world.data[room.world.idx(6, 43, 9)] = BLOCK.GOLD;
  const enemy = createEnemy('bomber', 54.5, 41, 60.5, 7);
  enemy.id = 'saved-enemy'; enemy.hp = 27; enemy.state = 'chase';
  enemy.vel.set(1, -2, 3); enemy.fuse = 1.4; enemy.windup = 0.2;
  enemy.path = [{ x: 55.5, y: 41, z: 61.5 }]; enemy.wanderDir.set(0.4, 0, 0.8);
  room.enemies.push(enemy);
  const animal = createAnimal('cat', 50.5, 40, 63.5);
  animal.id = 'saved-cat'; animal.state = 'flee'; animal.timer = 2.8;
  animal.vel.set(-1, 2, 0.5); animal.dir.set(-1, 0, 0);
  room.animals.push(animal);
  const fallen = createEnemy('stalker', 65, 42, 70);
  fallen.id = 'saved-body';
  const body = room.addBody(fallen);
  body.name = 'Gerald'; body.com.set(65, 43, 70); body.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  body.vel.set(1, 0, -2); body.angVel.set(0.2, 0.3, 0.4); body.up.set(0, 1, 0).applyQuaternion(body.q);
  body.limbs[0].node.rotation.x = 0.5; body.limbs[0].vx = 0.75;
  body.carried = true; body.carrying = p.id; p.carryId = body.id; body.pinned = false;
  body.sync();
  room.projectiles.push({ id: 'flying-tomato', ownerId: p.id, pos: new THREE.Vector3(60, 45, 70), vel: new THREE.Vector3(2, 4, -3), life: 1.2 });

  const saved = diskRoundTrip(room);
  assert.throws(() => makeRoom({ ...saved, enemies: [{ kind: 'future-dragon', pos: { x: 1, y: 2, z: 3 } }] }), { code: 'UNSUPPORTED_SAVE_FORMAT' }, 'new actor types must never be silently erased by an older game');
  const restored = makeRoom(saved);
  assert.equal(restored.players.size, 0, 'server restarts restore profiles, not fake online peers');
  assert.deepEqual(restored.world.data, room.world.data, 'entire original terrain survives independently of regeneration');
  assert.equal(restored.name, room.name);
  assert.equal(restored.createdAt, room.createdAt);
  for (const key of ['wave', 'score', 'kills', 'remaining', 'intermission', 'spawnTimer']) assert.equal(restored[key], room[key], key);
  assert.equal(restored.enemies[0].hp, 27);
  assert.equal(restored.enemies[0].fuse, 1.4);
  assert.deepEqual(vector(restored.enemies[0].vel), vector(enemy.vel));
  assert.deepEqual(restored.enemies[0].path, enemy.path);
  assert.deepEqual(vector(restored.animals[0].pos), vector(animal.pos));
  assert.equal(restored.animals[0].state, 'flee');
  assert.equal(restored.animals[0].timer, 2.8);
  const restoredBody = restored.ragdolls.bodies[0];
  assert.equal(restoredBody.name, 'Gerald');
  assert.equal(restoredBody.id, body.id);
  assert.equal(restoredBody.carried, false, 'offline hands are released');
  assert.deepEqual(vector(restoredBody.com), vector(body.com));
  assert.ok(restoredBody.q.angleTo(body.q) < 1e-7);
  assert.equal(restoredBody.limbs[0].node.rotation.x, 0.5);
  assert.equal(restoredBody.limbs[0].vx, 0.75);
  assert.deepEqual(restoredBody.limbs[0].rest, body.limbs[0].rest);
  assert.deepEqual(vector(restored.projectiles[0].vel), { x: 2, y: 4, z: -3 });
  assert.equal(restored.projectiles[0].life, 1.2);
  const returning = restored.addPlayer({}, 'Alice', aliceId);
  assert.notEqual(returning.id, p.id, 'connection IDs are independent of saved profiles');
  for (const key of ['health', 'tomatoes', 'yaw', 'pitch', 'slot']) assert.equal(returning[key], p[key], key);
  assert.deepEqual(vector(returning.pos), vector(p.pos));
  assert.deepEqual(returning.hotbar, p.hotbar);
  assert.equal(restored.snapshot().players[0].slot, 1);
  restored.tick(0.05);
  assert.ok(restored.enemies.every(e => Number.isFinite(e.pos.y)), 'restored simulation can keep running');
});

test('legacy seed and block edits migrate transparently to complete versioned terrain', () => {
  const room = makeRoom({ code: 'ABCDEF', gameMode: 'build', seed: 42, blocks: [[10, 41, 10, BLOCK.GOLD]], wave: 4, score: 123, kills: 7 });
  assert.equal(room.world.get(10, 41, 10), BLOCK.GOLD);
  const saved = diskRoundTrip(room);
  assert.equal(saved.formatVersion, 2);
  assert.deepEqual(decodeTerrain(saved.terrain), room.world.data);
  const restored = makeRoom(saved);
  assert.equal(restored.score, 123);
  assert.equal(restored.world.get(10, 41, 10), BLOCK.GOLD);
});

test('disconnected players keep a separate profile and duplicate active client IDs cannot replace it', () => {
  const room = makeRoom();
  const first = room.addPlayer({}, 'Alice', aliceId);
  first.health = 22; first.tomatoes = 1;
  const duplicate = room.addPlayer({}, 'Another tab', aliceId);
  assert.notEqual(duplicate.clientId, first.clientId);
  assert.equal(duplicate.health, 100);
  room.removePlayer(first);
  const returning = room.addPlayer({}, 'Alice', aliceId);
  assert.equal(returning.health, 22);
  assert.equal(returning.tomatoes, 1);
  room.acceptPose(returning, { ...vector(returning.pos), yaw: returning.yaw, pitch: returning.pitch, hotbar: [BLOCK.BEDROCK], slot: 999 });
  assert.deepEqual(returning.hotbar, DEFAULT_HOTBAR);
  assert.equal(returning.slot, 0);
});

test('new browsers evict the oldest offline profile before reaching an unsavable profile count', () => {
  const room = makeRoom();
  const active = room.addPlayer({}, 'Alice', aliceId);
  active.health = 27;
  for (let i = 0; i < 255; i++) {
    const clientId = i.toString(16).padStart(16, '0');
    room.profiles.set(clientId, { ...room.playerProfile(active), clientId, updatedAt: i });
  }
  const newcomer = room.addPlayer({}, 'New player', 'ffffffffffffffff');
  assert.equal(room.profiles.size, 256);
  assert.equal(room.profiles.has('0000000000000000'), false);
  assert.equal(room.profiles.has(aliceId), true, 'active profiles are retained');
  assert.equal(room.profiles.has(newcomer.clientId), true);
  const restored = makeRoom(diskRoundTrip(room));
  assert.equal(restored.profiles.size, 256, 'the complete bounded save can be reopened');
  assert.equal(restored.addPlayer({}, 'Alice', aliceId).health, 27);
});
