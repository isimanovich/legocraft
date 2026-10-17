import * as THREE from 'three';
import { World, BLOCK, BLOCK_INFO, PLACEABLE, DEFAULT_HOTBAR } from './world.js';
import { Player } from './player.js';
import { Enemy, findSpawnSpot, BLAST_RADIUS, BLAST_BLOCK_RADIUS, makeNameTag, NAME_TAG_SIZE } from './enemies.js';
import { Debris } from './debris.js';
import { Ragdolls, CARRY_DISTANCE } from './ragdoll.js';
import { Sfx } from './sfx.js';
import { rayBox, boxCollides } from './physics.js';
import { Animal } from './animals.js';
import { TouchControls } from './touch-controls.js';
import { MultiplayerSession } from './multiplayer.js';
import { RemotePlayers } from './remote-players.js';
import { NetworkEntities } from './network-entities.js';
import { decodeTerrain } from './save-format.js';
import { SoloSaveStore, captureSolo, restoreSolo } from './solo-saves.js';
import {
  Tomatoes, TOMATOES_PER_WAVE, TOMATO_MAX, TOMATO_BLAST_RADIUS, TOMATO_DAMAGE, TOMATO_CRATER_RADIUS, THROW_COOLDOWN,
} from './tomatoes.js';

// ---- Setup -----------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x6fb7ff);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 70, 150);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xdfefff, 0x6a7a55, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(60, 100, 30);
scene.add(sun);

const world = new World(scene, { sizeX: 144, sizeZ: 144, sizeY: 48, seed: (Math.random() * 1e6) | 0 });
const player = new Player(camera, world);
const debris = new Debris(scene, world);
const sfx = new Sfx();
const ragdolls = new Ragdolls(scene, world);
ragdolls.onImpact = (body, speed) => sfx.thud(Math.min(1, speed / 12));
const tomatoes = new Tomatoes(scene, world);

// Target block outline
const outline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x05131d, transparent: true, opacity: 0.8 }),
);
outline.visible = false;
scene.add(outline);

// Hand-held brick (view model)
const hand = buildHandBrick();
camera.add(hand);
hand.position.set(0.42, -0.38, -0.7);
hand.rotation.set(0.2, -0.5, 0.1);
// Sword view model (purely cosmetic: hits exactly as hard as a brick)
const swordHand = buildHandSword();
camera.add(swordHand);
swordHand.position.set(0.42, -0.42, -0.7);
swordHand.rotation.set(0.2, -0.5, 0.1);
swordHand.visible = false;

function buildHandBrick() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xc91a09 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.19, 0.64), mat);
  g.add(body);
  const studGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 10);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 4; j++) {
      const s = new THREE.Mesh(studGeo, mat);
      s.position.set(-0.08 + i * 0.16, 0.125, -0.24 + j * 0.16);
      g.add(s);
    }
  }
  return g;
}

/** A minifig sword: brown grip, yellow guard, grey blade, pointing forward and a little up. */
function buildHandSword() {
  const g = new THREE.Group();
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.22, 8), new THREE.MeshLambertMaterial({ color: 0x6c4a2e }));
  grip.rotation.x = Math.PI / 2;
  grip.position.z = 0.1;
  g.add(grip);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshLambertMaterial({ color: 0xf2cd37 }));
  pommel.position.z = 0.22;
  g.add(pommel);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.06), new THREE.MeshLambertMaterial({ color: 0xf2cd37 }));
  guard.position.z = -0.02;
  g.add(guard);
  const bladeMat = new THREE.MeshLambertMaterial({ color: 0xc8cdd1 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.025, 0.62), bladeMat);
  blade.position.z = -0.36;
  g.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4), bladeMat);
  tip.rotation.x = -Math.PI / 2;
  tip.rotation.y = Math.PI / 4;
  tip.position.z = -0.73;
  g.add(tip);
  g.rotation.x = -0.35; // blade points up and away
  return g;
}

// ---- Items & hotbar --------------------------------------------------------------
/** Hotbar entries: a block id (number) or the string 'sword'. */
const hotbar = [...DEFAULT_HOTBAR];
const HOTBAR_SLOTS = hotbar.length;
const itemName = (item) => (item === 'sword' ? 'Sword' : BLOCK_INFO[item].name);
const itemColor = (item) => '#' + BLOCK_INFO[item].color.toString(16).padStart(6, '0');

// ---- Game state ------------------------------------------------------------
const state = {
  mode: 'loading', // loading | ready | playing | paused | dead
  gameMode: null, // 'wave' | 'build', chosen on the start screen
  inventoryOpen: false, // the inventory overlay is up (game parked in 'paused')
  score: 0,
  kills: 0,
  wave: 1,
  elapsed: 0,
  waveRemaining: 0, // enemies still to spawn this wave
  intermission: 0, // seconds until the next wave starts (after a clear)
  spawnTimer: 2,
  swing: 0,
  swingCooldown: 0,
  flash: 0,
  slot: 0,
  mouse: [false, false, false],
  placeCooldown: 0,
  tomatoes: 0, // throwables in hand
  throwCooldown: 0,
  naming: null, // ragdoll body whose name is being typed (gameplay frozen meanwhile)
};
const enemies = [];
const INTERMISSION_SECONDS = 5;
let multiplayerChoice = false;
let networkLoading = false;
let networkPackets = [];
let networkCarryId = null;
let networkRespawning = false;
let networkRespawnTimer;
let networkGeneration = 0;
const remotePlayers = new RemotePlayers(scene);
// Initialised after the passive-creature array below.
let networkEntities;
const session = new MultiplayerSession({ onPacket: receiveNetworkPacket, onDisconnect: disconnected });
session.getInventory = () => ({ hotbar, slot: state.slot });
let soloRecord = null;
let saveBusy = false;
let soloSavePending;
let soloSaveProblem = false;
let newGamePending = false;
let sharedSaveTimer;
let savedListGeneration = 0;
const soloSaves = new SoloSaveStore();

/** Minifigs in a wave. Grows every wave; a wave ends only when all of them are destroyed. */
function waveSize(wave) {
  return 3 + Math.floor(wave * 1.5);
}

/** How many may be alive at once (30% below the original 2 + wave*2, capped). */
function maxAlive(wave) {
  return Math.max(3, Math.min(11, Math.round((2 + wave * 2) * 0.7)));
}

function startWave(wave) {
  state.wave = wave;
  state.waveRemaining = waveSize(wave);
  state.spawnTimer = 1.5;
  state.tomatoes = Math.min(TOMATO_MAX, state.tomatoes + TOMATOES_PER_WAVE);
  showWaveBanner(`WAVE ${wave}`);
  sfx.wave();
}

// ---- HUD -------------------------------------------------------------------
/** Fill a slot element with an item's icon (brick swatch or sword). */
function renderSlotIcon(el, item) {
  el.querySelector('.brick, .sword')?.remove();
  const icon = document.createElement('div');
  if (item === 'sword') {
    icon.className = 'sword';
  } else {
    icon.className = 'brick';
    icon.style.background = itemColor(item);
  }
  el.append(icon);
  el.title = itemName(item);
}

function makeSlotEl(i, item) {
  const el = document.createElement('div');
  el.className = 'slot';
  if (i != null) {
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = String(i + 1);
    el.append(num);
  }
  renderSlotIcon(el, item);
  return el;
}

const hotbarEl = $('hotbar');
const slotEls = hotbar.map((item, i) => {
  const el = makeSlotEl(i, item);
  hotbarEl.append(el);
  return el;
});

