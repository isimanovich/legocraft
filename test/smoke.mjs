// Headless smoke test: node --import ./test/register.mjs test/smoke.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, BLOCK, BLOCK_INFO, SEA, PLACEABLE, DEFAULT_HOTBAR } from '../src/world.js';
import { moveWithCollision, boxCollides, rayBox, inWater } from '../src/physics.js';
import { Enemy, pickType, AGGRO_RADIUS, FUSE_SECONDS, FUSE_RADIUS, BLINK_MIN, BLINK_MAX, findSpawnSpot, SPAWN_MIN_R, SPAWN_MAX_R, SPAWN_SPACING } from '../src/enemies.js';
import { Debris } from '../src/debris.js';
import { Ragdolls } from '../src/ragdoll.js';
import { Player } from '../src/player.js';
import { Tomatoes, TOMATO_LIFE } from '../src/tomatoes.js';
import { findPath } from '../src/pathfind.js';
import { Animal } from '../src/animals.js';

const scene = new THREE.Scene();
const world = new World(scene, { sizeX: 144, sizeZ: 144, sizeY: 48, seed: Number(process.env.SEED ?? 42) });

let t0 = performance.now();
world.generate();
console.log(`generate: ${(performance.now() - t0).toFixed(1)}ms`);

// Census: structures and lakes must actually land on the map.
const census = {};
for (const b of world.data) census[b] = (census[b] ?? 0) + 1;
const names = Object.fromEntries(Object.entries(BLOCK).map(([k, v]) => [v, k]));
console.log('census:', Object.entries(census).map(([k, v]) => `${names[k]}=${v}`).join(' '));
assert.ok(census[BLOCK.WATER] > 0, 'water present');
assert.ok(census[BLOCK.RED] + census[BLOCK.BLUE] + census[BLOCK.YELLOW] + census[BLOCK.WHITE] > 300, 'houses/bricks present');
assert.ok(census[BLOCK.WOOD] > 100, 'trees present');
assert.ok((census[BLOCK.GOLD] ?? 0) >= 1, 'pyramid present (gold cap)');
assert.ok((census[BLOCK.DARKGREY] ?? 0) >= 20, 'ruins present');
assert.ok((census[BLOCK.PLANKS] ?? 0) >= 20, 'pier present');
// Piers: every plank sits one above the water line with air above it, over water or beach.
{
  let planks = 0;
  for (let z = 0; z < world.sz; z++) {
    for (let x = 0; x < world.sx; x++) {
      for (let y = 0; y < world.sy; y++) {
        if (world.get(x, y, z) !== BLOCK.PLANKS) continue;
        planks++;
        assert.equal(y, SEA + 1, `plank at water line (y=${y})`);
        assert.ok(world.get(x, y + 1, z) === BLOCK.AIR || world.get(x, y + 1, z) === BLOCK.WOOD, 'deck is walkable');
        const below = world.get(x, y - 1, z);
        assert.ok(below === BLOCK.WATER || below === BLOCK.SAND || below === BLOCK.WOOD || below === BLOCK.DIRT, `pier over water/beach, got ${below}`);
      }
    }
  }
  console.log(`pier planks: ${planks}`);
}
// Hotbar defaults reference real items.
assert.equal(DEFAULT_HOTBAR.length, 9);
for (const item of DEFAULT_HOTBAR) assert.ok(item === 'sword' || BLOCK_INFO[item], `hotbar item ${item} exists`);
for (const t of PLACEABLE) assert.ok(BLOCK_INFO[t]?.name, `placeable ${t} has info`);

t0 = performance.now();
const built = world.update();
console.log(`meshed ${built} chunks in ${(performance.now() - t0).toFixed(1)}ms`);
assert.equal(world.dirty.size, 0);
const meshes = world.meshes.filter(Boolean);
assert.ok(meshes.length > 0, 'chunks produced meshes');
let tris = 0;
for (const m of meshes) tris += m.geometry.index.count / 3;
console.log(`triangles: ${tris}`);

// Terrain sanity
const h = world.heightAt(24, 24);
assert.ok(h > 3 && h < 44, `height in range: ${h}`);
assert.equal(world.get(24, 0, 24), BLOCK.BEDROCK);
assert.ok(world.get(24, h + 1, 24) === BLOCK.AIR || world.get(24, h, 24) === BLOCK.WATER);
// Water is wadeable and the raycast looks through it.
assert.ok(!world.isSolid(0, 0, 0) || world.get(0, 0, 0) !== BLOCK.WATER);
assert.equal(world.isSolid(-1, 5, 5), true);

// Raycast straight down hits the top non-water block with +y normal
const hit = world.raycast(new THREE.Vector3(24.5, 47, 24.5), new THREE.Vector3(0, -1, 0), 60);
assert.ok(hit, 'raycast hit');
let solidTop = h;
while (world.get(24, solidTop, 24) === BLOCK.WATER) solidTop--;
assert.equal(hit.y, solidTop);
assert.equal(hit.ny, 1);

