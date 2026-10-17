import * as THREE from 'three';
import { GRAVITY, moveWithCollision, inWater, applyBuoyancy, boxCollides } from './physics.js';
import { pathBetween } from './pathfind.js';

const SKIN = 0xf2cd37;
const BLACK = 0x05131d;

export const ENEMY_TYPES = {
  brute: { name: 'Brute', torso: 0xc91a09, legs: BLACK, hat: 0xc91a09, speed: 3.3, hp: 40, dmg: 10, scale: 1.0, score: 10, weight: 5 },
  scout: { name: 'Scout', torso: BLACK, legs: 0x0055bf, hat: null, speed: 5.4, hp: 20, dmg: 6, scale: 0.85, score: 15, weight: 3 },
  titan: { name: 'Titan', torso: 0x0055bf, legs: 0x237841, hat: 0x9ba19d, speed: 2.5, hp: 110, dmg: 18, scale: 1.45, score: 40, weight: 1 },
  // Kamikaze: never swings. Stand next to it for FUSE_SECONDS and it detonates,
  // hurting you, blasting nearby minifigs and blowing a crater in the terrain.
  bomber: { name: 'Bomber', torso: 0x237841, legs: BLACK, hat: null, speed: 3.6, hp: 30, dmg: 45, scale: 1.0, score: 25, weight: 2, bomber: true },
  // Enderman-like: towering, thin, glowing eyes. Blinks a few blocks away when
  // struck. Dies in one piece and ragdolls instead of bursting into bricks.
  stalker: { name: 'Stalker', torso: 0x1a1024, legs: 0x120a1a, hat: null, speed: 4.4, hp: 70, dmg: 14, scale: 1.55, h: 2.24, score: 35, weight: 2, stalker: true, ragdoll: true },
};

/** Unscaled figure height; most minifigs share one body, the Stalker is lankier. */
const BASE_HEIGHT = 1.85;
/** World-space height of a type (used for spawning without constructing an Enemy). */
export function typeHeight(t) {
  return (t.h ?? BASE_HEIGHT) * t.scale;
}
const EYE_GLOW = 0xcc22ff;
/** Stalker: chance a surviving hit makes it blink away, and how far it lands from the player. */
export const BLINK_CHANCE = 0.6;
export const BLINK_MIN = 4;
export const BLINK_MAX = 8;

/** Enemies ignore the player until they come within this many blocks. */
export const AGGRO_RADIUS = 12;
/** A chasing enemy gives up once the player is farther than this (hysteresis). */
export const LOSE_INTEREST_RADIUS = 22;
/** Bomber: how long the player must stay within FUSE_RADIUS before it blows. */
export const FUSE_SECONDS = 3;
/** Bomber: distance (blocks) at which the fuse burns. Leaving lets it cool down. */
export const FUSE_RADIUS = 2.6;
/** Bomber: damage radius for player/enemies, and the crater radius in blocks. */
export const BLAST_RADIUS = 4.5;
export const BLAST_BLOCK_RADIUS = 2.3;

// ---- Name tags ----------------------------------------------------------------
/** World size of a floating name tag. */
const TAG_W = 1.5;
const TAG_H = 0.4;
const tagMaterials = new Map(); // name -> SpriteMaterial (one canvas texture per type)

/**
 * Camera-facing sprite with `name` on a dark pill. Returns null where there is no canvas
 * (headless tests), so the figure works without it. Textures are cached per name+style
 * unless `cache` is false (one-off names: dispose the sprite's material yourself).
 */