function setSlot(i) {
  state.slot = (i + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  slotEls.forEach((el, k) => el.classList.toggle('active', k === state.slot));
  const item = hotbar[state.slot];
  $('blockname').textContent = itemName(item);
  const sword = item === 'sword';
  swordHand.visible = sword;
  hand.visible = !sword;
  if (!sword) hand.children[0].material.color.setHex(BLOCK_INFO[item].color);
}

/** Put `item` in hotbar slot `i` and refresh both the HUD and the inventory copy. */
function assignSlot(i, item) {
  hotbar[i] = item;
  renderSlotIcon(slotEls[i], item);
  renderInventoryHotbar();
  setSlot(state.slot);
}

function updateHud() {
  $('score').textContent = state.score;
  $('kills').textContent = state.kills;
  $('wave').textContent = state.wave;
  $('alive').textContent = state.waveRemaining > 0 ? `${enemies.length} (+${state.waveRemaining})` : `${enemies.length}`;
  $('tomatoes').textContent = state.tomatoes;
  updateCompass();
  const hp = Math.max(0, Math.round(player.health));
  $('healthfill').style.width = `${(hp / player.maxHealth) * 100}%`;
  $('healthlabel').textContent = hp;
}

function showWaveBanner(text) {
  const el = $('wave-banner');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(showWaveBanner.t);
  showWaveBanner.t = setTimeout(() => (el.style.opacity = 0), 2200);
}

// ---- Inventory (pauses the game while open) -----------------------------------
const INVENTORY_ITEMS = ['sword', ...PLACEABLE];
const invItemsEl = $('inv-items');
const invHotbarEl = $('inv-hotbar');
const invNameEl = $('inv-name');

for (const item of INVENTORY_ITEMS) {
  const el = makeSlotEl(null, item);
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Put ${itemName(item)} in the selected hotbar slot`);
  const pick = () => {
    assignSlot(state.slot, item);
    invNameEl.textContent = `${itemName(item)} \u2192 slot ${state.slot + 1}`;
    sfx.placeBlock();
  };
  el.addEventListener('click', pick);
  el.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); pick(); }
  });
  el.addEventListener('mouseenter', () => (invNameEl.textContent = itemName(item)));
  invItemsEl.append(el);
}

function renderInventoryHotbar() {
  invHotbarEl.replaceChildren();
  hotbar.forEach((item, i) => {
    const el = makeSlotEl(i, item);
    el.classList.toggle('active', i === state.slot);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Select hotbar slot ${i + 1} (${itemName(item)})`);
    const select = () => {
      setSlot(i);
      renderInventoryHotbar();
      invNameEl.textContent = `Slot ${i + 1}: ${itemName(item)}`;
    };
    el.addEventListener('click', select);
    el.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); select(); }
    });
    invHotbarEl.append(el);
  });
}

function openInventory() {
  if (state.mode !== 'playing' || state.naming || state.inventoryOpen) return;
  state.inventoryOpen = true;
  state.mode = 'paused';
  clearInput();
  syncControls();
  renderInventoryHotbar();
  invNameEl.textContent = itemName(hotbar[state.slot]);
  $('inventory').classList.remove('hidden');
  document.exitPointerLock?.();
}

function closeInventory() {
  if (!state.inventoryOpen) return;
  state.inventoryOpen = false;
  $('inventory').classList.add('hidden');
  // Re-lock to resume. If the browser refuses (it throttles re-locks right after an Esc),
  // pointerlockerror shows the normal pause screen so a click resumes instead.
  lock();
}

// ---- Spawnable passive creatures ----------------------------------------------
const animals = [];
const MAX_ANIMALS = 12;
networkEntities = new NetworkEntities({ scene, world, enemies, animals, ragdolls });

/** Ground spot about 3 blocks ahead of the player (falls back to nearby natural ground). */
function spawnSpotAhead(halfW, height) {
  player.lookDir(_dir);
  for (const d of [3, 4.5, 2, 6]) {
    const gx = player.pos.x + _dir.x * d;
    const gz = player.pos.z + _dir.z * d;
    const g = world.findGround(gx, gz, 3);
    if (!g) continue;
    const x = g.x + 0.5;
    const z = g.z + 0.5;
    if (Math.abs(g.y + 1 - player.pos.y) > 4) continue;
    if (boxCollides(world, x, g.y + 1.01, z, halfW, height)) continue;
    return { x, y: g.y + 1.01, z };
  }
  return null;
}

function spawnAnimal(kind) {
  if (session.connected) return networkAction('spawn', { kind });
  const probe = new Animal(kind, 0, 0, 0); // cheap: just for its size
  const spot = spawnSpotAhead(probe.halfW, probe.height);
  probe.dispose();
  if (!spot) return false;
  const a = new Animal(kind, spot.x, spot.y, spot.z);
  a.facing = Math.atan2(player.pos.x - spot.x, player.pos.z - spot.z); // looks at you
  scene.add(a.group);
  animals.push(a);
  if (animals.length > MAX_ANIMALS) removeAnimal(animals[0]);
  sfx.animal(kind);
  return true;
}

function removeAnimal(a) {
  const i = animals.indexOf(a);
  if (i < 0) return;
  animals.splice(i, 1);
  scene.remove(a.group);
  a.dispose();
}

/** A Stalker that is already dead: appears standing and topples into a ragdoll you can carry and name. */
function spawnFallenStalker() {
  if (session.connected) return networkAction('spawn', { kind: 'stalker' });
  const spot = spawnSpotAhead(0.32 * 1.55, 3.5);
  if (!spot) return false;
  const en = new Enemy('stalker', spot.x, spot.y, spot.z);
  en.facing = Math.atan2(player.pos.x - spot.x, player.pos.z - spot.z);
  en.group.rotation.y = en.facing;
  // Topple away from the player.
  en.vel.set(spot.x - player.pos.x, 0, spot.z - player.pos.z).normalize().multiplyScalar(2);
  en.hp = 0;
  scene.add(en.group);
  ragdolls.add(en);
  sfx.thud(0.6);
  return true;
}

for (const [id, fn, label] of [
  ['spawn-wolf', () => spawnAnimal('wolf'), 'Wolf'],
  ['spawn-cat', () => spawnAnimal('cat'), 'Cat'],
  ['spawn-stalker', spawnFallenStalker, 'Fallen Stalker'],
]) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    const ok = fn();
    invNameEl.textContent = ok ? `${label} spawned in front of you` : `No room for a ${label.toLowerCase()} here`;
  });
}

// ---- Enemy direction bar ---------------------------------------------------
const compassMarksEl = $('compass-marks');
const COMPASS_HALF_ANGLE = Math.PI / 2; // the bar spans this far either side of the view
const COMPASS_FAR = 45; // beyond this many blocks a marker is at its smallest
const markPool = [];

function makeMark() {
  const el = document.createElement('div');
  el.className = 'mark';
  compassMarksEl.append(el);
  markPool.push(el);
  return el;
}

/** Place one marker per enemy on the bar at its bearing; behind-you enemies become edge chevrons. */
function updateCompass() {
  const w = compassMarksEl.clientWidth;
  let n = 0;
  for (const en of enemies) {
    const dist = Math.hypot(en.pos.x - player.pos.x, en.pos.z - player.pos.z);
    const rel = player.bearingTo(en.pos.x, en.pos.z);
    const behind = Math.abs(rel) > COMPASS_HALF_ANGLE;
    const t = Math.max(-1, Math.min(1, rel / COMPASS_HALF_ANGLE));
    const el = markPool[n] ?? makeMark();
    n++;
    const near = Math.max(0, 1 - dist / COMPASS_FAR); // 1 = on top of you
    const color = '#' + en.type.torso.toString(16).padStart(6, '0');
    el.hidden = false;
    el.style.transform = `translateX(${((t + 1) / 2) * w}px) translateX(-50%)`;
    el.style.height = `${6 + near * 10}px`;
    el.style.opacity = `${0.5 + near * 0.5}`;
    el.style.background = color;
    el.style.color = color;
    el.textContent = behind ? (rel < 0 ? '\u2039' : '\u203A') : ''; // chevron pointing the way to turn
    el.classList.toggle('behind', behind);
    el.classList.toggle('hunting', en.state !== 'wander');
    el.title = `${en.type.name} ${Math.round(dist)} blocks`;
  }
  for (let i = n; i < markPool.length; i++) markPool[i].hidden = true;
}

// ---- Multiplayer sessions --------------------------------------------------
function notice(text) {
  $('session-notice').textContent = text;
  clearTimeout(notice.timer);
  if (text) notice.timer = setTimeout(() => { $('session-notice').textContent = ''; }, 6500);
}

// Shared saves live on the server; Solo saves stay in this browser's IndexedDB.
const soloEnvironment = () => ({ world, player, state, hotbar, enemies, animals, ragdolls, tomatoes, scene });
const newSaveId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const worldName = () => $('world-name').value.trim().slice(0, 40) || 'My world';
const saveTime = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function savedStatus(text) { $('save-status').textContent = text; }

function finishSharedSave(packet) {
  clearTimeout(sharedSaveTimer);
  saveBusy = false;
  $('save-world').disabled = false;
  if (packet) {
    session.worldName = packet.name || session.worldName;
    savedStatus(`Saved on the Pi at ${saveTime(packet.savedAt)}.`);
  }
}

