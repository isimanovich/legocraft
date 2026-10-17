// Passive creatures the player can spawn: a wolf and a cat. They wander, sit, swim,
// occasionally come over to see what you're doing, and run off when hit. They have
// no health and never attack; nothing in the game targets them.
import * as THREE from 'three';
import { GRAVITY, moveWithCollision, inWater, applyBuoyancy, boxCollides } from './physics.js';
import { makeNameTag } from './enemies.js';

export const ANIMAL_TYPES = {
  wolf: { name: 'Wolf', scale: 1.0, speed: 3.2, fur: 0x9ba19d, dark: 0x6c6e68, light: 0xe6e6e6, eye: 0xf2cd37, tail: 'straight' },
  cat: { name: 'Cat', scale: 0.62, speed: 2.8, fur: 0xfe8a18, dark: 0xc96a0a, light: 0xf4f4f4, eye: 0x4b9f4a, tail: 'curl' },
};

const _tmp = new THREE.Vector3();

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

export class Animal {
  constructor(kind, x, y, z) {
    const t = ANIMAL_TYPES[kind];
    this.kind = kind;
    this.type = t;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.halfW = 0.3 * t.scale;
    this.height = 0.85 * t.scale;
    this.onGround = false;
    this.facing = Math.random() * Math.PI * 2;
    this.state = 'idle'; // idle | walk | flee | sit
    this.timer = 1 + Math.random() * 2;
    this.dir = new THREE.Vector3();
    this.walkPhase = 0;
    this.jumpCooldown = 0;
    this.mats = {
      fur: new THREE.MeshLambertMaterial({ color: t.fur }),
      dark: new THREE.MeshLambertMaterial({ color: t.dark }),
      light: new THREE.MeshLambertMaterial({ color: t.light }),
      eye: new THREE.MeshLambertMaterial({ color: t.eye, emissive: t.eye, emissiveIntensity: 0.4 }),
      nose: new THREE.MeshLambertMaterial({ color: 0x1b1b1b }),
    };
    this.group = this.build();
    this.group.scale.setScalar(t.scale);
    this.group.position.copy(this.pos);
    this.tag = makeNameTag(t.name);
    if (this.tag) {
      this.tag.position.y = this.height / t.scale + 0.4 / t.scale;
      this.tag.scale.set(1.5 / t.scale, 0.4 / t.scale, 1);
      this.group.add(this.tag);
    }
  }

