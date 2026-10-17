import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STORE_VERSION = 2;
const MAX_BYTES = 128 * 1024 * 1024;

export function unsupportedSave(message) {
  return Object.assign(new Error(message), { code: 'UNSUPPORTED_SAVE_FORMAT' });
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) {
    // Directory fsync is supported on the Pi's Linux filesystem. Some desktop
    // filesystems reject it even though the individual file was synced.
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function atomicWrite(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

/** A serialized, atomic store. Invalid and newer saves are never overwritten. */
export function createPersistence(dataDir, { validateRoom, logger = console } = {}) {
  const filename = path.join(dataDir, 'rooms.json');
  let chain = Promise.resolve(), lastGoodRaw = null, loaded = false;
  function validate(document) {
    if (document && Number.isInteger(document.version) && document.version > STORE_VERSION) throw unsupportedSave(`Save file version ${document.version} is newer than this server. Update LEGOCRAFT before opening it.`);
    if (!document || ![1, STORE_VERSION].includes(document.version) || !Array.isArray(document.rooms)) throw new Error('Invalid world save file.');
    const codes = new Set();
    let invalid = null;
    for (const room of document.rooms) {
      try {
        validateRoom(room, document.version);
        if (codes.has(room.code)) throw new Error(`Duplicate saved world code ${room.code}.`);
        codes.add(room.code);
      } catch (error) {
        // A damaged earlier room must not hide a newer world later in the file
        // and cause an older backup to overwrite that newer world's data.
        if (error.code === 'UNSUPPORTED_SAVE_FORMAT') throw error;
        invalid ||= error;
      }
    }
    if (invalid) throw invalid;
    return document;
  }
  async function read(filename) {
    const info = await stat(filename);
    if (info.size > MAX_BYTES) throw new Error('World save file exceeds 128 MiB.');
    const raw = await readFile(filename, 'utf8');
    return { raw, document: validate(JSON.parse(raw)) };
  }
  function serial(operation) {
    const result = chain.catch(() => {}).then(operation);
    chain = result;
    return result;
  }
  return {
    filename,
    async load() {
      if (loaded) throw new Error('World storage has already been loaded.');
      let primary, primaryError;
      try { primary = await read(filename); }
      catch (error) { primaryError = error; }
      if (!primary) {
        if (primaryError.code === 'UNSUPPORTED_SAVE_FORMAT') throw primaryError;
        let backup;
        try { backup = await read(`${filename}.bak`); }
        catch (backupError) {
          if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') { loaded = true; return { version: STORE_VERSION, rooms: [] }; }
          throw new Error(`Cannot load saved worlds: ${primaryError.message}; backup unavailable: ${backupError.message}. Existing files were left unchanged.`, { cause: primaryError });
        }
        await mkdir(dataDir, { recursive: true });
        if (primaryError.code !== 'ENOENT') {
          const archive = `${filename}.corrupt-${timestamp()}-${randomUUID().slice(0, 8)}`;
          await rename(filename, archive);
          await syncDirectory(dataDir);
          logger.warn(`Recovered saved worlds from rooms.json.bak; damaged file preserved at ${archive}.`);
        } else logger.warn('Recovered missing rooms.json from rooms.json.bak.');
        await atomicWrite(filename, backup.raw);
        primary = backup;
      }
      lastGoodRaw = primary.raw;
      if (primary.document.version === 1) {
        await mkdir(dataDir, { recursive: true });
        await atomicWrite(`${filename}.v1-${timestamp()}-${randomUUID().slice(0, 8)}.bak`, primary.raw);
      }
      loaded = true;
      return primary.document;
    },
    write(rooms) {
      if (!loaded) return Promise.reject(new Error('Load world storage before saving.'));
      const contents = JSON.stringify(validate({ version: STORE_VERSION, rooms }));
      if (Buffer.byteLength(contents) > MAX_BYTES) return Promise.reject(new Error('World save file exceeds 128 MiB; export or archive unused worlds.'));
      return serial(async () => {
        await mkdir(dataDir, { recursive: true });
        if (lastGoodRaw !== null) await atomicWrite(`${filename}.bak`, lastGoodRaw);
        await atomicWrite(filename, contents);
        lastGoodRaw = contents;
      });
    },
    checkpoint(rooms, label = 'before-reset') {
      const contents = JSON.stringify(validate({ version: STORE_VERSION, rooms }));
      return serial(async () => {
        await mkdir(dataDir, { recursive: true });
        const archive = `${filename}.${label}-${timestamp()}-${randomUUID().slice(0, 8)}.bak`;
        await atomicWrite(archive, contents);
        return archive;
      });
    },
  };
}