export function makeNameTag(name, { color = '#f2cd37', pill = 'rgba(5, 19, 29, 0.72)', cache = true } = {}) {
  if (typeof document === 'undefined') return null;
  const cacheKey = `${color}|${pill}|${name}`;
  let mat = cache ? tagMaterials.get(cacheKey) : null;
  if (!mat) {
    const w = 256;
    const h = 68;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.font = '800 38px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Shrink long names to fit the pill.
    let size = 38;
    while (size > 18 && ctx.measureText(name).width > w - 44) {
      size -= 2;
      ctx.font = `800 ${size}px "Avenir Next", "Helvetica Neue", Arial, sans-serif`;
    }
    const tw = Math.min(w - 8, ctx.measureText(name).width + 36);
    // Pill
    ctx.fillStyle = pill;
    ctx.beginPath();
    ctx.roundRect((w - tw) / 2, 6, tw, h - 12, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Text with outline
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#05131d';
    ctx.strokeText(name, w / 2, h / 2 + 1);
    ctx.fillStyle = color;
    ctx.fillText(name, w / 2, h / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
    if (cache) tagMaterials.set(cacheKey, mat);
  }
  const s = new THREE.Sprite(mat);
  s.renderOrder = 1; // drawn after the opaque figure so the pill's alpha blends over it
  return s;
}
/** World size of a name tag, for sprites placed outside a scaled figure group. */
export const NAME_TAG_SIZE = { w: TAG_W, h: TAG_H };

// ---- Spawning ------------------------------------------------------------------
/** Spawn ring around the player, in blocks. */
export const SPAWN_MIN_R = 18;
export const SPAWN_MAX_R = 32;
/** A new minifig keeps at least this far from every other one (relaxed to half if the ring is crowded). */
export const SPAWN_SPACING = 9;
/** Successive spawns step round the player by the golden angle, so they never bunch up on one side. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Pick a spawn spot on natural ground, SPAWN_MIN_R..SPAWN_MAX_R from `origin`, away from
 * every minifig in `others`. `cursor.angle` is advanced each call so consecutive spawns
 * fan out around the player instead of clustering.
 * @returns {{x:number, z:number, y:number, typeKey:string}|null} y = ground block
 */
export function findSpawnSpot(world, origin, others, wave, cursor, rng = Math.random) {
  for (let attempt = 0; attempt < 24; attempt++) {
    cursor.angle += GOLDEN_ANGLE + (rng() - 0.5) * 0.5;
    const r = SPAWN_MIN_R + rng() * (SPAWN_MAX_R - SPAWN_MIN_R);
    const gx = origin.x + Math.cos(cursor.angle) * r;
    const gz = origin.z + Math.sin(cursor.angle) * r;
    if (gx < 2 || gz < 2 || gx > world.sx - 2 || gz > world.sz - 2) continue;
    const g = world.findGround(gx, gz, 3);
    if (!g) continue;
    const x = g.x + 0.5;
    const z = g.z + 0.5;
    const spacing = attempt < 16 ? SPAWN_SPACING : SPAWN_SPACING * 0.5;
    let crowded = false;
    for (const o of others) {
      if (Math.hypot(o.pos.x - x, o.pos.z - z) < spacing) { crowded = true; break; }
    }
    if (crowded) continue;
    const typeKey = pickType(wave);
    const t = ENEMY_TYPES[typeKey];
    if (boxCollides(world, x, g.y + 1.01, z, 0.32 * t.scale, typeHeight(t))) continue;
    return { x, z, y: g.y, typeKey };
  }
  return null;
}

export function pickType(wave = 1) {
  const entries = Object.entries(ENEMY_TYPES);
  // Titans (and scouts, bombers) become more common in later waves.
  const weights = entries.map(([k, t]) =>
    k === 'titan' ? t.weight + (wave - 1) * 0.6
      : k === 'scout' || k === 'bomber' || k === 'stalker' ? t.weight + (wave - 1) * 0.3
      : t.weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    r -= weights[i];
    if (r <= 0) return entries[i][0];
  }
  return 'brute';
}

/** Stat multipliers for a wave: tougher, harder-hitting, a little faster each wave. */
export function waveMods(wave) {
  const w = Math.max(0, wave - 1);
  return { hp: 1 + 0.15 * w, dmg: 1 + 0.1 * w, speed: Math.min(1.5, 1 + 0.04 * w) };
}

// Shared geometries
const G = {
  leg: new THREE.BoxGeometry(0.28, 0.55, 0.32),
  hip: new THREE.BoxGeometry(0.62, 0.14, 0.32),
  torso: new THREE.BoxGeometry(0.62, 0.6, 0.36),
  arm: new THREE.BoxGeometry(0.2, 0.5, 0.2),
  hand: new THREE.BoxGeometry(0.17, 0.14, 0.17),
  neck: new THREE.CylinderGeometry(0.14, 0.14, 0.08, 12),
  head: new THREE.CylinderGeometry(0.3, 0.3, 0.42, 16),
  stud: new THREE.CylinderGeometry(0.14, 0.14, 0.1, 12),
  eye: new THREE.BoxGeometry(0.08, 0.08, 0.04),
  brow: new THREE.BoxGeometry(0.14, 0.035, 0.04),
  mouth: new THREE.BoxGeometry(0.22, 0.04, 0.04),
  hat: new THREE.CylinderGeometry(0.34, 0.34, 0.14, 16),
  hatTop: new THREE.CylinderGeometry(0.26, 0.3, 0.2, 16),
  fuse: new THREE.CylinderGeometry(0.045, 0.045, 0.34, 8),
  fuseTip: new THREE.SphereGeometry(0.09, 8, 6),
  // Stalker: long thin limbs, narrow torso, cubic head with slit eyes.
  sLeg: new THREE.BoxGeometry(0.16, 0.95, 0.18),
  sHip: new THREE.BoxGeometry(0.44, 0.1, 0.22),
  sTorso: new THREE.BoxGeometry(0.44, 0.7, 0.26),
  sArm: new THREE.BoxGeometry(0.13, 0.9, 0.13),
  sHand: new THREE.BoxGeometry(0.15, 0.12, 0.15),
  sNeck: new THREE.BoxGeometry(0.12, 0.08, 0.12),
  sHead: new THREE.BoxGeometry(0.4, 0.4, 0.4),
  sEye: new THREE.BoxGeometry(0.13, 0.05, 0.03),
};

function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

export class Enemy {
  constructor(typeKey, x, y, z, wave = 1) {
    const t = ENEMY_TYPES[typeKey];
    const m = waveMods(wave);
    this.typeKey = typeKey;
    this.type = t;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.hp = Math.round(t.hp * m.hp);
    this.maxHp = this.hp;
    this.dmg = Math.round(t.dmg * m.dmg);
    this.speed = t.speed * m.speed;
    this.halfW = 0.32 * t.scale;
    this.height = typeHeight(t);
    this.onGround = false;
    this.state = 'wander';
    this.wanderTimer = 0;
    this.wanderDir = new THREE.Vector3();
    this.stuckTimer = 0;
    this.jumpCooldown = 0;
    this.detourTimer = 0;
    this.detourDir = new THREE.Vector3();
    this.detourSide = 1;
    this.detourStreak = 0;
    this.freeTimer = 0;
    this.path = null;
    this.pathIdx = 0;
    this.repathTimer = Math.random() * 0.5; // stagger replans across enemies
    this.attackCooldown = 0;
    this.windup = -1; // >=0 while swinging
    this.flash = 0;
    this.walkPhase = 0;
    this.facing = Math.random() * Math.PI * 2;
    this.dead = false;
    this.fuse = 0; // bomber: seconds the player has been within FUSE_RADIUS
    this.blinkOn = false;
    this.blinkPending = false; // stalker: teleport on the next update

    this.mats = {
      skin: new THREE.MeshLambertMaterial({ color: SKIN }),
      torso: new THREE.MeshLambertMaterial({ color: t.torso }),
      legs: new THREE.MeshLambertMaterial({ color: t.legs }),
      black: new THREE.MeshLambertMaterial({ color: BLACK }),
      hat: t.hat != null ? new THREE.MeshLambertMaterial({ color: t.hat }) : null,
      fuseTip: t.bomber ? new THREE.MeshLambertMaterial({ color: 0xff8800, emissive: 0xff5500 }) : null,
      eyes: t.stalker ? new THREE.MeshLambertMaterial({ color: 0xff66ff, emissive: EYE_GLOW }) : null,
    };
    this.group = t.stalker ? this.buildStalker() : this.build();
    this.group.scale.setScalar(t.scale);
    this.group.position.copy(this.pos);
    this.tag = makeNameTag(t.name);
    if (this.tag) {
      // Floats just above the head; counter-scaled so every type's tag is the same world size.
      this.tag.position.y = this.height / t.scale + 0.45 / t.scale;
      this.tag.scale.set(TAG_W / t.scale, TAG_H / t.scale, 1);
      this.group.add(this.tag);
    }
  }

  /** Detach the floating name tag (death). */
  removeTag() {
    if (this.tag) {
      this.group.remove(this.tag);
      this.tag = null;
    }
  }

  /** Lanky Enderman-like figure. Same limb/head fields as build() so animation and ragdoll work unchanged. */
  buildStalker() {
    const g = new THREE.Group();
    const M = this.mats;

    this.legL = new THREE.Group();
    this.legL.position.set(-0.13, 0.95, 0);
    this.legL.add(mesh(G.sLeg, M.legs, 0, -0.475, 0));
    this.legR = new THREE.Group();
    this.legR.position.set(0.13, 0.95, 0);
    this.legR.add(mesh(G.sLeg, M.legs, 0, -0.475, 0));
    g.add(this.legL, this.legR);

    this.waist = 0.95;
    this.upper = new THREE.Group();
    this.upper.position.set(0, this.waist, 0);
    g.add(this.upper);
    const u = this.upper;
    const uy = (y) => y - this.waist;

    u.add(mesh(G.sHip, M.legs, 0, uy(1.0), 0));
    u.add(mesh(G.sTorso, M.torso, 0, uy(1.4), 0));

    this.armL = new THREE.Group();
    this.armL.position.set(-0.29, uy(1.72), 0);
    this.armL.rotation.z = 0.08;
    this.armL.add(mesh(G.sArm, M.torso, 0, -0.45, 0));
    this.armL.add(mesh(G.sHand, M.legs, 0, -0.95, 0));
    this.armR = new THREE.Group();
    this.armR.position.set(0.29, uy(1.72), 0);
    this.armR.rotation.z = -0.08;
    this.armR.add(mesh(G.sArm, M.torso, 0, -0.45, 0));
    this.armR.add(mesh(G.sHand, M.legs, 0, -0.95, 0));
    u.add(this.armL, this.armR);

    this.head = new THREE.Group();
    this.head.position.set(0, uy(1.75), 0);
    this.head.add(mesh(G.sNeck, M.legs, 0, 0.04, 0));
    this.head.add(mesh(G.sHead, M.torso, 0, 0.28, 0));
    // Glowing slit eyes on +Z
    this.head.add(mesh(G.sEye, M.eyes, -0.1, 0.32, 0.205));
    this.head.add(mesh(G.sEye, M.eyes, 0.1, 0.32, 0.205));
    u.add(this.head);
    return g;
  }

  build() {
    const g = new THREE.Group();
    const M = this.mats;

    // Legs (pivot at hip)
    this.legL = new THREE.Group();
    this.legL.position.set(-0.16, 0.55, 0);
    this.legL.add(mesh(G.leg, M.legs, 0, -0.275, 0));
    this.legR = new THREE.Group();
    this.legR.position.set(0.16, 0.55, 0);
    this.legR.add(mesh(G.leg, M.legs, 0, -0.275, 0));
    g.add(this.legL, this.legR);

    // Everything above the legs hangs off a waist hinge so a ragdoll can fold over.
    this.waist = 0.62;
    this.upper = new THREE.Group();
    this.upper.position.set(0, this.waist, 0);
    g.add(this.upper);
    const u = this.upper;
    const uy = (y) => y - this.waist;

    u.add(mesh(G.hip, M.legs, 0, uy(0.62), 0));
    u.add(mesh(G.torso, M.torso, 0, uy(0.99), 0));

    // Arms (pivot at shoulder)
    this.armL = new THREE.Group();
    this.armL.position.set(-0.41, uy(1.24), 0);
    this.armL.rotation.z = 0.12;
    this.armL.add(mesh(G.arm, M.torso, 0, -0.25, 0));
    this.armL.add(mesh(G.hand, M.skin, 0, -0.55, 0));
    this.armR = new THREE.Group();
    this.armR.position.set(0.41, uy(1.24), 0);
    this.armR.rotation.z = -0.12;
    this.armR.add(mesh(G.arm, M.torso, 0, -0.25, 0));
    this.armR.add(mesh(G.hand, M.skin, 0, -0.55, 0));
    u.add(this.armL, this.armR);

    // Head
    this.head = new THREE.Group();
    this.head.position.set(0, uy(1.29), 0);
    this.head.add(mesh(G.neck, M.skin, 0, 0.04, 0));
    this.head.add(mesh(G.head, M.skin, 0, 0.29, 0));
    if (M.hat) {
      this.head.add(mesh(G.hat, M.hat, 0, 0.52, 0));
      this.head.add(mesh(G.hatTop, M.hat, 0, 0.66, 0));
    } else if (this.type.bomber) {
      // A lit fuse sticking out of the head stud.
      this.head.add(mesh(G.stud, M.skin, 0, 0.55, 0));
      const fuse = mesh(G.fuse, M.black, 0.04, 0.76, 0);
      fuse.rotation.z = -0.25;
      this.head.add(fuse);
      this.fuseTip = mesh(G.fuseTip, M.fuseTip, 0.08, 0.93, 0);
      this.head.add(this.fuseTip);
    } else {
      this.head.add(mesh(G.stud, M.skin, 0, 0.55, 0));
    }
    // Angry face on +Z
    const fz = 0.29;
    this.head.add(mesh(G.eye, M.black, -0.11, 0.33, fz));
    this.head.add(mesh(G.eye, M.black, 0.11, 0.33, fz));
    const browL = mesh(G.brow, M.black, -0.11, 0.41, fz);
    browL.rotation.z = -0.5;
    const browR = mesh(G.brow, M.black, 0.11, 0.41, fz);
    browR.rotation.z = 0.5;
    this.head.add(browL, browR);
    const mouth = mesh(G.mouth, M.black, 0, 0.18, fz);
    this.head.add(mouth);
    u.add(this.head);

    return g;
  }

  get center() {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
  }

  /**
   * True if moving along (dx,dz) runs into something taller than one block
   * (a one-block step is handled by the auto-jump).
   */
  blockedAhead(world, dx, dz) {
    const px = Math.floor(this.pos.x + dx * (this.halfW + 0.5));
    const pz = Math.floor(this.pos.z + dz * (this.halfW + 0.5));
    const y = Math.floor(this.pos.y + 0.1);
    // A one-block step is fine if there's headroom above it; otherwise we need
    // the full body height clear at the current level.
    const base = world.isSolid(px, y, pz) ? y + 1 : y;
    const cells = Math.ceil(this.height);
    for (let i = 0; i < cells; i++) if (world.isSolid(px, base + i, pz)) return true;
    return false;
  }

  /**
   * Choose a detour direction around an obstacle: try sideways on the preferred side,
   * then the other side, then back-diagonals, finally straight back. First clear one wins.
   */
  pickDetour(world, cx, cz) {
    const s = this.detourSide;
    const angles = [90 * s, -90 * s, 135 * s, -135 * s, 180];
    for (const deg of angles) {
      const a = (deg * Math.PI) / 180;
      const dx = cx * Math.cos(a) - cz * Math.sin(a);
      const dz = cx * Math.sin(a) + cz * Math.cos(a);
      this.detourDir.set(dx, 0, dz);
      if (!this.blockedAhead(world, dx, dz)) return;
    }
  }

  /** Returns true if this hit killed the enemy. */
  hit(dmg, kx, kz) {
    this.hp -= dmg;
    this.flash = 0.15;
    const len = Math.hypot(kx, kz) || 1;
    this.vel.x += (kx / len) * 7;
    this.vel.z += (kz / len) * 7;
    this.vel.y = Math.max(this.vel.y, 5);
    this.state = 'chase';
    const killed = this.hp <= 0;
    if (!killed && this.type.stalker && Math.random() < BLINK_CHANCE) this.blinkPending = true;
    return killed;
  }

  /**
   * Stalker: teleport to clear ground BLINK_MIN..BLINK_MAX blocks from the player.
   * Returns the position it left from, or null if no spot was found.
   */
  blink(world, player) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
      const g = world.findGround(player.pos.x + Math.cos(a) * r, player.pos.z + Math.sin(a) * r, 2);
      if (!g) continue;
      const x = g.x + 0.5;
      const y = g.y + 1.01;
      const z = g.z + 0.5;
      if (boxCollides(world, x, y, z, this.halfW, this.height)) continue;
      const from = this.pos.clone();
      this.pos.set(x, y, z);
      this.vel.set(0, 0, 0);
      this.path = null;
      this.repathTimer = 0;
      this.facing = Math.atan2(player.pos.x - x, player.pos.z - z);
      this.group.rotation.y = this.facing;
      this.group.position.copy(this.pos);
      return from;
    }
    return null;
  }

  /**
   * @param {number} dt
   * @param {import('./player.js').Player} player
   * @param {object} ctx {world, enemies, onAttack(enemy), onDetonate?(enemy), onTick?(enemy)}
   */
  update(dt, player, ctx) {
    const { world } = ctx;
    const t = this.type;

    if (this.blinkPending) {
      this.blinkPending = false;
      const from = this.blink(world, player);
      if (from) ctx.onBlink?.(this, from);
    }

    const dx = player.pos.x - this.pos.x;
    const dz = player.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = Math.abs(player.pos.y - this.pos.y);
    // Bombers close to fuse range and then just stand there ticking.
    const reach = t.bomber ? FUSE_RADIUS * 0.75 : 1.1 * t.scale + player.halfW + 0.3;

    let wishX = 0;
    let wishZ = 0;

    if (this.attackCooldown > 0) this.attackCooldown -= dt;

    // Bomber fuse: burns while the player stands within FUSE_RADIUS, cools at
    // half speed once they step away, detonates after FUSE_SECONDS of exposure.
    if (t.bomber) {
      if (dist <= FUSE_RADIUS && dy < 2.5) this.fuse += dt;
      else this.fuse = Math.max(0, this.fuse - dt * 0.5);
      if (this.fuse >= FUSE_SECONDS) {
        this.fuse = FUSE_SECONDS;
        ctx.onDetonate?.(this);
        return;
      }
    }

    if (dist <= reach && dy < 2.2) {
      this.state = 'attack';
    } else if (dist < AGGRO_RADIUS) {
      // Player wandered close enough: start chasing.
      this.state = 'chase';
    } else if (this.state === 'chase' && dist > LOSE_INTEREST_RADIUS) {
      // Player got away: give up and go back to wandering.
      this.state = 'wander';
      this.wanderTimer = 0;
    } else if (this.state === 'attack') {
      this.state = 'chase';
    }

    if (this.state === 'attack') {
      this.facing = Math.atan2(dx, dz);
      if (!t.bomber && this.windup < 0 && this.attackCooldown <= 0) {
        this.windup = 0;
      }
    } else if (this.state === 'chase') {
      const inv = 1 / (dist || 1);
      let cx = dx * inv;
      let cz = dz * inv;

      // Replan a path periodically (or when the old one is used up).
      this.repathTimer -= dt;
      if (this.repathTimer <= 0 || (this.path && this.pathIdx >= this.path.length)) {
        this.repathTimer = 0.5 + Math.random() * 0.3;
        if (dist > 1.5) {
          this.path = pathBetween(world, this.pos, player.pos, Math.ceil(this.height), 1200);
          this.pathIdx = 0;
        } else {
          this.path = null;
        }
      }
      if (this.path && this.pathIdx < this.path.length) {
        // Advance past waypoints we've reached, then steer at the current one.
        let wp = this.path[this.pathIdx];
        while (wp && Math.hypot(wp.x + 0.5 - this.pos.x, wp.z + 0.5 - this.pos.z) < 0.35 && Math.abs(wp.y - this.pos.y) < 1.2) {
          wp = this.path[++this.pathIdx];
        }
        if (wp) {
          const wx = wp.x + 0.5 - this.pos.x;
          const wz = wp.z + 0.5 - this.pos.z;
          const wl = Math.hypot(wx, wz) || 1;
          cx = wx / wl;
          cz = wz / wl;
        }
      } else {
        // No path: reactive steering. Look ahead for walls taller than one block and
        // sidestep along them until the straight line is clear again.
        const blocked = this.blockedAhead(world, cx, cz);
        if (blocked) {
          if (this.detourTimer <= 0 || this.blockedAhead(world, this.detourDir.x, this.detourDir.z)) {
            if (this.detourStreak === 0) this.detourSide = Math.random() < 0.5 ? 1 : -1;
            this.detourStreak = Math.min(this.detourStreak + 1, 5);
            this.pickDetour(world, cx, cz);
          }
          this.detourTimer = Math.max(this.detourTimer, 0.7);
          this.freeTimer = 0;
        }
        if (this.detourTimer > 0) {
          if (!blocked) this.detourTimer -= dt;
          cx = this.detourDir.x;
          cz = this.detourDir.z;
        }
      }
      wishX = cx * this.speed;
      wishZ = cz * this.speed;
      this.facing = Math.atan2(wishX, wishZ);
    } else {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 1.5 + Math.random() * 3;
        if (Math.random() < 0.35) this.wanderDir.set(0, 0, 0);
        else {
          const a = Math.random() * Math.PI * 2;
          this.wanderDir.set(Math.sin(a), 0, Math.cos(a));
        }
      }
      wishX = this.wanderDir.x * this.speed * 0.4;
      wishZ = this.wanderDir.z * this.speed * 0.4;
      if (this.wanderDir.lengthSq() > 0) this.facing = Math.atan2(this.wanderDir.x, this.wanderDir.z);
    }

    // Swing / hit resolution
    if (this.windup >= 0) {
      this.windup += dt;
      if (this.windup >= 0.35) {
        this.windup = -1;
        this.attackCooldown = 1.1;
        if (dist <= reach + 0.3 && Math.abs(player.pos.y - this.pos.y) < 2.2) {
          ctx.onAttack(this);
        }
      }
    }

    // Separation from other enemies
    for (const o of ctx.enemies) {
      if (o === this || o.dead) continue;
      const ox = this.pos.x - o.pos.x;
      const oz = this.pos.z - o.pos.z;
      const d = Math.hypot(ox, oz);
      const minD = this.halfW + o.halfW + 0.1;
      if (d < minD && d > 1e-4) {
        const push = (minD - d) * 4;
        wishX += (ox / d) * push;
        wishZ += (oz / d) * push;
      }
    }

    // Steering
    const swimming = inWater(world, this.pos);
    if (swimming) {
      wishX *= 0.5;
      wishZ *= 0.5;
    }
    const accel = this.onGround || swimming ? 12 : 3;
    const k = Math.min(1, accel * dt);
    this.vel.x += (wishX - this.vel.x) * k;
    this.vel.z += (wishZ - this.vel.z) * k;
    this.vel.y -= GRAVITY * dt;
    if (swimming) applyBuoyancy(this.vel, dt, false);

    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    const res = moveWithCollision(world, this.pos, this.vel, dt, this.halfW, this.height);
    this.onGround = res.onGround;

    // Auto-jump when blocked while trying to move
    const wantMove = Math.hypot(wishX, wishZ) > 0.5;
    const moved = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ);
    if (wantMove && moved < Math.hypot(wishX, wishZ) * dt * 0.25) {
      this.stuckTimer += dt;
      if (res.hitWall && (this.onGround || swimming) && this.jumpCooldown <= 0) {
        this.vel.y = 8.5;
        this.onGround = false;
        this.jumpCooldown = 0.6;
      }
      if (this.stuckTimer > 1.2) {
        // Still jammed (path or look-ahead missed it): drop the path, swap sides and
        // pick any clear direction until the next replan.
        this.path = null;
        this.repathTimer = Math.max(this.repathTimer, 1.0);
        this.detourSide = -this.detourSide;
        this.detourStreak = Math.min(this.detourStreak + 1, 5);
        const len = Math.hypot(wishX, wishZ) || 1;
        this.pickDetour(world, wishX / len, wishZ / len);
        this.detourTimer = 0.8 + this.detourStreak * 0.6;
        this.stuckTimer = 0;
        this.freeTimer = 0;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
      // Moving freely for a while: forget the obstacle.
      this.freeTimer += dt;
      if (this.freeTimer > 2.5) this.detourStreak = 0;
    }
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;

    // Visuals
    this.group.position.copy(this.pos);
    let da = this.facing - this.group.rotation.y;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.group.rotation.y += da * Math.min(1, 10 * dt);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (2 + hs * 2.2);
    const amp = Math.min(0.8, hs * 0.25);
    const swing = Math.sin(this.walkPhase) * amp;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    if (this.windup >= 0) {
      // Raise arm then strike
      const p = this.windup / 0.35;
      this.armR.rotation.x = p < 0.6 ? -2.4 * (p / 0.6) : -2.4 + (p - 0.6) / 0.4 * 3.2;
    } else {
      this.armR.rotation.x = swing * 0.8;
    }
    // Lean towards player when chasing
    this.group.rotation.x = this.state === 'chase' ? Math.min(0.12, hs * 0.03) : 0;

    if (this.flash > 0) {
      this.flash -= dt;
      const on = this.flash > 0;
      for (const m of Object.values(this.mats)) {
        if (m) m.emissive.setHex(on ? 0xff3333 : 0x000000);
      }
      if (this.mats.fuseTip) this.mats.fuseTip.emissive.setHex(0xff5500);
      if (this.mats.eyes) this.mats.eyes.emissive.setHex(EYE_GLOW);
    }

    // Fuse feedback: blink faster and swell as detonation approaches.
    if (t.bomber) {
      const f = this.fuse / FUSE_SECONDS;
      if (f > 0) {
        const rate = 3 + f * f * 14; // Hz
        const on = Math.floor(this.fuse * rate) % 2 === 0;
        if (on && !this.blinkOn) ctx.onTick?.(this);
        this.blinkOn = on;
        if (this.flash <= 0) {
          const hex = on ? 0xdddddd : 0x000000;
          this.mats.torso.emissive.setHex(hex);
          this.mats.legs.emissive.setHex(hex);
          this.mats.skin.emissive.setHex(on ? 0x666666 : 0);
        }
        this.group.scale.setScalar(t.scale * (1 + 0.22 * f * (on ? 1 : 0.6)));
      } else if (this.blinkOn || this.group.scale.x !== t.scale) {
        this.blinkOn = false;
        this.group.scale.setScalar(t.scale);
        if (this.flash <= 0) {
          this.mats.torso.emissive.setHex(0);
          this.mats.legs.emissive.setHex(0);
          this.mats.skin.emissive.setHex(0);
        }
      }
    }
  }

  /** Blow apart into bricks. Each part becomes world-space debris. */
  explode(debris) {
    this.dead = true;
    this.removeTag();
    const parts = [];
    this.group.updateMatrixWorld(true);
    this.group.traverse((o) => {
      if (o.isMesh) parts.push(o);
    });
    const c = this.center;
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    for (const p of parts) {
      p.getWorldPosition(wp);
      p.getWorldQuaternion(wq);
      p.getWorldScale(ws);
      p.parent.remove(p);
      p.position.copy(wp);
      p.quaternion.copy(wq);
      p.scale.copy(ws);
      const v = wp.clone().sub(c);
      v.y = Math.abs(v.y);
      v.normalize().multiplyScalar(3 + Math.random() * 3);
      v.y += 4 + Math.random() * 3;
      v.x += (Math.random() - 0.5) * 2;
      v.z += (Math.random() - 0.5) * 2;
      debris.launch(p, v, 1.8 + Math.random(), 9);
    }
    for (const m of Object.values(this.mats)) if (m) m.emissive.setHex(0);
  }

  /**
   * Die in one piece: hand the intact figure to the ragdoll system. Returns the
   * limb rig (nodes with slack rest poses) and the materials the body now owns.
   */
  toRagdoll() {
    this.dead = true;
    this.removeTag();
    for (const m of Object.values(this.mats)) if (m) m.emissive.setHex(0);
    if (this.mats.eyes) this.mats.eyes.emissive.setHex(0x2a0a33); // eyes go dark
    this.group.scale.setScalar(this.type.scale);
    this.group.rotation.x = 0;
    const r = (lo, hi) => (Math.random() < 0.5 ? -1 : 1) * (lo + Math.random() * (hi - lo));
    // kind: which part is held decides what dangles. axis: the direction the segment
    // extends from its pivot (-1 down the local Y, +1 up). parent: frame the limb rotates in.
    const limbs = [
      { node: this.legL, kind: 'leg', side: -1, axis: -1, parent: null, rest: { x: r(0.2, 0.9), z: r(0.05, 0.35) }, limit: 2.4 },
      { node: this.legR, kind: 'leg', side: 1, axis: -1, parent: null, rest: { x: r(0.2, 0.9), z: r(0.05, 0.35) }, limit: 2.4 },
      { node: this.upper, kind: 'upper', axis: 1, parent: null, rest: { x: r(0.0, 0.25), z: r(0.0, 0.15) }, limit: 1.4 },
      { node: this.armL, kind: 'arm', axis: -1, parent: this.upper, rest: { x: r(0.3, 1.4), z: r(0.3, 1.3) }, limit: 2.6 },
      { node: this.armR, kind: 'arm', axis: -1, parent: this.upper, rest: { x: r(0.3, 1.4), z: r(0.3, 1.3) }, limit: 2.6 },
      { node: this.head, kind: 'head', axis: 1, parent: this.upper, rest: { x: r(0.1, 0.5), z: r(0.1, 0.5) }, limit: 0.7 },
    ];
    return { limbs, mats: this.mats, waist: this.waist };
  }

  dispose() {
    for (const m of Object.values(this.mats)) if (m) m.dispose();
  }
}
