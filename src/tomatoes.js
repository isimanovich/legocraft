// Exploding tomatoes: a throwable the player gets a few of every wave. A tomato
// flies in an arc, spins, and bursts the moment it touches terrain, a minifig or
// a body (or after a timeout if it sails off the map). What the burst does to the
// world is up to the caller's onExplode callback; this module only owns flight.
import * as THREE from 'three';
import { GRAVITY } from './physics.js';

/** Tomatoes handed out at the start of every wave. */
export const TOMATOES_PER_WAVE = 3;
/** Most tomatoes the player can hold. */
export const TOMATO_MAX = 9;
/** Launch speed, blocks per second (player velocity is added on top). */
export const TOMATO_SPEED = 19;
/** Blast radius of a burst, in blocks. The thrower is never hurt. */
export const TOMATO_BLAST_RADIUS = 4;
/** Damage at the centre of a burst; falls off linearly to 25% at the edge. A direct hit kills anything but a Titan outright. */
export const TOMATO_DAMAGE = 90;
/** Blocks cleared around the burst point. */
export const TOMATO_CRATER_RADIUS = 1.3;
/** A tomato that touches nothing bursts on its own after this long. */
export const TOMATO_LIFE = 5;
/** Seconds between throws. */
export const THROW_COOLDOWN = 0.45;

const RADIUS = 0.22;
const bodyGeo = new THREE.SphereGeometry(RADIUS, 10, 8);
const stemGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.12, 5);
const leafGeo = new THREE.BoxGeometry(0.1, 0.03, 0.2);
const bodyMat = new THREE.MeshLambertMaterial({ color: 0xd62b1e });
const stemMat = new THREE.MeshLambertMaterial({ color: 0x3f8f2c });

/** Build a tomato mesh (also used for the hand model). Origin at the centre. */
export function buildTomato() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(bodyGeo, bodyMat));
  const stem = new THREE.Mesh(stemGeo, stemMat);
  stem.position.y = RADIUS + 0.04;
  g.add(stem);
  for (let i = 0; i < 3; i++) {
    const leaf = new THREE.Mesh(leafGeo, stemMat);
    leaf.position.y = RADIUS;
    leaf.rotation.y = (i / 3) * Math.PI * 2;
    leaf.rotation.x = -0.35;
    leaf.translateZ(0.09);
    g.add(leaf);
  }
  return g;
}

const _p = new THREE.Vector3();

export class Tomatoes {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = [];
  }

  /** Launch a tomato from `origin` along `dir` (unit), adding `carry` (thrower's velocity). */
  throw(origin, dir, carry = null) {
    const mesh = buildTomato();
    mesh.position.copy(origin);
    const vel = dir.clone().multiplyScalar(TOMATO_SPEED);
    vel.y += 1.5; // a little loft so it arcs
    if (carry) vel.add(carry);
    const t = {
      mesh,
      vel,
      life: TOMATO_LIFE,
      spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
    };
    this.scene.add(mesh);
    this.items.push(t);
    return t;
  }

  /**
   * Fly every tomato; each one that touches something is removed and reported.
   * @param {number} dt
   * @param {{enemies?: Array, bodies?: Array, onExplode: (pos: THREE.Vector3, hit: object|null) => void}} ctx
   */
  update(dt, ctx) {
    const { world } = this;
    const enemies = ctx.enemies ?? [];
    const bodies = ctx.bodies ?? [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const t = this.items[i];
      t.life -= dt;
      let hit = null;
      let burst = t.life <= 0;
      if (!burst) {
        // Sub-step so a fast tomato can't tunnel through a wall or a minifig.
        const speed = t.vel.length();
        const steps = Math.max(1, Math.ceil((speed * dt) / 0.2));
        const h = dt / steps;
        for (let s = 0; s < steps && !burst; s++) {
          t.vel.y -= GRAVITY * h;
          _p.copy(t.mesh.position).addScaledVector(t.vel, h);
          if (world.isSolid(Math.floor(_p.x), Math.floor(_p.y), Math.floor(_p.z))) {
            burst = true; // stop at the surface it hit, not inside the block
            break;
          }
          t.mesh.position.copy(_p);
          for (const en of enemies) {
            if (
              Math.abs(_p.x - en.pos.x) < en.halfW + RADIUS &&
              Math.abs(_p.z - en.pos.z) < en.halfW + RADIUS &&
              _p.y > en.pos.y - RADIUS &&
              _p.y < en.pos.y + en.height + RADIUS
            ) {
              hit = en;
              burst = true;
              break;
            }
          }
          if (burst) break;
          for (const b of bodies) {
            const r = 0.3 * b.scale + RADIUS;
            for (let k = -0.85; k <= 0.86; k += 0.425) {
              if (b.axisPoint(k, _q).distanceToSquared(_p) < r * r) {
                hit = b;
                burst = true;
                break;
              }
            }
            if (burst) break;
          }
        }
        t.mesh.rotation.x += t.spin.x * dt;
        t.mesh.rotation.y += t.spin.y * dt;
        t.mesh.rotation.z += t.spin.z * dt;
        if (t.mesh.position.y < -5) burst = true;
      }
      if (burst) {
        this.scene.remove(t.mesh);
        this.items.splice(i, 1);
        ctx.onExplode(t.mesh.position.clone(), hit);
      }
    }
  }

  clear() {
    for (const t of this.items) this.scene.remove(t.mesh);
    this.items.length = 0;
  }
}
const _q = new THREE.Vector3();
