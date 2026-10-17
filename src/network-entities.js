// Render the server's shared creatures and objects. These instances supply the
// same hit boxes and compass data as solo play, but never run local AI/physics.
import * as THREE from 'three';
import { Enemy, ENEMY_TYPES, FUSE_SECONDS, makeNameTag, NAME_TAG_SIZE } from './enemies.js';
import { Animal, ANIMAL_TYPES } from './animals.js';

const validId = (id) => typeof id === 'string' || typeof id === 'number';
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const removeFrom = (array, item) => {
  const index = array.indexOf(item);
  if (index !== -1) array.splice(index, 1);
};

export class NetworkEntities {
  constructor({ scene, world, enemies, animals, ragdolls }) {
    this.scene = scene;
    this.world = world;
    this.enemies = enemies;
    this.animals = animals;
    this.ragdolls = ragdolls;
    this.enemyRecords = new Map();
    this.animalRecords = new Map();
    this.projectileRecords = new Map();
    this.bodyRecords = new Map();
    this.projectileGeometry = null;
    this.projectileMaterial = null;
  }

  /** Apply complete arrays from a snapshot; omitted arrays remain unchanged. */
  apply(snapshot) {
    if (!snapshot) return;
    this.reconcile(this.enemyRecords, snapshot.enemies, (s) => this.createEnemy(s),
      (record, s, fresh) => this.applyEnemy(record, s, fresh), (record) => this.removeEnemy(record));
    this.reconcile(this.animalRecords, snapshot.animals, (s) => this.createAnimal(s),
      (record, s, fresh) => this.applyAnimal(record, s, fresh), (record) => this.removeAnimal(record));
    this.reconcile(this.projectileRecords, snapshot.projectiles, (s) => this.createProjectile(s),
      (record, s, fresh) => this.setTarget(record, s, fresh), (record) => this.scene.remove(record.entity));
    this.reconcile(this.bodyRecords, snapshot.bodies, (s) => this.createBody(s),
      (record, s, fresh) => this.applyBody(record, s, fresh), (record) => this.ragdolls.remove(record.entity));
  }

  reconcile(records, snapshots, create, apply, remove) {
    if (!Array.isArray(snapshots)) return;
    const seen = new Set();
    const accepted = [];
    for (const snapshot of snapshots) {
      if (!snapshot || !validId(snapshot.id) || seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);
      accepted.push(snapshot);
    }
    // Retire absent bodies before adding replacements: Ragdolls has a bounded
    // body count, and adding first could evict a body the snapshot still needs.
    for (const [id, record] of records) {
      if (seen.has(id)) continue;
      remove(record);
      records.delete(id);
    }
    for (const snapshot of accepted) {
      let record = records.get(snapshot.id);
      // Entity IDs normally retain their kind; handle a changed kind safely.
      if (record && snapshot.kind && record.kind !== snapshot.kind) {
        remove(record);
        records.delete(snapshot.id);
        record = null;
      }
      const fresh = !record;
      if (!record) {
        record = create(snapshot);
        if (!record) continue;
        records.set(snapshot.id, record);
      }
      apply(record, snapshot, fresh);
    }
  }

  createEnemy(snapshot) {
    if (!Object.hasOwn(ENEMY_TYPES, snapshot.kind)) return null;
    const entity = new Enemy(snapshot.kind, finite(snapshot.x), finite(snapshot.y), finite(snapshot.z));
    entity.netId = snapshot.id;
    this.scene.add(entity.group);
    this.enemies.push(entity);
    return { entity, kind: snapshot.kind, target: entity.pos.clone() };
  }

  setTarget(record, snapshot, fresh) {
    const position = record.entity.pos || record.entity.position;
    record.target.set(finite(snapshot.x), finite(snapshot.y), finite(snapshot.z));
    // Do not drag a teleport (or a newly joined entity) across the map.
    if (fresh || position.distanceToSquared(record.target) > 64) position.copy(record.target);
  }

  applyEnemy(record, snapshot, fresh) {
    const enemy = record.entity;
    this.setTarget(record, snapshot, fresh);
    enemy.facing = finite(snapshot.facing, enemy.facing);
    enemy.hp = finite(snapshot.hp, enemy.hp);
    enemy.maxHp = finite(snapshot.maxHp, enemy.maxHp);
    enemy.state = snapshot.state || 'wander';
    enemy.windup = finite(snapshot.windup, -1);
    enemy.fuse = finite(snapshot.fuse);
    enemy.flash = finite(snapshot.flash);
    enemy.group.position.copy(enemy.pos);
    if (fresh) enemy.group.rotation.y = enemy.facing;
  }

