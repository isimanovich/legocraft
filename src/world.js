import * as THREE from 'three';
import { fbm, hash2, hash3 } from './noise.js';

// ---- Block registry (LEGO palette) ----------------------------------------
export const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WOOD: 5,
  LEAVES: 6,
  RED: 7,
  BLUE: 8,
  YELLOW: 9,
  WHITE: 10,
  BEDROCK: 11,
  WATER: 12,
  ORANGE: 13,
  LIME: 14,
  PINK: 15,
  PURPLE: 16,
  BLACK: 17,
  DARKGREY: 18,
  AZURE: 19,
  DARKRED: 20,
  PLANKS: 21,
  GOLD: 22,
};

/** Columns at or below this height are flooded. */
export const SEA = 11;

export const BLOCK_INFO = {
  [BLOCK.GRASS]: { name: 'Grass brick', color: 0x237841, top: 0x2e9a4f },
  [BLOCK.DIRT]: { name: 'Brown brick', color: 0x583927 },
  [BLOCK.STONE]: { name: 'Grey brick', color: 0x9ba19d },
  [BLOCK.SAND]: { name: 'Tan brick', color: 0xe4cd9e },
  [BLOCK.WOOD]: { name: 'Wood brick', color: 0x6c4a2e },
  [BLOCK.LEAVES]: { name: 'Leaf brick', color: 0x4b9f4a },
  [BLOCK.RED]: { name: 'Red brick', color: 0xc91a09 },
  [BLOCK.BLUE]: { name: 'Blue brick', color: 0x0055bf },
  [BLOCK.YELLOW]: { name: 'Yellow brick', color: 0xf2cd37 },
  [BLOCK.WHITE]: { name: 'White brick', color: 0xf4f4f4 },
  [BLOCK.BEDROCK]: { name: 'Baseplate', color: 0x1b2a34 },
  [BLOCK.WATER]: { name: 'Water plate', color: 0x078bc9, top: 0x2cb3ec, noStud: true },
  [BLOCK.ORANGE]: { name: 'Orange brick', color: 0xfe8a18 },
  [BLOCK.LIME]: { name: 'Lime brick', color: 0xbbe90b },
  [BLOCK.PINK]: { name: 'Pink brick', color: 0xfc97ac },
  [BLOCK.PURPLE]: { name: 'Purple brick', color: 0x81007b },
  [BLOCK.BLACK]: { name: 'Black brick', color: 0x1b1b1b },
  [BLOCK.DARKGREY]: { name: 'Dark grey brick', color: 0x6c6e68 },
  [BLOCK.AZURE]: { name: 'Azure brick', color: 0x36aebf },
  [BLOCK.DARKRED]: { name: 'Dark red brick', color: 0x720e0f },
  [BLOCK.PLANKS]: { name: 'Plank', color: 0xb67c4a, top: 0xc98d57, noStud: true },
  [BLOCK.GOLD]: { name: 'Gold brick', color: 0xdbac34, top: 0xe8c04a },
};

/** Every brick you can place (inventory order). The hotbar holds a subset of these plus tools. */
export const PLACEABLE = [
  BLOCK.RED, BLOCK.BLUE, BLOCK.YELLOW, BLOCK.WHITE, BLOCK.GRASS, BLOCK.LIME, BLOCK.LEAVES,
  BLOCK.ORANGE, BLOCK.PINK, BLOCK.PURPLE, BLOCK.AZURE, BLOCK.DARKRED, BLOCK.GOLD,
  BLOCK.BLACK, BLOCK.DARKGREY, BLOCK.STONE, BLOCK.SAND, BLOCK.DIRT, BLOCK.WOOD, BLOCK.PLANKS,
];
/** Default hotbar: a sword, then a spread of bricks. */
export const DEFAULT_HOTBAR = ['sword', BLOCK.RED, BLOCK.BLUE, BLOCK.YELLOW, BLOCK.WHITE, BLOCK.STONE, BLOCK.WOOD, BLOCK.GRASS, BLOCK.LEAVES];

