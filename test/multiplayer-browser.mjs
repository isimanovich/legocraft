// Optional real-browser integration tests. Run through `npm run test:multiplayer-browser`.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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

// Preserve the full rendering/gameplay pipeline, with a smaller backing buffer
// so three software-rendered browser clients do not compete for GPU resources.
const hook = '\nrenderer.setPixelRatio(0.25);\nwindow.__game = { state, player, world, session, remotePlayers, networkEntities, enemies, animals, ragdolls, touchControls, clearInput };';

async function running(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'legocraft-browser-'));
  let game = await createGameServer({ dataDir, ...options });
  const address = await game.listen(0, '127.0.0.1');
  t.after(async () => {
    await game?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get server() { return game; },
    url: `http://127.0.0.1:${address.port}`,
    async stop() { const previous = game; game = null; await previous.close(); },
    async restart() {
      game = await createGameServer({ dataDir, ...options });
      await game.listen(address.port, '127.0.0.1');
    },
  };
}

async function client(t, url, { phone = false } = {}) {
  const context = await browser.newContext({
    viewport: phone ? { width: 844, height: 390 } : { width: 1280, height: 800 },
    hasTouch: phone, isMobile: phone, reducedMotion: 'reduce', deviceScaleFactor: 1,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/main.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.body()).toString() + hook });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__game?.state.mode === 'ready');
  // The desktop viewport deliberately selects the touch controls too, keeping
  // multiplayer independent of Headless Chromium's Pointer Lock restrictions.
  await page.locator('#input-touch').click();
  return { page, errors };
}

async function create(page, gameMode = 'build', name = 'Alice') {
  await page.locator('#session-multi').click();
  await page.locator('#player-name').fill(name);
  await page.locator('#room-mode').selectOption(gameMode);
  await page.locator('#room-create').click();
  await page.waitForFunction(() => __game.session.connected && __game.state.mode === 'ready');
  const code = await page.evaluate(() => __game.session.roomCode);
  await play(page);
  return code;
}

async function join(page, code, name = 'Bob') {
  if (await page.locator('#session-choice').isVisible()) await page.locator('#session-multi').click();
  await page.locator('#player-name').fill(name);
  await page.locator('#room-code').fill(code.toLowerCase());
  assert.equal(await page.locator('#room-code').inputValue(), code, 'room codes normalize while typing');
  await page.locator('#room-join').click();
  await page.waitForFunction(() => __game.session.connected && __game.state.mode === 'ready');
  await play(page);
}

async function play(page) {
  await page.locator('#start-cta').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
}

async function pause(page) {
  await page.locator('[data-touch-action="pause"]').click();
  await page.waitForFunction(() => __game.state.mode === 'paused');
}

async function hold(page, selector, until) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try { await until(); } finally { await page.mouse.up(); }
}

async function moveRight(page, observer, id) {
  const initial = await page.evaluate(() => __game.player.pos.x);
  const stick = await page.locator('#move-stick').boundingBox();
  assert.ok(stick);
  await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(stick.x + stick.width / 2 + 34, stick.y + stick.height / 2);
    await page.waitForFunction(x => __game.player.pos.x > x + 0.6, initial);
    await observer.waitForFunction(({ id, initial }) => __game.remotePlayers.peers.get(id)?.target.x > initial + 0.4, { id, initial });
  } finally { await page.mouse.up(); }
}

// Give the actual clients a small, deterministic playground. Changes travel
// through the real blocks protocol; action tests still use on-screen controls.
async function stage(room, pages) {
  for (let x = 68; x <= 80; x++) for (let z = 66; z <= 80; z++) {
    for (let y = 30; y <= 36; y++) room.edit(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
  }
  room.flushBlocks();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const id = await page.evaluate(() => __game.session.playerId);
    const player = room.players.get(id);
    player.pos.set(72.5 + i * 4, 31.01, 72.5);
    player.vel.set(0, 0, 0);
    player.yaw = player.pitch = 0;
    room.correction(player);
    await page.waitForFunction(x => Math.abs(__game.player.pos.x - x) < 0.1 && Math.abs(__game.player.pos.z - 72.5) < 0.1 && __game.player.yaw === 0, player.pos.x);
  }
}

async function blockIs(page, position, value) {
  await page.waitForFunction(({ position, value }) => __game.world.get(...position) === value, { position, value });
}