  createAnimal(snapshot) {
    if (!Object.hasOwn(ANIMAL_TYPES, snapshot.kind)) return null;
    const entity = new Animal(snapshot.kind, finite(snapshot.x), finite(snapshot.y), finite(snapshot.z));
    entity.netId = snapshot.id;
    this.scene.add(entity.group);
    this.animals.push(entity);
    return { entity, kind: snapshot.kind, target: entity.pos.clone() };
  }

  applyAnimal(record, snapshot, fresh) {
    const animal = record.entity;
    this.setTarget(record, snapshot, fresh);
    animal.facing = finite(snapshot.facing, animal.facing);
    animal.state = snapshot.state || 'idle';
    if (fresh) {
      animal.group.rotation.y = animal.facing;
      animal.walkPhase = finite(snapshot.walkPhase);
    }
    animal.group.position.copy(animal.pos);
  }

  createProjectile(snapshot) {
    if (!this.projectileGeometry) {
      this.projectileGeometry = new THREE.SphereGeometry(0.16, 8, 6);
      this.projectileMaterial = new THREE.MeshLambertMaterial({ color: 0xe63022 });
    }
    const entity = new THREE.Mesh(this.projectileGeometry, this.projectileMaterial);
    this.scene.add(entity);
    return { entity, kind: snapshot.kind, target: new THREE.Vector3() };
  }

  createBody(snapshot) {
    const enemy = new Enemy('stalker', finite(snapshot.x), finite(snapshot.y), finite(snapshot.z));
    this.scene.add(enemy.group);
    const entity = this.ragdolls.add(enemy);
    entity.netId = snapshot.id;
    return {
      entity,
      kind: snapshot.kind || 'stalker',
      target: entity.com.clone(),
      quaternion: new THREE.Quaternion(),
      limbs: [],
    };
  }

  applyBody(record, snapshot, fresh) {
    const body = record.entity;
    record.quaternion.set(finite(snapshot.qx), finite(snapshot.qy), finite(snapshot.qz), finite(snapshot.qw, 1));
    if (record.quaternion.lengthSq() < 0.0001) record.quaternion.identity();
    else record.quaternion.normalize();
    // The server sends the model's feet-origin pose. Ragdolls use its centre
    // of mass, so derive that centre before syncing the existing hit-test rig.
    record.target.set(0, body.halfLen, 0).applyQuaternion(record.quaternion);
    record.target.x += finite(snapshot.x);
    record.target.y += finite(snapshot.y);
    record.target.z += finite(snapshot.z);
    if (fresh || body.com.distanceToSquared(record.target) > 64) {
      body.com.copy(record.target);
      body.q.copy(record.quaternion);
    }
    body.carriedBy = snapshot.carrying ?? null;
    body.carried = body.carriedBy !== null;
    record.limbs = Array.isArray(snapshot.limbs) ? snapshot.limbs : [];
    if (fresh) this.syncBodyLimbs(record, 1);
    const name = typeof snapshot.name === 'string' ? snapshot.name.trim() : '';
    if (body.name !== name) {
      this.ragdolls.setName(body, name, (text) => {
        const label = makeNameTag(text, { color: '#ffffff', pill: 'rgba(60, 20, 80, 0.8)', cache: false });
        label?.scale.set(NAME_TAG_SIZE.w, NAME_TAG_SIZE.h, 1);
        return label;
      });
    }
    this.syncBody(body);
  }

  syncBody(body) {
    body.up.set(0, 1, 0).applyQuaternion(body.q);
    body.sync();
    if (body.label) this.ragdolls.placeLabel(body);
  }