async function saveSoloWorld({ quiet = false } = {}) {
  if (session.connected || networkLoading || !soloRecord || !state.gameMode || state.mode === 'loading') return false;
  if (saveBusy) {
    if (!soloSavePending) return false;
    if (quiet) return soloSavePending.then(() => true, () => false);
    // A pending autosave may predate the player's final edits. Save the current
    // paused state again before a manual save or a move to another world.
    await soloSavePending.catch(() => {});
    return saveSoloWorld({ quiet });
  }
  saveBusy = true;
  $('save-world').disabled = true;
  if (!quiet) savedStatus('Saving on this device…');
  try {
    soloSavePending = soloSaves.put({ ...soloRecord, snapshot: captureSolo(soloEnvironment()) });
    const saved = await soloSavePending;
    soloRecord = { id: saved.id, name: saved.name, createdAt: saved.createdAt };
    soloSaveProblem = false;
    savedStatus(`Saved on this device at ${saveTime(saved.updatedAt)}.`);
    return true;
  } catch (error) {
    soloSaveProblem = true;
    savedStatus(`Save failed: ${error.message}`);
    refreshSavedWorlds();
    syncSessionUi();
    if (!quiet) notice('Could not save this world. Keep this tab open and try Save now again.');
    return false;
  } finally {
    saveBusy = false;
    soloSavePending = null;
    $('save-world').disabled = false;
    syncSessionUi();
  }
}

function saveWorld() {
  if (saveBusy) return;
  if (!session.connected) { saveSoloWorld(); return; }
  saveBusy = true;
  $('save-world').disabled = true;
  savedStatus('Saving on the Pi…');
  if (!networkAction('save')) {
    finishSharedSave();
    savedStatus('Save could not be sent. Rejoin the world and try again.');
    return;
  }
  sharedSaveTimer = setTimeout(() => {
    finishSharedSave();
    savedStatus('Save was not confirmed. Try Save now again.');
  }, 10000);
}

function savedWorldRow(record, location) {
  const row = document.createElement('div');
  row.className = 'saved-world-row';
  row.setAttribute('role', 'listitem');
  const info = document.createElement('div');
  info.className = 'saved-world-info';
  const title = document.createElement('strong');
  title.className = 'saved-world-title';
  title.textContent = record.name || 'My world';
  const meta = document.createElement('span');
  meta.className = 'saved-world-meta';
  const details = [record.gameMode === 'wave' ? 'Waves' : 'Free build'];
  if (location === 'server') details.push(`Room ${record.code}`, `${record.players}/${record.maxPlayers} players`);
  if (record.updatedAt) details.push(new Date(record.updatedAt).toLocaleString());
  if (record.compatible === false) details.push('Needs a newer game version');
  meta.textContent = details.join(' · ');
  info.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'saved-world-actions';
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'menu-btn';
  resume.textContent = 'Resume';
  resume.dataset.resumeWorld = record.compatible === false ? 'unsupported' : 'compatible';
  resume.disabled = record.compatible === false || state.mode !== 'ready' || Boolean(state.gameMode);
  resume.addEventListener('click', () => {
    if (location === 'server') {
      multiplayerChoice = true;
      $('room-code').value = record.code;
      syncSessionUi();
      connectRoom('join');
    } else resumeSoloWorld(record.id);
  });
  actions.append(resume);
  if (location === 'server') {
    const backup = document.createElement('a');
    backup.className = 'menu-btn alt';
    backup.textContent = 'Backup';
    backup.href = `/api/worlds/${encodeURIComponent(record.code)}/export`;
    backup.download = `legocraft-${record.code}.json`;
    actions.append(backup);
  } else {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu-btn alt';
    remove.textContent = 'Delete';
    let confirmUntil = 0;
    remove.addEventListener('click', async () => {
      if (Date.now() > confirmUntil) {
        confirmUntil = Date.now() + 5000;
        remove.textContent = 'Confirm delete';
        setTimeout(() => { if (Date.now() >= confirmUntil) remove.textContent = 'Delete'; }, 5100);
        return;
      }
      remove.disabled = true;
      try { await soloSaves.delete(record.id); refreshSavedWorlds(); }
      catch (error) { $('saved-worlds-status').textContent = error.message; remove.disabled = false; }
    });
    actions.append(remove);
  }
  row.append(info, actions);
  return row;
}

async function refreshSavedWorlds() {
  const generation = ++savedListGeneration;
  $('saved-worlds-status').textContent = 'Loading saved worlds…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const results = await Promise.allSettled([
    soloSaves.list(),
    fetch('/api/worlds', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Shared saves need the Pi game server.');
      const data = await response.json();
      if (!Array.isArray(data.worlds)) throw new Error('Shared saves need the Pi game server.');
      return data.worlds;
    }),
  ]);
  clearTimeout(timeout);
  if (generation !== savedListGeneration) return;
  const messages = [];
  for (const [index, location] of ['solo', 'server'].entries()) {
    const list = $(location === 'solo' ? 'solo-world-list' : 'server-world-list');
    list.replaceChildren();
    const result = results[index];
    if (result.status === 'fulfilled') {
      for (const record of result.value) list.append(savedWorldRow(record, location));
      if (!result.value.length) list.textContent = 'No saved worlds yet.';
    } else {
      list.textContent = location === 'solo' ? 'Device saves are unavailable in this browser.' : 'Shared saves need the Pi game server.';
      if (location === 'solo') messages.push(result.reason.message);
    }
  }
  $('saved-worlds-status').textContent = messages.join(' ') || (state.gameMode
    ? 'You can delete an older device save to free space, then try Save world now again.'
    : 'Choose Resume to continue a saved world.');
}

async function resumeSoloWorld(id) {
  if (networkLoading || session.connected || state.mode !== 'ready' || state.gameMode) return;
  networkLoading = true;
  try {
    const record = await soloSaves.get(id);
    if (!record) throw new Error('This saved world could not be found.');
    state.mode = 'loading';
    showStartOverlay('loading');
    resetRun();
    restoreSolo(record.snapshot, soloEnvironment());
    soloRecord = { id: record.id, name: record.name, createdAt: record.createdAt };
    hotbar.forEach((item, i) => renderSlotIcon(slotEls[i], item));
    setSlot(state.slot);
    document.body.classList.toggle('build-mode', state.gameMode === 'build');
    await new Promise(resolve => buildWorld(resolve));
    networkLoading = false;
    state.mode = player.health <= 0 ? 'dead' : 'ready';
    if (state.mode === 'dead') die();
    else showStartOverlay('ready');
    savedStatus(`Resumed ${record.name} from this device.`);
    syncControls();
  } catch (error) {
    networkLoading = false;
    state.mode = 'ready';
    $('saved-worlds-status').textContent = `Could not resume: ${error.message}`;
    syncSessionUi();
  }
}

$('refresh-worlds').addEventListener('click', refreshSavedWorlds);
$('save-world').addEventListener('click', event => { event.stopPropagation(); saveWorld(); });
setInterval(() => saveSoloWorld({ quiet: true }), 15000);
// Mobile browsers may suspend a tab without firing beforeunload.
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSoloWorld({ quiet: true }); });
window.addEventListener('pagehide', () => saveSoloWorld({ quiet: true }));

function syncSessionUi() {
  const connected = session.connected;
  const atPicker = state.mode === 'ready' && !state.gameMode;
  $('session-choice').hidden = connected || !atPicker;
  $('session-solo').setAttribute('aria-pressed', String(!multiplayerChoice));
  $('session-multi').setAttribute('aria-pressed', String(multiplayerChoice));
  $('multiplayer-panel').hidden = connected || !multiplayerChoice || !atPicker;
  if (atPicker) $('mode-pick').classList.toggle('hidden', multiplayerChoice);
  $('session-status').hidden = !connected;
  $('session-label').textContent = connected ? `${session.worldName} · Room ${session.roomCode}` : '';
  $('world-name-field').hidden = !atPicker || connected;
  const manageSoloSaves = !connected && state.mode === 'paused' && soloSaveProblem;
  $('saved-worlds').hidden = !(atPicker || manageSoloSaves) || connected;
  $('server-world-saves').hidden = manageSoloSaves;
  for (const button of $('saved-worlds').querySelectorAll('[data-resume-world]')) {
    button.disabled = !atPicker || button.dataset.resumeWorld === 'unsupported';
  }
  $('save-world').hidden = state.mode !== 'paused' || !state.gameMode;
  $('save-status').hidden = !state.gameMode;
  $('room-leave').hidden = !connected || state.mode !== 'paused';
  $('room-reset').hidden = !connected || state.mode !== 'paused' || session.hostId !== session.playerId;
  $('new-game').classList.toggle('hidden', connected || state.mode !== 'paused');
  $('inv-description').textContent = connected
    ? 'Pick a slot and item. The room keeps playing while your bag is open.'
    : 'Pick a hotbar slot, then tap or click an item to put it there.';
  $('inventory-key-help').textContent = connected
    ? 'Inventory (the room keeps playing): all bricks and the sword'
    : 'Inventory (pauses the game): all bricks and the sword';
}

