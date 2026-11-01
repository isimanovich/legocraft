// node --import ./test/register.mjs test/remote-players.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RemotePlayers } from '../src/remote-players.js';
import { DEFAULT_SKIN, normalizeSkin, loadSkin, saveSkin } from '../src/skins.js';

assert.deepEqual(normalizeSkin({ skin: '#FFEEDD', shirt: 'url(evil)', pants: -1 }), { ...DEFAULT_SKIN, skin: '#ffeedd' }, 'skin colours are normalized and malformed fields use safe defaults');
assert.deepEqual(loadSkin({ getItem() { throw Error('Storage blocked'); } }), DEFAULT_SKIN, 'blocked storage keeps skin controls usable');
let storedSkin;
const storage = { getItem: () => storedSkin, setItem(_key, value) { storedSkin = value; } };
const customSkin = { skin: '#a57755', shirt: '#d63282', pants: '#22aa55' };
assert.deepEqual(saveSkin(customSkin, storage), customSkin);
assert.deepEqual(loadSkin(storage), customSkin, 'personalized colours survive reloading device preferences');

const scene = new THREE.Scene();
const unrelated = new THREE.Group();
scene.add(unrelated);
const remotes = new RemotePlayers(scene);
const self = { id: 'self', name: 'Me', x: 0, y: 0, z: 0 };
const player = { id: 'friend', name: 'Friend', x: 2, y: 5, z: 3, yaw: Math.PI - 0.1, pitch: 0.4, health: 50, maxHealth: 100, active: true };
remotes.updatePlayers([self, player], self.id);
assert.equal(remotes.peers.size, 1, 'the local player has no remote avatar');
const peer = remotes.peers.get(player.id);
assert.deepEqual(peer.group.position.toArray(), [2, 5, 3], 'server positions describe feet');
assert.equal(peer.healthFill.scale.x, 0.43, 'health bar reflects health');
remotes.update(0.1);
assert.equal(peer.head.rotation.x, 0.4, 'the head follows camera pitch');
remotes.updatePlayers([{ ...player, x: 3, yaw: -Math.PI + 0.1 }], self.id);
remotes.update(0.05);
assert.equal(peer.group.position.x, 2.5, 'movement interpolates over a 10 Hz snapshot');
assert.ok(Math.abs(peer.group.rotation.y - Math.PI) < 1e-8, 'yaw crosses the wrap by the shortest path');
assert.notEqual(peer.legL.rotation.x, 0, 'moving avatars animate their limbs');
remotes.update(0.05);
assert.equal(peer.group.position.x, 3);
remotes.update(0.05);
assert.equal(peer.legL.rotation.x, 0, 'stationary peers stop walking');
remotes.updatePlayers([{ ...player, pos: [30, 5, 3], active: false }], self.id);
assert.equal(peer.group.position.x, 30, 'large respawn/reconnect moves teleport immediately');
assert.equal(peer.materials.torso.opacity, 0.55, 'paused peers remain visible and dimmed');
assert.equal(peer.label, 'Friend (paused)');
remotes.updatePlayers([{ ...player, health: 0 }], self.id);
assert.equal(peer.label, 'Friend (respawning)');
assert.equal(peer.healthFill.visible, false);
assert.equal(peer.materials.torso.opacity, 0.25);
remotes.updatePlayers([{ ...player, skin: customSkin }], self.id);
assert.equal(peer.materials.skin.color.getHexString(), 'a57755', 'peers show customized skin tone');
assert.equal(peer.materials.torso.color.getHexString(), 'd63282', 'peers show customized shirts');
assert.equal(peer.materials.legs.color.getHexString(), '22aa55', 'peers show customized trousers');
remotes.updatePlayers([{ ...player, skin: { skin: '<script>', shirt: {}, pants: null } }], self.id);
assert.equal(peer.materials.skin.color.getHexString(), DEFAULT_SKIN.skin.slice(1), 'invalid network colours cannot affect rendering');
remotes.updatePlayers([{ ...player, sitting: true }], self.id);
remotes.update(0.1);
assert.equal(peer.avatar.position.y, -0.9, 'sitting lowers the avatar to the cushion');
assert.equal(peer.legL.rotation.x, -Math.PI / 2, 'seated peers bend their legs');
assert.equal(peer.label, 'Friend (sitting)');
remotes.updatePlayers([player], self.id);
remotes.update(0.1);
assert.equal(peer.avatar.position.y, 0, 'standing restores normal avatar height');

let materialDisposals = 0;
let geometryDisposals = 0;
for (const mat of Object.values(peer.materials)) mat.addEventListener('dispose', () => materialDisposals++);
for (const geometry of Object.values(remotes.geometries)) geometry.addEventListener('dispose', () => geometryDisposals++);
remotes.updatePlayers([self], self.id);
assert.equal(remotes.peers.size, 0, 'departed peers are removed');
assert.equal(materialDisposals, 6, 'peer materials are released on departure');
assert.equal(geometryDisposals, 0, 'shared geometry survives a peer departure');
assert.deepEqual(scene.children, [unrelated], 'cleanup preserves unrelated scene objects');

// A browser-like canvas verifies untrusted names stay text and one-off textures are freed.
const drawnText = [];
const previousDocument = globalThis.document;
globalThis.document = {
  createElement(type) {
    assert.equal(type, 'canvas');
    return { getContext: () => ({
      measureText: (text) => ({ width: text.length * 15 }), beginPath() {}, roundRect() {},
      fill() {}, stroke() {}, strokeText() {}, fillText(text) { drawnText.push(text); },
    }) };
  },
};
try {
  const unsafeName = '<img src=x onerror=alert(1)>';
  remotes.updatePlayers([{ ...player, name: unsafeName }], self.id);
  const named = remotes.peers.get(player.id);
  assert.equal(drawnText.at(-1), unsafeName, 'player names are painted as literal canvas text');
  let textureDisposals = 0;
  let tagMaterialDisposals = 0;
  named.tag.material.map.addEventListener('dispose', () => textureDisposals++);
  named.tag.material.addEventListener('dispose', () => tagMaterialDisposals++);
  remotes.updatePlayers([{ ...player, name: 'Renamed' }], self.id);
  assert.equal(textureDisposals, 1, 'renaming releases the previous one-off tag texture');
  assert.equal(tagMaterialDisposals, 1, 'renaming releases the previous tag material');
  named.tag.material.map.addEventListener('dispose', () => textureDisposals++);
  remotes.clear();
  assert.equal(textureDisposals, 2, 'clearing releases remaining tag textures');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
remotes.dispose();
assert.equal(geometryDisposals, Object.keys(remotes.geometries).length, 'teardown releases shared geometries');
remotes.dispose();
assert.equal(geometryDisposals, Object.keys(remotes.geometries).length, 'teardown is idempotent');
assert.deepEqual(scene.children, [unrelated]);
console.log('Remote player presence, interpolation, safe names, and resource cleanup passed.');