// set/dirty
assert.ok(world.set(24, h + 1, 24, BLOCK.RED));
assert.ok(world.dirty.size >= 1);
world.update();
assert.equal(world.heightAt(24, 24), h + 1);
world.set(24, h + 1, 24, BLOCK.AIR);
world.update();

// Physics: drop a box and make sure it lands on the surface
const pos = new THREE.Vector3(24.5, h + 5, 24.5);
const vel = new THREE.Vector3(0, 0, 0);
let onGround = false;
for (let i = 0; i < 200; i++) {
  vel.y -= 28 / 60;
  const r = moveWithCollision(world, pos, vel, 1 / 60, 0.3, 1.8);
  if (r.onGround) { onGround = true; break; }
}
assert.ok(onGround, 'landed');
assert.ok(Math.abs(pos.y - (solidTop + 1)) < 1e-6, `feet on block top: ${pos.y}`);
assert.ok(!boxCollides(world, pos.x, pos.y, pos.z, 0.3, 1.8));

// Walk into the world wall and get stopped
pos.set(0.5, world.heightAt(0, 0) + 1, 0.5);
vel.set(-10, 0, 0);
const r2 = moveWithCollision(world, pos, vel, 0.05, 0.3, 1.8);
assert.ok(r2.hitWall && Math.abs(pos.x - 0.301) < 1e-6 && vel.x === 0, `stopped at wall: ${pos.x}`);

// Ray-box
assert.ok(Math.abs(rayBox(0, 0, 0, 1, 0, 0, 2, -1, -1, 3, 1, 1) - 2) < 1e-9);
assert.equal(rayBox(0, 0, 0, -1, 0, 0, 2, -1, -1, 3, 1, 1), Infinity);

// Pathfinding: diagonal movement. On open ground a path is one straight line to the goal;
// around a wall the body never cuts through the wall's corner.
{
  const arena = new World(new THREE.Scene(), { sizeX: 32, sizeZ: 32, sizeY: 12, seed: 1 });
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y <= 5; y++) arena.set(x, y, z, y === 5 ? BLOCK.GRASS : BLOCK.STONE);
  const open = findPath(arena, { x: 3, y: 6, z: 3 }, { x: 20, y: 6, z: 17 }, 2);
  assert.ok(open, 'open-ground path found');
  assert.equal(open.length, 1, `open ground collapses to a single straight segment (got ${open.length})`);
  assert.deepEqual(open[0], { x: 20, y: 6, z: 17 }, 'and it ends at the goal');
  // Wall across the middle with a gap at the far end: x = 12, z 0..20, three blocks tall.
  for (let z = 0; z <= 20; z++) for (let y = 6; y <= 8; y++) arena.set(12, y, z, BLOCK.RED);
  const around = findPath(arena, { x: 6, y: 6, z: 6 }, { x: 18, y: 6, z: 6 }, 2);
  assert.ok(around && around.length >= 2, 'path around the wall found');
  assert.deepEqual(around[around.length - 1], { x: 18, y: 6, z: 6 }, 'reaches the goal');
  const halfW = 0.32;
  let prev = { x: 6, y: 6, z: 6 };
  let total = 0;
  for (const wp of around) {
    const ax = prev.x + 0.5, az = prev.z + 0.5;
    const dx = wp.x + 0.5 - ax, dz = wp.z + 0.5 - az;
    const len = Math.hypot(dx, dz);
    total += len;
    const n = Math.ceil(len / 0.1);
    for (let i = 0; i <= n; i++) {
      const sx = ax + (dx * i) / n, sz = az + (dz * i) / n;
      for (const [ox, oz] of [[halfW, halfW], [halfW, -halfW], [-halfW, halfW], [-halfW, -halfW]]) {
        assert.ok(!arena.isSolid(Math.floor(sx + ox), 6, Math.floor(sz + oz)), `body clips the wall at ${(sx + ox).toFixed(2)},${(sz + oz).toFixed(2)}`);
      }
    }
    prev = wp;
  }
  const manhattan = (21 - 6) * 2 + 12; // the old 4-connected route: down to z=21 and back up, 12 across
  console.log(`around the wall: ${around.length} waypoints, length ${total.toFixed(1)} (4-connected would be ${manhattan})`);
  assert.ok(total < manhattan - 4, 'diagonal route is clearly shorter than the grid-step one');
  assert.ok(around.some((wp) => wp.z >= 21), 'route goes round the wall end');
}

