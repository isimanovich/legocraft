// Bounded A* over standable voxel cells. Used by enemies to walk around houses,
// towers, boulders and tree clusters instead of hugging their walls.
import { BLOCK } from './world.js';

// Cardinal moves first, then diagonals (cost sqrt 2). A diagonal is only allowed when both
// cardinal cells beside it are passable, so nobody clips the corner of a wall.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SQRT2 = Math.SQRT2;
const MAX_CLIMB = 1; // one block up (auto-jump handles it)
const MAX_DROP = 3; // happily jump down this far
/** Half-width of the body the smoother keeps clear of walls when it straightens a path. */
const SMOOTH_HALF_W = 0.34;

/** True if `cells` blocks starting at (x,y,z) going up are all passable. */
export function clearColumn(world, x, y, z, cells) {
  for (let i = 0; i < cells; i++) if (world.isSolid(x, y + i, z)) return false;
  return true;
}

/** A cell (x,y,z) is standable if the entity's body fits and there is support below (ground or water). */
export function standable(world, x, y, z, cells) {
  if (world.get(x, y - 1, z) === BLOCK.AIR) return false; // water and solids both count as support
  return clearColumn(world, x, y, z, cells);
}

/** Snap a position to the standable cell at/below it (searches down a few blocks). */
export function groundCell(world, pos, cells) {
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  let y = Math.floor(pos.y + 0.1);
  for (let i = 0; i < 6; i++, y--) if (standable(world, x, y, z, cells)) return { x, y, z };
  return null;
}

class MinHeap {
  constructor() { this.a = []; }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function rebuild(node) {
  const path = [];
  for (let n = node; n.parent; n = n.parent) path.push({ x: n.x, y: n.y, z: n.z });
  return path.reverse();
}

/** True if a body `cells` tall can walk the straight line between two same-level cell centres. */
function lineWalkable(world, a, b, cells) {
  if (a.y !== b.y) return false;
  const ax = a.x + 0.5;
  const az = a.z + 0.5;
  const dx = b.x + 0.5 - ax;
  const dz = b.z + 0.5 - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz * SMOOTH_HALF_W; // perpendicular offsets: the body's two shoulders
  const pz = ux * SMOOTH_HALF_W;
  const steps = Math.ceil(len / 0.25);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * len;
    const sx = ax + ux * t;
    const sz = az + uz * t;
    for (const [ox, oz] of [[0, 0], [px, pz], [-px, -pz]]) {
      if (!standable(world, Math.floor(sx + ox), a.y, Math.floor(sz + oz), cells)) return false;
    }
  }
  return true;
}

/**
 * String-pulling: drop every waypoint that can be skipped by walking straight to a later
 * one on the same level, so a staircase of grid steps becomes one diagonal line.
 * Level changes (climbs and drops) are always kept as explicit waypoints.
 */
export function smoothPath(world, start, path, cells = 2) {
  if (path.length < 2) return path;
  const out = [];
  let from = start;
  let i = 0;
  while (i < path.length) {
    let j = i;
    for (let k = path.length - 1; k > i; k--) {
      if (lineWalkable(world, from, path[k], cells)) { j = k; break; }
    }
    out.push(path[j]);
    from = path[j];
    i = j + 1;
  }
  return out;
}

/**
 * A* from `start` to `goal` (both standable cells).
 * @returns {Array<{x,y,z}>|null} waypoints excluding the start cell. If the budget runs out
 *   before reaching the goal, returns the path to the closest cell explored (still useful),
 *   or null when nothing closer than the start was found.
 */
export function findPath(world, start, goal, cells = 2, maxNodes = 1500) {
  const key = (x, y, z) => (y * world.sz + z) * world.sx + x;
  // Octile distance: admissible for 8-connected moves with diagonal cost sqrt 2.
  const h = (x, y, z) => {
    const ax = Math.abs(x - goal.x);
    const az = Math.abs(z - goal.z);
    return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az) + Math.abs(y - goal.y) * 0.5;
  };
  const open = new MinHeap();
  const gScore = new Map();
  const closed = new Set();
  const startNode = { x: start.x, y: start.y, z: start.z, g: 0, f: 0, parent: null };
  startNode.f = h(start.x, start.y, start.z);
  gScore.set(key(start.x, start.y, start.z), 0);
  open.push(startNode);
  let best = startNode;
  let bestH = startNode.f;
  let expanded = 0;

  while (open.size) {
    const cur = open.pop();
    const ck = key(cur.x, cur.y, cur.z);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === goal.x && cur.z === goal.z && Math.abs(cur.y - goal.y) <= 1) return smoothPath(world, start, rebuild(cur), cells);
    const ch = h(cur.x, cur.y, cur.z);
    if (ch < bestH) { bestH = ch; best = cur; }
    if (++expanded > maxNodes) break;

    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      if (nx < 0 || nz < 0 || nx >= world.sx || nz >= world.sz) continue;
      const diagonal = dx !== 0 && dz !== 0;
      if (diagonal) {
        // Both cells beside the diagonal must be passable at the current level (no corner clipping).
        if (!clearColumn(world, cur.x + dx, cur.y, cur.z, cells) || !clearColumn(world, cur.x, cur.y, cur.z + dz, cells)) continue;
      }
      const stepCost = diagonal ? SQRT2 : 1;
      // Highest standable level in the neighbour column, from one up down to a drop.
      for (let dy = MAX_CLIMB; dy >= -MAX_DROP; dy--) {
        const ny = cur.y + dy;
        if (!standable(world, nx, ny, nz, cells)) continue;
        if (dy !== 0 && diagonal) break; // level changes only on cardinal steps (a diagonal jump can snag the corner)
        if (dy > 0 && world.isSolid(cur.x, cur.y + cells, cur.z)) break; // no headroom to jump
        if (dy < 0 && !clearColumn(world, nx, cur.y, nz, cells)) break; // would hit a ceiling walking off the edge
        const ng = cur.g + stepCost + (dy > 0 ? 0.6 : -dy * 0.15);
        const nk = key(nx, ny, nz);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          open.push({ x: nx, y: ny, z: nz, g: ng, f: ng + h(nx, ny, nz), parent: cur });
        }
        break;
      }
    }
  }
  return best === startNode ? null : smoothPath(world, start, rebuild(best), cells);
}

/** Path between two world positions (snapped to their ground cells). */
export function pathBetween(world, fromPos, toPos, cells = 2, maxNodes = 1500) {
  const a = groundCell(world, fromPos, cells);
  const b = groundCell(world, toPos, cells);
  if (!a || !b) return null;
  return findPath(world, a, b, cells, maxNodes);
}
