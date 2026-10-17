import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createGameServer } from './server.mjs';
import { BLOCK } from '../src/world.js';
import { createEnemy } from './headless.mjs';

async function running(t, options = {}) {
  const server = await createGameServer({ dataDir: null, tickMs: 100_000, snapshotMs: 20, ...options });
  const address = await server.listen(0, '127.0.0.1');
  let closed = false;
  t.after(async () => { if (!closed) await server.close(); });
  return { server, url: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/multiplayer`, async close() { await server.close(); closed = true; } };
}

async function client(t, url) {
  const socket = new WebSocket(url);
  const queue = [];
  const waits = new Set();
  socket.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    const waiter = [...waits].find(w => w.match(msg));
    if (waiter) { waits.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(msg); }
    else queue.push(msg);
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  return {
    socket, send: msg => socket.send(JSON.stringify(msg)),
    wait(match) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { waits.delete(waiter); reject(new Error('Timed out waiting for multiplayer packet')); }, 3000) };
        waits.add(waiter);
      });
    },
    async close() { const closed = once(socket, 'close'); socket.close(); await closed; },
  };
}

async function create(t, game, gameMode = 'build') {
  const a = await client(t, game.ws);
  a.send({ type: 'create', name: 'Alice', gameMode });
  return { a, welcome: await a.wait(m => m.type === 'welcome') };
}
function targetGround(room, player) {
  for (const pitch of [-0.5, -0.75, -1, -0.3, 0]) for (let yaw = 0; yaw < 6.28; yaw += 0.3) {
    const probe = { ...player, yaw, pitch };
    const hit = room.world.raycast(room.eye(probe), room.dir(probe), 6);
    if (!hit || hit.dist < 2 || room.world.get(hit.x, hit.y, hit.z) === BLOCK.BEDROCK) continue;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    if (!room.world.inBounds(x, y, z) || room.world.isSolid(x, y, z)) continue;
    if ([...room.players.values()].some(p => Math.abs(x + 0.5 - p.pos.x) < 1 && Math.abs(z + 0.5 - p.pos.z) < 1)) continue;
    return { yaw, pitch, hit, place: [x, y, z] };
  }
  throw new Error('No reachable ground in generated spawn area');
}
async function point(client, player, aim) {
  client.send({ type: 'pose', x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: aim.yaw, pitch: aim.pitch, active: false });
  await client.wait(m => m.type === 'state' && m.players.some(p => p.id === player.id && p.active === false && p.pitch === aim.pitch));
}

test('HTTP serves game assets while repository files and foreign WebSocket origins are blocked', async t => {
  const game = await running(t);
  assert.equal((await fetch(game.url + '/')).status, 200);
  assert.match((await fetch(game.url + '/src/main.js')).headers.get('content-type'), /javascript/);
  assert.deepEqual(await (await fetch(game.url + '/healthz')).json(), { ok: true, rooms: 0, players: 0 });
  for (const pathname of ['/.git/config', '/package.json', '/node_modules/ws/package.json', '/server/main.mjs', '/test/smoke.mjs', '/src/%2e%2e%2f.git/config', '/vendor/../../../etc/passwd']) {
    assert.equal((await fetch(game.url + pathname)).status, 404, pathname);
  }
  assert.equal((await fetch(game.url, { method: 'POST' })).status, 405);
  const socket = new WebSocket(game.ws, { origin: 'http://unrelated.example' });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.on('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 403); response.resume(); socket.terminate(); resolve(); });
    socket.on('open', () => reject(new Error('Cross-origin socket accepted')));
    socket.on('error', () => {});
  });
});

test('two browsers share authoritative building, validate actions, late joins and host handoff', async t => {
  const game = await running(t);
  const { a, welcome } = await create(t, game);
  const room = game.server.rooms.get(welcome.roomCode);
  const player = room.players.get(welcome.playerId);
  assert.equal(room.world.meshes.length, 0, 'server never builds chunks');
  const b = await client(t, game.ws);
  b.send({ type: 'join', roomCode: welcome.roomCode.toLowerCase(), name: 'Bob' });
  const joined = await b.wait(m => m.type === 'welcome');
  assert.equal(joined.state.players.length, 2);
  assert.ok(player.pos.distanceTo(room.players.get(joined.playerId).pos) >= 1.25, 'joining players have separate spawn positions');
  assert.equal(joined.world.seed, welcome.world.seed);
  const aim = targetGround(room, player);
  await point(a, player, aim);
  a.send({ type: 'action', action: 'place', block: BLOCK.RED, x: 0, y: 0, z: 0 });
  const edits = await b.wait(m => m.type === 'blocks');
  assert.deepEqual(edits.blocks, [[...aim.place, BLOCK.RED]], 'server chooses ray hit, ignoring claimed coordinates');
  assert.equal(room.world.get(...aim.place), BLOCK.RED);
  a.send({ type: 'action', action: 'place', block: BLOCK.BEDROCK });
  a.send({ type: 'action', action: 'place', block: BLOCK.BLUE });
  a.send({ type: 'pose', x: 1e9, y: 0, z: 1e9, yaw: 0, pitch: 0 });
  const corrected = await a.wait(m => m.type === 'correction');
  assert.equal(corrected.x, player.pos.x);
  assert.equal(room.blocks.size, 1, 'forbidden blocks and cooldown burst do not edit');
  a.send({ type: 'setBlock', x: 0, y: 0, z: 0, block: 0 });
  assert.equal((await a.wait(m => m.type === 'error')).code, 'BAD_MESSAGE');
  const c = await client(t, game.ws);
  c.send({ type: 'join', roomCode: welcome.roomCode, name: 'Carol' });
  const late = await c.wait(m => m.type === 'welcome');
  assert.deepEqual(late.blocks, edits.blocks, 'late join includes full edited world');
  b.send({ type: 'action', action: 'reset' });
  await b.wait(m => m.type === 'state' && m.players.length === 3);
  assert.equal(room.world.seed, welcome.world.seed, 'only host resets room');
  await a.close();
  await b.wait(m => m.type === 'state' && m.hostId === joined.playerId && m.players.length === 2);
  assert.equal(room.hostId, joined.playerId);
  b.send({ type: 'action', action: 'reset' });
  const reset = await c.wait(m => m.type === 'world');
  assert.equal(reset.blocks.length, 0);
  assert.notEqual(reset.world.seed, welcome.world.seed);
});

test('shared wave simulation, combat health, respawn, tomatoes and bodies stay authoritative', async t => {
  const game = await running(t);
  const { a, welcome } = await create(t, game, 'wave');
  const b = await client(t, game.ws);
  b.send({ type: 'join', roomCode: welcome.roomCode, name: 'Bob' });
  await b.wait(m => m.type === 'welcome');
  const room = game.server.rooms.get(welcome.roomCode);
  const player = room.players.get(welcome.playerId);
  room.tick(1.6);
  const state = await b.wait(m => m.type === 'state' && m.enemies.length === 1);
  assert.equal(state.remaining, 3);
  assert.equal(state.wave, 1);
  assert.equal(room.enemies[0].group.isMesh, undefined, 'enemy simulation has transforms without meshes');
  for (let i = 0; i < 40; i++) room.tick(0.05);
  assert.ok(room.enemies.every(e => [e.pos.x, e.pos.y, e.pos.z, e.hp].every(Number.isFinite)), 'full wave simulation runs for two seconds');
  a.send({ type: 'action', action: 'tomato', damage: 1e9 });
  a.send({ type: 'action', action: 'tomato' });
  const thrown = await b.wait(m => m.type === 'state' && m.projectiles.length === 1);
  assert.equal(thrown.players.find(p => p.id === welcome.playerId).tomatoes, 2, 'one tomato consumed; throw spam rejected');
  const stalker = createEnemy('stalker', player.pos.x + 2, player.pos.y, player.pos.z);
  stalker.id = 'test-stalker';
  room.enemies.push(stalker);
  assert.equal(stalker.hit(1000, 1, 0), true);
  room.killEnemy(stalker);
  room.tick(0.05);
  const sharedBody = await b.wait(m => m.type === 'state' && m.bodies.length === 1);
  assert.equal(sharedBody.bodies[0].id, stalker.id);
  assert.equal(sharedBody.bodies[0].limbs.length, 6);
  assert.ok(Number.isFinite(sharedBody.bodies[0].qw));
  room.hurt(player, 1000);
  a.send({ type: 'pose', x: player.pos.x + 1, y: player.pos.y, z: player.pos.z, yaw: 0, pitch: 0 });
  const dead = await a.wait(m => m.type === 'state' && m.players.find(p => p.id === player.id).health === 0);
  assert.equal(dead.players.find(p => p.id === player.id).health, 0);
  a.send({ type: 'action', action: 'respawn' });
  await a.wait(m => m.type === 'correction');
  const live = await b.wait(m => m.type === 'state' && m.players.find(p => p.id === player.id).health === 100);
  assert.equal(live.players.find(p => p.id === player.id).tomatoes, 3);
  room.hurt(player, 1000);
  a.send({ type: 'action', action: 'respawn' });
  assert.equal((await a.wait(m => m.type === 'error' && m.code === 'RESPAWN_COOLDOWN')).code, 'RESPAWN_COOLDOWN');
  assert.equal(player.health, 0, 'rapid death/respawn cooldown has an explicit rejection');
  player.nextRespawn = 0;
  a.send({ type: 'action', action: 'respawn' });
  await a.wait(m => m.type === 'correction');
  room.enemies.length = 0; room.remaining = 0;
  room.tick(0.05); room.tick(5.1);
  const next = await b.wait(m => m.type === 'state' && m.wave === 2);
  assert.equal(next.players.find(p => p.id === player.id).tomatoes, 6);
});

test('pose movement budgets reject rapid movement while immediate pose/action sequences work', async t => {
  const game = await running(t);
  const { a, welcome } = await create(t, game);
  const room = game.server.rooms.get(welcome.roomCode);
  const player = room.players.get(welcome.playerId);
  // Clear a small test corridor above the world. Both client and authoritative
  // position begin there; the fixture does not grant movement to incoming poses.
  player.pos.set(50.5, 49, 50.5); player.moveBudget = 0.65; player.budgetTime = Date.now();
  const sendPose = x => a.send({ type: 'pose', x, y: 49, z: 50.5, yaw: 0, pitch: 0 });
  sendPose(50.7);
  a.send({ type: 'action', action: 'tomato' });
  sendPose(50.9);
  a.send({ type: 'action', action: 'tomato' });
  for (let i = 1; i <= 8; i++) sendPose(50.9 + i * 0.3);
  await a.wait(m => m.type === 'correction');
  assert.ok(player.pos.x < 51.6, 'per-message tolerance cannot accumulate into rapid movement');
  assert.equal(room.projectiles.length, 1, 'action uses immediately preceding pose and throw cooldown');
  assert.ok(Math.abs(room.projectiles[0].pos.x - 50.7) < 0.01);
});

test('naming a selected moving body uses visible proximity and rejects distant or occluded bodies', async t => {
  const game = await running(t);
  const { a, welcome } = await create(t, game);
  const room = game.server.rooms.get(welcome.roomCode);
  const player = room.players.get(welcome.playerId);
  player.pos.set(50.5, 42, 50.5);
  player.yaw = Math.PI / 2; // Looking away while typing must still allow naming.
  const stalker = createEnemy('stalker', 52.5, 42, 50.5);
  stalker.id = 'nameable-body';
  const body = room.addBody(stalker);
  body.com.set(52.5, 43.62, 50.5); body.sync();
  a.send({ type: 'action', action: 'name', bodyId: body.id, name: '  Gerald  ' });
  await a.wait(m => m.type === 'state' && m.bodies.some(b => b.name === 'Gerald'));
  assert.equal(body.name, 'Gerald');
  body.com.x = 70; body.sync();
  a.send({ type: 'action', action: 'name', bodyId: body.id, name: 'Too distant' });
  await a.wait(m => m.type === 'state' && m.bodies[0]?.x > 65);
  assert.equal(body.name, 'Gerald');
  body.com.x = 54.5; body.sync();
  for (let y = 40; y <= 47; y++) for (let z = 48; z <= 52; z++) room.world.set(52, y, z, BLOCK.STONE);
  a.send({ type: 'action', action: 'name', bodyId: body.id, name: 'Behind wall' });
  await a.wait(m => m.type === 'state' && m.bodies[0]?.x < 60);
  assert.equal(body.name, 'Gerald', 'wall between eye and selected body prevents naming');
});

test('shared builds and room codes survive server restarts', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'legocraft-save-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await running(t, { dataDir });
  const { a, welcome } = await create(t, first);
  const room = first.server.rooms.get(welcome.roomCode);
  const player = room.players.get(welcome.playerId);
  const aim = targetGround(room, player);
  await point(a, player, aim);
  a.send({ type: 'action', action: 'place', block: BLOCK.GOLD });
  const edit = await a.wait(m => m.type === 'blocks');
  await a.close();
  await first.close();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.deepEqual(saved.rooms[0].blocks, edit.blocks);
  const second = await running(t, { dataDir });
  const newcomer = await client(t, second.ws);
  newcomer.send({ type: 'join', roomCode: welcome.roomCode, name: 'Returning builder' });
  const restored = await newcomer.wait(m => m.type === 'welcome');
  assert.equal(restored.world.seed, welcome.world.seed);
  assert.deepEqual(restored.blocks, edit.blocks);
  assert.equal(restored.hostId, restored.playerId);
  assert.equal(second.server.rooms.get(welcome.roomCode).world.get(...aim.place), BLOCK.GOLD);
});

test('room size limit and empty room expiration release server capacity', async t => {
  const game = await running(t, { maxPlayers: 2, maxRooms: 1, emptyRoomTtlMs: 0, tickMs: 20 });
  const { a, welcome } = await create(t, game);
  const b = await client(t, game.ws);
  b.send({ type: 'join', roomCode: welcome.roomCode });
  await b.wait(m => m.type === 'welcome');
  const c = await client(t, game.ws);
  c.send({ type: 'join', roomCode: welcome.roomCode });
  assert.equal((await c.wait(m => m.type === 'error')).code, 'ROOM_FULL');
  c.send({ type: 'create', gameMode: 'build' });
  assert.equal((await c.wait(m => m.type === 'error')).code, 'SERVER_FULL');
  await a.close(); await b.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  c.send({ type: 'create', gameMode: 'build' });
  assert.equal((await c.wait(m => m.type === 'welcome')).state.players.length, 1);
});
