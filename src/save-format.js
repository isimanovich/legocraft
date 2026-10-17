// Append new block names; never reorder or reuse these IDs. Names in each save
// allow a later migration to translate a palette without changing old worlds.
export const BLOCK_PALETTE = Object.freeze(['AIR', 'GRASS', 'DIRT', 'STONE', 'SAND', 'WOOD', 'LEAVES', 'RED', 'BLUE', 'YELLOW', 'WHITE', 'BEDROCK', 'WATER', 'ORANGE', 'LIME', 'PINK', 'PURPLE', 'BLACK', 'DARKGREY', 'AZURE', 'DARKRED', 'PLANKS', 'GOLD']);
export const SAVE_FORMAT_VERSION = 2;
export const TERRAIN_FORMAT_VERSION = 1;
export const WORLD_SIZE = Object.freeze({ sizeX: 144, sizeY: 48, sizeZ: 144 });
const VOLUME = WORLD_SIZE.sizeX * WORLD_SIZE.sizeY * WORLD_SIZE.sizeZ;

export function validateSaveVersion(saved) {
  const version = saved?.formatVersion ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > SAVE_FORMAT_VERSION) throw new Error(`Unsupported world save version ${version}; update the server before opening this world.`);
  return version;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Full terrain, losslessly compressed as [uint16 run length, uint8 palette ID]. */
export function encodeTerrain(data) {
  if (!(data instanceof Uint8Array) || data.length !== VOLUME) throw new Error('World terrain must contain exactly 144 × 48 × 144 blocks.');
  const bytes = [];
  for (let i = 0; i < data.length;) {
    const block = data[i];
    if (block >= BLOCK_PALETTE.length) throw new Error(`Unknown terrain block ID ${block}`);
    let run = 1;
    while (i + run < data.length && data[i + run] === block && run < 65535) run++;
    bytes.push(run & 255, run >>> 8, block);
    i += run;
  }
  return { version: TERRAIN_FORMAT_VERSION, encoding: 'rle8-base64', ...WORLD_SIZE, palette: [...BLOCK_PALETTE], data: toBase64(Uint8Array.from(bytes)) };
}

export function decodeTerrain(terrain) {
  if (!terrain || terrain.version !== TERRAIN_FORMAT_VERSION || terrain.encoding !== 'rle8-base64') throw new Error('Unsupported terrain save format; update the game before opening this world.');
  if (Object.entries(WORLD_SIZE).some(([k, v]) => terrain[k] !== v)) throw new Error('Unsupported saved world dimensions.');
  if (!Array.isArray(terrain.palette) || !terrain.palette.length || terrain.palette.length > 256 || new Set(terrain.palette).size !== terrain.palette.length) throw new Error('Invalid terrain block palette.');
  const palette = terrain.palette.map(name => {
    const block = BLOCK_PALETTE.indexOf(name);
    if (block < 0) throw new Error(`Unknown saved block ${String(name).slice(0, 32)}; update the game before opening this world.`);
    return block;
  });
  if (typeof terrain.data !== 'string' || !terrain.data.length || terrain.data.length > VOLUME * 4 || terrain.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(terrain.data)) throw new Error('Invalid encoded terrain.');
  let bytes;
  try { bytes = atob(terrain.data); } catch { throw new Error('Invalid encoded terrain.'); }
  if (bytes.length % 3) throw new Error('Truncated terrain data.');
  const data = new Uint8Array(VOLUME);
  let offset = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const run = bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8);
    const block = palette[bytes.charCodeAt(i + 2)];
    if (!run || block === undefined || offset + run > data.length) throw new Error('Invalid terrain run.');
    data.fill(block, offset, offset + run);
    offset += run;
  }
  if (offset !== data.length) throw new Error('Incomplete terrain data.');
  return data;
}