// Enemy AI chases a player
const cam = new THREE.PerspectiveCamera();
const player = new Player(cam, world);
player.spawn();
// Spawn 8 blocks out on roughly the player's level (cliffs are legit terrain, not AI bugs).
let eg = null;
for (const rad of [8, 10, 6]) {
  for (let a = 0; a < Math.PI * 2 && !eg; a += Math.PI / 8) {
    const g = world.findGround(player.pos.x + Math.cos(a) * rad, player.pos.z + Math.sin(a) * rad, 3);
    if (g && Math.abs(g.y + 1 - player.pos.y) <= 2) eg = g;
  }
  if (eg) break;
}
assert.ok(eg, 'enemy ground found');
const ex = eg.x + 0.5;
const ez = eg.z + 0.5;
const en = new Enemy('brute', ex, eg.y + 1.01, ez);
scene.add(en.group);
const debris = new Debris(scene, world);
let attacks = 0;
const ctx = { world, enemies: [en], onAttack: () => attacks++ };
const d0 = Math.hypot(player.pos.x - en.pos.x, player.pos.z - en.pos.z);
for (let i = 0; i < 60 * 12; i++) en.update(1 / 60, player, ctx);
const d1 = Math.hypot(player.pos.x - en.pos.x, player.pos.z - en.pos.z);
console.log(`enemy closed distance ${d0.toFixed(1)} -> ${d1.toFixed(1)}, state=${en.state}, attacks=${attacks}`);
assert.ok(d1 < d0, 'enemy approached player');
assert.ok(attacks > 0, 'enemy attacked once in reach');

// Enemy outside AGGRO_RADIUS ignores the player (short window: wandering may drift it closer).
let fg = null;
for (let a = 0; a < Math.PI * 2 && !fg; a += Math.PI / 4) {
  fg = world.findGround(player.pos.x + Math.cos(a) * (AGGRO_RADIUS + 10), player.pos.z + Math.sin(a) * (AGGRO_RADIUS + 10), 3);
}
assert.ok(fg, 'far enemy ground found');
const far = new Enemy(pickType(0), fg.x + 0.5, fg.y + 1.01, fg.z + 0.5);
let farAttacks = 0;
for (let i = 0; i < 60 * 4; i++) far.update(1 / 60, player, { world, enemies: [far], onAttack: () => farAttacks++ });
console.log(`far enemy state=${far.state}, attacks=${farAttacks}`);
assert.equal(far.state, 'wander', 'far enemy stays passive');
assert.equal(farAttacks, 0, 'far enemy never attacked');

// Bomber: never swings; standing within FUSE_RADIUS for FUSE_SECONDS detonates it.
{
  const bomber = new Enemy('bomber', player.pos.x + 1.2, player.pos.y, player.pos.z);
  let detonated = -1;
  let melee = 0;
  let ticks = 0;
  const bctx = { world, enemies: [bomber], onAttack: () => melee++, onDetonate: () => (detonated = frame), onTick: () => ticks++ };
  let frame = 0;
  for (; frame < 60 * 5 && detonated < 0; frame++) {
    bomber.update(1 / 60, player, bctx);
    bomber.pos.set(player.pos.x + 1.2, player.pos.y, player.pos.z); // pin next to the player
  }
  console.log(`bomber detonated at frame ${detonated} (${(detonated / 60).toFixed(2)}s), ticks=${ticks}, melee=${melee}`);
  assert.ok(detonated >= 0, 'bomber detonated');
  assert.ok(Math.abs(detonated / 60 - FUSE_SECONDS) < 0.1, 'fuse ran for ~3 s');
  assert.equal(melee, 0, 'bomber never melees');
  assert.ok(ticks > 10, 'fuse ticked');

  // Stepping away before the fuse runs out cools it down instead of detonating.
  const cool = new Enemy('bomber', player.pos.x + 1.2, player.pos.y, player.pos.z);
  let coolDet = 0;
  const cctx = { world, enemies: [cool], onAttack: () => {}, onDetonate: () => coolDet++ };
  for (let i = 0; i < 60 * 2; i++) {
    cool.update(1 / 60, player, cctx);
    cool.pos.set(player.pos.x + 1.2, player.pos.y, player.pos.z);
  }
  const fuseAt2s = cool.fuse;
  for (let i = 0; i < 60 * 3; i++) {
    cool.update(1 / 60, player, cctx);
    cool.pos.set(player.pos.x + FUSE_RADIUS + 3, player.pos.y, player.pos.z);
  }
  console.log(`bomber fuse ${fuseAt2s.toFixed(2)} -> ${cool.fuse.toFixed(2)} after backing off`);
  assert.ok(fuseAt2s > 1.9, 'fuse was burning');
  assert.ok(cool.fuse < fuseAt2s, 'fuse cooled when player left');
  assert.equal(coolDet, 0, 'no detonation after backing off');
}

// Kill + explode -> debris
assert.ok(en.hit(1000, 1, 0));
en.explode(debris);
assert.ok(debris.items.length > 10, `debris parts: ${debris.items.length}`);
for (let i = 0; i < 60 * 3; i++) debris.update(1 / 60);
assert.equal(debris.items.length, 0, 'debris expired');