  syncBodyLimbs(record, alpha) {
    for (let i = 0; i < record.entity.limbs.length; i++) {
      const pose = record.limbs[i];
      if (!Array.isArray(pose)) continue;
      const rotation = record.entity.limbs[i].node.rotation;
      rotation.x += angleDelta(rotation.x, finite(pose[0], rotation.x)) * alpha;
      rotation.z += angleDelta(rotation.z, finite(pose[1], rotation.z)) * alpha;
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const alpha = 1 - Math.exp(-16 * Math.min(dt, 0.1));
    for (const record of this.enemyRecords.values()) {
      const enemy = record.entity;
      const speed = this.moveCreature(record, alpha, dt);
      enemy.walkPhase += dt * (2 + speed * 2.2);
      const swing = Math.sin(enemy.walkPhase) * Math.min(0.8, speed * 0.25);
      enemy.legL.rotation.x = swing;
      enemy.legR.rotation.x = -swing;
      enemy.armL.rotation.x = -swing * 0.8;
      if (enemy.windup >= 0) {
        const phase = Math.min(1, enemy.windup / 0.35);
        enemy.armR.rotation.x = phase < 0.6 ? -2.4 * phase / 0.6 : -2.4 + (phase - 0.6) / 0.4 * 3.2;
      } else enemy.armR.rotation.x = swing * 0.8;
      enemy.group.rotation.x = enemy.state === 'chase' ? Math.min(0.12, speed * 0.03) : 0;
      enemy.flash = Math.max(0, enemy.flash - dt);
      for (const material of Object.values(enemy.mats)) {
        if (material) material.emissive.setHex(enemy.flash > 0 ? 0xff3333 : 0);
      }
      if (enemy.mats.eyes) enemy.mats.eyes.emissive.setHex(0xcc22ff);
      if (enemy.mats.fuseTip) enemy.mats.fuseTip.emissive.setHex(0xff5500);
      if (enemy.type.bomber) {
        const fuse = Math.min(1, enemy.fuse / FUSE_SECONDS);
        const lit = fuse > 0 && Math.floor(enemy.fuse * (3 + fuse * fuse * 14)) % 2 === 0;
        enemy.group.scale.setScalar(enemy.type.scale * (1 + 0.22 * fuse * (lit ? 1 : 0.6)));
        if (enemy.flash <= 0) {
          enemy.mats.torso.emissive.setHex(lit ? 0xdddddd : 0);
          enemy.mats.legs.emissive.setHex(lit ? 0xdddddd : 0);
          enemy.mats.skin.emissive.setHex(lit ? 0x666666 : 0);
        }
      }
    }
    for (const record of this.animalRecords.values()) {
      const animal = record.entity;
      const speed = this.moveCreature(record, alpha, dt);
      animal.walkPhase += dt * (4 + speed * 3);
      const swing = speed > 0.2 ? Math.min(1, speed / 2) * 0.7 : 0;
      for (const leg of animal.legs) leg.rotation.x = Math.sin(animal.walkPhase + leg.userData.phase) * swing;
      const sitting = animal.state === 'sit';
      animal.group.rotation.x = sitting ? -0.35 : 0;
      if (sitting) animal.group.position.y -= 0.12 * animal.type.scale;
      animal.head.rotation.y = Math.sin(animal.walkPhase * 0.3) * 0.25;
      if (animal.type.tail === 'curl') animal.tail.rotation.z = Math.sin(animal.walkPhase * 0.8) * 0.3;
      else animal.tail.rotation.y = Math.sin(animal.walkPhase * 1.5) * (animal.state === 'flee' ? 0.1 : 0.5);
    }
    for (const record of this.projectileRecords.values()) record.entity.position.lerp(record.target, alpha);
    for (const record of this.bodyRecords.values()) {
      const body = record.entity;
      body.com.lerp(record.target, alpha);
      body.q.slerp(record.quaternion, alpha);
      this.syncBodyLimbs(record, alpha);
      this.syncBody(body);
    }
  }

  moveCreature(record, alpha, dt) {
    const entity = record.entity;
    const dx = record.target.x - entity.pos.x;
    const dz = record.target.z - entity.pos.z;
    entity.pos.lerp(record.target, alpha);
    entity.vel.set(dx * alpha / dt, 0, dz * alpha / dt);
    entity.group.position.copy(entity.pos);
    entity.group.rotation.y += angleDelta(entity.group.rotation.y, entity.facing) * alpha;
    return Math.min(12, Math.hypot(entity.vel.x, entity.vel.z));
  }

  removeEnemy(record) {
    this.scene.remove(record.entity.group);
    removeFrom(this.enemies, record.entity);
    record.entity.dispose(); // Enemy geometry and default tags are shared.
  }

  removeAnimal(record) {
    this.scene.remove(record.entity.group);
    removeFrom(this.animals, record.entity);
    record.entity.dispose();
    // Animal builds its own geometry; its default name-tag material is shared.
    const geometries = new Set();
    record.entity.group.traverse((node) => { if (node.isMesh) geometries.add(node.geometry); });
    for (const geometry of geometries) geometry.dispose();
  }

  clear() {
    for (const record of this.enemyRecords.values()) this.removeEnemy(record);
    for (const record of this.animalRecords.values()) this.removeAnimal(record);
    for (const record of this.projectileRecords.values()) this.scene.remove(record.entity);
    for (const record of this.bodyRecords.values()) this.ragdolls.remove(record.entity);
    this.enemyRecords.clear();
    this.animalRecords.clear();
    this.projectileRecords.clear();
    this.bodyRecords.clear();
    this.projectileGeometry?.dispose();
    this.projectileMaterial?.dispose();
    this.projectileGeometry = null;
    this.projectileMaterial = null;
  }
}
