/** Additive, device-local minifigure colours; no downloaded textures required. */
export const DEFAULT_SKIN = Object.freeze({ skin: '#f2cd37', shirt: '#0055bf', pants: '#16344b' });
export const SKIN_PRESETS = Object.freeze([
  { name: 'Classic builder', ...DEFAULT_SKIN },
  { name: 'Explorer', skin: '#c98961', shirt: '#32a66a', pants: '#6e4938' },
  { name: 'Sunset', skin: '#f1c7a2', shirt: '#f06e49', pants: '#553c83' },
  { name: 'Starlight', skin: '#875337', shirt: '#a68cff', pants: '#254369' },
]);
const STORAGE_KEY = 'legocraft-player-skin';
const validColor = color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

export function normalizeSkin(value) {
  return Object.fromEntries(Object.entries(DEFAULT_SKIN).map(([key, fallback]) =>
    [key, validColor(value?.[key]) ? value[key].toLowerCase() : fallback]));
}

export function loadSkin(storage) {
  try {
    return normalizeSkin(JSON.parse((storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY) ?? 'null'));
  } catch { return { ...DEFAULT_SKIN }; }
}

/** Return the validated colours even if this browser refuses persistent storage. */
export function saveSkin(value, storage) {
  const skin = normalizeSkin(value);
  try { (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(skin)); } catch { /* Still works in this tab. */ }
  return skin;
}