// ---- Geometry helpers --------------------------------------------------------
// Each face: outward normal, 4 CCW corners (viewed from outside), shade factor.
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.80 },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.80 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.00 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.50 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.70 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.70 },
];

const STUD_SEGMENTS = 8;
const STUD_RADIUS = 0.24;
const STUD_HEIGHT = 0.17;
const STUD_RING = [];
for (let i = 0; i < STUD_SEGMENTS; i++) {
  const a = (i / STUD_SEGMENTS) * Math.PI * 2;
  STUD_RING.push([Math.cos(a) * STUD_RADIUS, Math.sin(a) * STUD_RADIUS]);
}

const tmpColor = new THREE.Color();

// ---- World ----------------------------------------------------------------------
export class World {
  constructor(scene, { sizeX = 96, sizeZ = 96, sizeY = 48, chunk = 16, seed = 1337, studs = true } = {}) {
    this.scene = scene;
    this.sx = sizeX;
    this.sz = sizeZ;
    this.sy = sizeY;
    this.chunk = chunk;
    this.seed = seed;
    this.studs = studs;
    this.data = new Uint8Array(sizeX * sizeY * sizeZ);
    this.cx = Math.ceil(sizeX / chunk);
    this.cz = Math.ceil(sizeZ / chunk);
    this.meshes = new Array(this.cx * this.cz).fill(null);
    this.dirty = new Set();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  idx(x, y, z) {
    return (y * this.sz + z) * this.sx + x;
  }

  inBounds(x, y, z) {
    return x >= 0 && x < this.sx && y >= 0 && y < this.sy && z >= 0 && z < this.sz;
  }

  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return BLOCK.AIR;
    return this.data[this.idx(x, y, z)];
  }

  /** Solid for collision. Outside x/z bounds and below y=0 count as walls. Water is wadeable. */
  isSolid(x, y, z) {
    if (y >= this.sy) return false;
    if (x < 0 || x >= this.sx || z < 0 || z >= this.sz || y < 0) return true;
    const t = this.data[this.idx(x, y, z)];
    return t !== BLOCK.AIR && t !== BLOCK.WATER;
  }

  set(x, y, z, type) {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.idx(x, y, z);
    if (this.data[i] === type) return false;
    this.data[i] = type;
    this.markDirty(x, z);
    // Neighbouring chunks share faces on the border.
    const c = this.chunk;
    if (x % c === 0) this.markDirty(x - 1, z);
    if (x % c === c - 1) this.markDirty(x + 1, z);
    if (z % c === 0) this.markDirty(x, z - 1);
    if (z % c === c - 1) this.markDirty(x, z + 1);
    return true;
  }

  markDirty(x, z) {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return;
    this.dirty.add(Math.floor(z / this.chunk) * this.cx + Math.floor(x / this.chunk));
  }