// Spawning: consecutive spawns fan out round the player and keep their distance from each other.
{
  const others = [];
  const cursor = { angle: 0 };
  for (let i = 0; i < 10; i++) {
    const s = findSpawnSpot(world, player.pos, others, 3, cursor);
    if (!s) break;
    const r = Math.hypot(s.x - player.pos.x, s.z - player.pos.z);
    assert.ok(r >= SPAWN_MIN_R - 5 && r <= SPAWN_MAX_R + 5, `spawn in the ring (${r.toFixed(1)}; findGround may shift it ~4 blocks)`);
    others.push({ pos: new THREE.Vector3(s.x, s.y + 1, s.z) });
  }
  assert.ok(others.length >= 8, `found ${others.length} spawn spots`);
  let minPair = Infinity;
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) minPair = Math.min(minPair, others[i].pos.distanceTo(others[j].pos));
  }
  // Angular spread: the spawns should not all sit in one half of the ring.
  const angles = others.map((o) => Math.atan2(o.pos.z - player.pos.z, o.pos.x - player.pos.x));
  const quadrants = new Set(angles.map((a) => Math.floor(((a + Math.PI) / (Math.PI * 2)) * 4) % 4));
  console.log(`spawns: ${others.length}, closest pair ${minPair.toFixed(1)} blocks, ${quadrants.size}/4 quadrants used`);
  assert.ok(minPair >= SPAWN_SPACING * 0.5 - 1e-9, 'no two spawns closer than the relaxed spacing');
  assert.ok(quadrants.size >= 3, 'spawns spread around the player');
}