for (const id of ['session-choice', 'multiplayer-panel', 'world-name-field', 'saved-worlds']) {
  $(id).addEventListener('click', (event) => event.stopPropagation());
}
for (const [id, together] of [['session-solo', false], ['session-multi', true]]) {
  $(id).addEventListener('click', () => {
    multiplayerChoice = together;
    syncSessionUi();
  });
}
try { $('player-name').value = localStorage.getItem('legocraft-name') || ''; } catch { /* Optional. */ }
$('room-create').addEventListener('click', () => connectRoom('create'));
$('room-join').addEventListener('click', () => connectRoom('join'));
$('room-code').addEventListener('input', () => {
  $('room-code').value = $('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('room-code').addEventListener('keydown', (event) => {
  if (event.code === 'Enter') { event.preventDefault(); connectRoom('join'); }
});
$('room-leave').addEventListener('click', (event) => { event.stopPropagation(); leaveRoom(); });
$('room-reset').addEventListener('click', (event) => {
  event.stopPropagation();
  if (session.hostId === session.playerId) networkAction('reset');
});

async function connectRoom(type) {
  if (networkLoading || session.connected || state.mode !== 'ready') return;
  const name = $('player-name').value.trim().slice(0, 16) || 'Builder';
  const roomCode = $('room-code').value.trim().toUpperCase();
  if (type === 'join' && !/^[A-Z0-9]{6}$/.test(roomCode)) {
    $('room-error').textContent = 'Enter the six-character room code from your friend’s screen.';
    return;
  }
  try { localStorage.setItem('legocraft-name', name); } catch { /* Optional. */ }
  for (const id of ['room-create', 'room-join', 'session-solo', 'session-multi']) $(id).disabled = true;
  $('room-error').textContent = type === 'create' ? 'Creating room…' : 'Joining room…';
  networkLoading = true;
  networkPackets = [];
  sfx.init();
  try {
    const welcome = await session.connect({ type, name, roomCode, worldName: worldName(), gameMode: $('room-mode').value });
    $('room-error').textContent = '';
    await loadNetworkWorld(welcome);
  } catch (error) {
    networkLoading = false;
    session.close();
    $('room-error').textContent = error.message;
    syncSessionUi();
  } finally {
    for (const id of ['room-create', 'room-join', 'session-solo', 'session-multi']) $(id).disabled = false;
  }
}

function networkAction(action, details = {}) {
  if (!session.connected || networkLoading) return false;
  session.pose(player, state.mode === 'playing' && !state.naming);
  return session.action(action, details);
}

async function loadNetworkWorld(packet) {
  const generation = ++networkGeneration;
  networkLoading = true;
  state.mode = 'loading';
  document.exitPointerLock?.();
  remotePlayers.clear();
  networkEntities.clear();
  networkCarryId = null;
  networkRespawning = false;
  resetRun();
  $('death').classList.add('hidden');
  showStartOverlay('loading');
  if (packet.world.terrain) {
    const data = decodeTerrain(packet.world.terrain);
    world.seed = packet.world.seed;
    world.data.set(data);
    for (let i = 0; i < world.meshes.length; i++) world.dirty.add(i);
  } else {
    world.regenerate(packet.world.seed);
    for (const [x, y, z, block] of packet.blocks) world.set(x, y, z, block);
  }
  session.worldName = packet.world.name || packet.state.name || session.worldName;
  soloRecord = null;
  state.gameMode = packet.state.gameMode;
  document.body.classList.toggle('build-mode', state.gameMode === 'build');
  const own = packet.state.players.find((p) => p.id === session.playerId);
  if (own) {
    setNetworkPosition(own);
    if (Array.isArray(own.hotbar) && own.hotbar.length === HOTBAR_SLOTS) {
      hotbar.splice(0, HOTBAR_SLOTS, ...own.hotbar);
      hotbar.forEach((item, i) => renderSlotIcon(slotEls[i], item));
      setSlot(own.slot ?? 0);
    }
  }
  applyNetworkState(packet.state);
  await new Promise((resolve) => buildWorld(resolve));
  if (!session.connected || generation !== networkGeneration) return;
  state.mode = player.health <= 0 ? 'dead' : 'ready';
  networkLoading = false;
  if (state.mode === 'dead') die();
  else showStartOverlay('ready');
  syncControls();
  const pending = networkPackets;
  networkPackets = [];
  for (const queued of pending) receiveNetworkPacket(queued);
  notice(`Room ${session.roomCode}: share this code. Pausing stops only your controls.`);
}

function setNetworkPosition(position) {
  player.pos.set(position.x, position.y, position.z);
  player.vel.set(0, 0, 0);
  player.yaw = position.yaw ?? player.yaw;
  player.pitch = position.pitch ?? player.pitch;
  player.syncCamera();
}

function receiveNetworkPacket(packet) {
  if (networkLoading) {
    // A backgrounded tab may wait for animation frames while sockets keep
    // receiving. Keep the latest state, and preserve authoritative edits.
    if (packet.type === 'event') return;
    if (packet.type === 'world') { networkPackets = [packet]; return; }
    if (packet.type === 'state' || packet.type === 'correction') {
      const previous = networkPackets.findIndex((p) => p.type === packet.type);
      if (previous >= 0) { networkPackets[previous] = packet; return; }
    }
    networkPackets.push(packet);
    return;
  }
  if (packet.type === 'saved') finishSharedSave(packet);
  else if (packet.type === 'state') applyNetworkState(packet);
  else if (packet.type === 'blocks') {
    for (const [x, y, z, block] of packet.blocks) world.set(x, y, z, block);
  } else if (packet.type === 'world') loadNetworkWorld(packet);
  else if (packet.type === 'correction') setNetworkPosition(packet);
  else if (packet.type === 'event') {
    if (packet.event === 'explosion') {
      debris.burst(packet.x, packet.y, packet.z, 0xd62b1e, 18, 0.2, 7);
      sfx.explosion();
    } else if (packet.event === 'kill') sfx.killEnemy();
    else if (packet.event === 'break') {
      debris.burst(packet.x + 0.5, packet.y + 0.5, packet.z + 0.5, BLOCK_INFO[packet.block]?.color ?? 0xaaaaaa, 8);
      sfx.breakBlock();
    } else if (packet.event === 'place') sfx.placeBlock();
  } else if (packet.type === 'error') {
    if (packet.code === 'SAVE_FAILED' || packet.code === 'SAVE_DISABLED') { finishSharedSave(); savedStatus(packet.message); }
    if (packet.code === 'AUTOSAVE_FAILED') savedStatus(packet.message);
    if (packet.code === 'RESPAWN_COOLDOWN') cancelRespawnWait();
    notice(packet.message);
  }
}

function applyNetworkState(snapshot) {
  const own = snapshot.players.find((p) => p.id === session.playerId);
  if (!own) return;
  const oldHealth = player.health;
  const oldWave = state.wave;
  session.hostId = snapshot.hostId;
  if (snapshot.worldName || snapshot.name) session.worldName = snapshot.worldName || snapshot.name;
  Object.assign(state, { score: snapshot.score, kills: snapshot.kills, wave: snapshot.wave,
    waveRemaining: snapshot.remaining, intermission: snapshot.intermission, tomatoes: own.tomatoes });
  if (own.health > 0 && (networkRespawning || state.mode === 'dead')) {
    cancelRespawnWait();
    setNetworkPosition(own);
    $('death').classList.add('hidden');
    state.mode = 'ready';
    showStartOverlay('ready');
    if (controlMode === 'touch') play();
  }
  player.health = own.health;
  if (own.health < oldHealth) { state.flash = 1; sfx.hurt(); }
  networkCarryId = own.carryId ?? null;
  if (networkCarryId) {
    const body = snapshot.bodies?.find((b) => b.id === networkCarryId);
    $('carry-hint').textContent = carryHint(body?.name);
    $('carry-hint').style.opacity = 1;
  } else $('carry-hint').style.opacity = 0;
  remotePlayers.updatePlayers(snapshot.players, session.playerId);
  networkEntities.apply(snapshot);
  $('session-players').textContent = `${snapshot.players.length}/8 players${session.hostId === session.playerId ? ' · Host' : ''}`;
  syncSessionUi();
  if (oldWave !== state.wave && !networkLoading) showWaveBanner(`WAVE ${state.wave}`);
  if (player.health <= 0 && state.mode !== 'dead' && !networkLoading && !networkRespawning) die();
}

function leaveRoom() {
  finishSharedSave();
  cancelRespawnWait();
  ++networkGeneration;
  session.close();
  networkLoading = false;
  networkPackets = [];
  networkCarryId = null;
  remotePlayers.clear();
  networkEntities.clear();
  multiplayerChoice = false;
  notice('You left the room.');
  newGame();
}

function disconnected(roomCode) {
  finishSharedSave();
  savedStatus('Connection lost. The last confirmed save stays on the Pi.');
  cancelRespawnWait();
  ++networkGeneration;
  networkLoading = false;
  networkPackets = [];
  networkCarryId = null;
  remotePlayers.clear();
  networkEntities.clear();
  multiplayerChoice = true;
  $('room-code').value = roomCode;
  $('room-error').textContent = `Connection lost. Rejoin room ${roomCode} when the Pi is available.`;
  notice('Disconnected. Rejoin to continue; your shared world stays on the Pi.');
  newGame();
}

// ---- Input -----------------------------------------------------------------
const canvas = renderer.domElement;
let controlMode = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 ? 'touch' : 'laptop';
try {
  const saved = localStorage.getItem('legocraft-controls');
  if (saved === 'touch' || saved === 'laptop') controlMode = saved;
} catch { /* Private browsing can disallow preference storage. */ }

const touchControls = new TouchControls({
  canvas,
  root: $('touch-controls'),
  onMove: (x, z) => { player.touch.x = x; player.touch.z = z; },
  onLook: (dx, dy) => player.onMouseMove(dx * 1.6, dy * 1.6),
  onHold: (action, held) => {
    if (action === 'jump' || action === 'sprint') {
      player.touch[action] = held;
      if (action === 'jump' && held && player.onGround) sfx.jump();
    } else holdAction(action === 'attack' ? 0 : 2, held);
  },
  onAction: (action) => {
    if (action === 'inventory') openInventory();
    else if (action === 'pause') pauseGame();
    else if (action === 'name') beginNaming();
    else if (action === 'tomato') throwTomato();
    else if (action.startsWith('slot:')) setSlot(Number(action.slice(5)));
  },
});

function holdAction(button, held) {
  state.mouse[button] = held;
  if (held && button === 0) state.swingCooldown = 0;
  if (held && button === 2) state.placeCooldown = 0;
  if (!held && button === 0 && session.connected && !networkLoading) {
    session.action('drop');
    networkCarryId = null;
  }
  if (!held && button === 0 && ragdolls.carrying) {
    player.lookDir(_dir);
    ragdolls.drop(_dir.clone().multiplyScalar(2.5).add(player.vel));
    $('carry-hint').style.opacity = 0;
  }
}

function clearInput() {
  touchControls.reset();
  player.keys.clear();
  Object.assign(player.touch, { x: 0, z: 0, jump: false, sprint: false });
  holdAction(0, false);
  state.mouse.fill(false);
}

function syncControls() {
  const touch = controlMode === 'touch';
  document.body.classList.toggle('touch-mode', touch);
  $('input-laptop').setAttribute('aria-pressed', String(!touch));
  $('input-touch').setAttribute('aria-pressed', String(touch));
  $('touch-help').hidden = !touch;
  $('laptop-help').hidden = touch;
  touchControls.setEnabled(touch && state.mode === 'playing' && !state.naming);
  syncSessionUi();
  if (!networkLoading) session.pose(player, state.mode === 'playing' && !state.naming);
}

function selectControls(mode) {
  clearInput();
  controlMode = mode;
  try { localStorage.setItem('legocraft-controls', mode); } catch { /* Optional preference. */ }
  syncControls();
  if (state.mode === 'paused') showStartOverlay('paused');
  else if (state.mode === 'ready' && state.gameMode) showStartOverlay('ready');
}
for (const mode of ['laptop', 'touch']) {
  $('input-' + mode).addEventListener('click', (event) => {
    event.stopPropagation();
    selectControls(mode);
  });
}
$('input-picker').addEventListener('click', (event) => event.stopPropagation());
syncControls();

function play() {
  if (!((state.mode === 'ready' && state.gameMode) || (state.mode === 'paused' && !state.inventoryOpen))) return;
  state.mode = 'playing';
  $('start').classList.add('hidden');
  syncControls();
}

function pauseGame() {
  if (state.mode !== 'playing') return;
  if (state.naming) endNaming(false);
  state.mode = 'paused';
  clearInput();
  syncControls();
  if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  if (!state.inventoryOpen) showStartOverlay('paused');
  saveSoloWorld({ quiet: true });
}

function pointerLockError() {
  if (controlMode !== 'laptop' || state.mode === 'playing') return;
  player.locked = false;
  if (state.inventoryOpen || state.mode === 'dead' || state.mode === 'loading') return;
  showStartOverlay(state.mode === 'ready' ? 'ready' : 'paused');
  $('start-cta').textContent = 'Mouse lock unavailable. Click to retry or choose iPad / iPhone controls.';
}

function lock() {
  sfx.init();
  if (controlMode === 'touch') { play(); return; }
  if (!canvas.requestPointerLock) { pointerLockError(); return; }
  try {
    const request = canvas.requestPointerLock();
    request?.catch(pointerLockError);
  } catch { pointerLockError(); }
}

/** Show the start/pause overlay in the right configuration for the current state. */
function showStartOverlay(kind) {
  const cta = $('start-cta');
  $('mode-pick').classList.toggle('hidden', kind !== 'pick');
  $('new-game').classList.toggle('hidden', kind !== 'paused');
  cta.classList.toggle('hidden', kind === 'pick');
  if (kind === 'loading') cta.textContent = 'Generating world\u2026';
  else if (kind === 'ready') cta.textContent = controlMode === 'touch' ? 'Tap to play' : 'Click to play';
  else if (kind === 'paused') cta.textContent = controlMode === 'touch' ? 'Paused — tap to resume' : 'Paused — click to resume';
  $('start').classList.remove('hidden');
  if (session.connected && kind === 'ready') cta.textContent = `Room ${session.roomCode} — ${controlMode === 'touch' ? 'tap' : 'click'} to play`;
  if (session.connected && kind === 'paused') cta.textContent = `Room keeps playing — ${controlMode === 'touch' ? 'tap' : 'click'} to resume`;
  syncSessionUi();
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  player.locked = locked;
  if (controlMode !== 'laptop') {
    if (locked) document.exitPointerLock?.();
    return;
  }
  if (locked) play();
  else pauseGame();
});
document.addEventListener('pointerlockerror', pointerLockError);

