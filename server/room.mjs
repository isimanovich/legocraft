import { randomInt, randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { BLOCK, PLACEABLE, DEFAULT_HOTBAR } from '../src/world.js';
import { SAVE_FORMAT_VERSION, encodeTerrain, decodeTerrain, validateSaveVersion } from '../src/save-format.js';
import { ENEMY_TYPES, findSpawnSpot, BLAST_RADIUS, BLAST_BLOCK_RADIUS, typeHeight } from '../src/enemies.js';
import { ANIMAL_TYPES } from '../src/animals.js';
import { Ragdolls, CARRY_DISTANCE } from '../src/ragdoll.js';
import { boxCollides, rayBox, GRAVITY } from '../src/physics.js';
import { TOMATOES_PER_WAVE, TOMATO_MAX, TOMATO_SPEED, TOMATO_LIFE, TOMATO_BLAST_RADIUS, TOMATO_DAMAGE, TOMATO_CRATER_RADIUS, THROW_COOLDOWN } from '../src/tomatoes.js';
import { createWorld, createEnemy, createAnimal } from './headless.mjs';

const id = () => randomUUID();
const xyz = p => ({ x: p.x, y: p.y, z: p.z });
const cleanName = (name, fallback = 'Builder') => typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20) || fallback : fallback;
const cleanWorldName = name => typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'My world' : 'My world';
const overlaps = (x, y, z, e) => x + 1 > e.pos.x - e.halfW && x < e.pos.x + e.halfW && y + 1 > e.pos.y && y < e.pos.y + e.height && z + 1 > e.pos.z - e.halfW && z < e.pos.z + e.halfW;
const falloff = (distance, radius) => distance >= radius ? 0 : Math.max(0.25, 1 - distance / radius);
const pose = p => ({ ...xyz(p.pos), yaw: p.yaw, pitch: p.pitch });
const clientIdPattern = /^[a-f0-9-]{16,64}$/i;
const finite = (v, fallback, min = -1e9, max = 1e9) => Number.isFinite(v) && v >= min && v <= max ? v : fallback;
const cleanHotbar = items => Array.isArray(items) && items.length === DEFAULT_HOTBAR.length && items.every(item => item === 'sword' || PLACEABLE.includes(item)) ? [...items] : [...DEFAULT_HOTBAR];
const cleanSlot = slot => Number.isInteger(slot) && slot >= 0 && slot < DEFAULT_HOTBAR.length ? slot : 0;
const validVector = value => value && [value.x, value.y, value.z].every(v => Number.isFinite(v) && Math.abs(v) <= 1e6);
const restoreVector = (target, value) => { if (validVector(value)) target.copy(value); };
const enemyNumbers = ['hp', 'maxHp', 'dmg', 'speed', 'wanderTimer', 'stuckTimer', 'jumpCooldown', 'detourTimer', 'detourSide', 'detourStreak', 'freeTimer', 'pathIdx', 'repathTimer', 'attackCooldown', 'windup', 'flash', 'walkPhase', 'facing', 'fuse'];
const animalNumbers = ['facing', 'timer', 'walkPhase', 'jumpCooldown'];
const bodyNumbers = ['pinTime', 'airTime', 'age', 'restTime'];
const fields = (object, names) => Object.fromEntries(names.map(key => [key, object[key]]));
const restoreNumbers = (target, source, names) => { for (const key of names) target[key] = finite(source[key], target[key]); };
const boundedList = (value, max, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`Invalid saved ${name}.`);
  return value;
};
const validClientId = value => typeof value === 'string' && clientIdPattern.test(value);
const validateKind = (registry, kind, label) => {
  if (typeof kind !== 'string' || !kind) throw new Error(`Invalid saved ${label} kind.`);
  if (!Object.hasOwn(registry, kind)) throw Object.assign(new Error(`Saved ${label} ${kind.slice(0, 32)} needs a newer game version.`), { code: 'UNSUPPORTED_SAVE_FORMAT' });
};

/** Validate actor collections before choosing a primary save or its backup. */
export function validateRoomActors(saved) {
  const collections = {
    profiles: boundedList(saved.profiles, 256, 'player profiles'), enemies: boundedList(saved.enemies, 128, 'enemies'),
    animals: boundedList(saved.animals, 12, 'animals'), bodies: boundedList(saved.bodies, 16, 'bodies'), projectiles: boundedList(saved.projectiles, 128, 'projectiles'),
  };
  const profileIds = new Set();
  for (const profile of collections.profiles) {
    if (!validClientId(profile.clientId) || !validVector(profile.pos) || profileIds.has(profile.clientId)) throw new Error('Invalid saved player profile.');
    profileIds.add(profile.clientId);
  }
  for (const enemy of collections.enemies) { validateKind(ENEMY_TYPES, enemy.kind, 'enemy'); if (!validVector(enemy.pos)) throw new Error('Invalid saved enemy position.'); }
  for (const animal of collections.animals) { validateKind(ANIMAL_TYPES, animal.kind, 'animal'); if (!validVector(animal.pos)) throw new Error('Invalid saved animal position.'); }
  for (const body of collections.bodies) {
    validateKind(ENEMY_TYPES, body.kind, 'body');
    if (!ENEMY_TYPES[body.kind].ragdoll || !validVector(body.feet) || !validVector(body.com)) throw new Error('Invalid saved body.');
  }
  for (const projectile of collections.projectiles) if (!validVector(projectile.pos) || !validVector(projectile.vel)) throw new Error('Invalid saved projectile.');
  return collections;
}

