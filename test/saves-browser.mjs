// Optional real-browser persistence tests. See README for Playwright setup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGameServer } from '../server/server.mjs';
import { createEnemy } from '../server/headless.mjs';
import { BLOCK } from '../src/world.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
after(() => browser.close());

// Test-only access to state. Keep the normal rendering and gameplay code, with
// a smaller backing buffer so software rendering does not dominate these tests.
const hook = '\nrenderer.setPixelRatio(0.25);\nwindow.__game = { state, player, world, session, enemies, animals, ragdolls, tomatoes, hotbar, clearInput, soloSaves, saveSoloWorld, newGame };';

async function running(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'legocraft-saves-browser-'));
  let server = await createGameServer({ dataDir, ...options });
  const address = await server.listen(0, '127.0.0.1');
  t.after(async () => {
    await server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get server() { return server; },
    dataDir,
    url: `http://127.0.0.1:${address.port}`,
    async stop() { const previous = server; server = null; await previous.close(); },
    async restart() {
      server = await createGameServer({ dataDir, ...options });
      await server.listen(address.port, '127.0.0.1');
    },
  };
}

async function client(t, url) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 }, hasTouch: true,
    reducedMotion: 'reduce', deviceScaleFactor: 1,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(35000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/main.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.body()).toString() + hook });
  });
  await page.goto(url);
  await ready(page);
  await page.locator('#input-touch').click();
  return { page, errors };
}

async function ready(page) {
  await page.waitForFunction(() => window.__game?.state.mode === 'ready');
}

async function play(page) {
  await page.locator('#start-cta').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
}

async function pause(page) {
  await page.locator('[data-touch-action="pause"]').click();
  await page.waitForFunction(() => __game.state.mode === 'paused');
}

async function goldInSlotThree(page) {
  await page.locator('[data-touch-action="inventory"]').click();
  await page.getByRole('button', { name: /^Select hotbar slot 3 / }).click();
  await page.getByRole('button', { name: 'Put Gold brick in the selected hotbar slot', exact: true }).click();
  await page.locator('#close-inventory').click();
  await page.waitForFunction(() => __game.state.mode === 'playing' && __game.hotbar[2] === 22 && __game.state.slot === 2);
}

async function save(page, destination) {
  await page.locator('#save-world').click();
  await page.waitForFunction(destination => {
    const text = document.getElementById('save-status').textContent;
    return text.startsWith('Saved ') && text.includes(destination);
  }, destination);
}

function row(page, selector, name) {
  return page.locator(`${selector} .saved-world-row`).filter({ hasText: name });
}

async function resume(page, selector, name, shared = false) {
  await row(page, selector, name).getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForFunction(shared => __game.state.mode === 'ready' && __game.state.gameMode !== null && __game.session.connected === shared, shared);
}

