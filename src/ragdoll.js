// Ragdoll bodies: a dead minifig that stays in one piece instead of bursting
// into bricks. The whole figure is one rigid body (position + orientation)
// that topples like a felled tree, bounces and slides over the voxels, and
// floats in water; the limbs flop on damped springs so it reads as a ragdoll
// without an articulated solver. Bodies can be nudged by walking into them,
// shoved by blasts, and picked up and carried.
import * as THREE from 'three';
import { GRAVITY, moveWithCollision, inWater, applyBuoyancy, rayBox } from './physics.js';

/** Most bodies kept in the world at once; the oldest is removed beyond this. */
export const MAX_BODIES = 16;
/** How far in front of the eye a carried body's grab point is held. */
export const CARRY_DISTANCE = 1.9;
/** Drop a carried body if it gets wedged this far from where the hand wants it. */
export const CARRY_BREAK_DISTANCE = 3.2;

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const sgn = (v) => (v < 0 ? -1 : 1);

class Body {
  /**
   * @param {THREE.Group} group figure root (origin at the feet), already detached from the enemy
   * @param {number} scale figure scale
   * @param {number} height figure height in world units
   * @param {Array<{node:THREE.Object3D, rest:{x:number,z:number}, limit:number}>} limbs
   * @param {Object<string, THREE.Material|null>} mats owned materials, disposed with the body
   * @param {THREE.Vector3} feet world position of the feet at death
   * @param {THREE.Vector3} vel velocity at death (knockback decides which way it falls)
   */
  constructor(group, scale, height, limbs, mats, feet, vel, waist = 0.62) {
    this.group = group;
    this.scale = scale;
    this.height = height;
    this.halfLen = height / 2;
    this.waist = waist; // model units, from the feet
    this.mats = mats;
    this.limbs = limbs.map((l) => ({ ...l, vx: rnd(-3, 3), vz: rnd(-3, 3) }));
    // Collision box around the centre of mass, roughly the body's thickness.
    this.colHalf = 0.2 * scale;
    this.colHeight = 0.4 * scale;
    this.q = group.quaternion.clone();
    this.up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.q);
    this.feet = feet.clone(); // pivot while toppling
    this.com = this.feet.clone().addScaledVector(this.up, this.halfLen);
    this.vel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    const ta = Math.random() * Math.PI * 2;
    this.tipAxis = new THREE.Vector3(Math.cos(ta), 0, Math.sin(ta)); // which way it falls when balanced
    // Initial spin from the killing blow: tangential velocity at the COM -> omega = (up x v) / r.
    this.angVel = new THREE.Vector3().crossVectors(this.up, vel).multiplyScalar(1 / this.halfLen);
    if (this.angVel.lengthSq() < 0.4) {
      // Barely any knockback: fall over in a random direction anyway.
      const a = Math.random() * Math.PI * 2;
      this.angVel.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.8);
    }
    this.pinned = true; // feet still planted: rotating about them
    this.pinTime = 0;
    this.onGround = false;
    this.swimming = false;
    this.airTime = 0; // seconds since the body last touched ground/water
    this.carried = false;
    this.grabLocal = new THREE.Vector3(); // grab point in body space
    this.age = 0;
    this.restTime = 0;
    this.name = ''; // given by the player after it fell
    this.label = null; // world-space sprite showing the name; follows the body
    this.sync();
  }

  /** Point `k` of the way along the body axis from the COM (-1 feet, +1 head). */
  axisPoint(k, out) {
    return out.copy(this.com).addScaledVector(this.up, k * this.halfLen);
  }

  rotate(dt) {
    const w = this.angVel.length();
    if (w < 1e-6) return;
    _a.copy(this.angVel).multiplyScalar(1 / w);
    _q.setFromAxisAngle(_a, w * dt);
    this.q.premultiply(_q).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.q);
  }

  /** Shake the limbs, e.g. on impact. */
  jolt(mag) {
    for (const l of this.limbs) {
      l.vx += rnd(-mag, mag);
      l.vz += rnd(-mag, mag);
    }
  }

  /** Apply an impulse (velocity change) at a world point: moves and spins the body. */
  impulse(point, dv) {
    this.pinned = false;
    this.vel.add(dv);
    _a.copy(point).sub(this.com);
    _b.crossVectors(_a, dv).multiplyScalar(1 / (this.halfLen * this.halfLen * 0.6 + 0.3));
    this.angVel.add(_b);
    this.jolt(dv.length() * 0.8);
    this.restTime = 0;
  }

  sync() {
    this.group.quaternion.copy(this.q);
    this.group.position.copy(this.com).addScaledVector(this.up, -this.halfLen);
  }

  /** Model-space height (from the feet) of the grab point; which part is being held. */
  grabHeight() {
    return (this.grabLocal.y + this.halfLen) / this.scale;
  }

  /**
   * Euler (x, z) that points a segment's axis along direction `d` (in the parent frame).
   * With rotation order XYZ and y = 0: R*(0,1,0) = (-sin z, cos z cos x, cos z sin x).
   */
  static aimAngles(d, axis, out) {
    const s = axis;
    out.z = Math.asin(THREE.MathUtils.clamp(-s * d.x, -1, 1));
    out.x = Math.atan2(s * d.z, s * d.y);
    return out;
  }

  updateLimbs(dt) {
    // Every segment that isn't being held is a loose pendulum: it hangs toward world
    // gravity and lags behind the root's spin (inertia). Lying on the ground the limbs
    // can't swing under the body, so there they settle flat instead.
    const carried = this.carried;
    // Brief hops over block edges (airTime < 0.15 s) don't count as flying, so a body
    // rolling on the ground keeps settling instead of flicking between modes.
    const grounded = !carried && !this.pinned && (this.onGround || this.swimming || this.airTime < 0.15);
    _q.copy(this.q).invert();
    _c.set(0, -1, 0).applyQuaternion(_q); // down, in body space
    _w.copy(this.angVel).applyQuaternion(_q); // root spin, in body space
    let heldUpper = false;
    let heldLower = false;
    if (carried) {
      const gh = this.grabHeight();
      heldUpper = gh > this.waist + 0.15;
      heldLower = gh < this.waist - 0.15; // grabbed around the waist: both halves dangle
      // Hand motion shakes the limbs.
      _b.copy(this.vel).sub(this.prevVel);
      const shake = Math.min(4, _b.length() * 0.12);
      if (shake > 0.05) this.jolt(shake);
    }
    this.prevVel.copy(this.vel);

    // Springs: floppy in the air, a little firmer in the hand, settling on the ground.
    const k = grounded ? 30 : carried ? 30 : 22;
    const c = grounded ? 7 : carried ? 4.5 : 3;
    const inertia = grounded ? 0.5 : 0.85; // how much of the root's spin the limbs lag behind
    for (const l of this.limbs) {
      let tx = l.rest.x;
      let tz = l.rest.z;
      let mode = 'gravity';
      if (carried) {
        let dangles;
        if (l.kind === 'leg') dangles = !(heldLower && Math.sign(this.grabLocal.x || 1) === l.side); // the grabbed leg stays; everything else hangs
        else if (l.kind === 'upper') dangles = !heldUpper; // held by the torso/head: waist stays; otherwise it folds
        else dangles = true; // arms and head always hang
        if (!dangles) mode = 'rest';
      } else if (grounded) {
        mode = 'flat';
      }
      if (mode !== 'rest') {
        if (mode === 'gravity') {
          _a.copy(_c);
        } else {
          // Flat: drop the segment onto the ground along its current heading; a segment
          // pointing straight up/down has no heading, so lay it along the body.
          _a.set(0, l.axis, 0).applyQuaternion(l.node.quaternion);
          if (l.parent) _a.applyQuaternion(l.parent.quaternion);
          _a.applyQuaternion(this.q); // current direction, world
          if (Math.hypot(_a.x, _a.z) < 0.2) _a.copy(this.up).multiplyScalar(l.axis);
          const horiz = Math.hypot(_a.x, _a.z);
          if (horiz < 0.2) mode = 'rest'; // body itself is vertical: nothing to lie along
          else _a.multiplyScalar(1 / horiz).setY(-0.15).normalize().applyQuaternion(_q);
        }
        if (mode !== 'rest') {
          if (l.parent) _a.applyQuaternion(_qp.copy(l.parent.quaternion).invert());
          Body.aimAngles(_a, l.axis, _aim);
          tx = _aim.x;
          tz = _aim.z;
          // Past the joint limit: bend as far as allowed toward the target. Only a fully
          // folded target (near +-pi, where the sign is arbitrary) keeps the side we're on.
          if (Math.abs(tx) > l.limit) {
            tx = Math.abs(tx) > Math.PI - 0.35 ? l.limit * (l.node.rotation.x >= 0 ? 1 : -1) : l.limit * Math.sign(tx);
          }
          if (Math.abs(tz) > l.limit) tz = l.limit * Math.sign(tz);
        }
      }
      // Root spin seen from the limb's parent frame; the limb tends to keep its world
      // orientation, so damping acts on (relative + root) angular velocity.
      _b.copy(_w);
      if (l.parent) _b.applyQuaternion(_qp.copy(l.parent.quaternion).invert());
      const r = l.node.rotation;
      l.vx += (-k * (r.x - tx) - c * (l.vx + inertia * _b.x)) * dt;
      l.vz += (-k * (r.z - tz) - c * (l.vz + inertia * _b.z)) * dt;
      r.x = THREE.MathUtils.clamp(r.x + l.vx * dt, -l.limit, l.limit);
      r.z = THREE.MathUtils.clamp(r.z + l.vz * dt, -l.limit, l.limit);
    }
  }
}
const _aim = { x: 0, z: 0 };
const _w = new THREE.Vector3();
const _qp = new THREE.Quaternion();