  /** Blocky quadruped, origin at the feet, facing +z. Same proportions for both; scale and colours differ. */
  build() {
    const g = new THREE.Group();
    const M = this.mats;
    const body = box(0.42, 0.36, 0.9, M.fur);
    body.position.set(0, 0.6, 0);
    g.add(body);
    const chest = box(0.3, 0.2, 0.3, M.light); // white bib
    chest.position.set(0, 0.52, 0.32);
    g.add(chest);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.78, 0.5);
    const skull = box(0.36, 0.32, 0.34, M.fur);
    this.head.add(skull);
    const snout = box(0.2, 0.16, 0.18, M.light);
    snout.position.set(0, -0.06, 0.24);
    this.head.add(snout);
    const nose = box(0.08, 0.06, 0.04, M.nose);
    nose.position.set(0, -0.02, 0.34);
    this.head.add(nose);
    for (const s of [-1, 1]) {
      const eye = box(0.06, 0.06, 0.03, M.eye);
      eye.position.set(s * 0.1, 0.05, 0.18);
      this.head.add(eye);
      const ear = box(0.1, 0.16, 0.06, M.dark);
      ear.position.set(s * 0.12, 0.22, -0.04);
      ear.rotation.z = -s * 0.15;
      this.head.add(ear);
    }
    g.add(this.head);
    this.legs = [];
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.14, 0.45, sz * 0.3);
      const leg = box(0.12, 0.45, 0.12, M.dark);
      leg.position.y = -0.22;
      pivot.add(leg);
      pivot.userData.phase = sx * sz > 0 ? 0 : Math.PI; // diagonal pairs move together
      g.add(pivot);
      this.legs.push(pivot);
    }
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.7, -0.45);
    const tailSeg = box(0.08, 0.08, 0.4, M.dark);
    tailSeg.position.z = -0.2;
    this.tail.add(tailSeg);
    if (this.type.tail === 'curl') {
      const tip = box(0.08, 0.3, 0.08, M.dark);
      tip.position.set(0, 0.12, -0.4);
      this.tail.add(tip);
    } else {
      this.tail.rotation.x = 0.4; // hangs down a little
    }
    g.add(this.tail);
    return g;
  }

  get center() {
    return _tmp.set(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
  }

  /** Something hit or startled it: bolt away from (fx, fz) for a while. */
  startle(fx, fz) {
    const dx = this.pos.x - fx;
    const dz = this.pos.z - fz;
    const len = Math.hypot(dx, dz) || 1;
    this.dir.set(dx / len, 0, dz / len);
    this.state = 'flee';
    this.timer = 2.5 + Math.random();
    this.vel.x += this.dir.x * 4;
    this.vel.z += this.dir.z * 4;
    this.vel.y = Math.max(this.vel.y, 4);
  }

  update(dt, world, player) {
    const t = this.type;
    // Decide what to do next.
    this.timer -= dt;
    if (this.timer <= 0) {
      const r = Math.random();
      const toPlayer = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      if (r < 0.3) {
        this.state = this.kind === 'cat' && Math.random() < 0.5 ? 'sit' : 'idle';
        this.timer = 1.5 + Math.random() * 3;
      } else if (r < 0.5 && toPlayer > 2.5 && toPlayer < 12) {
        // Curious: come and have a look.
        this.dir.set(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z).normalize();
        this.state = 'walk';
        this.timer = Math.min(3, toPlayer / t.speed);
      } else {
        const a = Math.random() * Math.PI * 2;
        this.dir.set(Math.sin(a), 0, Math.cos(a));
        this.state = 'walk';
        this.timer = 1 + Math.random() * 2.5;
      }
    }
    let speed = 0;
    if (this.state === 'walk') speed = t.speed * 0.5;
    else if (this.state === 'flee') speed = t.speed * 1.6;
    // Keep off the player's toes.
    const pdx = this.pos.x - player.pos.x;
    const pdz = this.pos.z - player.pos.z;
    const pd = Math.hypot(pdx, pdz);
    let wishX = this.dir.x * speed;
    let wishZ = this.dir.z * speed;
    if (pd < 1.2 && this.state !== 'flee') {
      wishX += (pdx / (pd || 1)) * 1.5;
      wishZ += (pdz / (pd || 1)) * 1.5;
    }

    const swimming = inWater(world, this.pos);
    this.vel.y -= GRAVITY * dt;
    if (swimming) applyBuoyancy(this.vel, dt, true);
    const accel = this.onGround || swimming ? 12 : 3;
    this.vel.x += (wishX - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wishZ - this.vel.z) * Math.min(1, accel * dt);
    const res = moveWithCollision(world, this.pos, this.vel, dt, this.halfW, this.height);
    this.onGround = res.onGround;
    this.jumpCooldown -= dt;
    if (res.hitWall && this.onGround && speed > 0 && this.jumpCooldown <= 0) {
      // Hop one block up like everyone else; if that fails a few times, turn around.
      if (!boxCollides(world, this.pos.x, this.pos.y + 1.05, this.pos.z, this.halfW, this.height)) {
        this.vel.y = 7.5;
        this.jumpCooldown = 0.6;
      } else if (this.state === 'flee') {
        // Don't run back into whatever scared it: sidestep along the wall instead.
        const side = Math.random() < 0.5 ? 1 : -1;
        this.dir.set(-this.dir.z * side, 0, this.dir.x * side);
        this.jumpCooldown = 0.3;
      } else {
        this.dir.multiplyScalar(-1);
        this.timer = Math.min(this.timer, 1);
      }
    }
    if (speed > 0 && Math.hypot(this.vel.x, this.vel.z) > 0.1) this.facing = Math.atan2(this.vel.x, this.vel.z);

    // Animate.
    const moving = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (4 + moving * 3);
    const swing = moving > 0.2 ? Math.min(1, moving / 2) * 0.7 : 0;
    for (const leg of this.legs) leg.rotation.x = Math.sin(this.walkPhase + leg.userData.phase) * swing;
    const sitting = this.state === 'sit';
    this.group.rotation.x = sitting ? -0.35 : 0;
    this.group.position.copy(this.pos);
    if (sitting) this.group.position.y -= 0.12 * t.scale;
    this.group.rotation.y = this.facing;
    this.head.rotation.y = Math.sin(this.walkPhase * 0.3) * 0.25;
    if (t.tail === 'curl') this.tail.rotation.z = Math.sin(this.walkPhase * 0.8) * 0.3;
    else this.tail.rotation.y = Math.sin(this.walkPhase * 1.5) * (this.state === 'flee' ? 0.1 : 0.5); // wag
  }

  dispose() {
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