test('three browsers share edits and movement; pause, host handoff, restart and rejoin work', { timeout: 120000 }, async t => {
  const game = await running(t);
  const host = await client(t, game.url, { phone: true });
  const guest = await client(t, game.url);
  const code = await create(host.page);
  await join(guest.page, code);
  const hostId = await host.page.evaluate(() => __game.session.playerId);
  const guestId = await guest.page.evaluate(() => __game.session.playerId);
  await Promise.all([host.page.waitForFunction(() => __game.remotePlayers.peers.size === 1), guest.page.waitForFunction(() => __game.remotePlayers.peers.size === 1)]);
  const room = game.server.rooms.get(code);
  await stage(room, [host.page, guest.page]);

  const target = [72, 32, 69], placed = [72, 32, 70];
  room.edit(...target, BLOCK.YELLOW); room.flushBlocks();
  await blockIs(host.page, target, BLOCK.YELLOW);
  await hold(host.page, '[data-touch-hold="attack"]', async () => {
    await Promise.all([blockIs(host.page, target, BLOCK.AIR), blockIs(guest.page, target, BLOCK.AIR)]);
  });
  assert.equal(room.world.get(...target), BLOCK.AIR, 'touch break changed the authoritative world');
  room.edit(...target, BLOCK.YELLOW); room.flushBlocks();
  await blockIs(host.page, target, BLOCK.YELLOW);
  await host.page.locator('#hotbar .slot').nth(1).click();
  await hold(host.page, '[data-touch-hold="place"]', async () => {
    await Promise.all([blockIs(host.page, placed, BLOCK.RED), blockIs(guest.page, placed, BLOCK.RED)]);
  });
  assert.equal(room.world.get(...placed), BLOCK.RED, 'touch placement was confirmed by the server');

  await moveRight(host.page, guest.page, hostId);
  await pause(host.page);
  await guest.page.waitForFunction(id => __game.remotePlayers.peers.get(id)?.paused === true, hostId);
  assert.equal(await host.page.locator('#room-reset').isVisible(), true, 'host can start a shared world');
  await moveRight(guest.page, host.page, guestId);
  assert.equal(await host.page.evaluate(() => __game.state.mode), 'paused', 'guest can play while host menu is open');
  await guest.page.locator('[data-touch-action="inventory"]').click();
  await guest.page.waitForFunction(() => __game.state.inventoryOpen);
  assert.match(await guest.page.locator('#inv-description').textContent(), /room keeps playing/);
  await guest.page.locator('#close-inventory').click();
  await guest.page.waitForFunction(() => __game.state.mode === 'playing');

  const late = await client(t, game.url);
  await join(late.page, code, 'Carol');
  await blockIs(late.page, placed, BLOCK.RED);
  assert.equal(await late.page.evaluate(() => __game.world.seed), room.world.seed);
  await late.page.waitForFunction(() => __game.remotePlayers.peers.size === 2);
  await host.page.locator('#room-leave').click();
  await host.page.waitForFunction(() => !__game.session.connected && __game.state.mode === 'ready');
  await guest.page.waitForFunction(() => __game.session.hostId === __game.session.playerId && __game.remotePlayers.peers.size === 1);
  assert.equal(room.hostId, guestId);
  await late.page.waitForFunction(id => !__game.remotePlayers.peers.has(id), hostId);

  // Drop the real server while a movement pointer is held. The local client
  // must release all input and offer its previous room code for reconnection.
  const stick = await guest.page.locator('#move-stick').boundingBox();
  await guest.page.mouse.move(stick.x + stick.width / 2 + 30, stick.y + stick.height / 2);
  await guest.page.mouse.down();
  await guest.page.waitForFunction(() => __game.touchControls.pointers.size === 1);
  const seed = room.world.seed;
  await game.stop();
  await guest.page.waitForFunction(() => !__game.session.connected && __game.state.mode === 'ready' && __game.state.gameMode === null);
  await guest.page.mouse.up();
  assert.deepEqual(await guest.page.evaluate(() => ({ pointers: __game.touchControls.pointers.size, keys: __game.player.keys.size, mouse: __game.state.mouse, x: __game.player.touch.x, z: __game.player.touch.z, peers: __game.remotePlayers.peers.size })),
    { pointers: 0, keys: 0, mouse: [false, false, false], x: 0, z: 0, peers: 0 });
  assert.match(await guest.page.locator('#room-error').textContent(), /Connection lost/);
  assert.equal(await guest.page.locator('#room-code').inputValue(), code);
  assert.equal(await guest.page.locator('#multiplayer-panel').isVisible(), true);
  await game.restart();
  await join(guest.page, code);
  assert.equal(await guest.page.evaluate(() => __game.world.seed), seed);
  await blockIs(guest.page, placed, BLOCK.RED);
  await late.page.waitForFunction(() => !__game.session.connected && __game.state.mode === 'ready');
  await join(late.page, code, 'Carol');
  await blockIs(late.page, placed, BLOCK.RED);

  await pause(guest.page);
  await guest.page.locator('#room-reset').click();
  await Promise.all([guest.page.waitForFunction(seed => __game.world.seed !== seed && __game.state.mode === 'ready', seed),
    late.page.waitForFunction(seed => __game.world.seed !== seed && __game.state.mode === 'ready', seed)]);
  assert.equal(await guest.page.evaluate(() => __game.world.seed), await late.page.evaluate(() => __game.world.seed));
  assert.equal(game.server.rooms.get(code).blocks.size, 0, 'shared reset clears the saved build');
  assert.deepEqual([...host.errors, ...guest.errors, ...late.errors], []);
});

