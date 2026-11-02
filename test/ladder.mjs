import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, BLOCK } from '../src/world.js';
import { Player } from '../src/player.js';
import { onLadder, boxCollides } from '../src/physics.js';

function playground(top = 8) {
  const world = new World(new THREE.Scene(), { sizeX: 16, sizeY: 16, sizeZ: 16 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, BLOCK.STONE);
  for (let y = 1; y <= top; y++) world.set(5, y, 5, BLOCK.LADDER);
  const player = new Player(new THREE.PerspectiveCamera(), world);
  player.pos.set(5.5, 1.01, 5.5);
  return { world, player };
}
function advance(player, seconds) {
  for (let i = 0; i < Math.round(seconds * 60); i++) player.update(1 / 60);
}

test('stacked ladders climb up and down at controlled speed and hold when input releases', () => {
  const { world, player } = playground();
  assert.equal(boxCollides(world, player.pos.x, player.pos.y, player.pos.z, .3, 1.8), false, 'rungs are passable, not a solid wall');
  player.keys.add('KeyW');
  advance(player, 1);
  assert.ok(Math.abs(player.pos.y - 4.21) < .001);
  assert.equal(player.climbing, true);
  assert.equal(player.pos.z, 5.5, 'forward movement grips rungs rather than running through');
  player.keys.clear();
  const height = player.pos.y;
  advance(player, .5);
  assert.equal(player.pos.y, height);
  assert.equal(player.vel.y, 0);
  player.keys.add('KeyS');
  advance(player, .5);
  assert.ok(Math.abs(player.pos.y - (height - 1.6)) < .001);
});

test('touch forward/back and Jump use the same ladder motion as keyboard controls', () => {
  const { player } = playground();
  player.touch.z = 1;
  advance(player, .5);
  assert.ok(Math.abs(player.pos.y - 2.61) < .001);
  player.touch.z = -1;
  advance(player, .25);
  assert.ok(Math.abs(player.pos.y - 1.81) < .001);
  player.touch.z = 0;
  player.touch.jump = true;
  advance(player, .5);
  assert.ok(Math.abs(player.pos.y - 3.41) < .001);
});

test('strafe, removed rungs and missing contact resume gravity instead of allowing wall climbs', () => {
  const { world, player } = playground();
  player.pos.y = 5;
  player.keys.add('KeyD');
  advance(player, .6);
  assert.equal(player.climbing, false);
  assert.ok(player.pos.x > 7);
  assert.ok(player.vel.y < 0);
  player.keys.clear(); player.pos.set(5.5, 5, 5.5); player.vel.set(0, 0, 0);
  for (let y = 1; y <= 8; y++) world.set(5, y, 5, BLOCK.AIR);
  player.update(1 / 60);
  assert.equal(player.climbing, false);
  assert.ok(player.vel.y < 0);
  // A full solid voxel between the player and a ladder cannot provide contact.
  world.set(6, 5, 5, BLOCK.STONE); world.set(7, 5, 5, BLOCK.LADDER);
  assert.equal(onLadder(world, player.pos), false);
});

test('solid ceilings block climbing, and descending reaches the ground safely', () => {
  const { world, player } = playground();
  world.set(5, 6, 5, BLOCK.STONE);
  player.keys.add('KeyW');
  advance(player, 2);
  assert.ok(player.pos.y + player.height < 6.001);
  assert.equal(boxCollides(world, player.pos.x, player.pos.y, player.pos.z, .3, 1.8), false);
  player.keys.clear(); player.keys.add('KeyS');
  advance(player, 2);
  assert.ok(Math.abs(player.pos.y - 1) < .001);
  assert.equal(player.onGround, true);
});

test('reaching the top permits forward movement onto a solid landing', () => {
  const { world, player } = playground(3);
  for (let x = 4; x <= 6; x++) for (let z = 1; z <= 4; z++) for (let y = 1; y <= 3; y++) world.set(x, y, z, BLOCK.STONE);
  player.keys.add('KeyW');
  advance(player, 1.25);
  assert.ok(player.pos.z < 5, 'forward input leaves the last rung once feet clear it');
  assert.ok(player.pos.y >= 3.99, 'player reaches the upper landing');
  player.keys.clear();
  advance(player, .2);
  assert.equal(player.onGround, true);
  assert.equal(player.climbing, false);
});

test('seated and dead players receive no ladder lift and water retains swimming buoyancy', () => {
  const { world, player } = playground();
  world.set(5, 1, 5, BLOCK.COUCH);
  player.pos.set(5.5, 2.01, 5.5); player.sitting = true; player.seat = { x: 5, y: 1, z: 5 };
  const y = player.pos.y;
  advance(player, .2);
  assert.equal(player.sitting, true, 'passable rungs do not invalidate a safe seat');
  assert.equal(player.pos.y, y); assert.equal(player.climbing, false);
  player.stand(); player.pos.set(5.5, 3, 5.5); player.health = 0; player.keys.add('KeyW');
  player.update(1 / 60);
  assert.equal(player.climbing, false); assert.ok(player.vel.y < 0);
  player.health = 100; player.keys.clear(); player.pos.set(5.8, 3, 5.5); player.vel.set(0, 0, 0);
  world.set(6, 3, 5, BLOCK.WATER); player.pos.x = 6.05;
  player.touch.jump = true;
  player.update(1 / 60);
  assert.equal(player.climbing, false, 'water at the lower legs keeps the existing swimming controls');
  assert.ok(player.vel.y > 0);
});
