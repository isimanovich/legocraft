import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from './room.mjs';
import { DEFAULT_SKIN } from '../src/skins.js';

test('player skin is validated, shared, updated and restored from saved profiles', () => {
  const clientId = 'aabbccdd-1234-4567-8888-123456789abc';
  const room = new Room('ABCDEF', 'build', () => {}, () => {}, { seed: 12345 });
  const custom = { skin: '#c98961', shirt: '#32a66a', pants: '#6e4938' };
  const player = room.addPlayer({}, 'Builder', clientId, custom);
  assert.deepEqual(room.snapshot().players[0].skin, custom);
  const updated = { ...custom, shirt: '#1122ff' };
  room.acceptPose(player, { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch, skin: updated });
  assert.deepEqual(player.skin, updated);
  const saved = JSON.parse(JSON.stringify(room.persisted()));
  assert.deepEqual(saved.profiles[0].skin, updated);
  const restored = new Room('ABCDEF', 'build', () => {}, () => {}, saved);
  assert.deepEqual(restored.addPlayer({}, 'Builder', clientId).skin, updated, 'rejoining old clients retain their saved appearance');
  const malformed = room.addPlayer({}, 'Invalid colours', undefined, { skin: false, shirt: 'javascript:alert(1)', pants: 0xffffff });
  assert.deepEqual(malformed.skin, DEFAULT_SKIN);
  delete saved.profiles[0].skin;
  const older = new Room('ABCDEF', 'build', () => {}, () => {}, saved);
  assert.deepEqual(older.addPlayer({}, 'Builder', clientId).skin, DEFAULT_SKIN, 'existing saves get defaults without a migration');
});
