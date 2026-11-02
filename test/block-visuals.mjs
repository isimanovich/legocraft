import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, BLOCK, BLOCK_INFO, PLACEABLE } from '../src/world.js';
import { BLOCK_PALETTE, WORLD_SIZE, encodeTerrain, decodeTerrain } from '../src/save-format.js';
import { boxCollides } from '../src/physics.js';

const smallWorld = (options = {}) => new World(new THREE.Scene(), { sizeX: 8, sizeY: 6, sizeZ: 8, seed: 42, ...options });
const values = attribute => Array.from({ length: attribute.count }, (_, i) => [attribute.getX(i), attribute.getY(i), attribute.getZ(i)]);

test('blocks default to flat tops, with layered soil/turf and cosmetic grass blades', () => {
  const world = smallWorld();
  world.set(1, 1, 1, BLOCK.STONE);
  world.update();
  let geometry = world.meshes[0].geometry;
  assert.equal(geometry.getAttribute('position').count, 24, 'a smooth isolated block has exactly its six cube faces');
  assert.equal(Math.max(...values(geometry.getAttribute('position')).map(p => p[1])), 2, 'no studs rise from an ordinary block');

  world.set(1, 1, 1, BLOCK.GRASS);
  // Include enough deterministic positions to exercise both plain turf and tufts.
  for (let x = 3; x <= 6; x++) world.set(x, 1, 1, BLOCK.GRASS);
  const terrain = world.data.slice();
  world.update();
  geometry = world.meshes[0].geometry;
  const positions = values(geometry.getAttribute('position'));
  const colors = values(geometry.getAttribute('color'));
  const normals = values(geometry.getAttribute('normal'));
  assert.ok(positions.some(p => p[1] > 2.1 && p[1] < 2.31), 'short grass blades visibly rise above exposed turf');
  assert.ok(positions.some(p => Math.abs(p[1] - 1.78) < 1e-6), 'the green turf band has an edge above the brown soil');
  assert.ok(colors.some(([r, g, b], i) => positions[i][1] === 1 && r > g && g > b), 'the underside and soil sides are brown');
  assert.ok(colors.some(([r, g, b], i) => positions[i][1] >= 2 && g > r && g > b), 'the cap and grass blades are green');
  for (const normal of normals) assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6, 'all face and blade normals are normalized');
  assert.deepEqual(world.data, terrain, 'cosmetic blades never become collision or saved terrain blocks');
  assert.equal(world.get(3, 2, 1), BLOCK.AIR);
  assert.equal(world.isSolid(3, 2, 1), false, 'blades do not obstruct movement or building');
  const hit = world.raycast(new THREE.Vector3(3.5, 4, 1.5), new THREE.Vector3(0, -1, 0));
  assert.equal(hit.y, 1, 'selection reaches the actual turf cube rather than cosmetic blades');
  assert.equal(BLOCK_INFO[BLOCK.GRASS].noStud, true, 'grass stays stud-free even in optional legacy stud rendering');
});

test('stackable ladder rails are passable, targetable and do not hide an adjacent wall', () => {
  const world = smallWorld();
  world.set(2, 0, 2, BLOCK.GRASS);
  world.set(2, 1, 2, BLOCK.LADDER);
  world.set(2, 2, 2, BLOCK.LADDER);
  world.set(1, 1, 2, BLOCK.STONE);
  world.update();
  assert.equal(BLOCK.LADDER, 26);
  assert.ok(PLACEABLE.includes(BLOCK.LADDER));
  assert.equal(world.isSolid(2, 1, 2), false);
  assert.equal(world.heightAt(2, 2), 0, 'the top ladder is not mistaken for a standing surface');
  assert.notEqual(world.findGround(2, 2)?.y, 2, 'spawn search does not select ladder rungs as ground');
  assert.equal(boxCollides(world, 2.5, 1.01, 2.5, .3, 1.8), false, 'the player can enter and climb the ladder voxel');
  const hit = world.raycast(new THREE.Vector3(2.5, 1.5, .5), new THREE.Vector3(0, 0, 1));
  assert.deepEqual([hit.x, hit.y, hit.z], [2, 1, 2], 'a passable ladder can still be picked and broken');
  const geometry = world.meshes[0].geometry;
  const positions = values(geometry.getAttribute('position'));
  const normals = values(geometry.getAttribute('normal'));
  assert.ok(positions.some((p, i) => p[0] === 2 && p[1] === 1 && p[2] === 2 && normals[i][0] === 1), 'the exposed wall face behind an open ladder is retained');
  assert.ok(positions.some(p => p[0] > 2.1 && p[0] < 2.2 && p[1] === 3), 'rails align at stacked cell boundaries');
});

test('ladder terrain round trips and older palettes retain every existing block ID', () => {
  for (const [name, id] of Object.entries(BLOCK)) assert.equal(BLOCK_PALETTE[id], name);
  assert.equal(BLOCK.BED, 25, 'existing furniture IDs are unchanged');
  const terrain = new Uint8Array(WORLD_SIZE.sizeX * WORLD_SIZE.sizeY * WORLD_SIZE.sizeZ);
  terrain[100] = BLOCK.LADDER;
  const saved = encodeTerrain(terrain);
  assert.deepEqual(decodeTerrain(saved), terrain);
  terrain[100] = BLOCK.GRASS;
  const older = encodeTerrain(terrain);
  older.palette.pop(); // A real earlier save has no LADDER palette entry.
  assert.deepEqual(decodeTerrain(older), terrain);
});
