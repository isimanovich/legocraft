// Real-browser checks for ladders, smooth terrain and procedural world audio.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGameServer } from '../server/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
after(() => browser.close());
const hook = '\nrenderer.setPixelRatio(0.25);\nwindow.__game = { state, player, world, hotbar, sfx, ambience, renderer, session, clearInput, selectControls, hand };';

async function client(t, { multiplayer = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'legocraft-terrain-browser-'));
  const server = await createGameServer({ dataDir });
  const address = await server.listen(0, '127.0.0.1');
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 1 });
  t.after(async () => { await context.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/main.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.body()).toString().replace('seed: (Math.random() * 1e6) | 0', 'seed: 42') + hook });
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => window.__game?.state.mode === 'ready');
  await page.locator('#input-touch').click();
  if (multiplayer) {
    await page.locator('#session-multi').click();
    await page.locator('#room-mode').selectOption('build');
    await page.locator('#room-create').click();
    await page.waitForFunction(() => __game.session.connected && __game.state.mode === 'ready');
    await page.locator('#start-cta').click();
  } else await page.locator('#mode-build').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
  return { page, errors, server };
}

async function hold(page, selector, until) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try { await until(); } finally { await page.mouse.up(); }
}

async function stick(page, dx, dy, until) {
  const box = await page.locator('#move-stick').boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await until();
  } finally { await page.mouse.up(); }
}

async function elapsed(page, seconds) {
  const start = await page.evaluate(() => __game.state.elapsed);
  await page.waitForFunction(({ start, seconds }) => __game.state.elapsed >= start + seconds, { start, seconds });
}

async function stage(page) {
  await page.evaluate(async () => {
    const { BLOCK } = await import('/src/world.js');
    const { world, player, clearInput } = __game;
    clearInput(); player.stand();
    for (let x = 66; x <= 80; x++) for (let z = 66; z <= 80; z++) {
      for (let y = 30; y <= 42; y++) world.set(x, y, z, y === 30 ? BLOCK.GRASS : BLOCK.AIR);
    }
    player.pos.set(72.5, 31.01, 75.5); player.vel.set(0, 0, 0);
    player.yaw = 0; player.pitch = Math.atan2(31 - (player.pos.y + player.eye), 3); player.syncCamera();
  });
}

test('place a ladder, climb with touch and keyboard, hold and safely exit', { timeout: 120000 }, async t => {
  const { page, errors } = await client(t);
  await stage(page);
  await page.locator('#hotbar .slot').nth(7).click();
  await page.waitForFunction(() => __game.hand.visible && __game.hand.children[1].visible);
  const heldGrass = await page.evaluate(() => {
    const { hand, world } = __game;
    const geometry = []; hand.traverse(node => { if (node.isMesh) geometry.push(node.geometry.type); });
    return { smooth: world.studs === false, noStuds: !geometry.includes('CylinderGeometry'),
      brown: hand.children[0].material.color.r > hand.children[0].material.color.g,
      green: hand.children[1].material.color.g > hand.children[1].material.color.r };
  });
  assert.deepEqual(heldGrass, { smooth: true, noStuds: true, brown: true, green: true });
  await page.locator('[data-touch-action="inventory"]').click();
  await page.getByRole('button', { name: 'Put Ladder in the selected hotbar slot', exact: true }).click();
  await page.locator('#close-inventory').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
  await hold(page, '[data-touch-hold="place"]', () => page.waitForFunction(() => __game.world.get(72, 31, 72) === 26));
  await page.evaluate(async () => {
    const { BLOCK } = await import('/src/world.js');
    const { world, player, clearInput } = __game;
    clearInput();
    for (let y = 32; y <= 37; y++) world.set(72, y, 72, BLOCK.LADDER);
    player.pos.set(72.5, 31.01, 72.5); player.vel.set(0, 0, 0); player.pitch = 0; player.syncCamera();
  });
  await hold(page, '[data-touch-hold="jump"]', () => page.waitForFunction(() => __game.player.climbing && __game.player.pos.y > 33));
  const held = await page.evaluate(() => __game.player.pos.y);
  await elapsed(page, .3);
  assert.ok(Math.abs(await page.evaluate(() => __game.player.pos.y) - held) < .06, 'releasing controls holds the rung');
  await stick(page, 0, 52, () => page.waitForFunction(y => __game.player.pos.y < y - 1, held));
  await page.evaluate(() => __game.selectControls('laptop'));
  const beforeKeyboard = await page.evaluate(() => __game.player.pos.y);
  await page.keyboard.down('w');
  try { await page.waitForFunction(y => __game.player.pos.y > y + .8, beforeKeyboard); }
  finally { await page.keyboard.up('w'); }
  await page.keyboard.down('s');
  try { await page.waitForFunction(y => __game.player.pos.y < y + .2, beforeKeyboard); }
  finally { await page.keyboard.up('s'); }
  await page.keyboard.down('d');
  try { await page.waitForFunction(() => !__game.player.climbing && __game.player.pos.x > 73.3); }
  finally { await page.keyboard.up('d'); }
  await page.waitForFunction(() => __game.player.onGround && __game.player.pos.y < 31.1);
  assert.deepEqual(errors, []);
});


