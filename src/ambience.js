import { BLOCK } from './world.js';
import { inWater } from './physics.js';

/** Sound groups describe the material beneath the feet, not the held item. */
export function surfaceForBlock(block) {
  if ([BLOCK.GRASS, BLOCK.LEAVES].includes(block)) return 'grass';
  if (block === BLOCK.DIRT) return 'dirt';
  if (block === BLOCK.SAND) return 'sand';
  if ([BLOCK.WOOD, BLOCK.PLANKS, BLOCK.LADDER].includes(block)) return 'wood';
  if ([BLOCK.STONE, BLOCK.BEDROCK].includes(block)) return 'stone';
  if ([BLOCK.COUCH, BLOCK.BED].includes(block)) return 'soft';
  if ([BLOCK.TV, BLOCK.GOLD].includes(block)) return 'metal';
  return 'brick';
}

/** Local movement and nearby water, driven by actual travel rather than held keys. */
export class Ambience {
  constructor(sfx, world) {
    this.sfx = sfx;
    this.world = world;
    this.reset();
  }

  reset() {
    this.previous = null;
    this.wasWet = null;
    this.travel = 0;
    this.strokeTravel = 0;
    this.splashCooldown = 0;
    this.scanTimer = 0;
    this.waterLevel = 0;
    this.sfx.setWaterLevel(0);
  }

  groundBlock(player) {
    const { x, y, z } = player.pos;
    const r = (player.halfW ?? 0.3) * 0.8;
    for (const [dx, dz] of [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r]]) {
      const block = this.world.get(Math.floor(x + dx), Math.floor(y - 0.06), Math.floor(z + dz));
      if (block !== BLOCK.AIR && block !== BLOCK.WATER && block !== BLOCK.LADDER) return block;
    }
    return BLOCK.AIR;
  }

  nearbyWater(pos) {
    const px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z);
    let nearest = Infinity;
    // At most 1183 cells per scan, every 0.4 seconds only while actively playing.
    for (let z = pz - 6; z <= pz + 6; z++) for (let x = px - 6; x <= px + 6; x++) {
      const horizontal = Math.hypot(x + 0.5 - pos.x, z + 0.5 - pos.z);
      if (horizontal > 6) continue;
      for (let y = py - 4; y <= py + 2; y++) {
        if (this.world.get(x, y, z) !== BLOCK.WATER) continue;
        const above = this.world.get(x, y + 1, z);
        if (above !== BLOCK.AIR && above !== BLOCK.LADDER) continue;
        nearest = Math.min(nearest, Math.hypot(horizontal, (y + 1 - pos.y) * 0.7));
      }
    }
    return nearest < 6 ? (1 - nearest / 6) ** 2 : 0;
  }

  update(dt, player, active) {
    if (!active || !this.sfx.enabled || player.health <= 0) {
      if (this.previous || this.waterLevel) this.reset();
      return;
    }
    dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const pos = player.pos;
    const wet = inWater(this.world, pos);
    this.splashCooldown = Math.max(0, this.splashCooldown - dt);
    const previous = this.previous;
    const horizontal = previous ? Math.hypot(pos.x - previous.x, pos.z - previous.z) : 0;
    const vertical = previous ? Math.abs(pos.y - previous.y) : 0;
    const distance = Math.hypot(horizontal, vertical);
    // Teleports/rejoins must not play a burst of stored footsteps or a huge splash.
    const moved = previous && distance < 1.5;
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.waterLevel = this.nearbyWater(pos);
      this.scanTimer = 0.4;
    }
    this.sfx.setWaterLevel(this.waterLevel);

    if (wet) {
      this.travel = 0;
      if (moved && this.wasWet === false && this.splashCooldown === 0 && distance > 0.03) {
        this.sfx.swim(true, 0.7 + Math.min(0.7, vertical * 3));
        this.splashCooldown = 1.2;
      }
      const swimmingUp = player.touch?.jump || player.keys?.has('Space');
      if (moved && this.wasWet === true && (horizontal > 0.001 || (swimmingUp && vertical > 0.001))) {
        this.strokeTravel += distance;
        if (this.strokeTravel >= 1.3) {
          this.sfx.swim(false, 0.8 + Math.random() * 0.3);
          this.strokeTravel %= 1.3;
        }
      } else this.strokeTravel = 0;
    } else {
      this.strokeTravel = 0;
      if (moved && !player.sitting && (player.onGround || player.climbing)) {
        const block = player.climbing ? BLOCK.LADDER : this.groundBlock(player);
        if (block !== BLOCK.AIR) {
          const stride = player.climbing ? 0.7 : 2.0;
          this.travel += player.climbing ? distance : horizontal;
          if (this.travel >= stride) {
            this.sfx.footstep(surfaceForBlock(block), 0.8 + Math.random() * 0.2);
            this.travel %= stride;
          }
        } else this.travel = 0;
      } else this.travel = 0;
    }
    this.previous = { x: pos.x, y: pos.y, z: pos.z };
    this.wasWet = wet;
  }
}