document.addEventListener('mousemove', (e) => {
  if (controlMode === 'laptop' && state.mode === 'playing' && player.locked && !state.naming) player.onMouseMove(e.movementX, e.movementY);
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && state.mode === 'dead') {
    restart();
    return;
  }
  if (state.naming) {
    // Typing a name: Enter confirms, Esc cancels, everything else goes to the input.
    if (e.code === 'Enter' || e.code === 'NumpadEnter') endNaming(true);
    else if (e.code === 'Escape') endNaming(false);
    return;
  }
  if (state.inventoryOpen) {
    if (e.code === 'KeyE' || e.code === 'Escape') {
      e.preventDefault();
      closeInventory();
    } else if (e.code.startsWith('Digit')) {
      const i = Number(e.code.slice(5)) - 1;
      if (i >= 0 && i < HOTBAR_SLOTS) {
        setSlot(i);
        renderInventoryHotbar();
      }
    }
    return;
  }
  if (state.mode !== 'playing') return;
  if (e.code === 'Escape') { e.preventDefault(); pauseGame(); return; }
  if (controlMode !== 'laptop' || e.repeat && ['KeyE', 'KeyN', 'KeyQ'].includes(e.code)) return;
  if (e.code === 'KeyN') {
    e.preventDefault();
    beginNaming();
    return;
  }
  if (e.code === 'KeyE') {
    e.preventDefault();
    openInventory();
    return;
  }
  player.keys.add(e.code);
  if (e.code === 'Space') {
    e.preventDefault();
    if (player.onGround) sfx.jump();
  }
  if (e.code === 'KeyQ') throwTomato();
  if (e.code.startsWith('Digit')) {
    const i = Number(e.code.slice(5)) - 1;
    if (i >= 0 && i < HOTBAR_SLOTS) setSlot(i);
  }
});
document.addEventListener('keyup', (e) => player.keys.delete(e.code));

