import * as THREE from 'three';
import { World, BLOCK, BLOCK_INFO, PLACEABLE, DEFAULT_HOTBAR } from './world.js';
import { Player } from './player.js';
import { Enemy, findSpawnSpot, BLAST_RADIUS, BLAST_BLOCK_RADIUS, makeNameTag, NAME_TAG_SIZE } from './enemies.js';
import { Debris } from './debris.js';
import { Ragdolls, CARRY_DISTANCE } from './ragdoll.js';
import { Sfx } from './sfx.js';
import { rayBox, boxCollides } from './physics.js';
import { Animal } from './animals.js';
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
  player.keys.clear();
  state.mouse.fill(false);
  renderInventoryHotbar();
  invNameEl.textContent = itemName(hotbar[state.slot]);
  $('inventory').classList.remove('hidden');
  // Release the pointer so the player can click; pointerlockchange parks the game in 'paused'.
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

// ---- Input -----------------------------------------------------------------
const canvas = renderer.domElement;

function lock() {
  canvas.requestPointerLock?.();
}

/** Show the start/pause overlay in the right configuration for the current state. */
function showStartOverlay(kind) {
  const cta = $('start-cta');
  $('mode-pick').classList.toggle('hidden', kind !== 'pick');
  $('new-game').classList.toggle('hidden', kind !== 'paused');
  cta.classList.toggle('hidden', kind === 'pick');
  if (kind === 'loading') cta.textContent = 'Generating world\u2026';
  else if (kind === 'ready') cta.textContent = 'Click to play';
  else if (kind === 'paused') cta.textContent = 'Paused - click to resume';
  $('start').classList.remove('hidden');
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  player.locked = locked;
  if (locked) {
    if ((state.mode === 'ready' && state.gameMode) || state.mode === 'paused') {
      const fresh = state.mode === 'ready';
      state.mode = 'playing';
      $('start').classList.add('hidden');
      if (fresh && state.gameMode === 'wave' && state.waveRemaining === 0 && enemies.length === 0) startWave(1);
    }
  } else if (state.mode === 'playing') {
    if (state.naming) endNaming(false);
    state.mode = 'paused';
    player.keys.clear();
    state.mouse.fill(false);
    // The inventory owns the screen while it is open; otherwise show the pause screen.
    if (!state.inventoryOpen) showStartOverlay('paused');
  }
});
document.addEventListener('pointerlockerror', () => {
  // Re-lock refused (browsers throttle it right after an Esc): fall back to the pause screen.
  if (state.mode === 'paused' && !state.inventoryOpen) showStartOverlay('paused');
});

