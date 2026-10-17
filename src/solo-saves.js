// Solo saves belong to this browser and origin. Shared worlds use the server's
// filesystem instead. Keep this format explicit so future upgrades can migrate
// old data rather than guessing at it or overwriting a newer game version.
import { encodeTerrain, decodeTerrain } from './save-format.js';
import { Enemy, ENEMY_TYPES, makeNameTag, NAME_TAG_SIZE } from './enemies.js';
import { Animal, ANIMAL_TYPES } from './animals.js';
import { PLACEABLE } from './world.js';

export const SOLO_SAVE_VERSION = 2;
export const MAX_SOLO_SAVES = 20;
const KIND = 'legocraft-solo';
const stateNumbers = ['score', 'kills', 'wave', 'elapsed', 'waveRemaining', 'intermission', 'spawnTimer', 'slot', 'tomatoes', 'throwCooldown', 'swingCooldown', 'placeCooldown'];
const enemyNumbers = ['hp', 'maxHp', 'dmg', 'speed', 'wanderTimer', 'stuckTimer', 'jumpCooldown', 'detourTimer', 'detourSide', 'detourStreak', 'freeTimer', 'attackCooldown', 'windup', 'flash', 'walkPhase', 'facing', 'fuse'];
const enemyBooleans = ['onGround', 'blinkOn', 'blinkPending'];
const bodyNumbers = ['pinTime', 'airTime', 'age', 'restTime'];
const bodyBooleans = ['pinned', 'onGround', 'swimming'];
const bodyVectors = ['feet', 'com', 'vel', 'prevVel', 'tipAxis', 'angVel', 'grabLocal'];
const vector = (value) => [value.x, value.y, value.z];
const values = (source, keys) => Object.fromEntries(keys.map((key) => [key, source[key]]));
const copyNumbers = (target, source, keys) => { for (const key of keys) if (source[key] !== undefined) target[key] = source[key]; };

/** A complete, JSON-safe snapshot. Transient input, meshes and sound are rebuilt. */
export function captureSolo({ world, player, state, hotbar, enemies, animals, ragdolls, tomatoes }) {
  if (state.gameMode !== 'wave' && state.gameMode !== 'build') throw new Error('Choose a game mode before saving a Solo world.');
  return {
    kind: KIND, version: SOLO_SAVE_VERSION, seed: world.seed,
    dimensions: [world.sx, world.sy, world.sz], terrain: encodeTerrain(world.data),
    gameMode: state.gameMode, state: values(state, stateNumbers), hotbar: [...hotbar],
    player: {
      pos: vector(player.pos), vel: vector(player.vel), knock: vector(player.knock),
      yaw: player.yaw, pitch: player.pitch, health: player.health, maxHealth: player.maxHealth,
      regenDelay: player.regenDelay, bob: player.bob, onGround: player.onGround,
    },
    enemies: enemies.filter((enemy) => !enemy.dead).map((enemy) => ({
      kind: enemy.typeKey, pos: vector(enemy.pos), vel: vector(enemy.vel),
      wanderDir: vector(enemy.wanderDir), detourDir: vector(enemy.detourDir),
      state: enemy.state, ...values(enemy, enemyNumbers), ...values(enemy, enemyBooleans),
    })),
    animals: animals.map((animal) => ({
      kind: animal.kind, pos: vector(animal.pos), vel: vector(animal.vel), dir: vector(animal.dir),
      state: animal.state, ...values(animal, ['timer', 'walkPhase', 'jumpCooldown', 'facing', 'onGround']),
    })),
    bodies: ragdolls.bodies.map((body) => ({
      kind: 'stalker', name: body.name, q: body.q.toArray(),
      ...values(body, bodyNumbers), ...values(body, bodyBooleans),
      ...Object.fromEntries(bodyVectors.map((key) => [key, vector(body[key])])),
      limbs: body.limbs.map((limb) => ({
        rotation: [limb.node.rotation.x, limb.node.rotation.z], vx: limb.vx, vz: limb.vz,
        rest: [limb.rest.x, limb.rest.z],
      })),
    })),
    projectiles: tomatoes.items.map((tomato) => ({
      pos: vector(tomato.mesh.position), vel: vector(tomato.vel), spin: vector(tomato.spin),
      rotation: [tomato.mesh.rotation.x, tomato.mesh.rotation.y, tomato.mesh.rotation.z], life: tomato.life,
    })),
  };
}