document.addEventListener('wheel', (e) => {
  if (controlMode !== 'laptop' || state.mode !== 'playing' || state.naming) return;
  setSlot(state.slot + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });

canvas.addEventListener('mousedown', (e) => {
  if (controlMode !== 'laptop' || state.mode !== 'playing' || !player.locked || state.naming) return;
  holdAction(e.button, true);
  if (e.button === 1) {
    e.preventDefault();
    throwTomato();
  }
});
document.addEventListener('mouseup', (e) => {
  if (controlMode === 'laptop') holdAction(e.button, false);
});
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
window.addEventListener('blur', pauseGame);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

$('start').addEventListener('click', () => {
  if (state.mode === 'loading') return;
  if (state.mode === 'ready' && !state.gameMode) return; // pick a mode first
  sfx.init();
  lock();
});
function chooseMode(mode) {
  if (state.mode !== 'ready' || state.gameMode || networkLoading || newGamePending) return;
  soloRecord = { id: newSaveId(), name: worldName() };
  savedStatus('Autosaves on this device every 15 seconds.');
  state.gameMode = mode;
  sfx.init();
  if (mode === 'build') state.tomatoes = TOMATO_MAX; // nothing to earn them from, so start stocked
  else startWave(1);
  document.body.classList.toggle('build-mode', mode === 'build');
  lock();
  saveSoloWorld({ quiet: true });
}
$('mode-wave').addEventListener('click', (e) => { e.stopPropagation(); chooseMode('wave'); });
$('mode-build').addEventListener('click', (e) => { e.stopPropagation(); chooseMode('build'); });
$('new-game').addEventListener('click', (e) => {
  e.stopPropagation(); // don't let the overlay's click re-lock the pointer
  if (state.mode === 'paused' || state.mode === 'ready') newGame();
});
$('inventory').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeInventory(); // click the backdrop to close
});
$('close-inventory').addEventListener('click', closeInventory);
$('death').addEventListener('click', () => {
  if (state.mode === 'dead') restart();
});