// Stalker: tall, blinks when hit, dies in one piece and ragdolls; the body can be carried.
{
  const countMeshes = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); return n; };
  const st = new Enemy('stalker', ex, eg.y + 1.01, ez);
  scene.add(st.group);
  assert.ok(st.height > 3.2 && st.height < 3.8, `stalker is tall: ${st.height.toFixed(2)}`);
  const meshesBefore = countMeshes(st.group);
  // Force a blink and check it lands on clear ground within range of the player.
  st.blinkPending = true;
  let blinks = 0;
  const sctx = { world, enemies: [st], onAttack: () => {}, onBlink: () => blinks++ };
  st.update(1 / 60, player, sctx);
  const bd = Math.hypot(player.pos.x - st.pos.x, player.pos.z - st.pos.z);
  console.log(`stalker blinked ${blinks}x, now ${bd.toFixed(1)} blocks from player`);
  assert.equal(blinks, 1, 'stalker blinked');
  assert.ok(bd >= BLINK_MIN - 3 && bd <= BLINK_MAX + 3, 'blink landed in range (findGround may shift it ~2 blocks)');
  assert.ok(!boxCollides(world, st.pos.x, st.pos.y, st.pos.z, st.halfW, st.height), 'blink spot is clear');

  // Kill it: no debris, the group stays in the scene as a ragdoll and topples over.
  assert.ok(st.hit(1000, 1, 0));
  const ragdolls = new Ragdolls(scene, world);
  const body = ragdolls.add(st);
  assert.equal(debris.items.length, 0, 'ragdoll death spawns no debris');
  assert.equal(countMeshes(st.group), meshesBefore, 'figure stays intact');
  assert.ok(scene.children.includes(st.group), 'body stays in the scene');
  const upStart = body.up.y;
  for (let i = 0; i < 60 * 6; i++) ragdolls.update(1 / 60, player, null);
  // Supported if the collision box, lowered slightly, touches something solid, or the body floats in water
  // (heightAt would count tree canopies, and a body may rest across a block edge).
  const floating = (b) => [-0.6, -0.3, 0].some((o) => inWater(world, new THREE.Vector3(b.com.x, b.com.y + o, b.com.z)));
  const supported = (b) => boxCollides(world, b.com.x, b.com.y - b.colHeight / 2 - 0.05, b.com.z, b.colHalf, b.colHeight) || floating(b);
  console.log(`ragdoll up.y ${upStart.toFixed(2)} -> ${body.up.y.toFixed(2)}, com y ${body.com.y.toFixed(2)}, supported=${supported(body)}, speed ${body.vel.length().toFixed(2)}`);
  assert.ok(Math.abs(body.up.y) < 0.35, 'body ended up lying down');
  assert.ok(!body.pinned, 'body released from its feet');
  assert.ok(supported(body) || body.vel.length() > 0.5, 'body rests on the ground');
  assert.ok(body.vel.length() < 0.5 || floating(body), 'body came to rest');
  assert.equal(countMeshes(st.group), meshesBefore, 'still intact after settling');
  for (const l of body.limbs) assert.ok(Number.isFinite(l.node.rotation.x) && Number.isFinite(l.node.rotation.z), 'limb rotations finite');

  const worldAxis = (node, axis) => {
    node.updateWorldMatrix(true, false);
    const q = new THREE.Quaternion();
    node.getWorldQuaternion(q);
    return new THREE.Vector3(0, axis, 0).applyQuaternion(q);
  };
  // Not held, free in the air with no spin: every limb hangs toward world-down.
  body.onGround = false;
  body.swimming = false;
  body.airTime = 1;
  for (let i = 0; i < 180; i++) body.updateLimbs(1 / 60);
  body.sync();
  const airLeg = worldAxis(st.legL, -1).y;
  const airArm = worldAxis(st.armR, -1).y;
  const airTorso = worldAxis(st.upper, 1).y;
  console.log(`free in air: leg dir.y ${airLeg.toFixed(2)}, arm dir.y ${airArm.toFixed(2)}, torso dir.y ${airTorso.toFixed(2)}`);
  assert.ok(airLeg < -0.7, 'legs hang down while falling');
  assert.ok(airArm < -0.6, 'arms hang down while falling (joint limits allow some tilt)');
  assert.ok(airTorso < -0.5, 'torso folds down while falling');
  // Back on the ground the limbs settle flat rather than poking into it.
  for (let i = 0; i < 60 * 3; i++) ragdolls.update(1 / 60, player, null);
  const flatLeg = worldAxis(st.legL, -1).y;
  const flatArm = worldAxis(st.armR, -1).y;
  console.log(`on ground: leg dir.y ${flatLeg.toFixed(2)}, arm dir.y ${flatArm.toFixed(2)}, body up.y ${body.up.y.toFixed(2)}`);
  assert.ok(flatLeg > -0.7, 'legs lie flat on the ground');
  assert.ok(flatArm > -0.7, 'arms lie flat on the ground');
  // A tossed body flails in flight and settles again after landing.
  const roofed = world.heightAt(body.com.x, body.com.z) > body.com.y + 0.5 || floating(body); // canopy/water: toss can't lift it
  const toss = body.axisPoint(0.5, new THREE.Vector3());
  body.impulse(toss, new THREE.Vector3(3, 9, 0));
  let airFrames = 0;
  let groundRun = 0;
  let frames = 0;
  for (; frames < 60 * 10; frames++) {
    ragdolls.update(1 / 60, player, null);
    if (!body.onGround && !body.swimming) {
      airFrames++;
      groundRun = 0;
    } else {
      groundRun++;
    }
    if (frames >= 120 && groundRun >= 150 && body.vel.length() < 0.5) break; // 2.5 s of rest
  }
  const limbSpeed = body.limbs.reduce((s, l) => s + Math.abs(l.vx) + Math.abs(l.vz), 0);
  const bodyStill = body.vel.length() < 0.5 && body.angVel.length() < 1;
  console.log(`tossed: ${airFrames} frames airborne (roofed=${roofed}), ${(frames / 60).toFixed(1)}s, landed supported=${supported(body)}, still=${bodyStill}, limb speed ${limbSpeed.toFixed(2)}`);
  assert.ok(airFrames > 10 || roofed, 'toss put the body in the air');
  assert.ok(supported(body) || body.vel.length() > 0.5, 'tossed body landed');
  assert.ok(limbSpeed < 3 || !bodyStill, 'limbs settled once the body stopped');
  assert.equal(countMeshes(st.group), meshesBefore, 'intact after the toss');

  // Carry: grab a point on the body and hold the hand well above it; the grab point follows.
  const restY = body.com.y;
  const grabPoint = body.axisPoint(0.6, new THREE.Vector3());
  ragdolls.grab(body, grabPoint);
  assert.equal(ragdolls.carrying, body);
  const hand = grabPoint.clone().add(new THREE.Vector3(0.5, 1.6, 0));
  for (let i = 0; i < 60 * 2; i++) ragdolls.update(1 / 60, player, hand);
  const held = body.grabLocal.clone().applyQuaternion(body.q).add(body.com);
  const gap = held.distanceTo(hand);
  // If the spot the body is being pulled to is inside a block (tree, wall), it legitimately lags behind.
  const want = body.com.clone().add(hand).sub(held);
  const blocked = boxCollides(world, want.x, want.y - body.colHeight / 2, want.z, body.colHalf, body.colHeight);
  console.log(`carried: grab point ${gap.toFixed(2)} from hand (blocked=${blocked}), body up.y ${body.up.y.toFixed(2)}, lifted ${(body.com.y - restY).toFixed(2)}`);
  assert.ok(gap < 0.5 || blocked, 'grab point tracks the hand');
  assert.ok(body.com.y > restY + 0.3 || blocked, 'body lifted off the ground');
  // Held by the upper body: the legs and arms dangle toward world-down, waist stays straight.
  const legDown = worldAxis(st.legL, -1).y;
  const armDown = worldAxis(st.armR, -1).y;
  console.log(`held by body: leg dir.y ${legDown.toFixed(2)}, arm dir.y ${armDown.toFixed(2)}, waist bend ${Math.abs(st.upper.rotation.x).toFixed(2)}`);
  assert.ok(legDown < -0.8, 'legs hang down while held by the body');
  assert.ok(armDown < -0.7, 'arms hang down while held by the body');
  assert.ok(Math.abs(st.upper.rotation.x) < 0.4, 'waist stays straight when held above it');
  // Re-grab by a foot: hangs head-down, straight (torso below the hip), arms dangle toward the ground.
  ragdolls.drop();
  const footPoint = body.axisPoint(-0.8, new THREE.Vector3());
  ragdolls.grab(body, footPoint);
  const hand2 = footPoint.clone().add(new THREE.Vector3(0, 1.4, 0));
  for (let i = 0; i < 60 * 3; i++) ragdolls.update(1 / 60, player, hand2);
  const armDown2 = worldAxis(st.armL, -1).y;
  console.log(`held by foot: body up.y ${body.up.y.toFixed(2)}, waist (x ${st.upper.rotation.x.toFixed(2)} z ${st.upper.rotation.z.toFixed(2)}), arm dir.y ${armDown2.toFixed(2)}`);
  assert.ok(body.up.y < -0.8, 'hangs head-down when held by a foot');
  assert.ok(armDown2 < -0.4, 'arms hang while held by a foot');
  // Grab around the waist while it lies flat: legs and torso both hang, folding the body into a V.
  ragdolls.drop();
  for (let i = 0; i < 60 * 4; i++) ragdolls.update(1 / 60, player, null);
  const kWaist = (body.waist * body.scale - body.halfLen) / body.halfLen;
  const waistPoint = body.axisPoint(kWaist, new THREE.Vector3());
  ragdolls.grab(body, waistPoint);
  const hand3 = waistPoint.clone().add(new THREE.Vector3(0, 1.4, 0));
  for (let i = 0; i < 60 * 3; i++) ragdolls.update(1 / 60, player, hand3);
  const fold = Math.hypot(st.upper.rotation.x, st.upper.rotation.z);
  const legDown3 = worldAxis(st.legR, -1).y;
  const headDown3 = worldAxis(st.upper, 1).y;
  console.log(`held by waist: body up.y ${body.up.y.toFixed(2)}, waist fold ${fold.toFixed(2)}, leg dir.y ${legDown3.toFixed(2)}, torso dir.y ${headDown3.toFixed(2)}`);
  assert.ok(legDown3 < -0.6, 'legs hang when held at the waist');
  assert.ok(headDown3 < -0.5, 'torso hangs when held at the waist');
  assert.ok(fold > 0.5 || Math.abs(body.up.y) > 0.8, 'body folds at the waist unless it swung vertical');
  // Drop it: it falls back down and comes to rest again.
  ragdolls.drop(new THREE.Vector3(2, 0, 0));
  assert.equal(ragdolls.carrying, null);
  for (let i = 0; i < 60 * 4; i++) ragdolls.update(1 / 60, player, null);
  console.log(`dropped: com y ${body.com.y.toFixed(2)}, supported=${supported(body)}, speed ${body.vel.length().toFixed(2)}`);
  assert.ok(supported(body), 'dropped body landed');
  assert.ok(body.vel.length() < 0.5 || floating(body), 'dropped body at rest');
  assert.equal(countMeshes(st.group), meshesBefore, 'intact after carrying');
  // Naming: a label sprite follows the body above its highest point; empty name clears it; removal cleans up.
  const fakeLabel = (n) => { const s = new THREE.Sprite(new THREE.SpriteMaterial()); s.userData.text = n; return s; };
  ragdolls.setName(body, '  Gerald ', fakeLabel);
  assert.equal(body.name, 'Gerald', 'name is trimmed');
  assert.ok(body.label && scene.children.includes(body.label), 'label added to the scene');
  assert.equal(body.label.userData.text, 'Gerald');
  ragdolls.update(1 / 60, player, null);
  const topY = Math.max(body.com.y, body.axisPoint(1, new THREE.Vector3()).y, body.axisPoint(-1, new THREE.Vector3()).y);
  assert.ok(Math.abs(body.label.position.x - body.com.x) < 1e-9 && Math.abs(body.label.position.z - body.com.z) < 1e-9, 'label over the body');
  assert.ok(body.label.position.y > topY && body.label.position.y < topY + 1, 'label floats above the highest part');
  const firstLabel = body.label;
  ragdolls.setName(body, 'Bob', fakeLabel);
  assert.ok(!scene.children.includes(firstLabel) && body.label !== firstLabel, 'renaming replaces the label');
  ragdolls.setName(body, '', fakeLabel);
  assert.equal(body.name, '');
  assert.equal(body.label, null, 'empty name removes the label');
  ragdolls.setName(body, 'Zed', fakeLabel);
  const lastLabel = body.label;
  ragdolls.clear();
  assert.ok(!scene.children.includes(st.group), 'cleared body left the scene');
  assert.ok(!scene.children.includes(lastLabel), 'its label went with it');
  console.log('naming: label follows the body, rename replaces, empty clears, removal cleans up');
}

