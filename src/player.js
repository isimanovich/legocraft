import * as THREE from 'three';
import { GRAVITY, moveWithCollision, inWater, applyBuoyancy } from './physics.js';

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.halfW = 0.3;
    this.height = 1.8;
    this.eye = 1.62;
    this.onGround = false;
    this.maxHealth = 100;
    this.health = 100;
    this.regenDelay = 0;
    this.keys = new Set();
    this.touch = { x: 0, z: 0, jump: false, sprint: false };
    this.locked = false;
    this.bob = 0;
    this.knock = new THREE.Vector3();

    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  spawn() {
    const g = this.world.findGround(this.world.sx / 2, this.world.sz / 2, 20) ||
      { x: Math.floor(this.world.sx / 2), z: Math.floor(this.world.sz / 2), y: this.world.heightAt(this.world.sx / 2, this.world.sz / 2) };
    this.pos.set(g.x + 0.5, g.y + 1.01, g.z + 0.5);
    this.vel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.syncCamera();
  }

  onMouseMove(dx, dy) {
    const s = 0.0022;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /** Unit direction the camera looks along. */
  lookDir(out = this._dir) {
    const cp = Math.cos(this.pitch);
    out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    return out;
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
  }

  /** Horizontal bearing of world point (x, z) relative to the view, in radians; positive = to the right. */
  bearingTo(x, z) {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  }

  takeDamage(amount, fromX, fromZ) {
    this.health = Math.max(0, this.health - amount);
    this.regenDelay = 5;
    const dx = this.pos.x - fromX;
    const dz = this.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.vel.x += (dx / len) * 6;
    this.vel.z += (dz / len) * 6;
    this.vel.y = Math.max(this.vel.y, 4);
    return this.health <= 0;
  }

  update(dt) {
    const k = this.keys;
    const sprint = this.touch.sprint || k.has('ShiftLeft') || k.has('ShiftRight');
    const swimming = inWater(this.world, this.pos);
    const speed = (sprint ? 8.5 : 5.2) * (swimming ? 0.55 : 1);

    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    let mx = this.touch.x;
    let mz = this.touch.z;
    if (k.has('KeyW') || k.has('ArrowUp')) mz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (Math.hypot(mx, mz) > 1) {
      const inv = 1 / Math.hypot(mx, mz);
      mx *= inv;
      mz *= inv;
    }
    const wishX = (this._fwd.x * mz + this._right.x * mx) * speed;
    const wishZ = (this._fwd.z * mz + this._right.z * mx) * speed;

    // Ground friction / air / water control
    const accel = this.onGround || swimming ? 18 : 5;
    const t = Math.min(1, accel * dt);
    this.vel.x += (wishX - this.vel.x) * t;
    this.vel.z += (wishZ - this.vel.z) * t;

    const jumping = this.touch.jump || k.has('Space');
    if (jumping && this.onGround) {
      this.vel.y = 9.2;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;
    if (swimming) applyBuoyancy(this.vel, dt, jumping);
    if (this.vel.y < -40) this.vel.y = -40;

    const res = moveWithCollision(this.world, this.pos, this.vel, dt, this.halfW, this.height);
    this.onGround = res.onGround;

    // Fell out of the world (shouldn't happen, bedrock) - respawn
    if (this.pos.y < -10) this.spawn();

    // Health regen
    if (this.regenDelay > 0) this.regenDelay -= dt;
    else if (this.health < this.maxHealth) this.health = Math.min(this.maxHealth, this.health + 4 * dt);

    // View bob
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 0.5) this.bob += dt * hs * 1.6;
    this.syncCamera();
  }

  syncCamera() {
    const bobY = Math.sin(this.bob) * 0.04;
    const bobX = Math.cos(this.bob * 0.5) * 0.02;
    this.camera.position.set(this.pos.x + bobX, this.pos.y + this.eye + bobY, this.pos.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