window.addEventListener('resize', () => {
  clearInput();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

slotEls.forEach((el, i) => {
  touchControls.bindPointer(el, `tap:slot:${i}`);
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Select hotbar slot ${i + 1}`);
  const select = () => {
    if (controlMode === 'touch' && state.mode === 'playing' && !state.naming) setSlot(i);
  };
  el.addEventListener('click', (e) => { if (e.detail === 0) select(); });
  el.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); select(); }
  });
});

// ---- Gameplay --------------------------------------------------------------
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Returns {enemy, dist} for the closest enemy under the crosshair within reach. */
function enemyUnderCrosshair(reach) {
  player.eyePos(_eye);
  player.lookDir(_dir);
  let best = null;
  let bestD = reach;
  for (const en of enemies) {
    const d = rayBox(
      _eye.x, _eye.y, _eye.z, _dir.x, _dir.y, _dir.z,
      en.pos.x - en.halfW, en.pos.y, en.pos.z - en.halfW,
      en.pos.x + en.halfW, en.pos.y + en.height, en.pos.z + en.halfW,
    );
    if (d < bestD) {
      bestD = d;
      best = en;
    }
  }
  return best ? { enemy: best, dist: bestD } : null;
}

/** Closest passive creature under the crosshair within reach. */
function animalUnderCrosshair(reach) {
  player.eyePos(_eye);
  player.lookDir(_dir);
  let best = null;
  let bestD = reach;
  for (const a of animals) {
    const d = rayBox(
      _eye.x, _eye.y, _eye.z, _dir.x, _dir.y, _dir.z,
      a.pos.x - a.halfW, a.pos.y, a.pos.z - a.halfW,
      a.pos.x + a.halfW, a.pos.y + a.height, a.pos.z + a.halfW,
    );
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best ? { animal: best, dist: bestD } : null;
}

function swing() {
  state.swing = 1;
  if (session.connected) { networkAction('attack'); return; }
  const target = enemyUnderCrosshair(4.5);
  player.eyePos(_eye);
  player.lookDir(_dir);
  const hit = world.raycast(_eye, _dir, 6);
  const body = ragdolls.hitTest(_eye, _dir, 4.0);

  // A body under the crosshair (and nearer than any live enemy or block) gets picked up.
  if (body && (!target || body.dist < target.dist) && (!hit || body.dist < hit.dist)) {
    ragdolls.grab(body.body, body.point);
    sfx.grab();
    $('carry-hint').textContent = carryHint(body.body.name);
    $('carry-hint').style.opacity = 1;
    return;
  }

  const pet = animalUnderCrosshair(4.5);
  if (pet && (!hit || pet.dist < hit.dist) && (!target || pet.dist < target.dist)) {
    pet.animal.startle(player.pos.x, player.pos.z);
    sfx.animal(pet.animal.kind, true);
    return;
  }

  if (target && (!hit || target.dist < hit.dist)) {
    const en = target.enemy;
    const killed = en.hit(12, _dir.x, _dir.z);
    if (killed) killEnemy(en);
    else sfx.hitEnemy();
    return;
  }
  if (hit) {
    const type = world.get(hit.x, hit.y, hit.z);
    if (type === BLOCK.BEDROCK) return;
    world.set(hit.x, hit.y, hit.z, BLOCK.AIR);
    debris.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, BLOCK_INFO[type].color, 10);
    sfx.breakBlock();
  }
}

function place() {
  const item = hotbar[state.slot];
  if (item === 'sword') return; // nothing to place
  if (session.connected) {
    state.swing = 0.6;
    networkAction('place', { block: item });
    return;
  }
  player.eyePos(_eye);
  player.lookDir(_dir);
  const hit = world.raycast(_eye, _dir, 6);
  if (!hit) return;
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  const cur = world.get(x, y, z);
  if (!world.inBounds(x, y, z) || (cur !== BLOCK.AIR && cur !== BLOCK.WATER)) return;
  // Don't entomb the player or an enemy.
  if (overlapsBox(x, y, z, player.pos, player.halfW, player.height)) return;
  for (const en of enemies) if (overlapsBox(x, y, z, en.pos, en.halfW, en.height)) return;
  for (const a of animals) if (overlapsBox(x, y, z, a.pos, a.halfW, a.height)) return;
  world.set(x, y, z, item);
  state.swing = 0.6;
  sfx.placeBlock();
}

function overlapsBox(bx, by, bz, pos, halfW, height) {
  return (
    bx + 1 > pos.x - halfW && bx < pos.x + halfW &&
    by + 1 > pos.y && by < pos.y + height &&
    bz + 1 > pos.z - halfW && bz < pos.z + halfW
  );
}

function killEnemy(en) {
  if (en.dead || !enemies.includes(en)) return; // already handled by a blast earlier this frame
  if (en.type.ragdoll) {
    // Stays in one piece: the group is kept in the scene and handed to the ragdoll system.
    ragdolls.add(en);
  } else {
    en.explode(debris);
    scene.remove(en.group);
  }
  enemies.splice(enemies.indexOf(en), 1);
  state.kills++;
  state.score += en.type.score * state.wave;
  sfx.killEnemy();
}

const spawnCursor = { angle: Math.random() * Math.PI * 2 };

function spawnEnemy() {
  const spot = findSpawnSpot(world, player.pos, enemies, state.wave, spawnCursor);
  if (!spot) return false;
  const en = new Enemy(spot.typeKey, spot.x, spot.y + 1.01, spot.z, state.wave);
  en.facing = Math.atan2(player.pos.x - spot.x, player.pos.z - spot.z);
  en.group.rotation.y = en.facing;
  scene.add(en.group);
  enemies.push(en);
  return true;
}

function onEnemyAttack(en) {
  const dead = player.takeDamage(en.dmg, en.pos.x, en.pos.z);
  state.flash = 1;
  sfx.hurt();
  if (dead) die();
}

/** Every creature within `radius` of a point bolts away from it. */
function scareAnimals(x, z, radius) {
  for (const a of animals) {
    if (Math.hypot(a.pos.x - x, a.pos.z - z) < radius) a.startle(x, z);
  }
}

/** Linear damage falloff with distance from a blast centre, floored at 25%. */
function blastFalloff(d, radius = BLAST_RADIUS) {
  return d >= radius ? 0 : Math.max(0.25, 1 - d / radius);
}

/** Clear a sphere of blocks around `c` (bedrock and water stay), with some debris. */
function crater(c, r) {
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  const cz = Math.floor(c.z);
  const ri = Math.ceil(r);
  let bursts = 0;
  for (let x = cx - ri; x <= cx + ri; x++) {
    for (let y = cy - ri; y <= cy + ri; y++) {
      for (let z = cz - ri; z <= cz + ri; z++) {
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z);
        if (d > r || !world.inBounds(x, y, z)) continue;
        const type = world.get(x, y, z);
        if (type === BLOCK.AIR || type === BLOCK.BEDROCK || type === BLOCK.WATER) continue;
        world.set(x, y, z, BLOCK.AIR);
        // Only some blocks shed debris, to keep the particle count sane.
        if (bursts < 14 && Math.random() < 0.35) {
          debris.burst(x + 0.5, y + 0.5, z + 0.5, BLOCK_INFO[type].color, 3, 0.2, 7);
          bursts++;
        }
      }
    }
  }
}

/** Lob a tomato from the eye along the crosshair, if there's one in hand. */
function throwTomato() {
  if (state.mode !== 'playing' || state.tomatoes <= 0 || state.throwCooldown > 0 || ragdolls.carrying || networkCarryId) return;
  if (session.connected) {
    state.throwCooldown = THROW_COOLDOWN;
    networkAction('tomato');
    sfx.throwTomato();
    return;
  }
  state.tomatoes--;
  state.throwCooldown = THROW_COOLDOWN;
  player.eyePos(_eye);
  player.lookDir(_dir);
  _eye.addScaledVector(_dir, 0.6); // leaves from just in front of the face
  _eye.y -= 0.15;
  tomatoes.throw(_eye, _dir, player.vel);
  sfx.throwTomato();
}

// ---- Naming fallen Stalkers --------------------------------------------------
const nameInput = $('name-input');
$('name-confirm').addEventListener('click', () => endNaming(true));
$('name-cancel').addEventListener('click', () => endNaming(false));

function carryHint(name) {
  return `Carrying ${name || 'a body'} — ${controlMode === 'touch' ? 'release Hit' : 'release left click'} to drop`;
}

/** Open the name prompt for the body being carried, or the one under the crosshair. */
function beginNaming() {
  if (state.mode !== 'playing' || state.naming) return;
  let body = session.connected ? ragdolls.bodies.find((b) => b.netId === networkCarryId) : ragdolls.carrying;
  if (!body) {
    player.eyePos(_eye);
    player.lookDir(_dir);
    const hit = ragdolls.hitTest(_eye, _dir, 5);
    const block = world.raycast(_eye, _dir, 5);
    if (hit && (!block || hit.dist < block.dist)) body = hit.body;
  }
  if (!body) return;
  state.naming = body;
  clearInput();
  syncControls();
  nameInput.value = body.name;
  $('name-prompt').classList.remove('hidden');
  nameInput.focus();
  nameInput.select();
}

function endNaming(confirm) {
  const body = state.naming;
  if (!body) return;
  state.naming = null;
  $('name-prompt').classList.add('hidden');
  nameInput.blur();
  syncControls();
  if (!confirm || !ragdolls.bodies.includes(body)) return;
  const name = nameInput.value.trim().slice(0, 16);
  if (session.connected) {
    networkAction('name', { bodyId: body.netId, name });
    return;
  }
  ragdolls.setName(body, name, (n) => {
    const s = makeNameTag(n, { color: '#ffffff', pill: 'rgba(60, 20, 80, 0.8)', cache: false });
    s?.scale.set(NAME_TAG_SIZE.w, NAME_TAG_SIZE.h, 1);
    return s;
  });
  if (name) sfx.grab();
  if (ragdolls.carrying === body) $('carry-hint').textContent = carryHint(name);
}

/** A tomato burst at `c`; `direct` is the minifig or body it struck, if any. Harmless to the thrower. */
function explodeTomato(c, direct) {
  crater(c, TOMATO_CRATER_RADIUS);

  // Minifigs in range; a direct hit takes full damage no matter where its centre is.
  for (const o of [...enemies]) {
    if (o.dead || !enemies.includes(o)) continue;
    const od = Math.hypot(o.pos.x - c.x, o.pos.y + o.height / 2 - c.y, o.pos.z - c.z);
    const of = o === direct ? 1 : blastFalloff(od, TOMATO_BLAST_RADIUS);
    if (of <= 0) continue;
    const kx = o.pos.x - c.x || (Math.random() - 0.5);
    const kz = o.pos.z - c.z || (Math.random() - 0.5);
    if (o.hit(Math.round(TOMATO_DAMAGE * of), kx, kz)) killEnemy(o);
  }

  ragdolls.impulseAt(c.x, c.y, c.z, TOMATO_BLAST_RADIUS + 0.5, 9);
  scareAnimals(c.x, c.z, TOMATO_BLAST_RADIUS + 3);
  debris.burst(c.x, c.y, c.z, 0xd62b1e, 22, 0.22, 9); // pulp
  debris.burst(c.x, c.y, c.z, 0xff7a5c, 10, 0.14, 6); // juice
  debris.burst(c.x, c.y, c.z, 0x3f8f2c, 4, 0.12, 5); // bits of stem
  sfx.splat();
}

/**
 * A Bomber's fuse ran out: crater the terrain, hurt everything nearby, remove it. Killing a
 * Bomber before that just bursts it into bricks like any other minifig; only the fuse blows.
 */
function detonate(en) {
  if (en.dead || !enemies.includes(en)) return;
  en.dead = true; // claim it now so a chained blast can't detonate it a second time
  const c = en.center;
  crater(c, BLAST_BLOCK_RADIUS);

  // Player damage with falloff; knockback comes from takeDamage.
  const pd = Math.hypot(player.pos.x - c.x, player.pos.y + player.height / 2 - c.y, player.pos.z - c.z);
  const pf = blastFalloff(pd);
  let killedPlayer = false;
  if (pf > 0) {
    killedPlayer = player.takeDamage(Math.round(en.dmg * pf), en.pos.x, en.pos.z);
    state.flash = 1;
    sfx.hurt();
  }

  // Other minifigs caught in the blast (chain kills count for the player).
  for (const o of [...enemies]) {
    if (o === en || o.dead || !enemies.includes(o)) continue;
    const od = Math.hypot(o.pos.x - c.x, o.pos.y + o.height / 2 - c.y, o.pos.z - c.z);
    const of = blastFalloff(od);
    if (of <= 0) continue;
    if (o.hit(Math.round(en.dmg * 1.5 * of), o.pos.x - c.x, o.pos.z - c.z)) killEnemy(o);
  }

  // The bomber itself flies apart. Self-destruction counts towards the wave but scores nothing.
  en.explode(debris);
  scene.remove(en.group);
  enemies.splice(enemies.indexOf(en), 1);
  state.kills++;
  ragdolls.impulseAt(c.x, c.y, c.z, BLAST_RADIUS + 1, 12);
  scareAnimals(c.x, c.z, BLAST_RADIUS + 4);
  debris.burst(c.x, c.y, c.z, 0xffa500, 18, 0.26, 10);
  debris.burst(c.x, c.y, c.z, 0x333333, 10, 0.3, 6);
  sfx.explosion();
  if (killedPlayer) die();
}

function die() {
  state.mode = 'dead';
  if (state.naming) endNaming(false);
  state.inventoryOpen = false;
  $('inventory').classList.add('hidden');
  clearInput();
  syncControls();
  sfx.die();
  document.exitPointerLock?.();
  $('final-score').textContent = state.score;
  $('final-kills').textContent = state.kills;
  $('final-wave').textContent = state.wave;
  $('start').classList.add('hidden');
  $('death').classList.remove('hidden');
}

/** Remove every enemy, body and particle and zero the run stats. */
function resetRun() {
  for (const en of enemies) scene.remove(en.group);
  enemies.length = 0;
  pendingDetonations.length = 0;
  debris.clear();
  ragdolls.clear();
  tomatoes.clear();
  for (const a of [...animals]) removeAnimal(a);
  if (state.naming) endNaming(false);
  if (state.inventoryOpen) {
    state.inventoryOpen = false;
    $('inventory').classList.add('hidden');
  }
  $('carry-hint').style.opacity = 0;
  Object.assign(state, {
    score: 0, kills: 0, wave: 1, elapsed: 0, waveRemaining: 0, intermission: 0, spawnTimer: 2, flash: 0, swing: 0,
    tomatoes: 0, throwCooldown: 0,
  });
  clearInput();
  syncControls();
  $('flash').style.opacity = 0;
}

/** After death: same world, fresh run. */
function cancelRespawnWait() {
  networkRespawning = false;
  clearTimeout(networkRespawnTimer);
  $('restart-game').disabled = false;
  $('restart-game').textContent = 'Rebuild yourself';
}

function restart() {
  if (session.connected) {
    if (networkRespawning) return;
    networkRespawning = true;
    $('restart-game').disabled = true;
    $('restart-game').textContent = 'Rebuilding…';
    session.action('respawn');
    networkRespawnTimer = setTimeout(() => {
      if (!networkRespawning) return;
      cancelRespawnWait();
      notice('Respawn was not confirmed. Try Rebuild yourself again.');
    }, 3000);
    return;
  }
  resetRun();
  player.spawn();
  if (state.gameMode === 'wave') startWave(1);
  else state.tomatoes = TOMATO_MAX;
  $('death').classList.add('hidden');
  showStartOverlay('ready');
  state.mode = 'ready';
  sfx.init();
  lock();
}

/** Keep the current Solo save before returning to the new-world picker. */
async function newGame() {
  if (newGamePending) return;
  newGamePending = true;
  $('new-game').disabled = true;
  if (soloRecord && state.gameMode && !session.connected) {
    if (!await saveSoloWorld()) {
      notice('Finish saving this world before starting another one. Try Save now again.');
      newGamePending = false;
      $('new-game').disabled = false;
      return;
    }
  }
  soloRecord = null;
  savedStatus('');
  state.mode = 'loading';
  document.exitPointerLock?.();
  resetRun();
  state.gameMode = null;
  document.body.classList.remove('build-mode');
  $('death').classList.add('hidden');
  showStartOverlay('loading');
  outline.visible = false;
  // Let the browser paint the overlay before the (synchronous) terrain pass.
  requestAnimationFrame(() => {
    world.regenerate();
    buildWorld(() => {
      player.spawn();
      setSlot(0);
      state.mode = 'ready';
      newGamePending = false;
      $('new-game').disabled = false;
      showStartOverlay('pick');
      refreshSavedWorlds();
    });
  });
}

/** Mesh every dirty chunk a few per frame so the page stays responsive, then call `done`. */
function buildWorld(done) {
  const step = () => {
    const n = world.update(6);
    if (world.dirty.size > 0 && n > 0) requestAnimationFrame(step);
    else done();
  };
  step();
}

// ---- Main loop ---------------------------------------------------------------
const pendingDetonations = [];
const enemyCtx = {
  world,
  enemies,
  onAttack: onEnemyAttack,
  onDetonate: (en) => pendingDetonations.push(en),
  onTick: () => sfx.tick(),
  onBlink: (en, from) => {
    debris.burst(from.x, from.y + en.height / 2, from.z, 0xaa33ff, 12, 0.16, 4);
    debris.burst(en.pos.x, en.pos.y + en.height / 2, en.pos.z, 0xaa33ff, 8, 0.16, 3);
    sfx.blink();
  },
};
const _hand = new THREE.Vector3();
const tomatoCtx = { enemies, bodies: ragdolls.bodies, onExplode: explodeTomato };
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state.mode === 'playing' && !state.naming) {
    state.elapsed += dt;

    // Wave flow (wave mode only): spawn the wave's quota a few at a time; when every
    // minifig is destroyed, pause briefly, then start the next (harder) wave.
    if (!session.connected && state.gameMode === 'wave' && state.waveRemaining === 0 && enemies.length === 0) {
      if (state.intermission <= 0) {
        state.intermission = INTERMISSION_SECONDS;
        showWaveBanner(`WAVE ${state.wave} CLEARED`);
      } else {
        state.intermission -= dt;
        if (state.intermission <= 0) startWave(state.wave + 1);
      }
    }

    const authoritativeHealth = player.health;
    player.update(dt);
    if (session.connected) player.health = authoritativeHealth;

    if (!session.connected) {
      // Enemies
      for (let i = enemies.length - 1; i >= 0; i--) {
        const en = enemies[i];
        en.update(dt, player, enemyCtx);
        if (en.pos.y < -5) {
          scene.remove(en.group);
          enemies.splice(i, 1);
        }
        if (state.mode !== 'playing') break;
      }
      // Passive creatures
      for (let i = animals.length - 1; i >= 0; i--) {
        const a = animals[i];
        a.update(dt, world, player);
        if (a.pos.y < -5) removeAnimal(a);
      }
      // Detonations are deferred so removing several enemies at once can't
      // disturb the loop above.
      while (pendingDetonations.length && state.mode === 'playing') detonate(pendingDetonations.shift());
      pendingDetonations.length = 0;
      state.spawnTimer -= dt;
      if (state.gameMode === 'wave' && state.spawnTimer <= 0 && state.waveRemaining > 0 && enemies.length < maxAlive(state.wave)) {
        if (spawnEnemy()) state.waveRemaining--;
        state.spawnTimer = Math.max(0.6, 2.5 - state.wave * 0.15);
      }
    }

    // Mouse actions (hold to repeat). Holding left while carrying a body keeps carrying it.
    state.swingCooldown -= dt;
    state.placeCooldown -= dt;
    if (state.mouse[0] && state.swingCooldown <= 0 && !ragdolls.carrying && !networkCarryId) {
      swing();
      state.swingCooldown = 0.28;
    }
    if (state.mouse[2] && state.placeCooldown <= 0) {
      place();
      state.placeCooldown = 0.22;
    }
    state.throwCooldown -= dt;

    // Tomatoes in flight (bursts may kill minifigs or the player)
    if (!session.connected) {
      tomatoes.update(dt, tomatoCtx);

      // Ragdoll bodies: the carried one hangs from a point in front of the eye.
      player.eyePos(_hand);
      player.lookDir(_dir);
      _hand.addScaledVector(_dir, CARRY_DISTANCE);
      _hand.y -= 0.25;
      ragdolls.update(dt, player, _hand);
      if (!ragdolls.carrying) $('carry-hint').style.opacity = 0;
    }

    // Target outline
    player.eyePos(_eye);
    player.lookDir(_dir);
    const hit = world.raycast(_eye, _dir, 6);
    const target = enemyUnderCrosshair(4.5);
    if (hit && (!target || hit.dist < target.dist) && world.get(hit.x, hit.y, hit.z) !== BLOCK.BEDROCK) {
      outline.visible = true;
      outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      outline.visible = false;
    }
  }

  // Always animate these so pause/death don't freeze mid-effect.
  if (session.connected && !networkLoading) {
    session.update(dt, player, state.mode === 'playing' && !state.naming);
    remotePlayers.update(dt);
    networkEntities.update(dt);
  }
  debris.update(dt);
  world.update(4);

  // Hand swing + bob
  state.swing = Math.max(0, state.swing - dt * 4);
  const s = Math.sin(state.swing * Math.PI);
  hand.rotation.x = 0.2 - s * 1.2;
  hand.position.y = -0.38 + Math.sin(player.bob) * 0.015 - s * 0.1;
  hand.position.x = 0.42 + Math.cos(player.bob * 0.5) * 0.01;
  swordHand.rotation.x = 0.2 - s * 1.6;
  swordHand.rotation.y = -0.5 + s * 0.6; // slashes across rather than straight down
  swordHand.position.y = -0.42 + Math.sin(player.bob) * 0.015 - s * 0.12;
  swordHand.position.x = hand.position.x;

  // Damage flash
  if (state.flash > 0) {
    state.flash = Math.max(0, state.flash - dt * 2.5);
    $('flash').style.opacity = state.flash;
  }

  updateHud();
  renderer.render(scene, camera);
}

// ---- Boot -----------------------------------------------------------------------
function boot() {
  refreshSavedWorlds();
  world.generate();
  buildWorld(() => {
    player.spawn();
    setSlot(0);
    state.mode = 'ready';
    showStartOverlay('pick');
  });
  requestAnimationFrame(frame);
}

boot();
