// Optional browser regression suite. See README for the Playwright setup command.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test, after } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = new URL(pathname === '/' ? 'index.html' : '.' + pathname, root);
    if (!file.href.startsWith(root.href)) throw new Error('Outside checkout');
    let body = await readFile(file);
    if (pathname === '/src/main.js') {
      // Test-only access to gameplay state; production modules stay private.
      body = body.toString().replace('seed: (Math.random() * 1e6) | 0', 'seed: 42') +
        '\nwindow.__game = {state, player, world, ragdolls, enemies, clearInput, die, touchControls};';
    }
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});
browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

async function open(options = {}, init) {
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (init) await page.addInitScript(init);
  await page.goto(url);
  await page.waitForFunction(() => window.__game?.state.mode === 'ready');
  return { page, context, errors };
}

async function centre(page, selector) {
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect, `${selector} is visible`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function fingers(page) {
  const session = await page.context().newCDPSession(page);
  const points = new Map();
  const send = async (type, touchPoints = [...points.values()]) => {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints });
    // CDP can acknowledge before the renderer delivers coalesced pointer events.
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  return {
    async down(id, point) { points.set(id, { id, ...point }); await send('touchStart'); },
    async move(id, point) { points.set(id, { id, ...point }); await send('touchMove'); },
    async up(id) {
      const point = points.get(id);
      points.delete(id);
      await send('touchEnd', [point]);
    },
    async cancel() { points.clear(); await send('touchCancel'); },
    async tap(id, point) { await this.down(id, point); await this.up(id); },
  };
}

async function stage(page) {
  await page.evaluate(async () => {
    const { player, world, clearInput } = __game;
    const { BLOCK } = await import('/src/world.js');
    clearInput();
    for (let x = 60; x < 84; x++) for (let z = 60; z < 84; z++) {
      for (let y = 30; y < 42; y++) world.set(x, y, z, y === 30 ? BLOCK.GRASS : BLOCK.AIR);
    }
    player.pos.set(72.5, 31.01, 72.5);
    player.vel.set(0, 0, 0);
    player.yaw = player.pitch = 0;
    player.syncCamera();
  });
}