const invalid = (field) => { throw new Error(`This Solo save has invalid ${field}. Its saved copy has been kept.`); };
function number(value, field, min = -1e9, max = 1e9) {
  if (!Number.isFinite(value) || value < min || value > max) invalid(field);
}
function numbers(object, keys, field, optional = true) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) invalid(field);
  for (const key of keys) if (!optional || object[key] !== undefined) number(object[key], `${field}.${key}`);
}
function tuple(value, length, field) {
  if (!Array.isArray(value) || value.length !== length) invalid(field);
  for (const item of value) number(item, field, -1e6, 1e6);
}
function booleanFields(object, fields, field) {
  for (const key of fields) if (object[key] !== undefined && typeof object[key] !== 'boolean') invalid(`${field}.${key}`);
}
function collection(value, max, field) {
  if (!Array.isArray(value) || value.length > max) invalid(field);
}

/** Validate everything before restore changes any live objects. Returns decoded terrain. */
export function validateSolo(saved, world) {
  if (!saved || typeof saved !== 'object') invalid('data');
  if (saved.version > SOLO_SAVE_VERSION) throw new Error('This Solo world was saved by a newer game version. Update the game to open it; its saved copy has been kept.');
  if (saved.version !== SOLO_SAVE_VERSION || saved.kind !== KIND) throw new Error('This Solo save format is not supported. Its saved copy has been kept.');
  if (saved.gameMode !== 'wave' && saved.gameMode !== 'build') invalid('game mode');
  number(saved.seed, 'seed');
  if (!Array.isArray(saved.dimensions) || saved.dimensions.join(',') !== '144,48,144') invalid('world dimensions');
  if (world && (world.sx !== 144 || world.sy !== 48 || world.sz !== 144)) invalid('world dimensions');
  const terrain = decodeTerrain(saved.terrain);
  if (terrain.length !== 144 * 48 * 144) invalid('terrain size');
  numbers(saved.state, stateNumbers, 'progress');
  for (const key of ['score', 'kills', 'wave', 'waveRemaining', 'slot', 'tomatoes']) {
    number(saved.state[key], `progress.${key}`, 0);
    if (!Number.isInteger(saved.state[key])) invalid(`progress.${key}`);
  }
  if (saved.state.slot > 8 || saved.state.tomatoes > 9 || saved.state.wave < 1) invalid('progress');
  if (!Array.isArray(saved.hotbar) || saved.hotbar.length !== 9 || saved.hotbar.some((item) => item !== 'sword' && !PLACEABLE.includes(item))) invalid('hotbar');
  numbers(saved.player, ['yaw', 'pitch', 'health', 'maxHealth', 'regenDelay', 'bob'], 'player', false);
  if (saved.player.health < 0 || saved.player.maxHealth !== 100 || saved.player.health > 100 || Math.abs(saved.player.pitch) > Math.PI / 2) invalid('player');
  tuple(saved.player.pos, 3, 'player position');
  tuple(saved.player.vel, 3, 'player velocity');
  tuple(saved.player.knock, 3, 'player knockback');
  booleanFields(saved.player, ['onGround'], 'player');
  collection(saved.enemies, 512, 'enemies');
  for (const enemy of saved.enemies) {
    if (!enemy || !Object.hasOwn(ENEMY_TYPES, enemy.kind) || !['wander', 'chase', 'attack'].includes(enemy.state)) invalid('enemy type or state');
    numbers(enemy, enemyNumbers, 'enemy');
    numbers(enemy, ['hp', 'maxHp', 'dmg', 'speed', 'facing'], 'enemy', false);
    if (enemy.hp <= 0 || enemy.hp > enemy.maxHp || enemy.maxHp <= 0 || enemy.speed <= 0) invalid('enemy health or speed');
    for (const key of ['pos', 'vel', 'wanderDir', 'detourDir']) tuple(enemy[key], 3, `enemy ${key}`);
    booleanFields(enemy, enemyBooleans, 'enemy');
  }
  collection(saved.animals, 12, 'animals');
  for (const animal of saved.animals) {
    if (!animal || !Object.hasOwn(ANIMAL_TYPES, animal.kind) || !['idle', 'walk', 'flee', 'sit'].includes(animal.state)) invalid('animal type or state');
    numbers(animal, ['timer', 'walkPhase', 'jumpCooldown', 'facing'], 'animal', false);
    for (const key of ['pos', 'vel', 'dir']) tuple(animal[key], 3, `animal ${key}`);
    booleanFields(animal, ['onGround'], 'animal');
  }
  collection(saved.bodies, 16, 'bodies');
  for (const body of saved.bodies) {
    if (!body || body.kind !== 'stalker' || typeof body.name !== 'string' || body.name.length > 64) invalid('body name or type');
    numbers(body, bodyNumbers, 'body', false);
    booleanFields(body, bodyBooleans, 'body');
    tuple(body.q, 4, 'body orientation');
    const length = Math.hypot(...body.q);
    if (length < 0.99 || length > 1.01) invalid('body orientation');
    for (const key of bodyVectors) tuple(body[key], 3, `body ${key}`);
    collection(body.limbs, 6, 'body limbs');
    if (body.limbs.length !== 6) invalid('body limbs');
    for (const limb of body.limbs) {
      if (!limb) invalid('body limb');
      tuple(limb.rotation, 2, 'limb rotation'); tuple(limb.rest, 2, 'limb rest');
      numbers(limb, ['vx', 'vz'], 'limb velocity', false);
    }
  }
  collection(saved.projectiles, 32, 'tomatoes');
  for (const tomato of saved.projectiles) {
    if (!tomato) invalid('tomato');
    for (const key of ['pos', 'vel', 'spin', 'rotation']) tuple(tomato[key], 3, `tomato ${key}`);
    number(tomato.life, 'tomato lifetime', 0, 5);
  }
  return terrain;
}