export class Room {
  constructor(code, gameMode, send, dirty, saved = {}) {
    const formatVersion = validateSaveVersion(saved);
    const actors = validateRoomActors(saved);
    this.code = code;
    this.name = cleanWorldName(saved.name);
    this.gameMode = gameMode;
    this.createdAt = finite(saved.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER);
    this.updatedAt = finite(saved.updatedAt, this.createdAt, 0, Number.MAX_SAFE_INTEGER);
    this.revision = finite(saved.revision, 0, 0, Number.MAX_SAFE_INTEGER);
    this.world = createWorld(saved.seed ?? randomInt(1, 1_000_000));
    if (formatVersion >= 2) this.world.data.set(decodeTerrain(saved.terrain));
    this.send = send;
    this.dirty = () => { this.updatedAt = Date.now(); this.revision++; dirty(); };
    this.players = new Map();
    this.profiles = new Map();
    this.hostId = null;
    this.emptySince = Date.now();
    this.blocks = new Map();
    this.pendingBlocks = new Map();
    this.enemies = [];
    this.animals = [];
    this.projectiles = [];
    this.ragdolls = new Ragdolls(new THREE.Scene(), this.world);
    this.spawnCursor = { angle: Math.random() * Math.PI * 2 };
    this.score = saved.score ?? 0;
    this.kills = saved.kills ?? 0;
    this.wave = saved.wave ?? 1;
    this.remaining = finite(saved.remaining, gameMode === 'wave' ? 3 + Math.floor(this.wave * 1.5) : 0, 0, 1e6);
    this.intermission = finite(saved.intermission, 0, 0, 60);
    this.spawnTimer = finite(saved.spawnTimer, 1.5, -60, 60);
    this.spawnCursor.angle = finite(saved.spawnCursor?.angle, this.spawnCursor.angle);
    this.saveElapsed = 0;
    for (const [x, y, z, type] of saved.blocks ?? []) {
      if (formatVersion < 2) this.edit(x, y, z, type, false);
      else this.blocks.set(`${x},${y},${z}`, [x, y, z, type]);
    }
    for (const profile of actors.profiles) {
      this.profiles.set(profile.clientId, { ...profile, hotbar: cleanHotbar(profile.hotbar), slot: cleanSlot(profile.slot) });
    }
    for (const data of actors.enemies) {
      const e = createEnemy(data.kind, data.pos.x, data.pos.y, data.pos.z, this.wave);
      e.id = typeof data.id === 'string' ? data.id : id();
      restoreNumbers(e, data, enemyNumbers);
      for (const key of ['vel', 'wanderDir', 'detourDir']) restoreVector(e[key], data[key]);
      if (['wander', 'chase', 'attack', 'windup'].includes(data.state)) e.state = data.state;
      for (const key of ['onGround', 'blinkOn', 'blinkPending']) if (typeof data[key] === 'boolean') e[key] = data[key];
      e.path = Array.isArray(data.path) && data.path.length <= 2048 && data.path.every(validVector) ? data.path.map(xyz) : null;
      e.group.rotation.y = e.facing;
      this.enemies.push(e);
    }
    for (const data of actors.animals) {
      const a = createAnimal(data.kind, data.pos.x, data.pos.y, data.pos.z);
      a.id = typeof data.id === 'string' ? data.id : id();
      restoreNumbers(a, data, animalNumbers);
      restoreVector(a.vel, data.vel); restoreVector(a.dir, data.dir);
      if (['idle', 'walk', 'flee', 'sit'].includes(data.state)) a.state = data.state;
      a.onGround = data.onGround === true;
      a.group.position.copy(a.pos); a.group.rotation.y = a.facing;
      this.animals.push(a);
    }
    for (const data of actors.bodies) {
      const e = createEnemy(data.kind, data.feet.x, data.feet.y, data.feet.z);
      e.id = typeof data.id === 'string' ? data.id : id();
      const b = this.addBody(e);
      for (const key of ['com', 'feet', 'vel', 'prevVel', 'angVel', 'tipAxis', 'grabLocal']) restoreVector(b[key], data[key]);
      if (Array.isArray(data.q) && data.q.length === 4 && data.q.every(Number.isFinite) && Math.hypot(...data.q) > 0.01) b.q.fromArray(data.q).normalize();
      b.up.set(0, 1, 0).applyQuaternion(b.q);
      restoreNumbers(b, data, bodyNumbers);
      for (const key of ['pinned', 'onGround', 'swimming']) if (typeof data[key] === 'boolean') b[key] = data[key];
      // A server restart disconnects every hand; bodies retain their pose and
      // momentum, but nobody remains attached to an offline player.
      b.carried = false; b.carrying = null;
      if (data.carried) { b.pinned = false; b.airTime = Math.max(1, b.airTime); }
      b.name = cleanName(data.name, '').slice(0, 16);
      if (Array.isArray(data.limbs) && data.limbs.length === b.limbs.length) data.limbs.forEach((savedLimb, i) => {
        const limb = b.limbs[i];
        if (!savedLimb || typeof savedLimb !== 'object') return;
        restoreNumbers(limb, savedLimb, ['vx', 'vz']);
        limb.rest.x = finite(savedLimb.rest?.x, limb.rest.x, -Math.PI, Math.PI);
        limb.rest.z = finite(savedLimb.rest?.z, limb.rest.z, -Math.PI, Math.PI);
        limb.node.rotation.x = finite(savedLimb.x, 0, -limb.limit, limb.limit);
        limb.node.rotation.z = finite(savedLimb.z, 0, -limb.limit, limb.limit);
      });
      b.sync();
    }
    for (const data of actors.projectiles) {
      this.projectiles.push({ id: typeof data.id === 'string' ? data.id : id(), ownerId: typeof data.ownerId === 'string' ? data.ownerId : null, pos: new THREE.Vector3().copy(data.pos), vel: new THREE.Vector3().copy(data.vel), life: finite(data.life, TOMATO_LIFE, 0, TOMATO_LIFE) });
    }
    this.pendingBlocks.clear();
  }