  /** Highest solid block y at column (x,z), or -1. */
  heightAt(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || x >= this.sx || z < 0 || z >= this.sz) return -1;
    for (let y = this.sy - 1; y >= 0; y--) {
      if (this.data[this.idx(x, y, z)] !== BLOCK.AIR) return y;
    }
    return -1;
  }

  /**
   * Find a standable column near (x,z) whose top block is natural ground
   * (not a tree). Spirals outward up to `radius`. Returns {x,z,y} (y = top block) or null.
   */
  findGround(x, z, radius = 8) {
    x = Math.floor(x);
    z = Math.floor(z);
    for (let r = 0; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const px = x + dx;
          const pz = z + dz;
          const h = this.heightAt(px, pz);
          if (h < 0 || h >= this.sy - 4) continue;
          const t = this.get(px, h, pz);
          if (t !== BLOCK.GRASS && t !== BLOCK.SAND && t !== BLOCK.DIRT) continue;
          if (this.get(px, h + 1, pz) !== BLOCK.AIR || this.get(px, h + 2, pz) !== BLOCK.AIR) continue;
          return { x: px, z: pz, y: h };
        }
      }
    }
    return null;
  }

  // ---- Terrain generation ----
  generate() {
    const { sx, sz, sy, seed } = this;
    const heights = new Int16Array(sx * sz);
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const nx = x / 48;
        const nz = z / 48;
        // fbm clusters around 0.5; stretch it so ~15% of the map dips under SEA (lakes).
        const base = Math.max(0, Math.min(1, (fbm(nx, nz, seed, 4) - 0.5) * 2.2 + 0.5));
        const ridge = Math.pow(fbm(nx * 0.5 + 100, nz * 0.5 + 100, seed + 7, 3), 2.5);
        // Lows dip under SEA so lakes form in the valleys.
        let h = 5 + base * 13 + ridge * 22;
        // Soften edges so the border walls aren't cliffs.
        const edge = Math.min(x, z, sx - 1 - x, sz - 1 - z);
        if (edge < 4) h = Math.min(h, 13 + edge);
        h = Math.max(4, Math.min(sy - 8, Math.floor(h)));
        heights[z * sx + x] = h;
        const beach = h <= SEA + 1;
        for (let y = 0; y <= h; y++) {
          let t;
          if (y === 0) t = BLOCK.BEDROCK;
          else if (y === h) t = beach ? BLOCK.SAND : BLOCK.GRASS;
          else if (y >= h - 3) t = beach ? BLOCK.SAND : BLOCK.DIRT;
          else t = BLOCK.STONE;
          this.data[this.idx(x, y, z)] = t;
        }
        for (let y = h + 1; y <= SEA; y++) this.data[this.idx(x, y, z)] = BLOCK.WATER;
      }
    }
    this.placeTrees(heights);
    this.placeStructures(heights);
    for (let i = 0; i < this.meshes.length; i++) this.dirty.add(i);
  }

  /** Throw the current terrain away and generate a fresh world from `seed`. All chunks are re-meshed. */
  regenerate(seed = (Math.random() * 1e6) | 0) {
    this.seed = seed;
    this.data.fill(BLOCK.AIR);
    this.generate();
  }

  placeTrees(heights) {
    const { sx, sz, sy, seed } = this;
    for (let z = 3; z < sz - 3; z++) {
      for (let x = 3; x < sx - 3; x++) {
        const h = heights[z * sx + x];
        if (h <= SEA + 1 || h > sy - 12) continue;
        if (hash2(x, z, seed + 99) > 0.012) continue;
        const pine = hash2(x, z, seed + 6) < 0.35;
        const trunk = pine ? 6 + Math.floor(hash2(x, z, seed + 5) * 2) : 4 + Math.floor(hash2(x, z, seed + 5) * 2);
        for (let y = 1; y <= trunk; y++) this.data[this.idx(x, h + y, z)] = BLOCK.WOOD;
        const top = h + trunk;
        // [dy, radius] layers; pines stack alternating wide/narrow rings into a cone.
        const layers = pine
          ? [[-4, 2], [-3, 1], [-2, 2], [-1, 1], [0, 1], [1, 0]]
          : [[-2, 1], [-1, 2], [0, 2], [1, 2], [2, 1]];
        for (const [dy, r] of layers) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.abs(dx) === r && Math.abs(dz) === r && r === 2) continue;
              const px = x + dx;
              const py = top + dy;
              const pz = z + dz;
              if (!this.inBounds(px, py, pz)) continue;
              const i = this.idx(px, py, pz);
              if (this.data[i] === BLOCK.AIR) this.data[i] = BLOCK.LEAVES;
            }
          }
        }
      }
    }
  }

  // ---- Structures ----
  /** Inclusive box fill, bounds-checked. */
  fill(x0, y0, z0, x1, y1, z1, type) {
    for (let y = Math.max(0, y0); y <= Math.min(this.sy - 1, y1); y++) {
      for (let z = Math.max(0, z0); z <= Math.min(this.sz - 1, z1); z++) {
        for (let x = Math.max(0, x0); x <= Math.min(this.sx - 1, x1); x++) {
          this.data[this.idx(x, y, z)] = type;
        }
      }
    }
  }

  /** True if every block in the inclusive box is air. */
  isClear(x0, y0, z0, x1, y1, z1) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.get(x, y, z) !== BLOCK.AIR) return false;
        }
      }
    }
    return true;
  }

  /** Ground stats over a rect: null if off-map, flooded, or steeper than maxSlope. */
  siteInfo(heights, x0, z0, x1, z1, maxSlope) {
    if (x0 < 2 || z0 < 2 || x1 >= this.sx - 2 || z1 >= this.sz - 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const h = heights[z * this.sx + x];
        if (h <= SEA) return null;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (hi - lo > maxSlope || hi > this.sy - 16) return null;
    return { base: hi, lo };
  }

  /** Raise/lower columns in a rect to `base` and clear everything above (trees etc.). */
  flatten(heights, x0, z0, x1, z1, base, top = BLOCK.GRASS) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const h = heights[z * this.sx + x];
        for (let y = h + 1; y < base; y++) this.data[this.idx(x, y, z)] = BLOCK.DIRT;
        this.data[this.idx(x, base, z)] = top;
        for (let y = base + 1; y < this.sy; y++) this.data[this.idx(x, y, z)] = BLOCK.AIR;
        heights[z * this.sx + x] = base;
      }
    }
  }

  placeStructures(heights) {
    const { sx, sz, seed } = this;
    const taken = [];
    const free = (x0, z0, x1, z1, pad) => {
      for (const t of taken) {
        if (x0 - pad <= t.x1 && x1 + pad >= t.x0 && z0 - pad <= t.z1 && z1 + pad >= t.z0) return false;
      }
      return true;
    };
    const claim = (x0, z0, x1, z1) => taken.push({ x0, z0, x1, z1 });
    // Scale counts with map area (tuned for 144x144).
    const scale = (sx * sz) / (144 * 144);
    const run = (salt, tries, max, build) => {
      let placed = 0;
      for (let i = 0; i < Math.ceil(tries * scale) && placed < Math.ceil(max * scale); i++) {
        const x = 3 + Math.floor(hash2(i, 1, seed + salt) * (sx - 12));
        const z = 3 + Math.floor(hash2(i, 2, seed + salt) * (sz - 12));
        const r = hash2(i, 3, seed + salt);
        if (build(x, z, r)) placed++;
      }
    };

    const PALETTE = [BLOCK.RED, BLOCK.BLUE, BLOCK.YELLOW, BLOCK.WHITE];
    const pick = (r, exclude) => {
      const opts = PALETTE.filter((c) => c !== exclude);
      return opts[Math.floor(r * opts.length) % opts.length];
    };

    // Watchtowers first: tallest, most visible landmarks.
    run(11, 16, 3, (x, z) => {
      const x1 = x + 4;
      const z1 = z + 4;
      const site = this.siteInfo(heights, x - 1, z - 1, x1 + 1, z1 + 1, 3);
      if (!site || !free(x - 1, z - 1, x1 + 1, z1 + 1, 4)) return false;
      const b = site.base;
      this.flatten(heights, x - 1, z - 1, x1 + 1, z1 + 1, b);
      const H = 10;
      this.fill(x, b, z, x1, b, z1, BLOCK.STONE);
      this.fill(x, b + 1, z, x1, b + H, z1, BLOCK.STONE);
      this.fill(x + 1, b + 1, z + 1, x1 - 1, b + H, z1 - 1, BLOCK.AIR);
      // Doorway on -z side, arrow slits on the others.
      this.fill(x + 2, b + 1, z, x + 2, b + 2, z, BLOCK.AIR);
      this.fill(x, b + 5, z + 2, x, b + 5, z + 2, BLOCK.AIR);
      this.fill(x1, b + 7, z + 2, x1, b + 7, z + 2, BLOCK.AIR);
      this.fill(x + 2, b + 6, z1, x + 2, b + 6, z1, BLOCK.AIR);
      // Spiral stair around the inner 3x3 ring: one block up per cell.
      const ring = [[x + 1, z + 1], [x + 1, z + 2], [x + 1, z + 3], [x + 2, z + 3], [x + 3, z + 3], [x + 3, z + 2], [x + 3, z + 1], [x + 2, z + 1]];
      ring.forEach(([px, pz], i) => this.fill(px, b + 1 + i, pz, px, b + 1 + i, pz, BLOCK.STONE));
      // Top floor, leaving the last two stair cells open for headroom.
      for (let pz = z + 1; pz <= z1 - 1; pz++) {
        for (let px = x + 1; px <= x1 - 1; px++) {
          if ((px === x + 3 && pz === z + 1) || (px === x + 2 && pz === z + 1)) continue;
          this.fill(px, b + 9, pz, px, b + 9, pz, BLOCK.STONE);
        }
      }
      // Crenellations and a flag.
      for (let pz = z; pz <= z1; pz++) {
        for (let px = x; px <= x1; px++) {
          const edge = px === x || px === x1 || pz === z || pz === z1;
          if (edge && (px + pz) % 2 === 0) this.fill(px, b + H + 1, pz, px, b + H + 1, pz, BLOCK.STONE);
        }
      }
      this.fill(x, b + H + 2, z, x, b + H + 3, z, BLOCK.RED);
      claim(x - 1, z - 1, x1 + 1, z1 + 1);
      return true;
    });

    // Minifig houses: coloured walls, stepped roof, door and windows.
    run(22, 30, 7, (x, z, r) => {
      const w = 5 + 2 * Math.floor(hash2(x, z, seed + 1) * 2);
      const d = 5 + 2 * Math.floor(hash2(x, z, seed + 2) * 2);
      const x1 = x + w - 1;
      const z1 = z + d - 1;
      const site = this.siteInfo(heights, x - 1, z - 1, x1 + 1, z1 + 1, 2);
      if (!site || !free(x - 1, z - 1, x1 + 1, z1 + 1, 3)) return false;
      const b = site.base;
      this.flatten(heights, x - 1, z - 1, x1 + 1, z1 + 1, b);
      const wall = pick(r);
      const roof = pick(hash2(x, z, seed + 3), wall);
      const H = 3;
      this.fill(x, b, z, x1, b, z1, BLOCK.STONE);
      this.fill(x, b + 1, z, x1, b + H, z1, wall);
      this.fill(x + 1, b + 1, z + 1, x1 - 1, b + H, z1 - 1, BLOCK.AIR);
      const dx = x + Math.floor(w / 2);
      const dz = z + Math.floor(d / 2);
      this.fill(dx, b + 1, z, dx, b + 2, z, BLOCK.AIR); // door
      this.fill(x, b + 2, dz, x, b + 2, dz, BLOCK.AIR); // windows
      this.fill(x1, b + 2, dz, x1, b + 2, dz, BLOCK.AIR);
      this.fill(dx, b + 2, z1, dx, b + 2, z1, BLOCK.AIR);
      for (let k = 0; ; k++) {
        const rx0 = x - 1 + k;
        const rx1 = x1 + 1 - k;
        const rz0 = z - 1 + k;
        const rz1 = z1 + 1 - k;
        if (rx0 > rx1 || rz0 > rz1) break;
        this.fill(rx0, b + H + 1 + k, rz0, rx1, b + H + 1 + k, rz1, roof);
      }
      claim(x - 1, z - 1, x1 + 1, z1 + 1);
      return true;
    });

    // Stepped pyramids: 9x9 sand tiers with a gold cap and a chamber you can walk into.
    run(55, 20, 2, (x, z, r) => {
      const S = 9;
      const x1 = x + S - 1;
      const z1 = z + S - 1;
      const site = this.siteInfo(heights, x - 1, z - 1, x1 + 1, z1 + 1, 3);
      if (!site || !free(x - 1, z - 1, x1 + 1, z1 + 1, 4)) return false;
      const b = site.base;
      this.flatten(heights, x - 1, z - 1, x1 + 1, z1 + 1, b, BLOCK.SAND);
      const tiers = 5;
      for (let k = 0; k < tiers; k++) {
        const type = k === tiers - 1 ? BLOCK.GOLD : k % 2 ? BLOCK.ORANGE : BLOCK.SAND;
        this.fill(x + k, b + 1 + k, z + k, x1 - k, b + 1 + k, z1 - k, type);
      }
      // Chamber in the middle with a tunnel out the -z face.
      const cx = x + 4;
      const cz = z + 4;
      this.fill(cx - 1, b + 1, cz - 1, cx + 1, b + 2, cz + 1, BLOCK.AIR);
      this.fill(cx, b + 1, z, cx, b + 2, cz - 2, BLOCK.AIR);
      this.fill(cx, b + 1, cz, cx, b + 1, cz, r < 0.5 ? BLOCK.GOLD : BLOCK.AZURE); // a treasure brick
      claim(x - 1, z - 1, x1 + 1, z1 + 1);
      return true;
    });

    // Ruins: a ring of broken grey columns with rubble, on a flattened pad.
    run(66, 30, 4, (x, z, r) => {
      const R = 4;
      const site = this.siteInfo(heights, x - R, z - R, x + R, z + R, 2);
      if (!site || !free(x - R, z - R, x + R, z + R, 3)) return false;
      const b = site.base;
      this.flatten(heights, x - R, z - R, x + R, z + R, b);
      this.fill(x - 2, b, z - 2, x + 2, b, z + 2, BLOCK.DARKGREY); // old floor
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.round(Math.cos(a) * 3.4);
        const pz = z + Math.round(Math.sin(a) * 3.4);
        const hgt = 1 + Math.floor(hash2(px, pz, seed + 5) * 5); // 1..5: some stumps, some whole
        this.fill(px, b + 1, pz, px, b + hgt, pz, hgt >= 4 ? BLOCK.STONE : BLOCK.DARKGREY);
        if (hgt >= 5) this.fill(px, b + hgt + 1, pz, px, b + hgt + 1, pz, BLOCK.WHITE); // capital
      }
      // A surviving lintel across two tall columns, and rubble in the ring.
      this.fill(x - 3, b + 6, z, x + 3, b + 6, z, BLOCK.STONE);
      for (let i = 0; i < 5; i++) {
        const px = x - 2 + Math.floor(hash2(i, 7, seed + r * 100) * 5);
        const pz = z - 2 + Math.floor(hash2(i, 8, seed + r * 100) * 5);
        if (this.get(px, b + 1, pz) === BLOCK.AIR) this.fill(px, b + 1, pz, px, b + 1, pz, BLOCK.DARKGREY);
      }
      claim(x - R, z - R, x + R, z + R);
      return true;
    });

    // Piers: planks on wooden posts running from a beach out over the lake.
    // Beach cells are rare, so this samples many candidates (each test is a few lookups).
    run(77, 600, 4, (x, z) => {
      if (x < 3 || z < 3 || x >= sx - 3 || z >= sz - 3) return false;
      const h = heights[z * sx + x];
      if (h !== SEA + 1) return false; // must start on the beach
      // Which way is the water?
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let dir = null;
      for (const d of dirs) {
        let wet = 0;
        for (let i = 1; i <= 7; i++) {
          const px = x + d[0] * i;
          const pz = z + d[1] * i;
          if (px < 1 || pz < 1 || px >= sx - 1 || pz >= sz - 1) break;
          if (heights[pz * sx + px] <= SEA) wet++;
          else break;
        }
        if (wet >= 6) { dir = d; break; }
      }
      if (!dir) return false;
      const L = 7;
      const ex = x + dir[0] * L;
      const ez = z + dir[1] * L;
      const bx0 = Math.min(x, ex) - 1;
      const bx1 = Math.max(x, ex) + 1;
      const bz0 = Math.min(z, ez) - 1;
      const bz1 = Math.max(z, ez) + 1;
      if (!free(bx0, bz0, bx1, bz1, 2)) return false;
      const y = SEA + 1; // deck one above the water surface
      const side = [dir[1], dir[0]]; // perpendicular
      for (let i = 0; i <= L; i++) {
        const px = x + dir[0] * i;
        const pz = z + dir[1] * i;
        // 3-wide deck.
        for (let s = -1; s <= 1; s++) this.fill(px + side[0] * s, y, pz + side[1] * s, px + side[0] * s, y, pz + side[1] * s, BLOCK.PLANKS);
        // Posts every third plank, down to the lake bed, with a railing block on top.
        if (i % 3 === 1) {
          for (const s of [-1, 1]) {
            const qx = px + side[0] * s;
            const qz = pz + side[1] * s;
            const bed = heights[qz * sx + qx];
            this.fill(qx, bed + 1, qz, qx, y + 1, qz, BLOCK.WOOD);
          }
        }
      }
      // Lantern post at the end.
      this.fill(ex, y + 1, ez, ex, y + 2, ez, BLOCK.WOOD);
      this.fill(ex, y + 3, ez, ex, y + 3, ez, BLOCK.YELLOW);
      claim(bx0, bz0, bx1, bz1);
      return true;
    });

    // Giant 2x4 bricks lying around (studs come free from the top-face mesher).
    run(33, 40, 10, (x, z, r) => {
      const along = r < 0.5;
      const x1 = x + (along ? 3 : 1);
      const z1 = z + (along ? 1 : 3);
      const site = this.siteInfo(heights, x, z, x1, z1, 1);
      if (!site || !free(x, z, x1, z1, 1)) return false;
      const b = site.base;
      if (!this.isClear(x, b + 1, z, x1, b + 2, z1)) return false;
      this.fill(x, b + 1, z, x1, b + 2, z1, pick(hash2(x, z, seed + 4)));
      claim(x, z, x1, z1);
      return true;
    });

    // Boulders: half-buried stone blobs, allowed on slopes.
    run(44, 40, 14, (x, z, r) => {
      const rad = 1.5 + r * 1.5;
      const R = Math.ceil(rad);
      if (!free(x - R, z - R, x + R, z + R, 1)) return false;
      const h = heights[z * sx + x];
      if (h <= SEA || h > this.sy - 12) return false;
      const cy = h + rad * 0.3;
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          for (let dx = -R; dx <= R; dx++) {
            const px = x + dx;
            const py = Math.floor(cy) + dy;
            const pz = z + dz;
            if (!this.inBounds(px, py, pz)) continue;
            const e = (dx * dx) / (rad * rad) + ((py - cy) * (py - cy)) / (rad * rad * 0.64) + (dz * dz) / (rad * rad);
            if (e > 1) continue;
            const i = this.idx(px, py, pz);
            if (this.data[i] === BLOCK.AIR || this.data[i] === BLOCK.LEAVES) this.data[i] = BLOCK.STONE;
          }
        }
      }
      claim(x - R, z - R, x + R, z + R);
      return true;
    });
  }

  // ---- Meshing ----
  /** Rebuild all dirty chunks. Returns number rebuilt. */
  update(maxPerFrame = Infinity) {
    let n = 0;
    for (const ci of this.dirty) {
      if (n >= maxPerFrame) break;
      this.buildChunk(ci);
      this.dirty.delete(ci);
      n++;
    }
    return n;
  }

  buildChunk(ci) {
    const c = this.chunk;
    const cxi = ci % this.cx;
    const czi = Math.floor(ci / this.cx);
    const x0 = cxi * c;
    const z0 = czi * c;
    const x1 = Math.min(x0 + c, this.sx);
    const z1 = Math.min(z0 + c, this.sz);

    const pos = [];
    const nor = [];
    const col = [];
    const idx = [];
    let v = 0;

    const pushQuad = (corners, n, r, g, b) => {
      for (let k = 0; k < 4; k++) {
        pos.push(corners[k][0], corners[k][1], corners[k][2]);
        nor.push(n[0], n[1], n[2]);
        col.push(r, g, b);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    };

    for (let y = 0; y < this.sy; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const t = this.data[this.idx(x, y, z)];
          if (t === BLOCK.AIR) continue;
          const info = BLOCK_INFO[t];
          const variation = 0.9 + 0.1 * hash3(x, y, z, 3);
          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const nx = x + face.n[0];
            const ny = y + face.n[1];
            const nz = z + face.n[2];
            if (ny < this.sy && this.get(nx, ny, nz) !== BLOCK.AIR) continue;
            if (ny >= this.sy) {
              // top of world: still render
            }
            const isTop = f === 2;
            tmpColor.setHex(isTop && info.top ? info.top : info.color);
            const s = face.shade * variation;
            const corners = face.c.map((cc) => [x + cc[0], y + cc[1], z + cc[2]]);
            pushQuad(corners, face.n, tmpColor.r * s, tmpColor.g * s, tmpColor.b * s);

            if (isTop && this.studs && !info.noStud) {
              v = this.pushStud(x, y, z, tmpColor, variation, pos, nor, col, idx, v);
            }
          }
        }
      }
    }

    const old = this.meshes[ci];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.meshes[ci] = null;
    }
    if (idx.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.meshes[ci] = mesh;
  }

  pushStud(x, y, z, color, variation, pos, nor, col, idx, v) {
    const cx = x + 0.5;
    const cz = z + 0.5;
    const yb = y + 1;
    const yt = yb + STUD_HEIGHT;
    const sideS = 0.78 * variation;
    const topS = 1.05 * variation;
    // Sides
    for (let i = 0; i < STUD_SEGMENTS; i++) {
      const [ax, az] = STUD_RING[i];
      const [bx, bz] = STUD_RING[(i + 1) % STUD_SEGMENTS];
      const nx = (ax + bx) * 0.5;
      const nz = (az + bz) * 0.5;
      const len = Math.hypot(nx, nz) || 1;
      const n = [nx / len, 0, nz / len];
      const corners = [
        [cx + ax, yb, cz + az],
        [cx + ax, yt, cz + az],
        [cx + bx, yt, cz + bz],
        [cx + bx, yb, cz + bz],
      ];
      for (let k = 0; k < 4; k++) {
        pos.push(corners[k][0], corners[k][1], corners[k][2]);
        nor.push(n[0], n[1], n[2]);
        col.push(color.r * sideS, color.g * sideS, color.b * sideS);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
    // Top cap (fan)
    const center = v;
    pos.push(cx, yt, cz);
    nor.push(0, 1, 0);
    col.push(color.r * topS, color.g * topS, color.b * topS);
    v++;
    for (let i = 0; i < STUD_SEGMENTS; i++) {
      const [ax, az] = STUD_RING[i];
      pos.push(cx + ax, yt, cz + az);
      nor.push(0, 1, 0);
      col.push(color.r * topS, color.g * topS, color.b * topS);
    }
    for (let i = 0; i < STUD_SEGMENTS; i++) {
      const a = center + 1 + i;
      const b = center + 1 + ((i + 1) % STUD_SEGMENTS);
      idx.push(center, b, a);
    }
    v += STUD_SEGMENTS;
    return v;
  }

  // ---- Raycast (Amanatides & Woo DDA) ----
  /**
   * @returns {{x:number,y:number,z:number,nx:number,ny:number,nz:number,dist:number}|null}
   */
  raycast(origin, dir, maxDist = 6) {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = stepX > 0 ? (x + 1 - origin.x) * tDeltaX : stepX < 0 ? (origin.x - x) * tDeltaX : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - origin.y) * tDeltaY : stepY < 0 ? (origin.y - y) * tDeltaY : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) * tDeltaZ : stepZ < 0 ? (origin.z - z) * tDeltaZ : Infinity;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let t = 0;
    for (let i = 0; i < 256; i++) {
      if (this.inBounds(x, y, z)) {
        const b = this.data[this.idx(x, y, z)];
        if (b !== BLOCK.AIR && b !== BLOCK.WATER) return { x, y, z, nx, ny, nz, dist: t };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) return null;
    }
    return null;
  }
}
