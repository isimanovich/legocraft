import * as THREE from 'three';
import { BLOCK } from './world.js';

const DAY_SKY = new THREE.Color(0x64b9ff);
const NIGHT_SKY = new THREE.Color(0x111c44);
const DUSK_SKY = new THREE.Color(0xf0a17c);
const WATER_GRAVITY = 15;
const MAX_DROPS = 72;
const MAX_RIPPLES = 10;

/** Cosmetic water only: bounded droplets follow gravity and settle into surface rings. */
export class WaterSplashes {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.userData.atmosphere = true;
    scene.add(this.group);
    this.drops = [];
    this.ripples = [];
    this.cooldown = 0;
    this.wasWet = false;
    this.previousY = null;
    this.dummy = new THREE.Object3D();
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x99eaff }), MAX_DROPS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.ringGeometry = new THREE.RingGeometry(0.85, 1, 16);
  }

  surfaceAt(x, y, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    let by = Math.floor(y);
    if (this.world.get(bx, by, bz) !== BLOCK.WATER) return null;
    while (by + 1 < this.world.sy && this.world.get(bx, by + 1, bz) === BLOCK.WATER) by++;
    return by + 1;
  }

  ripple(x, y, z, strength = 1) {
    if (this.ripples.length >= MAX_RIPPLES) {
      const old = this.ripples.shift();
      this.group.remove(old.mesh);
      old.mesh.material.dispose();
    }
    const mesh = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({
      color: 0xc4f4ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.025, z);
    this.group.add(mesh);
    this.ripples.push({ mesh, age: 0, strength });
  }

  splash(x, y, z, strength = 1) {
    const count = Math.min(22, Math.ceil(8 + strength * 4));
    for (let i = 0; i < count && this.drops.length < MAX_DROPS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * (1 + strength * 0.5);
      this.drops.push({
        x, y: y + 0.04, z,
        vx: Math.cos(angle) * speed, vy: 1.7 + Math.random() * (1.3 + strength), vz: Math.sin(angle) * speed,
        surface: y, life: 1.2, size: 0.045 + Math.random() * 0.045,
      });
    }
    this.ripple(x, y, z, strength);
  }

  update(dt, player) {
    dt = Math.max(0, Math.min(dt, 0.1));
    this.cooldown = Math.max(0, this.cooldown - dt);
    const { x, y, z } = player.pos;
    const surface = this.surfaceAt(x, y + 0.05, z);
    const wet = surface !== null;
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const dropSpeed = this.previousY === null || !dt ? 0 : Math.max(0, (this.previousY - y) / dt);
    // No splash on initial spawn/resume, and no stream of particles when standing still.
    if (wet && this.previousY !== null && (!this.wasWet || (speed > 0.7 && this.cooldown === 0))) {
      this.splash(x, surface, z, this.wasWet ? 0.35 : Math.min(3, 0.7 + dropSpeed * 0.15));
      this.cooldown = 0.25;
    }
    this.wasWet = wet;
    this.previousY = y;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vy -= WATER_GRAVITY * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.life -= dt;
      if (d.life <= 0 || (d.vy < 0 && d.y <= d.surface) || this.world.isSolid(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z))) {
        this.drops.splice(i, 1);
      }
    }
    this.mesh.count = this.drops.length;
    this.drops.forEach((d, i) => {
      this.dummy.position.set(d.x, d.y, d.z);
      this.dummy.scale.setScalar(d.size * Math.min(1, d.life * 4));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const radius = 0.12 + r.age * (0.65 + r.strength * 0.1);
      r.mesh.scale.setScalar(radius);
      r.mesh.material.opacity = Math.max(0, 0.5 * (1 - r.age / 1.3));
      if (r.age >= 1.3) {
        this.group.remove(r.mesh); r.mesh.material.dispose(); this.ripples.splice(i, 1);
      }
    }
  }

  reset() {
    this.drops.length = 0;
    this.mesh.count = 0;
    for (const r of this.ripples) { this.group.remove(r.mesh); r.mesh.material.dispose(); }
    this.ripples.length = 0;
    this.wasWet = false; this.previousY = null; this.cooldown = 0;
  }
}

