// Reuse the game's terrain, AI, collision and ragdoll simulation without a renderer,
// canvas, chunk meshes, or enemy meshes. Object3D supplies transforms only.
import * as THREE from 'three';
import { World } from '../src/world.js';
import { Enemy, ENEMY_TYPES, typeHeight, waveMods } from '../src/enemies.js';
import { Animal, ANIMAL_TYPES } from '../src/animals.js';

export function createWorld(seed) {
  const world = Object.assign(Object.create(World.prototype), {
    sx: 144, sy: 48, sz: 144, chunk: 16, seed, studs: false,
    data: new Uint8Array(144 * 48 * 144), meshes: [], dirty: new Set(),
    markDirty() {},
  });
  world.generate();
  return world;
}

const node = () => new THREE.Object3D();
const material = () => ({ emissive: new THREE.Color(), dispose() {} });

export function createEnemy(kind, x, y, z, wave = 1) {
  const type = ENEMY_TYPES[kind];
  const mods = waveMods(wave);
  const enemy = Object.assign(Object.create(Enemy.prototype), {
    typeKey: kind, type, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(),
    hp: Math.round(type.hp * mods.hp), maxHp: Math.round(type.hp * mods.hp),
    dmg: Math.round(type.dmg * mods.dmg), speed: type.speed * mods.speed,
    halfW: 0.32 * type.scale, height: typeHeight(type), onGround: false,
    state: 'wander', wanderTimer: 0, wanderDir: new THREE.Vector3(),
    stuckTimer: 0, jumpCooldown: 0, detourTimer: 0, detourDir: new THREE.Vector3(),
    detourSide: 1, detourStreak: 0, freeTimer: 0, path: null, pathIdx: 0,
    repathTimer: Math.random() * 0.5, attackCooldown: 0, windup: -1,
    flash: 0, walkPhase: 0, facing: Math.random() * Math.PI * 2,
    dead: false, fuse: 0, blinkOn: false, blinkPending: false, tag: null,
    group: node(), legL: node(), legR: node(), upper: node(), armL: node(), armR: node(), head: node(),
    waist: type.stalker ? 0.95 : 0.62,
    mats: { skin: material(), torso: material(), legs: material(),
      black: material(), eyes: type.stalker ? material() : null,
      fuseTip: type.bomber ? material() : null },
  });
  enemy.group.position.copy(enemy.pos);
  enemy.group.scale.setScalar(type.scale);
  return enemy;
}

export function createAnimal(kind, x, y, z) {
  const type = ANIMAL_TYPES[kind];
  return Object.assign(Object.create(Animal.prototype), {
    kind, type, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(),
    halfW: 0.3 * type.scale, height: 0.85 * type.scale, onGround: false,
    facing: Math.random() * Math.PI * 2, state: 'idle', timer: 1 + Math.random() * 2,
    dir: new THREE.Vector3(), walkPhase: 0, jumpCooldown: 0,
    group: node(), legs: [], head: node(), tail: node(), mats: {}, tag: null,
  });
}
