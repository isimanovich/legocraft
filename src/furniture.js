import { BLOCK } from './world.js';
import { boxCollides } from './physics.js';

export const DAY_LENGTH = 600;
export const DEFAULT_TIME_OF_DAY = 0.25;
export const SEATED_EYE = 0.72;
export const isFurniture = block => [BLOCK.TV, BLOCK.COUCH, BLOCK.BED].includes(block);
export const nextSleepTime = time => time >= 0.5 ? 0.25 : 0.75;

/** Remain above the furniture's collision voxel; require standing headroom. */
export function seatPosition(world, seat, halfW = 0.3, height = 1.8) {
  if (!seat || ![seat.x, seat.y, seat.z].every(Number.isInteger) || world.get(seat.x, seat.y, seat.z) !== BLOCK.COUCH) return null;
  const pos = { x: seat.x + 0.5, y: seat.y + 1.01, z: seat.z + 0.5 };
  return boxCollides(world, pos.x, pos.y, pos.z, halfW, height) ? null : pos;
}
