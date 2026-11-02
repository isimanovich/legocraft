import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Room } from './room.mjs';
import { Player } from '../src/player.js';
import { BLOCK } from '../src/world.js';

// Run the actual client controller through the existing authoritative pose path:
// ladder movement needs neither a collision bypass nor larger movement budgets.
test('shared ladder placement, climbing poses and saves preserve normal server collision checks', () => {
  const packets = [];
  const room = new Room('ABCDEF', 'build', (_socket, packet) => packets.push(packet), () => {}, { seed: 47 });
  for (let x = 70; x <= 74; x++) for (let z = 70; z <= 76; z++) for (let y = 30; y <= 42; y++) room.edit(x, y, z, y === 30 ? BLOCK.STONE : BLOCK.AIR);
  const player = room.addPlayer({}, 'Climber', 'aabbccdd-1234-4567-8888-123456789abc');
  player.pos.set(72.5, 31.01, 75.5); player.yaw = 0;
  player.pitch = Math.atan2(31 - (player.pos.y + 1.62), 3);
  room.action(player, { action: 'place', block: BLOCK.LADDER });
  assert.equal(room.world.get(72, 31, 72), BLOCK.LADDER, 'normal building action accepts the new inventory item');
  for (let y = 32; y <= 40; y++) room.edit(72, y, 72, BLOCK.LADDER);
  player.pos.set(72.5, 31.01, 72.5);
  const client = new Player(new THREE.PerspectiveCamera(), room.world);
  client.pos.copy(player.pos); client.keys.add('KeyW');
  const before = packets.length;
  for (let frame = 0; frame < 120; frame++) {
    client.update(1 / 60);
    if (frame % 6 !== 5) continue;
    // Each pose represents the next 100ms of a live connection, without sleeps.
    player.budgetTime -= 100; player.lastPose -= 100;
    room.acceptPose(player, { x: client.pos.x, y: client.pos.y, z: client.pos.z, yaw: 0, pitch: 0 });
    assert.ok(Math.abs(player.pos.y - client.pos.y) < 1e-8);
  }
  assert.ok(player.pos.y > 37);
  assert.equal(packets.slice(before).some(packet => packet.type === 'correction'), false);
  const snapshot = JSON.parse(JSON.stringify(room.persisted()));
  const restored = new Room('ABCDEF', 'build', () => {}, () => {}, snapshot);
  assert.equal(restored.world.get(72, 35, 72), BLOCK.LADDER);
  assert.equal(restored.world.isSolid(72, 35, 72), false);
  const returning = restored.addPlayer({}, 'Climber', player.clientId);
  assert.ok(Math.abs(returning.pos.y - player.pos.y) < 1e-8, 'saved mid-ladder player position survives');
  // Solid walls still reject movement even when an adjacent ladder is present.
  room.edit(73, Math.floor(player.pos.y), 72, BLOCK.STONE);
  player.budgetTime -= 100;
  room.acceptPose(player, { x: 73.5, y: player.pos.y, z: player.pos.z, yaw: 0, pitch: 0 });
  assert.equal(player.pos.x, 72.5);
});
