import http from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, validateRoomActors } from './room.mjs';
import { BLOCK_INFO } from '../src/world.js';
import { decodeTerrain, validateSaveVersion, SAVE_FORMAT_VERSION, TERRAIN_FORMAT_VERSION, BLOCK_PALETTE } from '../src/save-format.js';
import { createPersistence, unsupportedSave, STORE_VERSION } from './persistence.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codePattern = /^[A-HJ-NP-Z2-9]{6}$/;
const finiteInteger = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const publicAsset = relative => !relative.split('/').some(segment => !segment || segment.startsWith('.') || segment.includes('\\')) &&
  (/^(?:src|vendor|public)\//.test(relative) || relative === 'index.html') && Object.hasOwn(mime, path.extname(relative));

function validateSavedRoom(value, storeVersion) {
  if (value && Number.isInteger(value.formatVersion) && value.formatVersion > SAVE_FORMAT_VERSION) throw unsupportedSave(`World ${value.code || ''} uses a newer save version. Update LEGOCRAFT before opening it.`);
  const version = validateSaveVersion(value);
  // Check compatibility before strict current-format fields: a future palette
  // may also introduce block IDs this version cannot validate.
  if (version >= 2 && (value.terrain?.version > TERRAIN_FORMAT_VERSION || (value.terrain?.encoding && value.terrain.encoding !== 'rle8-base64') || value.terrain?.palette?.some?.(name => !BLOCK_PALETTE.includes(name)))) throw unsupportedSave(`World ${value.code} needs a newer terrain format or block palette. Update LEGOCRAFT before opening it.`);
  const blockLimit = version === 1 ? 100_000 : 144 * 47 * 144;
  if (!(value && codePattern.test(value.code) && ['wave', 'build'].includes(value.gameMode) && finiteInteger(value.seed, 0, 1e9) &&
    finiteInteger(value.score, 0, 1e12) && finiteInteger(value.kills, 0, 1e9) && finiteInteger(value.wave, 1, 10000) &&
    Array.isArray(value.blocks) && value.blocks.length <= blockLimit && value.blocks.every(b => Array.isArray(b) && b.length === 4 && finiteInteger(b[0], 0, 143) && finiteInteger(b[1], 1, 47) && finiteInteger(b[2], 0, 143) && (b[3] === 0 || (Number.isInteger(b[3]) && Object.hasOwn(BLOCK_INFO, b[3]) && b[3] !== 11))))) throw new Error(`Invalid saved world ${value?.code || ''}.`);
  if (storeVersion === STORE_VERSION && version !== SAVE_FORMAT_VERSION) throw new Error('Version 2 storage requires versioned world snapshots.');
  if (version >= 2) {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40 || !finiteInteger(value.createdAt, 0, Number.MAX_SAFE_INTEGER) || !finiteInteger(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid saved world metadata for ${value.code}.`);
    decodeTerrain(value.terrain);
    validateRoomActors(value);
  }
}
const cleanWorldName = (value, fallback) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || fallback : fallback;

/** A LAN server. No account system; anyone with the room code can join and build. */
export async function createGameServer({ root = repositoryRoot, dataDir = path.resolve(process.env.DATA_DIR || '.local-data'), maxPlayers = 8, maxRooms = 16, emptyRoomTtlMs = 24 * 60 * 60 * 1000, tickMs = 50, snapshotMs = 100, autosaveMs = 15_000, logger = console } = {}) {
  root = await realpath(root);
  const rooms = new Map();
  let needsSave = false, stopping = false, autosaveRunning = false;
  const storage = dataDir ? createPersistence(dataDir, { validateRoom: validateSavedRoom, logger }) : null;
  const send = (socket, packet) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(packet));
  };
  const error = (socket, code, message) => send(socket, { type: 'error', code, message });
  async function persist() {
    if (!storage) return;
    needsSave = false;
    try { await storage.write([...rooms.values()].map(r => r.persisted())); }
    catch (error) { needsSave = true; throw error; }
  }
  function dirty() {
    needsSave = true;
  }
  if (storage) {
    try {
      const data = await storage.load();
      for (const saved of data.rooms) rooms.set(saved.code, new Room(saved.code, saved.gameMode, send, dirty, saved));
      if (data.version === 1) await persist();
    } catch (e) {
      throw new Error(`Cannot load multiplayer room data: ${e.message}`, { cause: e });
    }
  }

  const worldSummary = room => ({ code: room.code, name: room.name, gameMode: room.gameMode, createdAt: room.createdAt, updatedAt: room.updatedAt, players: room.players.size, maxPlayers, status: room.players.size ? 'active' : 'saved' });
  const saveError = (socket, cause) => {
    logger.error('Unable to save multiplayer rooms:', cause.code || cause.message);
    error(socket, 'SAVE_FAILED', 'The server could not save this world. Check free disk space and DATA_DIR permissions, then try Save now again.');
  };
  const backgroundSaveError = cause => {
    logger.error('Unable to autosave multiplayer rooms:', cause.code || cause.message);
    for (const room of rooms.values()) if (room.players.size) room.broadcast({ type: 'error', code: 'AUTOSAVE_FAILED', message: 'Automatic saving failed. Check the server disk space and storage permissions, then try Save now. Your current game is still running.' });
  };
  async function saveAction(socket, room, renameTo) {
    if (!storage) { error(socket, 'SAVE_DISABLED', 'Saved worlds are disabled on this server.'); return; }
    if (renameTo !== undefined) { room.name = renameTo; room.dirty(); }
    try {
      const savedAt = Date.now();
      await persist();
      send(socket, { type: 'saved', code: room.code, name: room.name, savedAt });
      if (renameTo !== undefined) room.broadcast(room.snapshot());
    } catch (cause) { saveError(socket, cause); }
  }

  const httpServer = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end(); return; }
    if (pathname === '/healthz') {
      const body = JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (pathname === '/api/worlds') {
      const body = JSON.stringify({ version: STORE_VERSION, persistence: Boolean(storage), worlds: [...rooms.values()].map(worldSummary).sort((a, b) => b.updatedAt - a.updatedAt) });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const exportCode = /^\/api\/worlds\/([A-HJ-NP-Z2-9]{6})\/export$/.exec(pathname)?.[1];
    if (exportCode) {
      const room = rooms.get(exportCode);
      if (!room) { response.writeHead(404).end(); return; }
      const body = JSON.stringify({ version: STORE_VERSION, rooms: [room.persisted()] });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="legocraft-${exportCode}.json"`, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicAsset(relative)) { response.writeHead(404).end(); return; }
    try {
      const candidate = await realpath(path.join(root, relative));
      if (!candidate.startsWith(root + path.sep) || !publicAsset(path.relative(root, candidate).split(path.sep).join('/'))) { response.writeHead(404).end(); return; }
      const info = await stat(candidate);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mime[path.extname(candidate)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(candidate).on('error', () => response.destroy()).pipe(response);
    } catch (e) { response.writeHead(e.code === 'EACCES' ? 403 : 404).end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    // Browsers must originate from this host (including the port); native LAN
    // clients without Origin may connect as well. This works behind Nginx when
    // its proxy preserves Host, including the port where applicable.
    let originAllowed = true;
    if (request.headers.origin) {
      try { const origin = new URL(request.headers.origin); originAllowed = ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host; } catch { originAllowed = false; }
    }
    if (stopping || pathname !== '/multiplayer' || !originAllowed || wss.clients.size >= maxRooms * maxPlayers + 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', socket => {
    let room = null, player = null, alive = true, resetPending = false;
    let tokens = 60, tokenTime = Date.now();
    const joinTimeout = setTimeout(() => { if (!room) socket.close(1008, 'Create or join a room first'); }, 10_000);
    joinTimeout.unref();
    socket.on('pong', () => { alive = true; });
    socket.isAlive = () => alive;
    socket.markNotAlive = () => { alive = false; };
    socket.on('error', () => {});
    socket.on('message', (raw, isBinary) => {
      if (stopping) return;
      const now = Date.now();
      tokens = Math.min(60, tokens + (now - tokenTime) * 0.03); tokenTime = now;
      if (--tokens < 0 || isBinary) { socket.close(1008, 'Message rate or format limit exceeded'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { error(socket, 'BAD_MESSAGE', 'Send a JSON message.'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { error(socket, 'BAD_MESSAGE', 'Invalid multiplayer message.'); return; }
      if (msg.type === 'create' || msg.type === 'join') {
        if (room) { error(socket, 'ALREADY_JOINED', 'Leave the current room before joining another.'); return; }
        if (msg.type === 'create') {
          if (!['wave', 'build'].includes(msg.gameMode)) { error(socket, 'BAD_MODE', 'Choose Waves or Free build.'); return; }
          if (rooms.size >= maxRooms) { error(socket, 'SERVER_FULL', 'The server has reached its room limit.'); return; }
          let code;
          do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
          room = new Room(code, msg.gameMode, send, dirty);
          room.name = cleanWorldName(msg.worldName, `World ${code}`);
          rooms.set(code, room);
          dirty();
        } else {
          const code = typeof msg.roomCode === 'string' ? msg.roomCode.trim().toUpperCase() : '';
          room = rooms.get(code);
          if (!room) { error(socket, 'ROOM_NOT_FOUND', 'Room not found. Check the six-character room code.'); return; }
          if (room.players.size >= maxPlayers) { room = null; error(socket, 'ROOM_FULL', `This room already has ${maxPlayers} players.`); return; }
        }
        clearTimeout(joinTimeout);
        // Deliver all prior edits to existing players before the newcomer can
        // interact. Its welcome already contains the complete delta list.
        room.flushBlocks();
        player = room.addPlayer(socket, msg.name, msg.clientId);
        send(socket, { type: 'welcome', version: 1, playerId: player.id, roomCode: room.code, hostId: room.hostId, savedWorld: worldSummary(room), world: room.worldInfo(), blocks: [...room.blocks.values()], state: room.snapshot() });
        room.broadcast(room.snapshot());
      } else if (!room) error(socket, 'NOT_JOINED', 'Create or join a room first.');
      else if (msg.type === 'pose') room.acceptPose(player, msg);
      else if (msg.type === 'action') {
        if (msg.action === 'save') { void saveAction(socket, room); return; }
        if (msg.action === 'rename') {
          if (room.hostId !== player.id) { error(socket, 'HOST_ONLY', 'Only the host can rename this world.'); return; }
          const name = cleanWorldName(msg.name, '');
          if (!name) { error(socket, 'BAD_NAME', 'Give this world a name.'); return; }
          void saveAction(socket, room, name); return;
        }
        if (msg.action === 'reset' && storage && room.hostId === player.id) {
          if (resetPending) return;
          resetPending = true;
          // Keep a durable copy of the complete world before the host replaces
          // it. A failed backup must leave the live build untouched.
          void storage.checkpoint([...rooms.values()].map(r => r.persisted())).then(() => {
            if (!stopping && room.players.has(player.id) && room.hostId === player.id) { room.action(player, msg); room.flushBlocks(); }
          }).catch(cause => saveError(socket, cause)).finally(() => { resetPending = false; });
          return;
        }
        room.action(player, msg); room.flushBlocks();
      }
      else error(socket, 'BAD_MESSAGE', 'Unknown multiplayer message.');
    });
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      if (room && player) {
        room.removePlayer(player); dirty();
        if (storage && !stopping) void persist().catch(backgroundSaveError);
      }
    });
  });

  let lastTick = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
    for (const [code, room] of rooms) {
      if (!storage && !room.players.size && Date.now() - room.emptySince > emptyRoomTtlMs) { room.ragdolls.clear(); rooms.delete(code); dirty(); continue; }
      room.tick(dt);
      room.flushBlocks();
    }
  }, tickMs);
  const snapshots = setInterval(() => { for (const room of rooms.values()) if (room.players.size) room.broadcast(room.snapshot()); }, snapshotMs);
  const autosaver = setInterval(() => {
    if (!storage || stopping || autosaveRunning || (!needsSave && ![...rooms.values()].some(room => room.players.size))) return;
    autosaveRunning = true;
    void persist().catch(backgroundSaveError).finally(() => { autosaveRunning = false; });
  }, Math.max(20, autosaveMs));
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) { if (!socket.isAlive()) socket.terminate(); else { socket.markNotAlive(); socket.ping(); } }
  }, 30_000);
  ticker.unref(); snapshots.unref(); autosaver.unref(); heartbeat.unref();

  return {
    httpServer, wss, rooms,
    async listen(port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0') {
      await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, host, () => { httpServer.off('error', reject); resolve(); }); });
      return httpServer.address();
    },
    flushPersistence: persist,
    async close() {
      stopping = true;
      clearInterval(ticker); clearInterval(snapshots); clearInterval(heartbeat); clearInterval(autosaver);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => httpServer.close(resolve));
      await persist();
    },
  };
}