/** Restore simulation data; caller rebuilds chunks and refreshes the HUD afterwards. */
export function restoreSolo(saved, env) {
  const { world, player, state, hotbar, enemies, animals, ragdolls, tomatoes, scene } = env;
  const terrain = validateSolo(saved, world);
  const EnemyClass = env.EnemyClass ?? Enemy;
  const AnimalClass = env.AnimalClass ?? Animal;
  for (const enemy of enemies) { scene.remove(enemy.group); enemy.dispose?.(); }
  for (const animal of animals) { scene.remove(animal.group); animal.dispose?.(); }
  enemies.length = 0; animals.length = 0; ragdolls.clear(); tomatoes.clear();
  world.seed = saved.seed;
  world.data.set(terrain);
  for (let i = 0; i < world.meshes.length; i++) world.dirty.add(i);
  player.pos.fromArray(saved.player.pos); player.vel.fromArray(saved.player.vel); player.knock.fromArray(saved.player.knock);
  copyNumbers(player, saved.player, ['yaw', 'pitch', 'health', 'maxHealth', 'regenDelay', 'bob', 'onGround']);
  player.syncCamera();
  copyNumbers(state, saved.state, stateNumbers);
  state.gameMode = saved.gameMode;
  hotbar.splice(0, hotbar.length, ...saved.hotbar);
  for (const data of saved.enemies) {
    const enemy = new EnemyClass(data.kind, ...data.pos, saved.state.wave);
    copyNumbers(enemy, data, [...enemyNumbers, ...enemyBooleans, 'state']);
    for (const key of ['pos', 'vel', 'wanderDir', 'detourDir']) enemy[key].fromArray(data[key]);
    // Paths are disposable caches; recalculate against the saved terrain.
    enemy.path = null; enemy.pathIdx = 0; enemy.repathTimer = 0;
    enemy.group.position.copy(enemy.pos); enemy.group.rotation.y = enemy.facing;
    enemies.push(enemy); scene.add(enemy.group);
  }
  for (const data of saved.animals) {
    const animal = new AnimalClass(data.kind, ...data.pos);
    copyNumbers(animal, data, ['state', 'timer', 'walkPhase', 'jumpCooldown', 'facing', 'onGround']);
    for (const key of ['pos', 'vel', 'dir']) animal[key].fromArray(data[key]);
    animal.group.position.copy(animal.pos); animal.group.rotation.y = animal.facing;
    animals.push(animal); scene.add(animal.group);
  }
  for (const data of saved.bodies) {
    const enemy = new EnemyClass('stalker', ...data.feet);
    scene.add(enemy.group);
    const body = ragdolls.add(enemy);
    copyNumbers(body, data, [...bodyNumbers, ...bodyBooleans]);
    for (const key of bodyVectors) body[key].fromArray(data[key]);
    body.q.fromArray(data.q); body.up.set(0, 1, 0).applyQuaternion(body.q);
    body.carried = false; // A saved grip must not remain attached to old input.
    for (let i = 0; i < body.limbs.length; i++) {
      const limb = body.limbs[i], savedLimb = data.limbs[i];
      limb.node.rotation.x = savedLimb.rotation[0]; limb.node.rotation.z = savedLimb.rotation[1];
      limb.rest = { x: savedLimb.rest[0], z: savedLimb.rest[1] };
      limb.vx = savedLimb.vx; limb.vz = savedLimb.vz;
    }
    body.sync();
    ragdolls.setName(body, data.name, (name) => {
      const tag = makeNameTag(name, { color: '#ffffff', pill: 'rgba(60, 20, 80, 0.8)', cache: false });
      tag?.scale.set(NAME_TAG_SIZE.w, NAME_TAG_SIZE.h, 1);
      return tag;
    });
  }
  for (const data of saved.projectiles) {
    const tomato = tomatoes.throw(player.pos, player.vel.clone().set(0, 0, 0));
    tomato.mesh.position.fromArray(data.pos); tomato.mesh.rotation.set(...data.rotation);
    tomato.vel.fromArray(data.vel); tomato.spin.fromArray(data.spin); tomato.life = data.life;
  }
  return saved;
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('This device is out of save storage. Remove an old Solo save or free some browser storage, then save again.');
  if (error?.name === 'VersionError') return new Error('These Solo saves use a newer storage version. Update the game to open them.');
  return new Error(`Solo saves are unavailable in this browser${error?.message ? `: ${error.message}` : '.'}`);
}
function recordSummary(record) {
  return { id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt,
    version: record.version, gameMode: record.snapshot?.gameMode,
    compatible: record.version === SOLO_SAVE_VERSION && record.snapshot?.version === SOLO_SAVE_VERSION };
}
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id);
const makeId = () => {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error('This browser cannot create a safe Solo save ID.');
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** IndexedDB acknowledges a save only after its read/write transaction completes. */
export class SoloSaveStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = 'legocraft-saves' } = {}) {
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.opening = null;
  }
  async open() {
    if (!this.indexedDB) throw new Error('Solo saves need browser storage. Disable private browsing or allow website storage, then try again.');
    if (!this.opening) {
      this.opening = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore('worlds', { keyPath: 'id' });
        request.onerror = () => reject(storageError(request.error));
        request.onblocked = () => { blocked = true; reject(new Error('Close other LEGOcraft tabs before updating Solo saves.')); };
        request.onsuccess = () => {
          if (blocked) { request.result.close(); return; }
          const db = request.result;
          db.onversionchange = () => { db.close(); this.opening = null; };
          resolve(db);
        };
      }).catch((error) => { this.opening = null; throw error; });
    }
    return this.opening;
  }
  async list() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('worlds', 'readonly');
      const request = tx.objectStore('worlds').getAll();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
      tx.oncomplete = () => resolve(request.result.map(recordSummary).sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }
  async get(id) {
    if (!validId(id)) throw new Error('Invalid Solo save ID.');
    const db = await this.open();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction('worlds', 'readonly');
      const request = tx.objectStore('worlds').get(id);
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
      tx.oncomplete = () => resolve(request.result);
    });
    if (!record) throw new Error('That Solo world is no longer saved on this device.');
    if (record.version > SOLO_SAVE_VERSION) throw new Error('This Solo world was saved by a newer game version. Update the game to open it; its saved copy has been kept.');
    if (record.version !== SOLO_SAVE_VERSION) throw new Error('This Solo save format is not supported. Its saved copy has been kept.');
    validateSolo(record.snapshot);
    return record;
  }
  async put({ id = makeId(), name, snapshot }) {
    if (!validId(id)) throw new Error('Invalid Solo save ID.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give your Solo world a name before saving.');
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (!cleanName) throw new Error('Give your Solo world a name before saving.');
    validateSolo(snapshot);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction('worlds', 'readwrite', { durability: 'strict' }); }
      catch { tx = db.transaction('worlds', 'readwrite'); }
      let failure, record;
      const store = tx.objectStore('worlds');
      const previous = store.get(id), count = store.count();
      let pending = 2;
      const ready = () => {
        if (--pending) return;
        const old = previous.result;
        if (old && (old.version !== SOLO_SAVE_VERSION || old.snapshot?.version !== SOLO_SAVE_VERSION)) {
          failure = new Error('This Solo world uses another save version. Its saved copy has been kept; save this game under a new world name.');
          tx.abort(); return;
        }
        if (!old && count.result >= MAX_SOLO_SAVES) {
          failure = new Error(`This browser already has ${MAX_SOLO_SAVES} Solo worlds. Remove an old save before creating another.`);
          tx.abort(); return;
        }
        const now = Date.now();
        record = { id, name: cleanName, version: SOLO_SAVE_VERSION, createdAt: old?.createdAt ?? now, updatedAt: now, snapshot };
        store.put(record);
      };
      previous.onsuccess = ready; count.onsuccess = ready;
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => {};
      tx.oncomplete = () => resolve(record);
    });
  }
  async delete(id) {
    if (!validId(id)) throw new Error('Invalid Solo save ID.');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('worlds', 'readwrite');
      tx.objectStore('worlds').delete(id);
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
      tx.oncomplete = () => resolve();
    });
  }
  async close() {
    const db = this.opening ? await this.opening : null;
    db?.close(); this.opening = null;
  }
}
