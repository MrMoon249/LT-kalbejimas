// Visi duomenys – vienas versijuotas JSON įrašas localStorage.
const KEY = 'lt-kalbejimas';
const VERSION = 1;
const defaults = () => ({
  version: VERSION,
  texts: [], // {id,title,author,text,createdAt,notes:{stepId:string}}
  attempts: [], // {id,textId,createdAt,durationSec,transcript,evaluation}
  settings: { apiKey: '', model: '', targetMinSec: 120, targetMaxSec: 180 },
});

let state = load();

function load() {
  const d = defaults();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && raw.version === VERSION) {
      return {
        ...d,
        texts: Array.isArray(raw.texts) ? raw.texts : [],
        attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
        settings: { ...d.settings, ...raw.settings },
      };
    }
  } catch { /* sugadinti ar nepasiekiami duomenys – pradedame iš naujo */ }
  return d;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const texts = () => state.texts;
export const getText = (id) => state.texts.find((t) => t.id === id);

export function addText({ title, author, text }) {
  const t = { id: uid(), title, author, text, createdAt: Date.now(), notes: {} };
  state.texts.unshift(t);
  save();
  return t;
}

export function updateText(id, patch) {
  const t = getText(id);
  if (t) Object.assign(t, patch);
  return save();
}

export function setNote(textId, stepId, value) {
  const t = getText(textId);
  if (t) t.notes = { ...t.notes, [stepId]: value };
  return save();
}

export function deleteText(id) {
  state.texts = state.texts.filter((t) => t.id !== id);
  state.attempts = state.attempts.filter((a) => a.textId !== id);
  save();
}

/** Bandymai, naujausi viršuje; su textId – tik to teksto. */
export const attempts = (textId) => (textId ? state.attempts.filter((a) => a.textId === textId) : state.attempts);
export const getAttempt = (id) => state.attempts.find((a) => a.id === id);

export function addAttempt({ textId, durationSec, transcript, evaluation }) {
  const a = { id: uid(), textId, createdAt: Date.now(), durationSec, transcript, evaluation };
  state.attempts.unshift(a);
  return save() ? a : null;
}

export function deleteAttempt(id) {
  state.attempts = state.attempts.filter((a) => a.id !== id);
  save();
}

export const settings = () => state.settings;
export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  return save();
}

export function clearAll() {
  try { localStorage.removeItem(KEY); } catch { /* nieko */ }
  state = defaults();
}
