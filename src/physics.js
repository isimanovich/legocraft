// Axis-separated AABB vs voxel collision shared by player and enemies.
// Entities are boxes centred on (pos.x, pos.z) with feet at pos.y.
import { BLOCK } from './world.js';

export const GRAVITY = 28;
const EPS = 1e-3;

/** True when the entity's lower legs are inside a water block. */
export function inWater(world, pos) {
  return world.get(Math.floor(pos.x), Math.floor(pos.y + 0.3), Math.floor(pos.z)) === BLOCK.WATER;
}

/**
 * Buoyancy for an entity in water: cancels gravity, floats it up until the legs
 * clear the surface, and damps vertical motion so it bobs instead of pogoing.
 * `swimUp` (Space held) gives a steady upward kick strong enough to climb a one-block shore.
 */
export function applyBuoyancy(vel, dt, swimUp = false) {
  vel.y += (GRAVITY + 10) * dt;
  vel.y *= Math.max(0, 1 - 3 * dt);
  if (swimUp && vel.y < 6) vel.y = 6;
}

export function boxCollides(world, x, y, z, halfW, height) {
  const x0 = Math.floor(x - halfW);
  const x1 = Math.floor(x + halfW - EPS);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + height - EPS);
  const z0 = Math.floor(z - halfW);
  const z1 = Math.floor(z + halfW - EPS);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (world.isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * Integrates velocity into position with collision. Mutates pos & vel.
 * @returns {{onGround:boolean, hitWall:boolean}}
 */
export function moveWithCollision(world, pos, vel, dt, halfW, height) {
  let onGround = false;
  let hitWall = false;

  // Y
  const py = pos.y;
  pos.y += vel.y * dt;
  if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) {
    if (vel.y < 0) {
      pos.y = Math.floor(pos.y) + 1;
      onGround = true;
    } else if (vel.y > 0) {
      pos.y = Math.floor(pos.y + height) - height - EPS;
    }
    if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) pos.y = py;
    vel.y = 0;
  }

  // X
  const px = pos.x;
  pos.x += vel.x * dt;
  if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) {
    if (vel.x > 0) pos.x = Math.floor(pos.x + halfW) - halfW - EPS;
    else if (vel.x < 0) pos.x = Math.ceil(pos.x - halfW) + halfW + EPS;
    if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) pos.x = px;
    vel.x = 0;
    hitWall = true;
  }

  // Z
  const pz = pos.z;
  pos.z += vel.z * dt;
  if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) {
    if (vel.z > 0) pos.z = Math.floor(pos.z + halfW) - halfW - EPS;
    else if (vel.z < 0) pos.z = Math.ceil(pos.z - halfW) + halfW + EPS;
    if (boxCollides(world, pos.x, pos.y, pos.z, halfW, height)) pos.z = pz;
    vel.z = 0;
    hitWall = true;
  }

  // Ground check when standing still vertically
  if (!onGround && vel.y === 0) {
    onGround = boxCollides(world, pos.x, pos.y - 0.02, pos.z, halfW, height);
  }
  return { onGround, hitWall };
}

/** Ray vs AABB (slab test). Returns distance or Infinity. */
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  if (tmax < 0) return Infinity;
  return tmin >= 0 ? tmin : 0;
}
