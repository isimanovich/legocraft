import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPersistence, unsupportedSave } from './persistence.mjs';
import { createGameServer } from './server.mjs';
import { BLOCK, DEFAULT_HOTBAR } from '../src/world.js';

const quiet = { warn() {}, error() {} };
const serversByDirectory = new Map();
const primitiveRoom = { code: 'ABCDEF', value: 1 };
const validatePrimitive = room => {
  if (room?.formatVersion > 2) throw unsupportedSave('Newer world format.');
  if (!room || !/^[A-Z]{6}$/.test(room.code) || !Number.isInteger(room.value)) throw new Error('Invalid saved world.');
};
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'legocraft-durable-'));
  t.after(async () => {
    // Close writers before removing their directory; short-interval autosave
    // fixtures could otherwise recreate it while the cleanup traverses it.
    try { for (const close of serversByDirectory.get(dir) || []) await close(); }
    finally { serversByDirectory.delete(dir); await rm(dir, { recursive: true, force: true }); }
  });
  return dir;
}
const storeFor = dir => createPersistence(dir, { validateRoom: validatePrimitive, logger: quiet });

test('atomic storage keeps a complete previous snapshot and restores a damaged primary', async t => {
  const dir = await directory(t), store = storeFor(dir);
  assert.deepEqual(await store.load(), { version: 2, rooms: [] });
  await store.write([primitiveRoom]);
  await store.write([{ ...primitiveRoom, value: 2 }]);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'rooms.json.bak'), 'utf8')).rooms[0].value, 1);
  await writeFile(path.join(dir, 'rooms.json'), '{interrupted');
  const recovered = await storeFor(dir).load();
  assert.equal(recovered.rooms[0].value, 1);
  const archived = (await readdir(dir)).find(name => name.startsWith('rooms.json.corrupt-'));
  assert.ok(archived);
  assert.equal(await readFile(path.join(dir, archived), 'utf8'), '{interrupted');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8')), recovered);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('newer versions refuse startup without rolling back or rewriting any files', async t => {
  const dir = await directory(t), store = storeFor(dir);
  await store.load(); await store.write([primitiveRoom]); await store.write([{ ...primitiveRoom, value: 2 }]);
  for (const future of [
    { version: 3, rooms: [primitiveRoom] },
    { version: 2, rooms: [{ ...primitiveRoom, formatVersion: 3 }] },
    { version: 2, rooms: [{ code: 'BROKEN', value: null }, { ...primitiveRoom, formatVersion: 3 }] },
  ]) {
    const raw = JSON.stringify(future);
    await writeFile(path.join(dir, 'rooms.json'), raw);
    await assert.rejects(() => storeFor(dir).load(), { code: 'UNSUPPORTED_SAVE_FORMAT' });
    assert.equal(await readFile(path.join(dir, 'rooms.json'), 'utf8'), raw);
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('rooms.json.corrupt-')));
  }
});