// Tomatoes: fly in an arc, burst on a minifig (reporting it), on terrain (outside the block), or on a timer.
{
  const tomatoes = new Tomatoes(scene, world);
  const bursts = [];
  const ctx = { enemies: [], bodies: [], onExplode: (pos, hit) => bursts.push({ pos, hit }) };
  // Point blank at a minifig in a clear column high above the ground: must register as a direct hit.
  const tx = ex + 0.5;
  const tz = ez + 0.5;
  const target = new Enemy('brute', tx, 40, tz);
  ctx.enemies.push(target);
  tomatoes.throw(new THREE.Vector3(tx - 3, 40 + target.height / 2, tz), new THREE.Vector3(1, 0, 0));
  for (let i = 0; i < 60 && bursts.length === 0; i++) tomatoes.update(1 / 60, ctx);
  assert.equal(bursts.length, 1, 'tomato burst on the minifig');
  assert.equal(bursts[0].hit, target, 'burst reports the minifig it struck');
  assert.equal(tomatoes.items.length, 0, 'burst tomato removed');
  console.log(`tomato hit minifig at ${bursts[0].pos.x.toFixed(2)} (${(bursts[0].pos.x - (tx - 3)).toFixed(2)} blocks out)`);
  ctx.enemies.length = 0;
  // Straight down onto the ground: bursts just above the surface, never inside a block.
  bursts.length = 0;
  const gy = world.heightAt(tx, tz);
  tomatoes.throw(new THREE.Vector3(tx, gy + 8, tz), new THREE.Vector3(0, -1, 0));
  for (let i = 0; i < 180 && bursts.length === 0; i++) tomatoes.update(1 / 60, ctx);
  assert.equal(bursts.length, 1, 'tomato burst on terrain');
  const bp = bursts[0].pos;
  assert.equal(bursts[0].hit, null, 'terrain burst has no target');
  assert.ok(!world.isSolid(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z)), 'burst point is outside the block');
  assert.ok(bp.y - (gy + 1) < 0.6, `burst within 0.6 of the surface (${(bp.y - gy - 1).toFixed(2)})`);
  // Touching nothing: bursts on its own when its life runs out (shortened here so it stays airborne).
  bursts.length = 0;
  const sky = tomatoes.throw(new THREE.Vector3(tx, 44, tz), new THREE.Vector3(0, 1, 0));
  assert.ok(Math.abs(sky.life - TOMATO_LIFE) < 1e-9, 'fresh tomato has the full fuse');
  sky.life = 0.5;
  let frames = 0;
  while (bursts.length === 0 && frames < 120) {
    tomatoes.update(1 / 60, ctx);
    frames++;
  }
  console.log(`sky tomato burst after ${(frames / 60).toFixed(2)}s at y ${bursts[0]?.pos.y.toFixed(1)}`);
  assert.ok(bursts.length === 1 && Math.abs(frames / 60 - 0.5) < 0.05, 'tomato bursts on the timer');
  assert.equal(bursts[0].hit, null, 'timer burst has no target');
  tomatoes.clear();
}