test('phone: multitouch move/look/jump, cancellation, pause and background reset', async () => {
  const { page, context, errors } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, () => {
    // iOS touch gameplay must work without Pointer Lock or persistent storage.
    HTMLCanvasElement.prototype.requestPointerLock = undefined;
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
  });
  try {
    assert.equal(await page.locator('#input-touch').getAttribute('aria-pressed'), 'true');
    await page.locator('#mode-build').tap();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    assert.equal(await page.locator('#touch-controls').isVisible(), true);
    await stage(page);
    const touch = await fingers(page);
    const stick = await centre(page, '#move-stick');
    await touch.down(1, stick);
    await touch.move(1, { x: stick.x + 18, y: stick.y - 28 });
    await touch.down(2, { x: 280, y: 300 });
    await touch.move(2, { x: 310, y: 280 });
    await page.waitForFunction(() => Math.hypot(__game.player.pos.x - 72.5, __game.player.pos.z - 72.5) > 0.05);
    const input = await page.evaluate(() => ({ ...__game.player.touch, yaw: __game.player.yaw, pitch: __game.player.pitch }));
    assert.ok(input.x > 0 && input.z > 0 && Math.hypot(input.x, input.z) <= 1);
    await page.waitForFunction(() => __game.player.yaw < 0 && __game.player.pitch > 0);
    await touch.down(3, await centre(page, '[data-touch-hold="jump"]'));
    assert.equal(await page.evaluate(() => __game.player.touch.jump), true);
    await page.waitForFunction(() => __game.player.pos.y > 31.1);
    await touch.up(3);
    await page.waitForFunction(() => !__game.player.touch.jump);
    assert.ok(await page.evaluate(() => __game.player.touch.z > 0));
    await touch.down(4, await centre(page, '[data-touch-hold="attack"]'));
    assert.equal(await page.evaluate(() => __game.state.mouse[0]), true);
    await touch.cancel();
    await page.waitForFunction(() => __game.touchControls.pointers.size === 0);
    assert.deepEqual(await page.evaluate(() => ({ ...__game.player.touch })), { x: 0, z: 0, jump: false, sprint: false });
    assert.deepEqual(await page.evaluate(() => __game.state.mouse), [false, false, false]);
    const place = await centre(page, '[data-touch-hold="place"]');
    await touch.down(8, place);
    await touch.move(8, { x: place.x + 2, y: place.y });
    await page.evaluate(() => {
      const [id, pointer] = [...__game.touchControls.pointers].find(([, p]) => p.role === 'place');
      pointer.element.releasePointerCapture(id);
    });
    await touch.move(8, { x: place.x + 5, y: place.y });
    await page.waitForFunction(() => !__game.state.mouse[2]);
    await touch.up(8);
    const beforeCancel = await page.evaluate(() => __game.state.tomatoes);
    await touch.down(9, await centre(page, '[data-touch-action="tomato"]'));
    await touch.cancel();
    assert.equal(await page.evaluate(() => __game.state.tomatoes), beforeCancel, 'cancelled taps do not activate');
    await page.locator('#touch-sprint').tap();
    assert.equal(await page.locator('#touch-sprint').getAttribute('aria-pressed'), 'true');
    await touch.down(5, stick);
    await touch.move(5, { x: stick.x, y: stick.y - 30 });
    const tomatoes = await page.evaluate(() => __game.state.tomatoes);
    await touch.tap(6, await centre(page, '[data-touch-action="tomato"]'));
    assert.equal(await page.evaluate(() => __game.state.tomatoes), tomatoes - 1);
    await touch.tap(6, await centre(page, '#hotbar .slot:nth-child(3)'));
    assert.equal(await page.evaluate(() => __game.state.slot), 2);
    // A second finger must be able to tap Pause while movement remains held.
    await touch.tap(6, await centre(page, '[data-touch-action="pause"]'));
    await page.waitForFunction(() => __game.state.mode === 'paused');
    await touch.up(5);
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => ({ ...__game.player.touch })), { x: 0, z: 0, jump: false, sprint: false });
    await page.locator('#start-cta').tap();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    await touch.down(7, await centre(page, '[data-touch-hold="attack"]'));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(() => __game.state.mode === 'paused');
    await touch.cancel();
    assert.deepEqual(await page.evaluate(() => __game.state.mouse), [false, false, false]);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('touch gameplay: build/break, hotbar, tomatoes, inventory, carry/name, restart', async () => {
  const { page, context, errors } = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  try {
    await page.locator('#mode-build').tap();
    await stage(page);
    const touch = await fingers(page);
    await page.evaluate(async () => {
      const { BLOCK } = await import('/src/world.js');
      __game.world.set(72, 32, 69, BLOCK.RED);
    });
    await touch.down(1, await centre(page, '[data-touch-hold="attack"]'));
    await page.waitForFunction(() => __game.world.get(72, 32, 69) === 0);
    await touch.up(1);
    await page.locator('#hotbar .slot').nth(1).tap();
    assert.equal(await page.evaluate(() => __game.state.slot), 1);
    await page.evaluate(async () => {
      const { BLOCK } = await import('/src/world.js');
      __game.world.set(72, 32, 68, BLOCK.STONE);
    });
    await touch.down(2, await centre(page, '[data-touch-hold="place"]'));
    await page.waitForFunction(() => __game.world.get(72, 32, 69) !== 0);
    await touch.up(2);
    const tomatoes = await page.evaluate(() => __game.state.tomatoes);
    await page.locator('[data-touch-action="tomato"]').tap();
    assert.equal(await page.evaluate(() => __game.state.tomatoes), tomatoes - 1);
    await page.locator('[data-touch-action="inventory"]').tap();
    assert.equal(await page.evaluate(() => __game.state.mode), 'paused');
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    await page.locator('#inv-hotbar .slot').nth(4).tap();
    await page.locator('#inv-items .slot').first().tap();
    assert.match(await page.locator('#inv-name').textContent(), /Sword.*slot 5/);
    await stage(page);
    await page.locator('#spawn-stalker').tap();
    assert.equal(await page.evaluate(() => __game.ragdolls.bodies.length), 1, await page.locator('#inv-name').textContent());
    await page.locator('#close-inventory').tap();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    await page.evaluate(() => {
      const { player, ragdolls } = __game;
      const delta = ragdolls.bodies[0].com.clone().sub(player.eyePos());
      player.yaw = Math.atan2(-delta.x, -delta.z);
      player.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    });
    await touch.down(3, await centre(page, '[data-touch-hold="attack"]'));
    await page.waitForFunction(() => !!__game.ragdolls.carrying);
    assert.match(await page.locator('#carry-hint').textContent(), /release Hit/);
    await touch.up(3);
    assert.equal(await page.evaluate(() => !!__game.ragdolls.carrying), false);
    // Supply a carried body as the naming target, then use only the visible UI.
    await page.evaluate(() => {
      const body = __game.ragdolls.bodies[0];
      __game.ragdolls.grab(body, body.com.clone());
    });
    await page.locator('[data-touch-action="name"]').tap();
    assert.equal(await page.locator('#name-prompt').isVisible(), true);
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    await page.locator('#name-input').fill('Gerald');
    await page.locator('#name-confirm').tap();
    assert.equal(await page.evaluate(() => __game.ragdolls.bodies[0].name), 'Gerald');
    assert.equal(await page.locator('#touch-controls').isVisible(), true);
    await page.evaluate(() => __game.die());
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    await page.locator('#restart-game').tap();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    assert.equal(await page.evaluate(() => __game.state.gameMode), 'build');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('laptop keyboard/mouse, inventory, switching modes and saved preference', async () => {
  const { page, context, errors } = await open({ viewport: { width: 1280, height: 800 } });
  try {
    assert.equal(await page.locator('#input-laptop').getAttribute('aria-pressed'), 'true');
    await page.locator('#mode-build').click();
    await page.waitForFunction(() => __game.state.mode === 'playing' && !!document.pointerLockElement);
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    await stage(page);
    await page.keyboard.down('w');
    await page.waitForFunction(() => __game.player.pos.z < 72.4);
    await page.keyboard.up('w');
    await page.keyboard.press('Digit3');
    assert.equal(await page.evaluate(() => __game.state.slot), 2);
    const yaw = await page.evaluate(() => __game.player.yaw);
    await page.mouse.move(400, 300);
    await page.mouse.move(450, 300);
    assert.notEqual(await page.evaluate(() => __game.player.yaw), yaw);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => __game.state.mouse[0]), true);
    await page.mouse.up();
    await page.keyboard.press('e');
    await page.waitForFunction(() => __game.state.inventoryOpen && !document.pointerLockElement);
    await page.locator('#close-inventory').click();
    // Pointer Lock may be throttled immediately after release; retry through the pause UI.
    if (await page.locator('#start').isVisible()) await page.locator('#start-cta').click();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    await page.keyboard.down('w');
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => __game.state.mode === 'paused');
    assert.equal(await page.evaluate(() => __game.player.keys.size), 0);
    await page.keyboard.up('w');
    await page.locator('#input-touch').click();
    assert.equal(await page.evaluate(() => __game.state.mode), 'paused');
    await page.locator('#start-cta').click();
    await page.waitForFunction(() => __game.state.mode === 'playing');
    assert.equal(await page.locator('#touch-controls').isVisible(), true);
    await page.locator('[data-touch-action="pause"]').click();
    await page.reload();
    await page.waitForFunction(() => window.__game?.state.mode === 'ready');
    assert.equal(await page.locator('#input-touch').getAttribute('aria-pressed'), 'true');
    // Switching back does not restart or reset the run.
    await page.locator('#input-laptop').click();
    await page.locator('#mode-build').click();
    await page.waitForFunction(() => __game.state.mode === 'playing' && !!document.pointerLockElement);
    assert.equal(await page.locator('#touch-controls').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('phone/tablet portrait and landscape layouts keep controls inside the viewport', async () => {
  const { page, context, errors } = await open({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  try {
    await page.locator('#mode-wave').tap();
    for (const [width, height] of [[320,568], [844,390], [1024,768], [768,1024]]) {
      await page.setViewportSize({ width, height });
      for (const selector of ['#move-stick', '#touch-sprint', '#touch-actions', '#touch-menu', '#hotbar', '#health', '#compass']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${selector} fits ${width}x${height}`);
      }
      await page.locator('[data-touch-action="inventory"]').tap();
      await page.locator('#inv-items .slot').last().tap();
      await page.locator('#close-inventory').tap();
      await page.waitForFunction(() => __game.state.mode === 'playing');
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