test('wave clients render the server enemy once and share combat, death and respawn', { timeout: 60000 }, async t => {
  const game = await running(t, { tickMs: 100000 });
  const host = await client(t, game.url, { phone: true });
  const guest = await client(t, game.url);
  const code = await create(host.page, 'wave');
  await join(guest.page, code);
  const room = game.server.rooms.get(code);
  await stage(room, [host.page, guest.page]);
  const hostId = await host.page.evaluate(() => __game.session.playerId);
  const hostPlayer = room.players.get(hostId);
  const enemy = createEnemy('stalker', 72.5, 31.01, 69.5);
  enemy.id = 'browser-fixture-stalker';
  enemy.hp = 1;
  room.enemies.push(enemy);
  room.hurt(hostPlayer, 17);
  room.broadcast(room.snapshot());
  await Promise.all([host.page.waitForFunction(() => __game.enemies.length === 1 && __game.player.health === 83),
    guest.page.waitForFunction(id => __game.enemies.length === 1 && __game.remotePlayers.peers.get(id)?.healthFill.scale.x < 0.8, hostId)]);
  assert.equal(await host.page.evaluate(() => __game.networkEntities.enemyRecords.size), 1);
  await hold(host.page, '[data-touch-hold="attack"]', async () => {
    await Promise.all([host.page.waitForFunction(() => __game.state.kills === 1 && __game.enemies.length === 0),
      guest.page.waitForFunction(() => __game.state.kills === 1 && __game.enemies.length === 0)]);
  });
  assert.equal(room.kills, 1, 'one server kill for both clients');
  assert.equal(await host.page.evaluate(() => __game.state.score), room.score);
  assert.equal(await guest.page.evaluate(() => __game.state.score), room.score);
  assert.ok(room.score > 0);
  await guest.page.waitForFunction(() => __game.ragdolls.bodies.length === 1);

  room.hurt(hostPlayer, 1000);
  room.broadcast(room.snapshot());
  await host.page.waitForFunction(() => __game.state.mode === 'dead' && __game.player.health === 0);
  await guest.page.waitForFunction(id => __game.remotePlayers.peers.get(id)?.dead === true, hostId);
  assert.equal(await guest.page.evaluate(() => __game.state.mode), 'playing');
  // Expire the retry timer before a successful authoritative reply arrives.
  // A late acknowledgement must recover even after the pending flag is gone.
  await host.page.evaluate(() => {
    const originalTimer = window.setTimeout;
    const originalPacket = __game.session.onPacket;
    const deferred = [];
    window.__respawnTimedOut = false;
    __game.session.onPacket = packet => {
      const own = packet.players?.find(player => player.id === __game.session.playerId);
      if (packet.type === 'state' && own?.health > 0 && !window.__respawnTimedOut) deferred.push(packet);
      else originalPacket(packet);
    };
    window.setTimeout = (callback, delay, ...args) => originalTimer.call(window, delay === 3000 ? () => {
      callback(...args);
      window.__respawnTimedOut = true;
      for (const packet of deferred.splice(0)) originalPacket(packet);
    } : callback, delay === 3000 ? 0 : delay, ...args);
    window.__restoreRespawnTest = () => {
      window.setTimeout = originalTimer;
      __game.session.onPacket = originalPacket;
    };
  });
  try {
    await host.page.locator('#restart-game').click();
    await host.page.waitForFunction(() => window.__respawnTimedOut === true);
    await host.page.waitForFunction(() => __game.player.health === 100 && __game.state.mode === 'playing');
  } finally {
    await host.page.evaluate(() => window.__restoreRespawnTest());
  }
  await guest.page.waitForFunction(id => __game.remotePlayers.peers.get(id)?.dead === false, hostId);
  assert.equal(room.players.get(hostId).health, 100);
  assert.deepEqual([...host.errors, ...guest.errors], []);
});
