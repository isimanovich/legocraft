// Optional browser coverage for skins, home furniture, lighting and water effects.
// Run with PLAYWRIGHT_MODULE and CHROMIUM_PATH as documented in README.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const hook = '\nrenderer.setPixelRatio(0.25);\nwindow.__game = { state, player, world, hotbar, clearInput, atmosphere, renderer, useFurniture, soloEnvironment, saveSoloWorld };';
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = new URL(pathname === '/' ? 'index.html' : '.' + pathname, root);
    if (!file.href.startsWith(root.href)) throw new Error('Outside checkout');
    let body = await readFile(file);
    if (pathname === '/src/main.js') body = body.toString().replace('seed: (Math.random() * 1e6) | 0', 'seed: 42') + hook;
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

async function client(t) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 1 });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => __game?.state.mode === 'ready');
  return { page, errors };
}

async function aim(page, x, z, targetY = 31) {
  await page.evaluate(({ x, z, targetY }) => {
    const { player, clearInput } = __game;
    clearInput();
    player.pos.set(x + 0.5, 31.01, z + 3.5);
    player.vel.set(0, 0, 0);
    player.yaw = 0;
    player.pitch = Math.atan2(targetY - (player.pos.y + player.eye), 3);
    player.syncCamera();
  }, { x, z, targetY });
}

async function pick(page, label) {
  await page.locator('[data-touch-action="inventory"]').click();
  await page.getByRole('button', { name: `Put ${label} in the selected hotbar slot`, exact: true }).click();
  await page.locator('#close-inventory').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
}

async function place(page, x, z, label, id) {
  await pick(page, label);
  await aim(page, x, z);
  const control = await page.locator('[data-touch-hold="place"]').boundingBox();
  await page.mouse.move(control.x + control.width / 2, control.y + control.height / 2);
  await page.mouse.down();
  try {
    await page.waitForFunction(({ x, z, id }) => __game.world.get(x, 31, z) === id, { x, z, id });
  } finally { await page.mouse.up(); }
}

test('skin colours preview and persist on this device', { timeout: 90000 }, async t => {
  const { page, errors } = await client(t);
  await page.locator('#skin-picker summary').click();
  const choices = { 'skin-tone': '#b77b57', 'skin-shirt': '#fa6b35', 'skin-pants': '#5e43a2' };
  for (const [id, value] of Object.entries(choices)) await page.locator('#' + id).fill(value);
  assert.equal(await page.locator('#skin-preview').isVisible(), true);
  await page.reload();
  await page.waitForFunction(() => __game?.state.mode === 'ready');
  for (const [id, value] of Object.entries(choices)) assert.equal(await page.locator('#' + id).inputValue(), value);
  assert.deepEqual(errors, []);
});