export class Ragdolls {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.bodies = [];
    this.carrying = null;
    /** Called with (body, impactSpeed) when a body lands or hits a wall hard. */
    this.onImpact = null;
  }

  /**
   * Turn a dead enemy into a ragdoll. The enemy's group is re-used as-is, so the
   * figure stays intact.
   * @param {import('./enemies.js').Enemy} en
   */
  add(en) {
    const rig = en.toRagdoll();
    const body = new Body(en.group, en.type.scale, en.height, rig.limbs, rig.mats, en.pos, en.vel, rig.waist);
    this.bodies.push(body);
    if (this.bodies.length > MAX_BODIES) this.remove(this.bodies[0]);
    return body;
  }

  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    if (this.carrying === body) this.carrying = null;
    this.scene.remove(body.group);
    this.clearLabel(body);
    for (const m of Object.values(body.mats)) if (m) m.dispose();
  }

  /**
   * Give a body a name. `makeLabel(name)` returns a sprite (or null) which is kept in the
   * scene and follows the body; an empty name clears it.
   */
  setName(body, name, makeLabel) {
    this.clearLabel(body);
    body.name = name.trim();
    if (!body.name) return;
    const label = makeLabel ? makeLabel(body.name) : null;
    if (label) {
      body.label = label;
      this.scene.add(label);
      this.placeLabel(body);
    }
  }

  clearLabel(body) {
    if (!body.label) return;
    this.scene.remove(body.label);
    body.label.material.map?.dispose();
    body.label.material.dispose();
    body.label = null;
  }

  /** Float the label above whatever part of the body is highest. */
  placeLabel(body) {
    const top = Math.max(body.com.y, body.axisPoint(1, _a).y, body.axisPoint(-1, _b).y);
    body.label.position.set(body.com.x, top + 0.55, body.com.z);
  }

  clear() {
    for (const b of [...this.bodies]) this.remove(b);
  }

  /**
   * Closest body under a ray within `reach`. Tests a few boxes along the body axis.
   * @returns {{body:Body, dist:number, point:THREE.Vector3}|null}
   */
  hitTest(eye, dir, reach) {
    let best = null;
    let bestD = reach;
    for (const b of this.bodies) {
      const h = 0.3 * b.scale;
      for (let k = -0.85; k <= 0.86; k += 0.425) {
        b.axisPoint(k, _a);
        const d = rayBox(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, _a.x - h, _a.y - h, _a.z - h, _a.x + h, _a.y + h, _a.z + h);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
    }
    if (!best) return null;
    const point = eye.clone().addScaledVector(dir, bestD);
    return { body: best, dist: bestD, point };
  }

  /** Pick a body up by `point` (world). It follows the hand until drop(). */
  grab(body, point) {
    this.drop();
    body.carried = true;
    body.pinned = false;
    body.restTime = 0;
    _q.copy(body.q).invert();
    body.grabLocal.copy(point).sub(body.com).applyQuaternion(_q);
    body.vel.set(0, 0, 0);
    body.angVel.multiplyScalar(0.3);
    this.carrying = body;
  }

  /** Let go of the carried body, keeping whatever velocity the hand gave it plus `toss`. */
  drop(toss = null) {
    const b = this.carrying;
    if (!b) return;
    b.carried = false;
    b.airTime = 1;
    if (toss) b.vel.add(toss);
    b.jolt(2);
    this.carrying = null;
  }

  /** Shove every body within `radius` of a point (blasts). */
  impulseAt(cx, cy, cz, radius, strength) {
    for (const b of this.bodies) {
      _a.set(b.com.x - cx, b.com.y - cy, b.com.z - cz);
      const d = _a.length();
      if (d >= radius) continue;
      const f = strength * (1 - d / radius);
      _a.multiplyScalar(1 / (d || 1)).multiplyScalar(f);
      _a.y += f * 0.6;
      b.axisPoint(rnd(-0.8, 0.8), _b);
      b.impulse(_b, _a);
    }
  }

  /**
   * @param {number} dt
   * @param {import('./player.js').Player} player
   * @param {THREE.Vector3} [handTarget] where the carried body's grab point should be (world)
   */
  update(dt, player, handTarget = null) {
    const world = this.world;
    for (const b of this.bodies) {
      b.age += dt;
      if (b.carried) {
        this.updateCarried(b, dt, handTarget);
      } else if (b.pinned) {
        this.updatePinned(b, dt);
      } else {
        this.updateFree(b, dt);
      }
      this.pushByPlayer(b, player);
      b.updateLimbs(dt);
      b.sync();
      if (b.label) this.placeLabel(b);
    }
  }

  /** Toppling about planted feet, like a felled tree: theta'' = 3g/(2L) sin(theta). */
  updatePinned(b, dt) {
    b.pinTime += dt;
    _a.crossVectors(b.up, DOWN).multiplyScalar((1.5 * GRAVITY) / b.height);
    b.angVel.addScaledVector(_a, dt);
    b.rotate(dt);
    b.com.copy(b.feet).addScaledVector(b.up, b.halfLen);
    const fx = Math.floor(b.feet.x);
    const fz = Math.floor(b.feet.z);
    const supported = this.world.isSolid(fx, Math.floor(b.feet.y - 0.1), fz);
    if (b.up.y < 0.3 || !supported || b.pinTime > 3) {
      // Release: the COM keeps its tangential velocity (v = omega x r).
      b.pinned = false;
      b.airTime = 1;
      _a.copy(b.up).multiplyScalar(b.halfLen);
      b.vel.crossVectors(b.angVel, _a);
      b.jolt(3);
    }
  }

  updateFree(b, dt) {
    const world = this.world;
    const swimming = inWater(world, _a.set(b.com.x, b.com.y - 0.3, b.com.z));
    b.swimming = swimming;
    b.vel.y -= GRAVITY * dt;
    if (swimming) {
      applyBuoyancy(b.vel, dt, false);
      b.vel.x *= Math.max(0, 1 - 1.5 * dt);
      b.vel.z *= Math.max(0, 1 - 1.5 * dt);
    }
    const preVy = b.vel.y;
    const preSpeed = Math.hypot(b.vel.x, b.vel.z);
    _b.set(b.com.x, b.com.y - b.colHeight / 2, b.com.z);
    const res = moveWithCollision(world, _b, b.vel, dt, b.colHalf, b.colHeight);
    b.com.set(_b.x, _b.y + b.colHeight / 2, _b.z);
    b.onGround = res.onGround;
    b.airTime = res.onGround || swimming ? 0 : b.airTime + dt;

    if (res.onGround && preVy < -2.5) {
      // Landed: bounce a little, spin and flail with the impact.
      b.vel.y = -preVy * 0.25;
      if (b.vel.y < 1) b.vel.y = 0;
      b.angVel.x += rnd(-1, 1) * -preVy * 0.15;
      b.angVel.z += rnd(-1, 1) * -preVy * 0.15;
      b.jolt(-preVy * 0.6);
      this.onImpact?.(b, -preVy);
    } else if (res.hitWall && preSpeed > 3) {
      b.jolt(preSpeed * 0.4);
      b.angVel.y += rnd(-1, 1) * preSpeed * 0.2;
      this.onImpact?.(b, preSpeed);
    }

    if (b.onGround || swimming) {
      // Friction and settle flat: torque the body axis toward horizontal.
      const f = Math.max(0, 1 - (swimming ? 2 : 7) * dt);
      b.vel.x *= f;
      b.vel.z *= f;
      _a.set(0, -sgn(b.up.y), 0);
      _c.crossVectors(b.up, _a).multiplyScalar(swimming ? 10 : 25);
      // Near-vertical (upright or on its head) the restoring torque vanishes; add a
      // steady push in this body's own tip direction so it always falls over.
      const vert = (Math.abs(b.up.y) - 0.85) / 0.15;
      if (vert > 0) _c.addScaledVector(b.tipAxis, 10 * Math.min(1, vert));
      b.angVel.addScaledVector(_c, dt);
      b.angVel.multiplyScalar(Math.max(0, 1 - 8 * dt));
      if (Math.abs(b.up.y) < 0.1) b.angVel.y *= Math.max(0, 1 - 6 * dt);
    } else {
      b.angVel.multiplyScalar(Math.max(0, 1 - 0.6 * dt));
    }
    b.rotate(dt);

    // Fell out of the world.
    if (b.com.y < -5) this.remove(b);
  }

  /** Carried: the grab point tracks the hand; the rest hangs below it like a pendulum. */
  updateCarried(b, dt, handTarget) {
    if (!handTarget) return this.drop();
    // Where the COM must be for the grab point to sit at the hand.
    _a.copy(b.grabLocal).applyQuaternion(b.q); // grab offset, world
    _b.copy(handTarget).sub(_a); // desired COM
    _c.copy(_b).sub(b.com);
    const gap = _c.length();
    if (gap > CARRY_BREAK_DISTANCE) return this.drop();
    // Critically damped-ish pull toward the target, then collide so it can't pass through walls.
    b.vel.copy(_c).multiplyScalar(16);
    const maxV = 30;
    if (b.vel.length() > maxV) b.vel.multiplyScalar(maxV / b.vel.length());
    _b.set(b.com.x, b.com.y - b.colHeight / 2, b.com.z);
    moveWithCollision(this.world, _b, b.vel, dt, b.colHalf, b.colHeight);
    b.com.set(_b.x, _b.y + b.colHeight / 2, _b.z);

    // Pendulum: rotate so the grab offset points up (COM hangs under the hand).
    const r = _a.length();
    if (r > 0.15) {
      _a.multiplyScalar(1 / r);
      // Torque grows with the lever arm; grabbed near the middle the root keeps its
      // orientation and the two halves do the hanging (updateLimbs).
      const lever = THREE.MathUtils.smoothstep(r / b.halfLen, 0.25, 0.6);
      _c.crossVectors(_a, UP).multiplyScalar(18 * lever);
      // Balanced upside down (grab point straight below the COM): the righting torque
      // vanishes there, so tip it sideways like any real inverted pendulum would.
      if (_a.y < -0.9) _c.x += 6 * lever;
      b.angVel.addScaledVector(_c, dt);
    }
    // Swing a little with the hand's motion.
    _c.crossVectors(UP, b.vel).multiplyScalar(0.02);
    b.angVel.addScaledVector(_c, dt * 60);
    b.angVel.multiplyScalar(Math.max(0, 1 - 5 * dt));
    b.rotate(dt);
  }

  /** Walking into a body shoves it along. Bodies are not solid to the player. */
  pushByPlayer(b, player) {
    if (b.carried) return;
    const pr = player.halfW + 0.3 * b.scale;
    const pcy = player.pos.y + player.height / 2;
    for (let k = -0.85; k <= 0.86; k += 0.425) {
      b.axisPoint(k, _a);
      const dx = _a.x - player.pos.x;
      const dz = _a.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > pr || Math.abs(_a.y - pcy) > player.height / 2 + 0.3 * b.scale) continue;
      const ps = Math.hypot(player.vel.x, player.vel.z);
      const push = (pr - d) * 10 + ps * 0.4;
      const inv = 1 / (d || 1);
      _b.set(dx * inv * push, 0.2, dz * inv * push);
      // Light touch: don't spin it wildly from a brush.
      b.pinned = false;
      b.vel.x += _b.x;
      b.vel.z += _b.z;
      _c.crossVectors(_a.sub(b.com), _b).multiplyScalar(0.25 / (b.halfLen * b.halfLen * 0.6 + 0.3));
      b.angVel.add(_c);
      b.jolt(1.5);
      b.restTime = 0;
      break;
    }
  }
}