test('ladder climbing reaches the authoritative multiplayer server', { timeout: 90000 }, async t => {
  const { page, errors, server } = await client(t, { multiplayer: true });
  const { code, id } = await page.evaluate(() => ({ code: __game.session.roomCode, id: __game.session.playerId }));
  const room = server.rooms.get(code);
  const { BLOCK } = await import('../src/world.js');
  for (let x = 69; x <= 75; x++) for (let z = 69; z <= 75; z++) {
    for (let y = 30; y <= 40; y++) room.edit(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
  }
  for (let y = 31; y <= 37; y++) room.edit(72, y, 72, BLOCK.LADDER);
  room.flushBlocks();
  const player = room.players.get(id);
  player.pos.set(72.5, 31.01, 72.5); player.vel.set(0, 0, 0); player.yaw = 0; player.pitch = 0;
  room.correction(player);
  await page.waitForFunction(() => __game.world.get(72, 37, 72) === 26 && Math.abs(__game.player.pos.z - 72.5) < .05);
  await hold(page, '[data-touch-hold="jump"]', async () => {
    await page.waitForFunction(() => __game.player.climbing && __game.player.pos.y > 33);
    await page.waitForFunction(() => __game.player.pos.y > 33.5);
  });
  const deadline = Date.now() + 5000;
  while (player.pos.y <= 33) {
    assert.ok(Date.now() < deadline, 'the server accepts the legitimate ladder climb');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(player.pos.y > 33 && player.pos.y < 37, 'shared authoritative position follows ladder movement');
  assert.equal(room.world.get(72, 34, 72), BLOCK.LADDER);
  assert.deepEqual(errors, []);
});

test('real audio varies footsteps by ground, adds water sounds and silences on pause or mute', { timeout: 90000 }, async t => {
  const { page, errors } = await client(t);
  await page.waitForFunction(() => __game.sfx.ctx?.state === 'running');
  await stage(page);
  const sounds = await page.evaluate(async () => {
    const { BLOCK } = await import('/src/world.js');
    const { ambience, sfx, world } = __game;
    const footsteps = [], swimming = [];
    const step = sfx.footstep.bind(sfx), swim = sfx.swim.bind(sfx);
    sfx.footstep = (surface, strength) => { footsteps.push(surface); return step(surface, strength); };
    sfx.swim = (entry, strength) => { swimming.push(entry); return swim(entry, strength); };
    const actor = { pos: { x: 70.5, y: 31.01, z: 70.5 }, vel: { x: 4, y: 0, z: 0 }, halfW: .3, health: 100,
      onGround: true, climbing: false, sitting: false, touch: {}, keys: new Set() };
    try {
      for (const block of [BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND, BLOCK.WOOD, BLOCK.STONE, BLOCK.RED, BLOCK.COUCH, BLOCK.TV]) {
        for (let x = 70; x <= 75; x++) world.set(x, 30, 70, block);
        actor.pos.x = 70.5; ambience.reset(); ambience.update(.1, actor, true);
        for (let i = 0; i < 5; i++) { actor.pos.x += .5; ambience.update(.1, actor, true); }
      }
      const beforeIdle = footsteps.length;
      for (let i = 0; i < 10; i++) ambience.update(.1, actor, true);
      const idleSteps = footsteps.length - beforeIdle;
      for (let x = 70; x <= 76; x++) world.set(x, 31, 70, BLOCK.WATER);
      ambience.reset(); actor.onGround = false; actor.pos = { x: 70.5, y: 32.2, z: 70.5 };
      ambience.update(.1, actor, true);
      actor.pos.y = 31.2; ambience.update(.1, actor, true);
      for (let i = 0; i < 5; i++) { actor.pos.x += .4; ambience.update(.1, actor, true); }
      const beforeSwimIdle = swimming.length;
      for (let i = 0; i < 10; i++) ambience.update(.1, actor, true);
      return { footsteps, swimming, idleSteps, idleSwimming: swimming.length - beforeSwimIdle };
    } finally { sfx.footstep = step; sfx.swim = swim; ambience.reset(); }
  });
  assert.deepEqual(sounds.footsteps, ['grass', 'dirt', 'sand', 'wood', 'stone', 'brick', 'soft', 'metal']);
  assert.equal(sounds.idleSteps, 0);
  assert.ok(sounds.swimming.includes(true), 'entering water produces a splash');
  assert.ok(sounds.swimming.includes(false), 'swimming distance produces strokes');
  assert.equal(sounds.idleSwimming, 0);
  await page.evaluate(() => {
    const { player, clearInput, ambience } = __game;
    clearInput(); player.pos.set(70.5, 31.2, 70.5); player.vel.set(0, 0, 0); player.syncCamera(); ambience.reset();
  });
  await page.waitForFunction(() => __game.sfx.water && __game.ambience.waterLevel > 0);
  await page.evaluate(() => { window.__waterSource = __game.sfx.water.source; });
  await elapsed(page, .5);
  assert.equal(await page.evaluate(() => __game.sfx.water?.source === window.__waterSource), true, 'water ambience reuses its one loop');
  await page.locator('[data-touch-action="pause"]').click();
  await page.waitForFunction(() => __game.state.mode === 'paused' && !__game.sfx.water && __game.ambience.waterLevel === 0);
  await page.locator('#sound-toggle').click();
  assert.equal(await page.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
  await page.waitForFunction(() => !__game.sfx.enabled && __game.sfx.master.gain.value < .001 && !__game.sfx.water, null, { timeout: 5000 }).catch(async error => {
    const diagnostic = await page.evaluate(() => ({ enabled: __game.sfx.enabled, gain: __game.sfx.master.gain.value,
      context: __game.sfx.ctx.state, time: __game.sfx.ctx.currentTime, water: !!__game.sfx.water, mode: __game.state.mode }));
    throw new Error(JSON.stringify(diagnostic), { cause: error });
  });
  const mutedSteps = await page.evaluate(() => {
    const { ambience, player, sfx } = __game;
    const original = sfx.footstep; let count = 0;
    sfx.footstep = (...args) => { count++; return original.apply(sfx, args); };
    try {
      const actor = { ...player, pos: { x: 70.5, y: 31.01, z: 70.5 }, onGround: true };
      for (let i = 0; i < 8; i++) { actor.pos.x += .5; ambience.update(.1, actor, true); }
      return count;
    } finally { sfx.footstep = original; }
  });
  assert.equal(mutedSteps, 0, 'active movement cannot emit footsteps while muted');
  await page.reload();
  await page.waitForFunction(() => __game.state.mode === 'ready');
  assert.equal(await page.locator('#sound-toggle').getAttribute('aria-pressed'), 'false', 'mute persists on this browser');
  await page.locator('#sound-toggle').click();
  await page.waitForFunction(() => __game.sfx.enabled && __game.sfx.ctx?.state === 'running');
  assert.equal(await page.evaluate(() => __game.sfx.water), null, 'reenabling sound in the menu does not start ambience');
  assert.deepEqual(errors, []);
});