async function terrainHash(page) {
  return page.evaluate(async () => {
    const digest = await crypto.subtle.digest('SHA-256', __game.world.data);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  });
}

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('named shared world survives server reboot and resumes the same device profile', { timeout: 150000 }, async t => {
  // Freeze simulation, while leaving real snapshots, sockets and persistence
  // running. That makes save/reload comparisons independent of enemy AI timing.
  const game = await running(t, { tickMs: 100000 });
  const host = await client(t, game.url);
  const page = host.page;
  const name = 'Family castle';
  await page.locator('#session-multi').click();
  await page.locator('#world-name').fill(name);
  await page.locator('#player-name').fill('Alice');
  await page.locator('#room-mode').selectOption('wave');
  await page.locator('#room-create').click();
  await page.waitForFunction(() => __game.session.connected && __game.state.mode === 'ready');
  const { code, id } = await page.evaluate(() => ({ code: __game.session.roomCode, id: __game.session.playerId }));
  await play(page);

  const room = game.server.rooms.get(code);
  for (let x = 68; x <= 80; x++) for (let z = 68; z <= 80; z++) {
    for (let y = 30; y <= 36; y++) room.edit(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
  }
  room.edit(70, 31, 70, BLOCK.GOLD);
  room.flushBlocks();
  const player = room.players.get(id);
  player.pos.set(72.5, 31.01, 72.5);
  player.vel.set(0, 0, 0);
  player.yaw = 0.3; player.pitch = -0.1;
  player.health = 57; player.tomatoes = 4;
  room.score = 321; room.kills = 7; room.wave = 4; room.remaining = 2;
  const enemy = createEnemy('brute', 77.5, 31.01, 72.5, room.wave);
  enemy.id = 'saved-browser-brute'; enemy.hp = 31;
  room.enemies.push(enemy);
  room.correction(player);
  room.broadcast(room.snapshot());
  await page.waitForFunction(() => Math.abs(__game.player.pos.x - 72.5) < 0.1 && __game.player.health === 57 && __game.enemies.length === 1 && __game.world.get(70, 31, 70) === 22);
  await goldInSlotThree(page);
  await pause(page);
  await until(() => player.hotbar[2] === BLOCK.GOLD && player.slot === 2, 'inventory reaches the server before saving');
  const expectedTerrain = createHash('sha256').update(room.world.data).digest('hex');
  assert.equal(await terrainHash(page), expectedTerrain, 'client has the complete authoritative terrain');
  await save(page, 'Pi');
  const durable = JSON.parse(await readFile(path.join(game.dataDir, 'rooms.json'), 'utf8'));
  const saved = durable.rooms.find(room => room.code === code);
  assert.equal(saved.name, name, 'save acknowledgment follows the durable write');
  assert.ok(saved.terrain, 'the saved world contains complete terrain');
  assert.equal(saved.profiles.find(profile => profile.clientId === player.clientId).health, 57);

  await game.stop();
  await page.waitForFunction(() => !__game.session.connected);
  await game.restart();
  await page.reload();
  await ready(page);
  await resume(page, '#server-world-list', name, true);
  const restored = await page.evaluate(() => ({
    code: __game.session.roomCode, x: __game.player.pos.x, y: __game.player.pos.y, z: __game.player.pos.z,
    health: __game.player.health, tomatoes: __game.state.tomatoes, score: __game.state.score,
    kills: __game.state.kills, wave: __game.state.wave, remaining: __game.state.waveRemaining,
    hotbar: [...__game.hotbar], slot: __game.state.slot, enemies: __game.enemies.map(enemy => ({ kind: enemy.typeKey, hp: enemy.hp })),
  }));
  assert.equal(restored.code, code);
  assert.ok(Math.abs(restored.x - 72.5) < 0.1 && Math.abs(restored.y - 31.01) < 0.1 && Math.abs(restored.z - 72.5) < 0.1, 'same device resumes at its saved position');
  assert.equal(restored.health, 57);
  assert.equal(restored.tomatoes, 4);
  assert.deepEqual([restored.score, restored.kills, restored.wave, restored.remaining], [321, 7, 4, 2]);
  assert.equal(restored.hotbar[2], BLOCK.GOLD);
  assert.equal(restored.slot, 2);
  assert.deepEqual(restored.enemies, [{ kind: 'brute', hp: 31 }]);
  assert.equal(await terrainHash(page), expectedTerrain, 'reboot preserves every terrain byte');

  // Another browser can discover and resume the named shared world without
  // knowing the room code; it receives a distinct player profile.
  const guest = await client(t, game.url);
  await resume(guest.page, '#server-world-list', name, true);
  assert.equal(await guest.page.evaluate(() => __game.session.roomCode), code);
  assert.equal(await terrainHash(guest.page), expectedTerrain);
  const profiles = [...game.server.rooms.get(code).players.values()];
  assert.equal(new Set(profiles.map(player => player.clientId)).size, 2);
  assert.deepEqual([...host.errors, ...guest.errors], []);
});

test('Solo restores a saved intermission and New game keeps the previous named world', { timeout: 100000 }, async t => {
  const game = await running(t);
  const { page, errors } = await client(t, game.url);
  const name = 'Device treehouse';
  await page.locator('#world-name').fill(name);
  await page.locator('#mode-build').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
  await goldInSlotThree(page);
  await pause(page);
  await page.evaluate(async () => {
    const { Enemy } = await import('/src/enemies.js');
    const { Animal } = await import('/src/animals.js');
    const { BLOCK } = await import('/src/world.js');
    const { world, player, state, animals, ragdolls, clearInput } = __game;
    clearInput();
    for (let x = 68; x <= 80; x++) for (let z = 68; z <= 80; z++) {
      for (let y = 30; y <= 36; y++) world.set(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
    }
    world.set(70, 31, 70, BLOCK.PURPLE);
    player.pos.set(72.5, 31.01, 72.5);
    player.vel.set(0, 0, 0);
    player.yaw = 0.45; player.pitch = -0.2; player.health = 64;
    player.syncCamera();
    // Stage a real between-wave save: no enemies or pending spawns. Resuming
    // play must continue this intermission rather than reinitialize wave one.
    state.gameMode = 'wave';
    state.score = 456; state.kills = 9; state.wave = 4; state.waveRemaining = 0;
    state.tomatoes = 6; state.elapsed = 132.5; state.intermission = 3; state.spawnTimer = 0.6;
    const cat = new Animal('cat', 70.5, 31.01, 75.5);
    cat.state = 'sit'; animals.push(cat); world.scene.add(cat.group);
    const stalker = new Enemy('stalker', 76.5, 31.01, 76.5);
    world.scene.add(stalker.group);
    const body = ragdolls.add(stalker);
    ragdolls.setName(body, 'Buddy');
  });
  const expectedTerrain = await terrainHash(page);
  await save(page, 'device');
  await page.reload();
  await ready(page);
  await resume(page, '#solo-world-list', name);
  const restored = await page.evaluate(() => ({
    gameMode: __game.state.gameMode, position: __game.player.pos.toArray(),
    yaw: __game.player.yaw, pitch: __game.player.pitch, health: __game.player.health,
    hotbar: [...__game.hotbar], slot: __game.state.slot,
    progress: ['score', 'kills', 'wave', 'waveRemaining', 'tomatoes', 'elapsed', 'intermission', 'spawnTimer'].map(key => __game.state[key]),
    enemies: __game.enemies.map(enemy => ({ kind: enemy.typeKey, hp: enemy.hp })),
    animals: __game.animals.map(animal => ({ kind: animal.kind, state: animal.state })),
    bodies: __game.ragdolls.bodies.map(body => body.name),
  }));
  assert.equal(restored.gameMode, 'wave');
  assert.deepEqual(restored.position, [72.5, 31.01, 72.5]);
  assert.equal(restored.yaw, 0.45);
  assert.equal(restored.pitch, -0.2);
  assert.equal(restored.health, 64);
  assert.equal(restored.hotbar[2], BLOCK.GOLD);
  assert.equal(restored.slot, 2);
  assert.deepEqual(restored.progress, [456, 9, 4, 0, 6, 132.5, 3, 0.6]);
  assert.deepEqual(restored.enemies, []);
  assert.deepEqual(restored.animals, [{ kind: 'cat', state: 'sit' }]);
  assert.deepEqual(restored.bodies, ['Buddy']);
  assert.equal(await terrainHash(page), expectedTerrain, 'Solo restores every terrain byte');
  assert.equal(await row(page, '#solo-world-list', name).count(), 1, 'resuming updates the existing save rather than creating a duplicate');

  await play(page);
  await page.waitForFunction(() => __game.state.elapsed > 132.6);
  await pause(page);
  const continued = await page.evaluate(() => ({
    wave: __game.state.wave, remaining: __game.state.waveRemaining,
    intermission: __game.state.intermission, score: __game.state.score,
    kills: __game.state.kills, tomatoes: __game.state.tomatoes, enemies: __game.enemies.length,
  }));
  const { intermission, ...continuedProgress } = continued;
  assert.deepEqual(continuedProgress, {
    wave: 4, remaining: 0, score: 456, kills: 9, tomatoes: 6, enemies: 0,
  }, 'starting play keeps the resumed wave and resources');
  assert.ok(intermission > 0 && intermission < 3, 'the saved intermission continues counting down');

  // Hold an autosave after it captures the world, then make a final edit. New
  // game must save that newer state before leaving, even if tapped repeatedly.
  await page.waitForFunction(() => !document.getElementById('save-world').disabled);
  await page.evaluate(() => {
    const { soloSaves, saveSoloWorld, world } = __game;
    const originalPut = soloSaves.put.bind(soloSaves);
    const originalRegenerate = world.regenerate.bind(world);
    const gate = new Promise(resolve => { window.__releaseSaveRace = resolve; });
    let first = true;
    window.__newWorldGenerations = 0;
    soloSaves.put = async record => {
      if (first) { first = false; await gate; }
      return originalPut(record);
    };
    world.regenerate = (...args) => {
      window.__newWorldGenerations++;
      return originalRegenerate(...args);
    };
    window.__restoreSaveRace = () => {
      soloSaves.put = originalPut;
      world.regenerate = originalRegenerate;
    };
    window.__pendingSaveRace = saveSoloWorld({ quiet: true });
    world.set(71, 31, 70, 19); // Azure brick, added after the autosave snapshot.
  });
  const finalTerrain = await terrainHash(page);
  assert.notEqual(finalTerrain, expectedTerrain, 'the final edit follows the pending autosave snapshot');
  await page.locator('#new-game').click();
  assert.equal(await page.locator('#new-game').isDisabled(), true, 'New game waits for the save to finish');
  await page.evaluate(() => {
    __game.newGame();
    __game.newGame();
    window.__releaseSaveRace();
  });
  await page.waitForFunction(() => __game.state.mode === 'ready' && __game.state.gameMode === null);
  assert.equal(await page.evaluate(() => window.__newWorldGenerations), 1, 'repeated New game taps generate only one new world');
  await page.evaluate(() => window.__restoreSaveRace());
  await row(page, '#solo-world-list', name).getByRole('button', { name: 'Resume', exact: true }).waitFor();
  assert.equal(await row(page, '#solo-world-list', name).count(), 1, 'New game keeps the previous world in the saved-world catalog');
  await resume(page, '#solo-world-list', name);
  assert.equal(await page.evaluate(() => __game.state.wave), 4, 'the previous world can still be resumed');
  assert.equal(await terrainHash(page), finalTerrain, 'New game preserves edits made after the pending autosave snapshot');
  assert.deepEqual(errors, []);
});