document.addEventListener('mousemove', (e) => {
  if (state.mode === 'playing' && player.locked && !state.naming) player.onMouseMove(e.movementX, e.movementY);
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
  if (state.mode !== 'playing' || state.naming) return;
  setSlot(state.slot + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });

canvas.addEventListener('mousedown', (e) => {
  if (state.mode !== 'playing' || !player.locked || state.naming) return;
  state.mouse[e.button] = true;
  if (e.button === 0) state.swingCooldown = 0; // immediate first swing
  if (e.button === 1) {
    e.preventDefault();
    throwTomato();
  }
  if (e.button === 2) state.placeCooldown = 0;
});
document.addEventListener('mouseup', (e) => {
  state.mouse[e.button] = false;
  if (e.button === 0 && ragdolls.carrying) {
    // Let go: the body keeps the hand's motion plus a gentle forward toss.
    player.lookDir(_dir);
    ragdolls.drop(_dir.clone().multiplyScalar(2.5).add(player.vel));
    $('carry-hint').style.opacity = 0;
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

$('start').addEventListener('click', () => {
  if (state.mode === 'loading') return;
  if (state.mode === 'ready' && !state.gameMode) return; // pick a mode first
  sfx.init();
  lock();
});
function chooseMode(mode) {
  if (state.mode !== 'ready') return;
  state.gameMode = mode;
  if (mode === 'build') state.tomatoes = TOMATO_MAX; // nothing to earn them from, so start stocked
  document.body.classList.toggle('build-mode', mode === 'build');
  sfx.init();
  lock();
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
$('death').addEventListener('click', () => {
  if (state.mode === 'dead') restart();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  const target = enemyUnderCrosshair(4.5);
  player.eyePos(_eye);
  player.lookDir(_dir);
  const hit = world.raycast(_eye, _dir, 6);
  const body = ragdolls.hitTest(_eye, _dir, 4.0);

  // A body under the crosshair (and nearer than any live enemy or block) gets picked up.
  if (body && (!target || body.dist < target.dist) && (!hit || body.dist < hit.dist)) {
    ragdolls.grab(body.body, body.point);
    sfx.grab();
    $('carry-hint').textContent = `Carrying ${body.body.name || 'a body'} \u2014 release left click to drop`;
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
  if (state.mode !== 'playing' || state.tomatoes <= 0 || state.throwCooldown > 0 || ragdolls.carrying) return;
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

/** Open the name prompt for the body being carried, or the one under the crosshair. */
function beginNaming() {
  if (state.mode !== 'playing' || state.naming) return;
  let body = ragdolls.carrying;
  if (!body) {
    player.eyePos(_eye);
    player.lookDir(_dir);
    const hit = ragdolls.hitTest(_eye, _dir, 5);
    const block = world.raycast(_eye, _dir, 5);
    if (hit && (!block || hit.dist < block.dist)) body = hit.body;
  }
  if (!body) return;
  state.naming = body;
  player.keys.clear();
  state.mouse.fill(false);
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
  if (!confirm || !ragdolls.bodies.includes(body)) return;
  const name = nameInput.value.trim().slice(0, 16);
  ragdolls.setName(body, name, (n) => {
    const s = makeNameTag(n, { color: '#ffffff', pill: 'rgba(60, 20, 80, 0.8)', cache: false });
    s?.scale.set(NAME_TAG_SIZE.w, NAME_TAG_SIZE.h, 1);
    return s;
  });
  if (name) sfx.grab();
  if (ragdolls.carrying === body) $('carry-hint').textContent = `Carrying ${name || 'a body'} \u2014 release left click to drop`;
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
  state.mouse.fill(false);
  player.keys.clear();
  $('flash').style.opacity = 0;
}

/** After death: same world, fresh run. */
function restart() {
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

/** From the pause menu: throw the world away and generate a new one, then wait for a click to play. */
function newGame() {
  state.mode = 'loading';
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
      showStartOverlay('pick');
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
    if (state.gameMode === 'wave' && state.waveRemaining === 0 && enemies.length === 0) {
      if (state.intermission <= 0) {
        state.intermission = INTERMISSION_SECONDS;
        showWaveBanner(`WAVE ${state.wave} CLEARED`);
      } else {
        state.intermission -= dt;
        if (state.intermission <= 0) startWave(state.wave + 1);
      }
    }

    player.update(dt);

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

    // Mouse actions (hold to repeat). Holding left while carrying a body keeps carrying it.
    state.swingCooldown -= dt;
    state.placeCooldown -= dt;
    if (state.mouse[0] && state.swingCooldown <= 0 && !ragdolls.carrying) {
      swing();
      state.swingCooldown = 0.28;
    }
    if (state.mouse[2] && state.placeCooldown <= 0) {
      place();
      state.placeCooldown = 0.22;
    }
    state.throwCooldown -= dt;

    // Tomatoes in flight (bursts may kill minifigs or the player)
    tomatoes.update(dt, tomatoCtx);

    // Ragdoll bodies: the carried one hangs from a point in front of the eye.
    player.eyePos(_hand);
    player.lookDir(_dir);
    _hand.addScaledVector(_dir, CARRY_DISTANCE);
    _hand.y -= 0.25;
    ragdolls.update(dt, player, _hand);
    if (!ragdolls.carrying) $('carry-hint').style.opacity = 0;

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