test('place home furniture, sit and stand, sleep through day/night, and restore the clock', { timeout: 120000 }, async t => {
  const { page, errors } = await client(t);
  await page.locator('#input-touch').click();
  await page.locator('#mode-build').click();
  await page.waitForFunction(() => __game.state.mode === 'playing');
  await page.evaluate(async () => {
    const { BLOCK } = await import('/src/world.js');
    for (let x = 67; x <= 80; x++) for (let z = 67; z <= 80; z++) {
      for (let y = 30; y <= 38; y++) __game.world.set(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
    }
  });
  await place(page, 71, 71, 'Couch', 24);
  await aim(page, 71, 71, 31.5);
  await page.locator('[data-touch-action="interact"]').click();
  await page.waitForFunction(() => __game.player.sitting);
  assert.equal(await page.evaluate(() => __game.player.eye), 0.72);
  // The normal movement input releases a seat rather than trapping the player.
  await page.evaluate(() => { __game.player.touch.z = 1; });
  await page.waitForFunction(() => !__game.player.sitting);
  await page.evaluate(() => __game.clearInput());
  assert.equal(await page.evaluate(() => __game.player.eye), 1.62);

  await place(page, 74, 71, 'Bed', 25);
  await aim(page, 74, 71, 31.5);
  await page.evaluate(() => { __game.state.timeOfDay = 0.25; });
  await page.locator('[data-touch-action="interact"]').click();
  await page.waitForFunction(() => __game.state.timeOfDay > 0.7 && __game.state.timeOfDay < 0.8);
  await page.locator('[data-touch-action="interact"]').click();
  await page.waitForFunction(() => __game.state.timeOfDay > 0.2 && __game.state.timeOfDay < 0.3);

  await place(page, 77, 71, 'TV (off)', 23);
  await aim(page, 77, 71, 31.5);
  const clock = await page.evaluate(() => __game.state.timeOfDay);
  await page.locator('[data-touch-action="interact"]').click();
  assert.ok(Math.abs(await page.evaluate(() => __game.state.timeOfDay) - clock) < 0.01, 'the TV does not change the clock');
  await page.locator('[data-touch-action="pause"]').click();
  await page.waitForFunction(() => __game.state.mode === 'paused');
  const restored = await page.evaluate(async () => {
    const { captureSolo, restoreSolo } = await import('/src/solo-saves.js');
    const env = __game.soloEnvironment();
    env.state.timeOfDay = 0.75;
    const snapshot = captureSolo(env);
    env.state.timeOfDay = 0.25;
    env.world.set(71, 31, 71, 0);
    restoreSolo(snapshot, env);
    return { time: env.state.timeOfDay, couch: env.world.get(71, 31, 71), bed: env.world.get(74, 31, 71), tv: env.world.get(77, 31, 71) };
  });
  assert.deepEqual(restored, { time: 0.75, couch: 24, bed: 25, tv: 23 });
  assert.equal(await page.evaluate(() => __game.saveSoloWorld()), true, 'world with furniture and clock saves successfully');
  assert.deepEqual(errors, []);
});

test('day/night lighting casts shadows and entering water emits droplets that fall and settle', { timeout: 90000 }, async t => {
  const { page, errors } = await client(t);
  const result = await page.evaluate(async () => {
    const { BLOCK } = await import('/src/world.js');
    const { atmosphere, renderer, world, player } = __game;
    atmosphere.update(0, player, 0.25);
    const day = atmosphere.scene.background.getHex();
    atmosphere.update(0, player, 0.75);
    const night = atmosphere.scene.background.getHex();
    const lights = { day, night, shadows: renderer.shadowMap.enabled && atmosphere.sun.castShadow, moon: atmosphere.moon.visible, stars: atmosphere.stars.visible };
    world.set(60, 30, 60, BLOCK.STONE);
    world.set(60, 31, 60, BLOCK.WATER);
    const actor = { pos: { x: 60.5, y: 33, z: 60.5 }, vel: { x: 0, y: -8, z: 0 } };
    const splashes = atmosphere.splashes;
    splashes.reset();
    splashes.update(0.016, actor);
    actor.pos.y = 31.2;
    splashes.update(0.016, actor);
    const count = splashes.drops.length;
    const before = splashes.drops[0]?.vy;
    splashes.update(0.05, actor);
    const after = splashes.drops[0]?.vy;
    for (let i = 0; i < 40; i++) splashes.update(0.05, actor);
    return { ...lights, count, gravity: before - after, remaining: splashes.drops.length, ripples: splashes.ripples.length };
  });
  assert.notEqual(result.day, result.night);
  assert.equal(result.shadows, true);
  assert.equal(result.moon, true);
  assert.equal(result.stars, true);
  assert.ok(result.count > 0 && result.count <= 72);
  assert.ok(Math.abs(result.gravity - 0.75) < 1e-9, 'water droplets accelerate downwards');
  assert.equal(result.remaining, 0);
  assert.equal(result.ripples, 0);
  assert.deepEqual(errors, []);
});
