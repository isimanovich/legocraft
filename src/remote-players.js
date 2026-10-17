import * as THREE from 'three';
import { makeNameTag, NAME_TAG_SIZE } from './enemies.js';

const SNAPSHOT_SECONDS = 0.1;
const TELEPORT_DISTANCE = 8;
const COLORS = [0x0055bf, 0xc91a09, 0x237841, 0x81007b, 0x36aebf, 0xfe8a18];

function colorFor(player) {
  if (Number.isInteger(player.color) && player.color >= 0 && player.color <= 0xffffff) return player.color;
  if (typeof player.color === 'string' && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(player.color)) return player.color;
  let hash = 0;
  for (const char of String(player.id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function positionOf(player) {
  const pos = player.pos ?? [player.x, player.y, player.z];
  return Array.isArray(pos) && pos.length >= 3 && pos.slice(0, 3).every(Number.isFinite) ? pos : null;
}

function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function disposeTag(tag) {
  if (!tag) return;
  tag.removeFromParent();
  tag.material.map?.dispose();
  tag.material.dispose();
}

/** Visual presence only: peers never collide with or change the local simulation. */
export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.peers = new Map();
    this.disposed = false;
    // One geometry set per scene, shared by every peer and released on teardown.
    this.geometries = {
      leg: new THREE.BoxGeometry(0.27, 0.55, 0.32),
      hip: new THREE.BoxGeometry(0.6, 0.14, 0.32),
      torso: new THREE.BoxGeometry(0.6, 0.6, 0.34),
      arm: new THREE.BoxGeometry(0.19, 0.48, 0.2),
      hand: new THREE.BoxGeometry(0.16, 0.14, 0.16),
      neck: new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10),
      head: new THREE.CylinderGeometry(0.28, 0.28, 0.4, 12),
      stud: new THREE.CylinderGeometry(0.13, 0.13, 0.1, 10),
      eye: new THREE.BoxGeometry(0.065, 0.075, 0.035),
      mouth: new THREE.BoxGeometry(0.16, 0.03, 0.035),
    };
  }

  createPeer(player, pos) {
    const group = new THREE.Group();
    group.name = `remote-player-${player.id}`;
    const material = (color) => new THREE.MeshLambertMaterial({ color });
    const materials = {
      torso: material(colorFor(player)), skin: material(0xf2cd37),
      legs: material(0x05131d), face: material(0x05131d),
      healthBack: new THREE.SpriteMaterial({ color: 0x731b1b, depthWrite: false }),
      healthFill: new THREE.SpriteMaterial({ color: 0x62c350, depthWrite: false }),
    };
    const mesh = (kind, mat, x, y, z) => {
      const node = new THREE.Mesh(this.geometries[kind], materials[mat]);
      node.position.set(x, y, z);
      return node;
    };
    const legL = new THREE.Group();
    const legR = new THREE.Group();
    legL.position.set(-0.16, 0.55, 0);
    legR.position.set(0.16, 0.55, 0);
    legL.add(mesh('leg', 'legs', 0, -0.275, 0));
    legR.add(mesh('leg', 'legs', 0, -0.275, 0));
    group.add(legL, legR, mesh('hip', 'legs', 0, 0.62, 0), mesh('torso', 'torso', 0, 0.99, 0));
    const armL = new THREE.Group();
    const armR = new THREE.Group();
    armL.position.set(-0.4, 1.24, 0);
    armR.position.set(0.4, 1.24, 0);
    armL.rotation.z = -0.1;
    armR.rotation.z = 0.1;
    for (const arm of [armL, armR]) {
      arm.add(mesh('arm', 'torso', 0, -0.24, 0), mesh('hand', 'skin', 0, -0.53, 0));
    }
    group.add(armL, armR);
    const head = new THREE.Group();
    head.position.set(0, 1.3, 0);
    head.add(mesh('neck', 'skin', 0, 0.02, 0), mesh('head', 'skin', 0, 0.22, 0), mesh('stud', 'skin', 0, 0.45, 0));
    // Player yaw zero faces -Z, matching the local camera and movement controls.
    head.add(mesh('eye', 'face', -0.09, 0.27, -0.267), mesh('eye', 'face', 0.09, 0.27, -0.267), mesh('mouth', 'face', 0, 0.13, -0.28));
    group.add(head);
    const healthBack = new THREE.Sprite(materials.healthBack);
    const healthFill = new THREE.Sprite(materials.healthFill);
    healthBack.position.y = healthFill.position.y = 2.03;
    healthBack.scale.set(0.9, 0.075, 1);
    healthFill.scale.set(0.86, 0.045, 1);
    healthBack.renderOrder = 2;
    healthFill.renderOrder = 3;
    group.add(healthBack, healthFill);
    group.position.set(...pos);
    group.rotation.y = Number.isFinite(player.yaw) ? player.yaw : 0;
    const peer = {
      group, materials, legL, legR, armL, armR, head, healthFill, healthBack,
      from: group.position.clone(), target: group.position.clone(), elapsed: SNAPSHOT_SECONDS,
      fromYaw: group.rotation.y, targetYaw: group.rotation.y, fromPitch: 0, targetPitch: 0,
      phase: 0, dead: false, paused: false, tag: null, label: null,
    };
    this.scene.add(group);
    this.peers.set(player.id, peer);
    return peer;
  }

  /** Apply a complete server snapshot; omitted peers have left the session. */
  updatePlayers(players, selfId) {
    if (this.disposed) return;
    const seen = new Set();
    for (const player of players) {
      if (!player || player.id == null || player.id === selfId) continue;
      const pos = positionOf(player);
      if (!pos) continue;
      seen.add(player.id);
      const peer = this.peers.get(player.id) ?? this.createPeer(player, pos);
      peer.from.copy(peer.group.position);
      peer.target.set(...pos);
      peer.fromYaw = peer.group.rotation.y;
      peer.targetYaw = peer.fromYaw + angleDelta(peer.fromYaw, Number.isFinite(player.yaw) ? player.yaw : peer.fromYaw);
      peer.fromPitch = peer.head.rotation.x;
      peer.targetPitch = Number.isFinite(player.pitch) ? THREE.MathUtils.clamp(player.pitch, -1.5, 1.5) : 0;
      peer.elapsed = 0;
      // Respawns and reconnects should not sweep an avatar across the whole map.
      if (peer.from.distanceTo(peer.target) > TELEPORT_DISTANCE) {
        peer.group.position.copy(peer.target);
        peer.from.copy(peer.target);
        peer.group.rotation.y = peer.targetYaw;
        peer.fromYaw = peer.targetYaw;
      }
      const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 100;
      const health = Number.isFinite(player.health) ? THREE.MathUtils.clamp(player.health / maxHealth, 0, 1) : 1;
      peer.dead = player.dead === true || health <= 0;
      peer.paused = player.active === false && !peer.dead;
      const opacity = peer.dead ? 0.25 : peer.paused ? 0.55 : 1;
      for (const key of ['torso', 'skin', 'legs', 'face']) {
        const mat = peer.materials[key];
        const transparent = opacity < 1;
        if (mat.transparent !== transparent) {
          mat.transparent = transparent;
          mat.depthWrite = !transparent;
          mat.needsUpdate = true;
        }
        mat.opacity = opacity;
      }
      peer.materials.torso.color.set(colorFor(player));
      peer.healthFill.scale.x = Math.max(0.001, 0.86 * health);
      peer.healthFill.visible = !peer.dead;
      peer.healthBack.visible = !peer.dead;
      const name = String(player.name ?? 'Player').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'Player';
      const label = `${name}${peer.dead ? ' (respawning)' : peer.paused ? ' (paused)' : ''}`;
      if (label !== peer.label) {
        disposeTag(peer.tag);
        peer.label = label;
        peer.tag = makeNameTag(label, { color: '#ffffff', cache: false });
        if (peer.tag) {
          peer.tag.position.y = 2.31;
          peer.tag.scale.set(NAME_TAG_SIZE.w, NAME_TAG_SIZE.h, 1);
          peer.group.add(peer.tag);
        }
      }
    }
    for (const [id, peer] of this.peers) {
      if (!seen.has(id)) this.removePeer(id, peer);
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || this.disposed) return;
    for (const peer of this.peers.values()) {
      const oldX = peer.group.position.x;
      const oldZ = peer.group.position.z;
      peer.elapsed = Math.min(SNAPSHOT_SECONDS, peer.elapsed + dt);
      const t = peer.elapsed / SNAPSHOT_SECONDS;
      peer.group.position.lerpVectors(peer.from, peer.target, t);
      peer.group.rotation.y = THREE.MathUtils.lerp(peer.fromYaw, peer.targetYaw, t);
      peer.head.rotation.x = THREE.MathUtils.lerp(peer.fromPitch, peer.targetPitch, t);
      const distance = Math.hypot(peer.group.position.x - oldX, peer.group.position.z - oldZ);
      const walking = !peer.dead && !peer.paused && distance > 0.0001;
      peer.phase += distance * 2.5;
      const swing = walking ? Math.sin(peer.phase) * 0.55 : 0;
      peer.legL.rotation.x = swing;
      peer.legR.rotation.x = -swing;
      peer.armL.rotation.x = -swing * 0.8;
      peer.armR.rotation.x = swing * 0.8;
    }
  }

  removePeer(id, peer) {
    peer.group.removeFromParent();
    disposeTag(peer.tag);
    for (const mat of Object.values(peer.materials)) mat.dispose();
    this.peers.delete(id);
  }

  clear() {
    for (const [id, peer] of this.peers) this.removePeer(id, peer);
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.disposed = true;
  }
}