// Direction bar: bearingTo agrees with lookDir. Straight ahead = 0, to the right = +90 deg, behind = 180.
{
  const d = new THREE.Vector3();
  for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -2.3]) {
    player.yaw = yaw;
    player.pitch = 0;
    player.lookDir(d);
    const ahead = player.bearingTo(player.pos.x + d.x * 10, player.pos.z + d.z * 10);
    const behind = player.bearingTo(player.pos.x - d.x * 10, player.pos.z - d.z * 10);
    // Right-hand side: forward x up = (-fz, 0, fx) in a right-handed frame (looking -z, right is +x).
    const rx = -d.z;
    const rz = d.x;
    const right = player.bearingTo(player.pos.x + rx * 10, player.pos.z + rz * 10);
    assert.ok(Math.abs(ahead) < 1e-9, `ahead is 0 at yaw ${yaw}: ${ahead}`);
    assert.ok(Math.abs(Math.abs(behind) - Math.PI) < 1e-9, `behind is 180 at yaw ${yaw}: ${behind}`);
    assert.ok(Math.abs(right - Math.PI / 2) < 1e-9, `right is +90 at yaw ${yaw}: ${right}`);
  }
  player.yaw = Math.PI;
  console.log('bearingTo matches lookDir for 5 yaws');
}

