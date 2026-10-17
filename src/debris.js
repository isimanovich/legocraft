import * as THREE from 'three';
import { GRAVITY } from './physics.js';

const cubeGeo = new THREE.BoxGeometry(1, 1, 1);

export class Debris {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = [];
  }

  /** Launch an existing mesh (already in world space) as debris. */
  launch(mesh, vel, life = 2.2, spin = 6) {
    mesh.userData.debris = true;
    this.scene.add(mesh);
    this.items.push({
      mesh,
      vel: vel.clone(),
      life,
      maxLife: life,
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * spin,
        (Math.random() - 0.5) * spin,
        (Math.random() - 0.5) * spin,
      ),
      baseScale: mesh.scale.clone(),
    });
  }

  /** Burst of small cubes of a colour at a point (block breaking). */
  burst(x, y, z, colorHex, count = 10, size = 0.18, speed = 4) {
    const mat = new THREE.MeshLambertMaterial({ color: colorHex });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(cubeGeo, mat);
      const s = size * (0.6 + Math.random() * 0.8);
      m.scale.set(s, s, s);
      m.position.set(
        x + (Math.random() - 0.5) * 0.6,
        y + (Math.random() - 0.5) * 0.6,
        z + (Math.random() - 0.5) * 0.6,
      );
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.9 + 1,
        (Math.random() - 0.5) * speed,
      );
      this.launch(m, v, 1.2 + Math.random() * 0.6, 10);
    }
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.items.splice(i, 1);
        continue;
      }
      d.vel.y -= GRAVITY * dt;
      const p = d.mesh.position;
      p.x += d.vel.x * dt;
      p.y += d.vel.y * dt;
      p.z += d.vel.z * dt;
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;

      // Bounce on terrain surface
      const bx = Math.floor(p.x);
      const by = Math.floor(p.y);
      const bz = Math.floor(p.z);
      if (this.world.isSolid(bx, by, bz)) {
        p.y = by + 1 + 0.05;
        if (d.vel.y < 0) d.vel.y = -d.vel.y * 0.35;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.5);
      }
      // Shrink out over the final 0.5s
      const k = Math.min(1, d.life / 0.5);
      d.mesh.scale.copy(d.baseScale).multiplyScalar(k);
    }
  }

  clear() {
    for (const d of this.items) this.scene.remove(d.mesh);
    this.items.length = 0;
  }
}