  broadcast(packet) { for (const p of this.players.values()) this.send(p.socket, packet); }
  worldInfo() { return { code: this.code, name: this.name, gameMode: this.gameMode, createdAt: this.createdAt, updatedAt: this.updatedAt, revision: this.revision, seed: this.world.seed, sizeX: this.world.sx, sizeY: this.world.sy, sizeZ: this.world.sz, terrain: encodeTerrain(this.world.data) }; }
  playerProfile(p) { return { clientId: p.clientId, name: p.name, pos: xyz(p.pos), yaw: p.yaw, pitch: p.pitch, health: p.health, regenDelay: p.regenDelay, tomatoes: p.tomatoes, hotbar: [...p.hotbar], slot: p.slot, updatedAt: Date.now() }; }
  persisted() {
    for (const p of this.players.values()) this.profiles.set(p.clientId, this.playerProfile(p));
    return { formatVersion: SAVE_FORMAT_VERSION, code: this.code, name: this.name, gameMode: this.gameMode, createdAt: this.createdAt, updatedAt: this.updatedAt, revision: this.revision,
      seed: this.world.seed, terrain: encodeTerrain(this.world.data), blocks: [...this.blocks.values()], score: this.score, kills: this.kills, wave: this.wave,
      remaining: this.remaining, intermission: this.intermission, spawnTimer: this.spawnTimer, spawnCursor: { ...this.spawnCursor }, profiles: [...this.profiles.values()],
      enemies: this.enemies.map(e => ({ id: e.id, kind: e.typeKey, pos: xyz(e.pos), vel: xyz(e.vel), wanderDir: xyz(e.wanderDir), detourDir: xyz(e.detourDir), ...fields(e, enemyNumbers), state: e.state, onGround: e.onGround, blinkOn: e.blinkOn, blinkPending: e.blinkPending, path: e.path?.map(xyz) ?? null })),
      animals: this.animals.map(a => ({ id: a.id, kind: a.kind, pos: xyz(a.pos), vel: xyz(a.vel), dir: xyz(a.dir), ...fields(a, animalNumbers), state: a.state, onGround: a.onGround })),
      bodies: this.ragdolls.bodies.map(b => ({ id: b.id, kind: b.kind ?? 'stalker', name: b.name, ...Object.fromEntries(['com', 'feet', 'vel', 'prevVel', 'angVel', 'tipAxis', 'grabLocal'].map(key => [key, xyz(b[key])])), q: b.q.toArray(), ...fields(b, bodyNumbers), carried: b.carried, pinned: b.pinned, onGround: b.onGround, swimming: b.swimming,
        limbs: b.limbs.map(l => ({ x: l.node.rotation.x, z: l.node.rotation.z, vx: l.vx, vz: l.vz, rest: { ...l.rest } })) })),
      projectiles: this.projectiles.map(t => ({ id: t.id, ownerId: t.ownerId, pos: xyz(t.pos), vel: xyz(t.vel), life: t.life })) };
  }