/** One modest shadow map and simple geometry keep this usable without postprocessing. */
export class Atmosphere {
  constructor(scene, renderer, world, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.world = world;
    this.camera = camera;
    this.elapsed = 0;
    this.shadowRefresh = 0;
    this.shadowCountdown = 0;
    this.previousDaylight = null;
    this.group = new THREE.Group();
    this.group.userData.atmosphere = true;
    scene.add(this.group);
    this.hemi = new THREE.HemisphereLight(0xdcefff, 0x718849, 1.35);
    this.sun = new THREE.DirectionalLight(0xfff4d5, 1.65);
    this.sun.castShadow = true;
    // Updating nearby shadows at 10 Hz avoids a full extra terrain pass each frame.
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.035;
    Object.assign(this.sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 140 });
    this.group.add(this.hemi, this.sun, this.sun.target);
    this.sunDisk = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 1), new THREE.MeshBasicMaterial({ color: 0xffefac, fog: false }));
    this.moon = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1), new THREE.MeshBasicMaterial({ color: 0xd5eaff, fog: false }));
    this.group.add(this.sunDisk, this.moon);
    const starPositions = [];
    for (let i = 0; i < 90; i++) {
      const angle = i * 2.39996, elevation = 0.15 + ((i * 37) % 89) / 100;
      const radius = Math.sqrt(1 - elevation * elevation) * 115;
      starPositions.push(Math.cos(angle) * radius, elevation * 115, Math.sin(angle) * radius);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xe4edff, size: 0.35, fog: false }));
    this.group.add(this.stars);
    this.clouds = new THREE.Group();
    this.cloudMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    const cloudGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 12; i++) {
      const cloud = new THREE.Mesh(cloudGeo, this.cloudMaterial);
      cloud.scale.set(8 + i % 4 * 3, 1.2, 4 + i % 3 * 2);
      cloud.position.set((i * 39 % 170) - 85, 60 + i % 3 * 3, (i * 67 % 170) - 85);
      this.clouds.add(cloud);
    }
    this.group.add(this.clouds);
    this.splashes = new WaterSplashes(scene, world);
    if (!scene.background?.isColor) scene.background = DAY_SKY.clone();
    if (!scene.fog) scene.fog = new THREE.Fog(DAY_SKY, 70, 150);
    this.setQuality('laptop');
  }

  setQuality(controlMode) {
    const mobile = controlMode !== 'laptop';
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const size = mobile ? 256 : 512;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.needsUpdate = true;
    this.shadowCountdown = 0;
  }

  update(dt, player, timeOfDay = 0.25) {
    dt = Math.max(0, Math.min(dt, 0.1));
    this.elapsed += dt;
    const phase = Number.isFinite(timeOfDay) ? timeOfDay : 0.25;
    const angle = phase * Math.PI * 2;
    const elevation = Math.sin(angle);
    const daylight = THREE.MathUtils.smoothstep(elevation, -0.15, 0.5);
    this.shadowCountdown -= dt;
    const isDay = elevation >= 0;
    if (this.shadowCountdown <= 1e-6 || this.previousDaylight !== isDay) {
      this.sun.shadow.needsUpdate = true;
      this.shadowCountdown = 0.1;
    }
    this.previousDaylight = isDay;
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);
    this.scene.background.copy(NIGHT_SKY).lerp(DAY_SKY, daylight).lerp(DUSK_SKY, dusk * 0.6);
    this.scene.fog.color.copy(this.scene.background);
    this.hemi.intensity = THREE.MathUtils.lerp(0.42, 1.2, daylight);
    this.hemi.color.setHex(0xa5c2ff).lerp(new THREE.Color(0xe2f4ff), daylight);
    this.sun.intensity = THREE.MathUtils.lerp(0.28, 1.5, daylight);
    this.sun.color.setHex(0x9bbcff).lerp(new THREE.Color(0xfff0ce), daylight);
    const x = player.pos.x, z = player.pos.z;
    // At night the same light follows the moon; keep the shadow volume near the player.
    const sign = elevation >= 0 ? 1 : -1;
    this.sun.position.set(x + Math.cos(angle) * 55 * sign, 22 + Math.abs(elevation) * 65, z + 30);
    this.sun.target.position.set(x, 10, z);
    this.sunDisk.position.set(x + Math.cos(angle) * 100, 20 + elevation * 100, z - 45);
    this.moon.position.set(x - Math.cos(angle) * 100, 20 - elevation * 100, z - 45);
    this.sunDisk.visible = elevation > -0.1;
    this.moon.visible = elevation < 0.1;
    this.sunDisk.lookAt(this.camera.position); this.moon.lookAt(this.camera.position);
    this.stars.position.set(x, 0, z);
    this.stars.visible = daylight < 0.25;
    this.clouds.position.set(x + Math.sin(this.elapsed * 0.008) * 10, 0, z);
    this.cloudMaterial.color.setHex(0x64769a).lerp(new THREE.Color(0xffffff), daylight);
    this.splashes.update(dt, player);
    this.shadowRefresh -= dt;
    if (this.shadowRefresh <= 0) {
      // Also catches rebuilt chunks and newly spawned creatures. Camera-held items stay unshadowed.
      const mark = (node, excluded = false) => {
        excluded ||= node === this.camera || !!node.userData.atmosphere || !!node.userData.debris;
        if (node.isMesh && !excluded) { node.castShadow = true; node.receiveShadow = true; }
        if (!excluded) for (const child of node.children) mark(child);
      };
      mark(this.scene);
      this.shadowRefresh = 0.5;
    }
  }

  reset() {
    this.splashes.reset();
    this.shadowCountdown = 0;
    this.sun.shadow.needsUpdate = true;
  }
}