// Name tags: with a canvas available each enemy carries a sprite above its head at a constant
// world size, and death (either kind) removes it. Headless (no document) enemies simply have none.
{
  assert.equal(new Enemy('brute', ex, eg.y + 1.01, ez).tag, null, 'no tag without a document');
  const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ width: 120 })) });
  globalThis.document = { createElement: () => ({ getContext: () => ctxStub }) };
  try {
    const worldTagHeight = (en) => en.tag.scale.y * en.group.scale.y;
    const brute = new Enemy('brute', ex, eg.y + 1.01, ez);
    const titan = new Enemy('titan', ex, eg.y + 1.01, ez);
    const stalker = new Enemy('stalker', ex, eg.y + 1.01, ez);
    for (const en of [brute, titan, stalker]) {
      assert.ok(en.tag?.isSprite, `${en.type.name} has a sprite tag`);
      assert.ok(en.group.children.includes(en.tag), 'tag is attached to the figure');
      const tagY = en.tag.position.y * en.group.scale.y;
      assert.ok(tagY > en.height && tagY < en.height + 0.6, `${en.type.name} tag floats just above the head (${tagY.toFixed(2)} vs ${en.height.toFixed(2)})`);
    }
    assert.ok(Math.abs(worldTagHeight(brute) - worldTagHeight(titan)) < 1e-9, 'tags are the same world size regardless of figure scale');
    assert.notStrictEqual(brute.tag.material, titan.tag.material, 'different names get different textures');
    assert.strictEqual(new Enemy('brute', ex, eg.y + 1.01, ez).tag.material, brute.tag.material, 'same name shares one texture');
    brute.explode(debris);
    assert.equal(brute.tag, null, 'explode removes the tag');
    assert.ok(!brute.group.children.some((o) => o.isSprite), 'no sprite left on the exploded group');
    stalker.hit(1000, 1, 0);
    stalker.toRagdoll();
    assert.equal(stalker.tag, null, 'ragdoll removes the tag');
    assert.ok(!stalker.group.children.some((o) => o.isSprite), 'no sprite left on the body');
    debris.clear();
    console.log('name tags attach above the head and are removed on death');
  } finally {
    delete globalThis.document;
  }
}

// Passive creatures: a wolf and a cat wander without clipping into terrain, never attack, and bolt when startled.
{
  // An open, flat spot: every neighbour column within a block of the centre height with clear air above.
  const openSpot = () => {
    for (let r = 3; r < 40; r += 1) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const g = world.findGround(player.pos.x + Math.cos(a) * r, player.pos.z + Math.sin(a) * r, 2);
        if (!g) continue;
        let ok = true;
        for (let dx = -2; dx <= 2 && ok; dx++) {
          for (let dz = -2; dz <= 2 && ok; dz++) {
            const h = world.heightAt(g.x + dx, g.z + dz);
            if (Math.abs(h - g.y) > 1 || world.get(g.x + dx, h, g.z + dz) === BLOCK.WATER) ok = false;
            for (let y = 1; y <= 3 && ok; y++) if (world.get(g.x + dx, h + y, g.z + dz) !== BLOCK.AIR) ok = false;
          }
        }
        if (ok) return g;
      }
    }
    return null;
  };
  const spot = openSpot();
  assert.ok(spot, 'animal ground found');
  for (const kind of ['wolf', 'cat']) {
    const a = new Animal(kind, spot.x + 0.5, spot.y + 1.01, spot.z + 0.5);
    scene.add(a.group);
    const start = a.pos.clone();
    let maxFromStart = 0;
    let frames = 0;
    // Up to 30 s: a cat may sit through several idle picks before it bothers to stroll.
    for (; frames < 60 * 30 && (frames < 60 * 6 || maxFromStart < 1.5); frames++) {
      a.update(1 / 60, world, player);
      assert.ok(!boxCollides(world, a.pos.x, a.pos.y + 0.01, a.pos.z, a.halfW * 0.9, a.height * 0.9), `${kind} stays out of blocks`);
      maxFromStart = Math.max(maxFromStart, a.pos.distanceTo(start));
    }
    assert.ok(maxFromStart > 1, `${kind} wandered (${maxFromStart.toFixed(1)} blocks in ${(frames / 60).toFixed(0)}s)`);
    assert.ok(a.pos.y > -5, `${kind} still in the world`);
    // Startle it from the player's side: it should end up farther from the player than it was.
    const before = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
    a.startle(player.pos.x, player.pos.z);
    assert.equal(a.state, 'flee');
    for (let i = 0; i < 60; i++) a.update(1 / 60, world, player);
    const after = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
    console.log(`${kind}: wandered ${maxFromStart.toFixed(1)} blocks, startled ${before.toFixed(1)} -> ${after.toFixed(1)} from player`);
    assert.ok(after > before - 0.5, `${kind} ran away (or was blocked) rather than toward the player`);
    assert.equal(a.tag, null, 'headless: no tag');
    scene.remove(a.group);
    a.dispose();
  }
}

// Player update runs
player.keys.add('KeyW');
for (let i = 0; i < 60; i++) player.update(1 / 60);
console.log(`player at ${player.pos.x.toFixed(2)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(2)}`);

console.log('OK');