  addPlayer(socket, name, clientId) {
    if (!validClientId(clientId) || [...this.players.values()].some(p => p.clientId === clientId)) clientId = id();
    const profile = this.profiles.get(clientId);
    if (!profile && this.profiles.size >= 256) {
      const active = new Set([...this.players.values()].map(p => p.clientId));
      const oldest = [...this.profiles.values()].filter(p => !active.has(p.clientId)).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))[0];
      if (!oldest) throw new Error('This world has reached its player profile limit.');
      this.profiles.delete(oldest.clientId);
    }
    const player = { id: id(), clientId, name: cleanName(name, profile?.name), socket, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: Math.PI, pitch: 0,
      halfW: 0.3, height: 1.8, health: 100, maxHealth: 100, regenDelay: 0, tomatoes: this.gameMode === 'build' ? TOMATO_MAX : TOMATOES_PER_WAVE,
      hotbar: cleanHotbar(profile?.hotbar), slot: cleanSlot(profile?.slot),
      active: true, carryId: null, lastPose: Date.now(), nextAttack: 0, nextPlace: 0, nextThrow: 0, nextSpawn: 0, nextRespawn: 0 };
    this.spawnPlayer(player);
    if (profile) {
      const pos = profile.pos;
      if (validVector(pos) && pos.x >= player.halfW && pos.x <= this.world.sx - player.halfW && pos.z >= player.halfW && pos.z <= this.world.sz - player.halfW && pos.y >= 0 && pos.y <= this.world.sy + 8 && !boxCollides(this.world, pos.x, pos.y + 0.01, pos.z, player.halfW * 0.98, player.height - 0.02) && [...this.players.values()].every(other => other.pos.distanceTo(new THREE.Vector3().copy(pos)) > 0.8)) player.pos.copy(pos);
      player.yaw = finite(profile.yaw, Math.PI, -1e6, 1e6);
      player.pitch = finite(profile.pitch, 0, -Math.PI / 2, Math.PI / 2);
      player.health = finite(profile.health, 100, 0, 100);
      player.regenDelay = finite(profile.regenDelay, 0, 0, 5);
      player.tomatoes = finite(profile.tomatoes, player.tomatoes, 0, TOMATO_MAX);
    }
    this.players.set(player.id, player);
    this.profiles.set(clientId, this.playerProfile(player));
    this.hostId ||= player.id;
    this.emptySince = null;
    this.dirty();
    return player;
  }

  spawnPlayer(p) {
    this.drop(p);
    const world = this.world;
    const occupied = [...this.players.values()].filter(other => other !== p && other.health > 0);
    const safe = ground => ground && !boxCollides(world, ground.x + 0.5, ground.y + 1.01, ground.z + 0.5, p.halfW, p.height) &&
      occupied.every(other => Math.hypot(other.pos.x - ground.x - 0.5, other.pos.z - ground.z - 0.5) >= 1.25);
    let spot = null;
    // Give each arriving/respawning player a separate clear column near the
    // centre, rather than placing their cameras inside each other's avatars.
    for (let radius = 0; radius <= 24 && !spot; radius += 2) {
      for (let dz = -radius; dz <= radius && !spot; dz += 2) for (let dx = -radius; dx <= radius && !spot; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const ground = world.findGround(world.sx / 2 + dx, world.sz / 2 + dz, 2);
        if (safe(ground)) spot = ground;
      }
    }
    if (!spot) {
      // Extensive building may cover all natural ground near spawn. Search for any
      // column with enough headroom before falling back to the top of the centre.
      for (let z = 2; z < world.sz - 2 && !spot; z += 2) for (let x = 2; x < world.sx - 2 && !spot; x += 2) {
        const y = world.heightAt(x, z);
        const ground = { x, y, z };
        if (y < world.sy - 3 && safe(ground)) spot = ground;
      }
    }
    spot ||= { x: 72, z: 72, y: world.heightAt(72, 72) };
    p.pos.set(spot.x + 0.5, spot.y + 1.01, spot.z + 0.5);
    p.vel.set(0, 0, 0);
    p.yaw = Math.PI;
    p.pitch = 0;
    p.health = 100;
    p.regenDelay = 0;
    p.lastPose = Date.now();
    p.budgetTime = p.lastPose;
    p.moveBudget = 0.65;
    p.verticalBudget = 0.65;
  }

  removePlayer(p) {
    this.drop(p);
    this.profiles.set(p.clientId, this.playerProfile(p));
    this.players.delete(p.id);
    if (this.hostId === p.id) this.hostId = this.players.keys().next().value ?? null;
    if (!this.players.size) this.emptySince = Date.now();
    this.dirty();
    this.broadcast(this.snapshot());
  }

  correction(p) { this.send(p.socket, { type: 'correction', ...pose(p) }); }
  acceptPose(p, msg) {
    if (p.health <= 0) return;
    const { x, y, z, yaw, pitch } = msg;
    const world = this.world;
    const now = Date.now();
    const dt = Math.max(0.02, Math.min(0.6, (now - p.lastPose) / 1000));
    const budgetElapsed = Math.max(0, (now - p.budgetTime) / 1000);
    p.moveBudget = Math.min(8, p.moveBudget + budgetElapsed * 13);
    p.verticalBudget = Math.min(28, p.verticalBudget + budgetElapsed * 45);
    p.budgetTime = now;
    const horizontal = Math.hypot(x - p.pos.x, z - p.pos.z);
    const vertical = Math.abs(y - p.pos.y);
    if (![x, y, z, yaw, pitch].every(Number.isFinite) || x < p.halfW || x > world.sx - p.halfW || z < p.halfW || z > world.sz - p.halfW || y < 0 || y > world.sy + 8 || Math.abs(pitch) > Math.PI / 2 + 0.01 || Math.abs(yaw) > 1e6 ||
        horizontal > p.moveBudget || vertical > p.verticalBudget || boxCollides(world, x, y + 0.01, z, p.halfW * 0.98, p.height - 0.02)) {
      this.correction(p);
      return;
    }
    // Reject crossing solid walls even if the final client position is clear.
    const distance = p.pos.distanceTo(new THREE.Vector3(x, y, z));
    const steps = Math.max(1, Math.ceil(distance / 0.2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (boxCollides(world, p.pos.x + (x - p.pos.x) * t, p.pos.y + (y - p.pos.y) * t + 0.01, p.pos.z + (z - p.pos.z) * t, p.halfW * 0.9, p.height - 0.04)) { this.correction(p); return; }
    }
    p.vel.set((x - p.pos.x) / dt, (y - p.pos.y) / dt, (z - p.pos.z) / dt).clampLength(0, 45);
    p.pos.set(x, y, z);
    p.moveBudget -= horizontal;
    p.verticalBudget -= vertical;
    p.yaw = yaw;
    p.pitch = pitch;
    p.active = msg.active !== false;
    if (msg.hotbar !== undefined) p.hotbar = cleanHotbar(msg.hotbar);
    if (msg.slot !== undefined) p.slot = cleanSlot(msg.slot);
    p.lastPose = now;
  }

  eye(p) { return p.pos.clone().add(new THREE.Vector3(0, 1.62, 0)); }
  dir(p) { const cp = Math.cos(p.pitch); return new THREE.Vector3(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp); }
  rayEntity(origin, dir, entities, maxDistance) {
    let best = null;
    for (const e of entities) {
      const distance = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, e.pos.x - e.halfW, e.pos.y, e.pos.z - e.halfW, e.pos.x + e.halfW, e.pos.y + e.height, e.pos.z + e.halfW);
      if (distance < (best?.distance ?? maxDistance)) best = { entity: e, distance };
    }
    return best;
  }

  edit(x, y, z, type, persist = true) {
    const key = `${x},${y},${z}`;
    if (!this.blocks.has(key) && this.blocks.size >= 100_000) return false;
    if (!this.world.set(x, y, z, type)) return false;
    const block = [x, y, z, type];
    this.blocks.set(key, block);
    this.pendingBlocks.set(key, block);
    if (persist) this.dirty();
    return true;
  }

  action(p, msg) {
    const now = Date.now();
    if (msg.action === 'respawn') {
      if (p.health > 0) return;
      if (now < p.nextRespawn) { this.send(p.socket, { type: 'error', code: 'RESPAWN_COOLDOWN', message: 'Please wait a moment before respawning again.' }); return; }
      p.nextRespawn = now + 1000;
      this.spawnPlayer(p);
      p.tomatoes = this.gameMode === 'build' ? TOMATO_MAX : TOMATOES_PER_WAVE;
      this.correction(p);
      this.dirty();
      return;
    }
    if (p.health <= 0) return;
    if (msg.action === 'drop') { this.drop(p); return; }
    if (msg.action === 'reset') {
      if (p.id !== this.hostId) return;
      this.reset();
      return;
    }
    if (msg.action === 'name') { this.nameBody(p, msg); return; }
    const origin = this.eye(p), direction = this.dir(p);
    const hit = this.world.raycast(origin, direction, 6);
    if (msg.action === 'attack' || msg.action === 'grab') {
      if (now < p.nextAttack || p.carryId) return;
      p.nextAttack = now + 280;
      const enemy = this.rayEntity(origin, direction, this.enemies, 4.5);
      const pet = this.rayEntity(origin, direction, this.animals, 4.5);
      const bodyHit = this.ragdolls.hitTest(origin, direction, 4);
      if (bodyHit && !bodyHit.body.carried && bodyHit.dist < (hit?.dist ?? Infinity) && bodyHit.dist < (enemy?.distance ?? Infinity) && bodyHit.dist < (pet?.distance ?? Infinity)) {
        this.ragdolls.carrying = null;
        this.ragdolls.grab(bodyHit.body, bodyHit.point);
        bodyHit.body.carrying = p.id;
        p.carryId = bodyHit.body.id;
        this.ragdolls.carrying = null;
        return;
      }
      if (msg.action === 'grab') return;
      this.broadcast({ type: 'event', event: 'swing', playerId: p.id });
      if (pet && pet.distance < (hit?.dist ?? Infinity) && pet.distance < (enemy?.distance ?? Infinity)) { pet.entity.startle(p.pos.x, p.pos.z); return; }
      if (enemy && enemy.distance < (hit?.dist ?? Infinity)) {
        if (enemy.entity.hit(12, direction.x, direction.z)) this.killEnemy(enemy.entity);
      } else if (hit && this.world.get(hit.x, hit.y, hit.z) !== BLOCK.BEDROCK) this.edit(hit.x, hit.y, hit.z, BLOCK.AIR);
    } else if (msg.action === 'place') {
      if (!PLACEABLE.includes(msg.block) || now < p.nextPlace || !hit) return;
      p.nextPlace = now + 220;
      const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
      if (!this.world.inBounds(x, y, z) || ![BLOCK.AIR, BLOCK.WATER].includes(this.world.get(x, y, z))) return;
      if ([...this.players.values(), ...this.enemies, ...this.animals].some(e => overlaps(x, y, z, e))) return;
      this.edit(x, y, z, msg.block);
    } else if (msg.action === 'tomato') {
      if (p.tomatoes <= 0 || now < p.nextThrow || p.carryId) return;
      p.tomatoes--;
      p.nextThrow = now + THROW_COOLDOWN * 1000;
      origin.addScaledVector(direction, 0.6).add(new THREE.Vector3(0, -0.15, 0));
      const velocity = direction.multiplyScalar(TOMATO_SPEED).add(p.vel);
      velocity.y += 1.5;
      this.projectiles.push({ id: id(), ownerId: p.id, pos: origin, vel: velocity, life: TOMATO_LIFE });
      this.dirty();
    } else if (msg.action === 'spawn' && now >= p.nextSpawn) {
      p.nextSpawn = now + 700;
      this.spawnAhead(p, msg.kind);
    }
  }

  spawnAhead(p, kind) {
    if (typeof kind !== 'string') return;
    if (!Object.hasOwn(ANIMAL_TYPES, kind ?? '') && !Object.hasOwn(ENEMY_TYPES, kind ?? '')) return;
    // The existing Stalker spawn button creates a harmless fallen body in either mode.
    if (Object.hasOwn(ENEMY_TYPES, kind) && kind !== 'stalker' && this.gameMode !== 'build') return;
    if (Object.hasOwn(ENEMY_TYPES, kind) && kind !== 'stalker' && this.enemies.length >= 16) return;
    const animal = ANIMAL_TYPES[kind];
    const halfW = animal ? animal.scale * 0.3 : ENEMY_TYPES[kind].scale * 0.32;
    const height = animal ? animal.scale * 0.85 : typeHeight(ENEMY_TYPES[kind]);
    const direction = this.dir(p);
    for (const d of [3, 4.5, 2, 6]) {
      const g = this.world.findGround(p.pos.x + direction.x * d, p.pos.z + direction.z * d, 3);
      if (!g || Math.abs(g.y + 1 - p.pos.y) > 4 || boxCollides(this.world, g.x + 0.5, g.y + 1.01, g.z + 0.5, halfW, height)) continue;
      const e = (animal ? createAnimal : createEnemy)(kind, g.x + 0.5, g.y + 1.01, g.z + 0.5);
      e.id = id();
      e.facing = Math.atan2(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
      e.group.rotation.y = e.facing;
      if (animal) {
        this.animals.push(e);
        if (this.animals.length > 12) this.animals.shift();
      } else if (kind === 'stalker') {
        e.vel.copy(e.pos).sub(p.pos).setY(0).normalize().multiplyScalar(2);
        this.addBody(e);
      } else this.enemies.push(e);
      this.dirty();
      return;
    }
  }

  addBody(enemy) {
    const body = this.ragdolls.add(enemy);
    body.id = enemy.id;
    body.kind = enemy.typeKey;
    body.carrying = null;
    return body;
  }
  drop(p) {
    const body = this.ragdolls.bodies.find(b => b.id === p.carryId);
    if (body) {
      this.ragdolls.carrying = body;
      this.ragdolls.drop();
      body.carrying = null;
      this.ragdolls.carrying = null;
    }
    p.carryId = null;
  }
  nameBody(p, msg) {
    if (typeof msg.name !== 'string') return;
    const origin = this.eye(p), direction = this.dir(p);
    const hit = this.ragdolls.hitTest(origin, direction, 5);
    const body = typeof msg.bodyId === 'string' ? this.ragdolls.bodies.find(b => b.id === msg.bodyId) : this.ragdolls.bodies.find(b => b.id === p.carryId) ?? hit?.body;
    if (!body || (body.carrying && body.carrying !== p.id)) return;
    if (body.carrying !== p.id) {
      // A name dialog releases the mouse and drops the body. It may move while
      // the user types, so validate the selected body's proximity and visibility
      // rather than requiring the crosshair to remain exactly on that body.
      let visible = false;
      for (let k = -0.85; k <= 0.86; k += 0.425) {
        const point = body.axisPoint(k, new THREE.Vector3());
        const toPoint = point.sub(origin), distance = toPoint.length();
        if (distance > 5 || distance < 0.001) continue;
        const wall = this.world.raycast(origin, toPoint.multiplyScalar(1 / distance), distance);
        if (!wall || wall.dist >= distance - 0.3 * body.scale) { visible = true; break; }
      }
      if (!visible) return;
    }
    this.ragdolls.setName(body, cleanName(msg.name, '').slice(0, 16));
    this.dirty();
  }

  killEnemy(enemy, score = true) {
    if (enemy.dead || !this.enemies.includes(enemy)) return;
    this.enemies.splice(this.enemies.indexOf(enemy), 1);
    if (enemy.type.ragdoll) this.addBody(enemy);
    enemy.dead = true;
    this.kills++;
    if (score) this.score += enemy.type.score * this.wave;
    this.dirty();
    this.broadcast({ type: 'event', event: 'kill', id: enemy.id, kind: enemy.typeKey, ...xyz(enemy.pos) });
  }
  hurt(p, damage) {
    p.health = Math.max(0, p.health - damage);
    p.regenDelay = 5;
    if (p.health <= 0) this.drop(p);
  }
  crater(center, radius) {
    const r = Math.ceil(radius);
    for (let x = Math.floor(center.x) - r; x <= Math.floor(center.x) + r; x++) for (let y = Math.floor(center.y) - r; y <= Math.floor(center.y) + r; y++) for (let z = Math.floor(center.z) - r; z <= Math.floor(center.z) + r; z++) {
      if (Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y, z + 0.5 - center.z) > radius) continue;
      const block = this.world.get(x, y, z);
      if (![BLOCK.AIR, BLOCK.WATER, BLOCK.BEDROCK].includes(block)) this.edit(x, y, z, BLOCK.AIR);
    }
  }
  explode(center, { tomato = false, direct = null, bomber = null } = {}) {
    const radius = tomato ? TOMATO_BLAST_RADIUS : BLAST_RADIUS;
    const damage = tomato ? TOMATO_DAMAGE : bomber.dmg;
    this.crater(center, tomato ? TOMATO_CRATER_RADIUS : BLAST_BLOCK_RADIUS);
    if (bomber) {
      this.killEnemy(bomber, false);
      for (const p of this.players.values()) if (p.health > 0) this.hurt(p, Math.round(damage * falloff(center.distanceTo(p.pos.clone().add(new THREE.Vector3(0, 0.9, 0))), radius)));
    }
    for (const e of [...this.enemies]) {
      const factor = e === direct ? 1 : falloff(center.distanceTo(e.center), radius);
      if (factor > 0 && e.hit(Math.round(damage * (tomato ? 1 : 1.5) * factor), e.pos.x - center.x, e.pos.z - center.z)) this.killEnemy(e);
    }
    this.ragdolls.impulseAt(center.x, center.y, center.z, radius + 0.5, tomato ? 9 : 12);
    for (const a of this.animals) if (Math.hypot(a.pos.x - center.x, a.pos.z - center.z) < radius + 3) a.startle(center.x, center.z);
    this.broadcast({ type: 'event', event: 'explosion', tomato, ...xyz(center) });
  }

  updateProjectiles(dt) {
    for (const t of [...this.projectiles]) {
      t.life -= dt;
      let burst = t.life <= 0, direct = null;
      const steps = Math.max(1, Math.ceil(t.vel.length() * dt / 0.2));
      const h = dt / steps;
      for (let i = 0; i < steps && !burst; i++) {
        t.vel.y -= GRAVITY * h;
        const next = t.pos.clone().addScaledVector(t.vel, h);
        if (this.world.isSolid(Math.floor(next.x), Math.floor(next.y), Math.floor(next.z))) { burst = true; break; }
        t.pos.copy(next);
        direct = this.enemies.find(e => Math.abs(next.x - e.pos.x) < e.halfW + 0.22 && Math.abs(next.z - e.pos.z) < e.halfW + 0.22 && next.y > e.pos.y - 0.22 && next.y < e.pos.y + e.height + 0.22);
        burst = !!direct || next.y < -5;
        if (!burst) for (const b of this.ragdolls.bodies) {
          const point = new THREE.Vector3();
          for (let k = -0.85; k <= 0.86; k += 0.425) if (b.axisPoint(k, point).distanceTo(next) < 0.3 * b.scale + 0.22) { burst = true; break; }
          if (burst) break;
        }
      }
      if (burst) { this.projectiles.splice(this.projectiles.indexOf(t), 1); this.explode(t.pos.clone(), { tomato: true, direct }); }
    }
  }

  tick(dt) {
    if (!this.players.size) return;
    // This also captures movement, health regeneration and running simulations;
    // the store batches these notifications into its periodic disk checkpoint.
    this.saveElapsed += dt;
    if (this.saveElapsed >= 1) { this.saveElapsed = 0; this.dirty(); }
    const living = [...this.players.values()].filter(p => p.health > 0);
    for (const p of living) {
      p.regenDelay -= dt;
      if (p.regenDelay <= 0) p.health = Math.min(100, p.health + 4 * dt);
      // A stationary client must not keep its last running velocity indefinitely.
      if (Date.now() - p.lastPose > 200) p.vel.set(0, 0, 0);
    }
    const closest = pos => living.reduce((best, p) => !best || p.pos.distanceToSquared(pos) < best.pos.distanceToSquared(pos) ? p : best, null);
    if (living.length) {
      const detonations = [];
      for (const e of [...this.enemies]) {
        const target = closest(e.pos);
        e.update(dt, target, { world: this.world, enemies: this.enemies, onAttack: () => this.hurt(target, e.dmg), onDetonate: () => detonations.push(e) });
        if (e.pos.y < -5) this.killEnemy(e, false);
      }
      for (const e of detonations) if (!e.dead) this.explode(e.center, { bomber: e });
      for (const a of this.animals) a.update(dt, this.world, closest(a.pos));
      if (this.gameMode === 'wave') {
        if (this.remaining === 0 && this.enemies.length === 0) {
          if (this.intermission <= 0) this.intermission = 5;
          else if ((this.intermission -= dt) <= 0) {
            this.wave++;
            this.remaining = 3 + Math.floor(this.wave * 1.5);
            this.spawnTimer = 1.5;
            for (const p of this.players.values()) p.tomatoes = Math.min(TOMATO_MAX, p.tomatoes + TOMATOES_PER_WAVE);
            this.dirty();
          }
        }
        this.spawnTimer -= dt;
        const maxAlive = Math.max(3, Math.min(11, Math.round((2 + this.wave * 2) * 0.7)));
        if (this.remaining > 0 && this.spawnTimer <= 0 && this.enemies.length < maxAlive) {
          const origin = living[Math.floor(Math.random() * living.length)].pos;
          const spot = findSpawnSpot(this.world, origin, this.enemies, this.wave, this.spawnCursor);
          if (spot) { const e = createEnemy(spot.typeKey, spot.x, spot.y + 1.01, spot.z, this.wave); e.id = id(); this.enemies.push(e); this.remaining--; }
          this.spawnTimer = Math.max(0.6, 2.5 - this.wave * 0.15);
        }
      }
    }
    this.updateProjectiles(dt);
    for (const b of [...this.ragdolls.bodies]) {
      b.age += dt;
      if (b.carried) {
        const p = this.players.get(b.carrying);
        if (!p || p.health <= 0) { if (p) this.drop(p); else { b.carried = false; b.carrying = null; } }
        else {
          this.ragdolls.carrying = b;
          this.ragdolls.updateCarried(b, dt, this.eye(p).addScaledVector(this.dir(p), CARRY_DISTANCE));
          if (!b.carried) { b.carrying = null; p.carryId = null; }
          this.ragdolls.carrying = null;
        }
      } else if (b.pinned) this.ragdolls.updatePinned(b, dt);
      else this.ragdolls.updateFree(b, dt);
      for (const p of living) this.ragdolls.pushByPlayer(b, p);
      b.updateLimbs(dt);
      b.sync();
    }
    for (const p of this.players.values()) if (p.carryId && !this.ragdolls.bodies.some(b => b.id === p.carryId)) p.carryId = null;
  }

  flushBlocks() {
    if (this.pendingBlocks.size) { this.broadcast({ type: 'blocks', blocks: [...this.pendingBlocks.values()] }); this.pendingBlocks.clear(); }
  }
  snapshot() {
    return { type: 'state', roomCode: this.code, worldName: this.name, hostId: this.hostId, gameMode: this.gameMode,
      wave: this.wave, score: this.score, kills: this.kills, remaining: this.remaining, intermission: Math.max(0, this.intermission),
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, ...pose(p), health: p.health, maxHealth: 100, tomatoes: p.tomatoes, hotbar: [...p.hotbar], slot: p.slot, carryId: p.carryId, active: p.active })),
      enemies: this.enemies.map(e => ({ id: e.id, kind: e.typeKey, ...xyz(e.pos), facing: e.facing, hp: e.hp, maxHp: e.maxHp, state: e.state, windup: e.windup, fuse: e.fuse, flash: e.flash })),
      animals: this.animals.map(a => ({ id: a.id, kind: a.kind, ...xyz(a.pos), facing: a.facing, state: a.state, walkPhase: a.walkPhase })),
      projectiles: this.projectiles.map(t => ({ id: t.id, ...xyz(t.pos) })),
      bodies: this.ragdolls.bodies.map(b => ({ id: b.id, kind: 'stalker', name: b.name, ...xyz(b.group.position), qx: b.q.x, qy: b.q.y, qz: b.q.z, qw: b.q.w, carrying: b.carrying,
        limbs: b.limbs.map(l => [l.node.rotation.x, l.node.rotation.z]) })),
    };
  }
  reset() {
    for (const p of this.players.values()) this.drop(p);
    this.ragdolls.clear();
    this.world.regenerate(randomInt(1, 1_000_000));
    this.blocks.clear(); this.pendingBlocks.clear();
    this.enemies.length = 0; this.animals.length = 0; this.projectiles.length = 0;
    this.score = 0; this.kills = 0; this.wave = 1; this.intermission = 0; this.spawnTimer = 1.5;
    this.remaining = this.gameMode === 'wave' ? 4 : 0;
    this.profiles.clear();
    for (const p of this.players.values()) { this.spawnPlayer(p); p.tomatoes = this.gameMode === 'wave' ? TOMATOES_PER_WAVE : TOMATO_MAX; }
    this.broadcast({ type: 'world', world: this.worldInfo(), blocks: [], state: this.snapshot() });
    this.dirty();
  }
}