test('invalid worlds fail intact and failed disk writes preserve the primary snapshot', async t => {
  const dir = await directory(t), invalid = '{"version":2,"rooms":[{"code":"ABCDEF","value":"bad"}]}';
  await writeFile(path.join(dir, 'rooms.json'), invalid);
  await assert.rejects(() => storeFor(dir).load(), /Existing files were left unchanged/);
  assert.equal(await readFile(path.join(dir, 'rooms.json'), 'utf8'), invalid);
  await rm(path.join(dir, 'rooms.json'));
  const store = storeFor(dir); await store.load(); await store.write([primitiveRoom]);
  const before = await readFile(path.join(dir, 'rooms.json'), 'utf8');
  await mkdir(path.join(dir, 'rooms.json.bak'));
  await assert.rejects(() => store.write([{ ...primitiveRoom, value: 2 }]));
  assert.equal(await readFile(path.join(dir, 'rooms.json'), 'utf8'), before);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

async function running(t, dir, options = {}) {
  const game = await createGameServer({ dataDir: dir, tickMs: 100_000, snapshotMs: 100_000, logger: quiet, ...options });
  const address = await game.listen(0, '127.0.0.1');
  let closed = false;
  async function close() { if (closed) return; closed = true; await game.close(); }
  if (!serversByDirectory.has(dir)) serversByDirectory.set(dir, []);
  serversByDirectory.get(dir).push(close);
  t.after(close);
  return { game, url: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/multiplayer`, close };
}
async function client(t, url) {
  const socket = new WebSocket(url), queue = [], waits = new Set();
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()), wait = [...waits].find(w => w.match(message));
    if (wait) { waits.delete(wait); clearTimeout(wait.timer); wait.resolve(message); }
    else queue.push(message);
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  return {
    send: value => socket.send(JSON.stringify(value)),
    wait(match) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiting = { match, resolve, timer: setTimeout(() => { waits.delete(waiting); reject(new Error('Timed out waiting for saved-world packet')); }, 3000) };
        waits.add(waiting);
      });
    },
    async close() { const done = once(socket, 'close'); socket.close(); await done; },
  };
}

test('legacy worlds migrate with an untouched upgrade backup and complete frozen terrain', async t => {
  const dir = await directory(t);
  const legacy = { version: 1, rooms: [{ code: 'ABCDEF', gameMode: 'build', seed: 12345, blocks: [[20, 35, 20, BLOCK.GOLD]], score: 9, kills: 2, wave: 3 }] };
  const raw = JSON.stringify(legacy);
  await writeFile(path.join(dir, 'rooms.json'), raw);
  const runningGame = await running(t, dir);
  const names = await readdir(dir), backup = names.find(name => name.startsWith('rooms.json.v1-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dir, backup), 'utf8'), raw);
  const stored = JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.rooms[0].formatVersion, 2);
  assert.equal(stored.rooms[0].terrain.encoding, 'rle8-base64');
  assert.equal(runningGame.game.rooms.get('ABCDEF').world.get(20, 35, 20), BLOCK.GOLD);
  assert.equal((await (await fetch(runningGame.url + '/api/worlds')).json()).worlds[0].code, 'ABCDEF');
});

test('named saved worlds resume profiles after reboot, remain listed, and export safely', async t => {
  const dir = await directory(t), first = await running(t, dir, { emptyRoomTtlMs: 0, tickMs: 20 });
  const alice = await client(t, first.ws), clientId = 'abcd1234-abcd-1234-abcd-123456789abc';
  alice.send({ type: 'create', gameMode: 'build', name: 'Alice', worldName: 'Kids castle', clientId });
  const welcome = await alice.wait(message => message.type === 'welcome');
  assert.equal(welcome.savedWorld.name, 'Kids castle');
  const room = first.game.rooms.get(welcome.roomCode), player = room.players.get(welcome.playerId);
  player.pos.set(30.5, 49, 30.5); player.health = 63; player.regenDelay = 5; player.tomatoes = 4;
  player.hotbar = [...DEFAULT_HOTBAR]; player.hotbar[1] = BLOCK.GOLD; player.slot = 1;
  room.score = 789; room.world.set(42, 42, 42, BLOCK.PURPLE);
  alice.send({ type: 'action', action: 'save' });
  const acknowledgment = await alice.wait(message => message.type === 'saved');
  assert.equal(acknowledgment.code, welcome.roomCode);
  const onDisk = JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8'));
  assert.equal(onDisk.rooms[0].score, 789, 'save acknowledgment follows durable write');
  await alice.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(first.game.rooms.size, 1, 'persistent rooms never expire while empty');
  await first.close();
  const second = await running(t, dir);
  const catalog = await (await fetch(second.url + '/api/worlds')).json();
  assert.equal(catalog.persistence, true);
  assert.equal(catalog.worlds[0].status, 'saved');
  assert.equal(catalog.worlds[0].name, 'Kids castle');
  const exported = await fetch(second.url + `/api/worlds/${welcome.roomCode}/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal((await exported.json()).rooms[0].score, 789);
  assert.equal((await fetch(second.url + '/api/worlds/../../rooms.json/export')).status, 404);
  const returning = await client(t, second.ws);
  returning.send({ type: 'join', roomCode: welcome.roomCode, name: 'Alice', clientId });
  const restored = await returning.wait(message => message.type === 'welcome');
  const me = restored.state.players.find(p => p.id === restored.playerId);
  assert.equal(me.health, 63); assert.equal(me.tomatoes, 4); assert.equal(me.slot, 1);
  assert.deepEqual(me.hotbar, player.hotbar);
  assert.equal(me.x, 30.5); assert.equal(me.y, 49);
  assert.equal(second.game.rooms.get(welcome.roomCode).world.get(42, 42, 42), BLOCK.PURPLE, 'full terrain includes edits outside legacy deltas');
});

test('automatic snapshots capture live progress and save errors do not claim success', async t => {
  const dir = await directory(t), live = await running(t, dir, { autosaveMs: 25 });
  const a = await client(t, live.ws);
  a.send({ type: 'create', gameMode: 'build', name: 'Builder', worldName: 'Automatic' });
  const welcome = await a.wait(message => message.type === 'welcome');
  const room = live.game.rooms.get(welcome.roomCode);
  room.score = 456;
  for (let i = 0; i < 100; i++) {
    try { if (JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8')).rooms[0].score === 456) break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8')).rooms[0].score, 456);
  // A directory at the backup path reliably simulates a disk write failure even
  // when tests run as root; permissions alone would not do so.
  await rm(path.join(dir, 'rooms.json.bak'), { force: true });
  await mkdir(path.join(dir, 'rooms.json.bak'));
  await a.wait(message => message.type === 'error' && message.code === 'AUTOSAVE_FAILED');
  a.send({ type: 'action', action: 'save' });
  assert.equal((await a.wait(message => message.type === 'error' && message.code === 'SAVE_FAILED')).code, 'SAVE_FAILED');
  await rm(path.join(dir, 'rooms.json.bak'), { recursive: true });
});

test('host reset checkpoints the previous world and rename persists for all players', async t => {
  const dir = await directory(t), live = await running(t, dir);
  const a = await client(t, live.ws);
  a.send({ type: 'create', gameMode: 'build', worldName: 'Before reset' });
  const welcome = await a.wait(message => message.type === 'welcome');
  const room = live.game.rooms.get(welcome.roomCode);
  room.world.set(40, 40, 40, BLOCK.RED); room.score = 123;
  a.send({ type: 'action', action: 'rename', name: 'After rename' });
  assert.equal((await a.wait(message => message.type === 'saved')).name, 'After rename');
  const other = await client(t, live.ws);
  other.send({ type: 'join', roomCode: welcome.roomCode }); await other.wait(message => message.type === 'welcome');
  other.send({ type: 'action', action: 'rename', name: 'Denied' });
  assert.equal((await other.wait(message => message.type === 'error')).code, 'HOST_ONLY');
  a.send({ type: 'action', action: 'reset' });
  await a.wait(message => message.type === 'world');
  const checkpoint = (await readdir(dir)).find(name => name.startsWith('rooms.json.before-reset-'));
  assert.ok(checkpoint);
  assert.equal(JSON.parse(await readFile(path.join(dir, checkpoint), 'utf8')).rooms[0].score, 123);
  assert.equal(room.score, 0);
});

test('future blocks and actors remain untouched, while a damaged actor recovers the backup', async t => {
  const dir = await directory(t), first = await running(t, dir);
  const a = await client(t, first.ws);
  a.send({ type: 'create', gameMode: 'build', worldName: 'Compatible world' });
  await a.wait(message => message.type === 'welcome');
  await first.game.flushPersistence(); await first.close();
  const original = JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8'));
  for (const change of [
    room => { room.terrain.version = 2; },
    room => { room.terrain.encoding = 'future-rle'; },
    room => { room.terrain.palette.push('FUTURE_BLOCK'); room.blocks.push([20, 35, 20, 23]); },
    room => { room.enemies = [{ kind: 'future-creature', pos: { x: 10, y: 30, z: 10 } }]; },
  ]) {
    const newer = structuredClone(original); change(newer.rooms[0]);
    const raw = JSON.stringify(newer);
    await writeFile(path.join(dir, 'rooms.json'), raw);
    await assert.rejects(() => createGameServer({ dataDir: dir, logger: quiet }), /newer|Update/);
    assert.equal(await readFile(path.join(dir, 'rooms.json'), 'utf8'), raw);
  }
  const damaged = structuredClone(original);
  damaged.rooms[0].enemies = [{ kind: 'stalker', pos: null }];
  await writeFile(path.join(dir, 'rooms.json'), JSON.stringify(damaged));
  const restored = await running(t, dir);
  assert.equal(restored.game.rooms.size, 1);
  assert.equal([...restored.game.rooms.values()][0].name, 'Compatible world');
  assert.ok((await readdir(dir)).some(name => name.startsWith('rooms.json.corrupt-')));
});
