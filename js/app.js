import { STEPS } from './plan.js';
import * as store from './store.js';
import { Timer, Recorder, Recognizer, speechSupported } from './speech.js';

// AI modulis kraunamas atskirai, kad programėlė (planas, laikmatis) veiktų ir be jo.
let ai = null;
try { ai = await import(`./ai.js${new URL(import.meta.url).search}`); } catch (e) { console.warn('AI modulio įkelti nepavyko', e); }
// Serverio režimas: jei šalia yra api.php, raktas guli serveryje, o programėlė atrakinama serverio slaptažodžiu.
let server = null;
try { server = ai ? await ai.serverStatus() : null; } catch { server = null; }

const app = document.getElementById('app');

/* ---------- pagalbinės ---------- */

/** Kuria DOM elementą; tekstas visada dedamas kaip tekstiniai mazgai (jokio innerHTML). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (ts) => new Date(ts).toLocaleString('lt-LT', { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, one, few, many) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
const attemptsLabel = (n) => plural(n, 'bandymas', 'bandymai', 'bandymų');
const issuesLabel = (n) => plural(n, 'kalbos klaida', 'kalbos klaidos', 'kalbos klaidų');
const go = (hash) => { location.hash = hash; };

const header = (title, back, sub) =>
  h('header', { class: 'view-head' },
    back && h('a', { class: 'back', href: back, 'aria-label': 'Atgal' }, '‹'),
    h('div', { class: 'grow' }, h('h1', null, title), sub && h('p', { class: 'muted small' }, sub)));

const alertBox = (msg, kind = 'error') => h('p', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
const spinner = (label) => h('p', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);

/* ---------- AI kvietimai ---------- */

let flash = ''; // vienkartinis pranešimas kitam rodiniui
let returnTo = ''; // kur grįžti įvedus API raktą

/** Grąžina {apiKey, model} arba null: be rakto nukreipia į Nustatymus, be AI modulio – kviečia showError. */
function aiOptions(showError) {
  if (!ai) {
    showError('AI modulio įkelti nepavyko. Patikrink interneto ryšį ir perkrauk puslapį.');
    return null;
  }
  const s = store.settings();
  if (server) return { apiKey: ai.serverKey(server), model: server.model || s.model || ai.DEFAULT_MODEL };
  if (!s.apiKey) {
    flash = 'Šiam veiksmui reikia API rakto. Įvesk jį čia ir grįžk atgal.';
    returnTo = location.hash;
    go('#/nustatymai');
    return null;
  }
  return { apiKey: providerKey(s), model: s.model || ai.DEFAULT_MODEL };
}

/** Raktas su tiekėjo žyme: jei nustatymuose pasirinkta nexos.ai, o raktas neprasideda „nexos-“. */
const providerKey = (s, key = s.apiKey) => (s.provider === 'nexos' && key && !/^nexos-/i.test(key) ? `nx:${key}` : key);

const aiErrorText = (e) => {
  if (e && e.code === 'login' && server) { server.authed = false; setTimeout(render); } // sesija baigėsi – rodome prisijungimą
  return e && e.code && e.message ? e.message : 'Įvyko nenumatyta klaida. Bandyk dar kartą.';
};

/* ---------- maršrutizatorius ---------- */

const routes = [
  [/^$/, viewTexts, 'tekstai'],
  [/^naujas$/, () => viewTextForm(null), 'tekstai'],
  [/^t\/([^/]+)$/, viewPrep, 'tekstai'],
  [/^t\/([^/]+)\/redaguoti$/, viewTextForm, 'tekstai'],
  [/^t\/([^/]+)\/kalbeti$/, viewSpeak, 'tekstai'],
  [/^a\/([^/]+)$/, viewEvaluation, 'istorija'],
  [/^istorija(?:\/([^/]+))?$/, viewHistory, 'istorija'],
  [/^nustatymai$/, viewSettings, 'nustatymai'],
];

let cleanup = null; // dabartinio rodinio išėjimo veiksmas
let lastPath = null;

/* ---------- užraktas (tik širma nuo smalsių akių, ne šifravimas) ---------- */

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hashPassword(pw, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
const UNLOCK_KEY = 'kalbejimas-atrakinta';
const sessionGet = () => { try { return sessionStorage.getItem(UNLOCK_KEY); } catch { return null; } };
const sessionSet = (v) => { try { v ? sessionStorage.setItem(UNLOCK_KEY, v) : sessionStorage.removeItem(UNLOCK_KEY); } catch { /* privatus langas */ } };
let unlockedHash = sessionGet(); // atrakinta, kol atidarytas šis skirtukas
const isLocked = () => {
  if (server) return !server.authed;
  const l = store.settings().lock;
  return !!(l && l.hash) && unlockedHash !== l.hash;
};

function viewServerLogin() {
  if (server.error) return [header('Serveris nesukonfigūruotas', null, 'Kalbėjimo įskaitos treniruoklis'), alertBox(server.error)];
  const pw = h('input', { id: 'l-pw', type: 'password', autocomplete: 'current-password' });
  const status = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Prisijungti');
  return [
    header('Prisijungimas', null, 'Kalbėjimo įskaitos treniruoklis'),
    h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          Object.assign(server, await ai.serverLogin(pw.value));
          render();
        } catch (err) {
          status.replaceChildren(alertBox(err && err.message ? err.message : 'Prisijungti nepavyko.'));
          pw.value = ''; pw.focus();
        } finally {
          btn.disabled = false;
        }
      },
    },
      h('label', { for: 'l-pw' }, 'Slaptažodis'), pw, status, btn),
  ];
}

function viewLock() {
  if (server) return viewServerLogin();
  const pw = h('input', { id: 'l-pw', type: 'password', autocomplete: 'current-password' });
  const status = h('div', { 'aria-live': 'polite' });
  return [
    header('Užrakinta', null, 'Kalbėjimo įskaitos treniruoklis'),
    h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const l = store.settings().lock;
        let got = '';
        try { got = await hashPassword(pw.value, l.salt); } catch { /* nesaugus kontekstas */ }
        if (got === l.hash) { unlockedHash = got; sessionSet(got); render(); }
        else { status.replaceChildren(alertBox('Neteisingas slaptažodis.')); pw.value = ''; pw.focus(); }
      },
    },
      h('label', { for: 'l-pw' }, 'Slaptažodis'), pw, status,
      h('button', { class: 'btn primary block', type: 'submit' }, 'Atrakinti')),
    h('button', {
      class: 'btn danger block', type: 'button',
      onclick: () => {
        if (!confirm('Pamiršai slaptažodį? Vienintelis kelias – ištrinti VISUS tekstus, bandymus ir nustatymus (taip pat API raktą). Tęsti?')) return;
        store.clearAll(); sess = null; unlockedHash = null; sessionSet(null); go('#/'); render();
      },
    }, 'Pamiršau slaptažodį – ištrinti viską'),
  ];
}

function render() {
  const path = location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  cleanup?.();
  cleanup = null;
  const tabsEl = document.getElementById('tabs');
  if (isLocked()) {
    if (tabsEl) tabsEl.hidden = true;
    app.replaceChildren(...viewLock().flat(Infinity).filter(Boolean));
    return;
  }
  if (tabsEl) tabsEl.hidden = false;
  let view = notFound, tab = '', args = [];
  for (const [re, fn, t] of routes) {
    const m = path.match(re);
    if (m) { view = fn; tab = t; args = m.slice(1).map((a) => a && decodeURIComponent(a)); break; }
  }
  const nodes = [view(...args)].flat(Infinity).filter(Boolean);
  if (flash && view !== viewSettings) { nodes.splice(1, 0, alertBox(flash)); flash = ''; }
  app.replaceChildren(...nodes);
  document.querySelectorAll('#tabs a').forEach((a) =>
    a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if (path !== lastPath) { window.scrollTo(0, 0); lastPath = path; }
}

function notFound() {
  return [header('Nerasta', '#/'), h('p', { class: 'muted' }, 'Tokio puslapio ar įrašo nėra.'),
    h('a', { class: 'btn', href: '#/' }, 'Į tekstų sąrašą')];
}

/* ---------- 1. Tekstai ---------- */

function viewTexts() {
  const list = store.texts();
  return [
    header('Tekstai', null, 'Kalbėjimo įskaitos treniruoklis'),
    h('a', { class: 'btn primary block', href: '#/naujas' }, '+ Naujas tekstas'),
    list.length === 0
      ? h('div', { class: 'empty' },
        h('p', null, 'Dar nėra nė vieno teksto.'),
        h('p', { class: 'muted' }, 'Nufotografuok mokytojos duotą tekstą arba įklijuok jį – ir pradėk ruoštis.'))
      : h('ul', { class: 'list' }, list.map((t) => {
        const n = store.attempts(t.id).length;
        return h('li', { class: 'card row' },
          h('a', { class: 'grow item-link', href: `#/t/${t.id}` },
            h('strong', null, t.title || 'Be pavadinimo'),
            h('span', { class: 'muted small' }, [t.author, attemptsLabel(n)].filter(Boolean).join(' · '))),
          h('button', {
            class: 'icon-btn danger', type: 'button', 'aria-label': `Ištrinti tekstą „${t.title}“`,
            onclick: () => {
              if (confirm(`Ištrinti tekstą „${t.title}“ ir visus jo bandymus?`)) { store.deleteText(t.id); render(); }
            },
          }, '✕'));
      })),
  ];
}

/** Sumažina nuotrauką iki maxSide ilgosios kraštinės ir grąžina JPEG base64. */
async function fileToImage(file, maxSide = 1600, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { mediaType: 'image/jpeg', base64: canvas.toDataURL('image/jpeg', quality).split(',')[1] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function viewTextForm(id) {
  const existing = id ? store.getText(id) : null;
  if (id && !existing) return notFound();

  const title = h('input', { id: 'f-title', type: 'text', value: existing?.title || '', autocomplete: 'off' });
  const author = h('input', { id: 'f-author', type: 'text', value: existing?.author || '', autocomplete: 'off' });
  const text = h('textarea', { id: 'f-text', rows: 12, value: existing?.text || '', placeholder: 'Įklijuok arba įrašyk tekstą čia…' });
  const status = h('div', { 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', id: 'f-photos' });
  const photoBtn = h('label', { class: 'btn block', for: 'f-photos' }, 'Fotografuoti arba pasirinkti nuotraukas');

  file.addEventListener('change', async () => {
    const files = [...file.files];
    file.value = '';
    if (!files.length) return;
    const opts = aiOptions((m) => status.replaceChildren(alertBox(m)));
    if (!opts) return;
    photoBtn.classList.add('disabled');
    status.replaceChildren(spinner(`Skaitau tekstą iš ${files.length === 1 ? 'nuotraukos' : 'nuotraukų'}… Tai gali užtrukti iki minutės.`));
    try {
      let images;
      try { images = await Promise.all(files.map((f) => fileToImage(f))); }
      catch { throw { code: 'image', message: 'Nepavyko atidaryti nuotraukos. Pabandyk kitą failą (JPEG arba PNG).' }; }
      const res = await ai.extractText(images, opts);
      title.value = res?.title || title.value;
      author.value = res?.author || author.value;
      text.value = res?.text || text.value;
      status.replaceChildren(alertBox('Tekstas nuskaitytas. Peržiūrėk ir pataisyk, jei kas nors nuskaityta klaidingai.', 'ok'));
    } catch (e) {
      status.replaceChildren(alertBox(aiErrorText(e)));
    } finally {
      photoBtn.classList.remove('disabled');
    }
  });

  const TOPICS = ['Žmogus ir meilė', 'Draugystė', 'Šeima ir kartų santykiai', 'Technologijos ir jaunimas', 'Gamta ir atsakomybė', 'Laisvė ir pasirinkimas', 'Mokykla ir mokymasis', 'Tapatybė ir savivertė'];
  const topic = h('input', { id: 'g-topic', type: 'text', autocomplete: 'off', placeholder: 'pvz., Žmogus ir meilė' });
  topic.setAttribute('list', 'g-topics'); // „list“ savybė tik skaitoma
  const genre = h('select', { id: 'g-genre' }, (ai?.GENRES || ['straipsnis']).map((g) => h('option', { value: g }, g)));
  const genBtn = h('button', {
    class: 'btn block', type: 'button',
    onclick: async () => {
      const opts = aiOptions((m) => status.replaceChildren(alertBox(m)));
      if (!opts) return;
      if (text.value.trim() && !confirm('Laukuose jau yra tekstas. Pakeisti jį sugeneruotu?')) return;
      genBtn.disabled = true;
      status.replaceChildren(spinner('Rašau treniruočių tekstą… Tai gali užtrukti iki minutės.'));
      try {
        const res = await ai.generateText({ topic: topic.value, genre: genre.value }, opts);
        title.value = res.title;
        author.value = `${res.author} (išgalvotas autorius, AI tekstas)`.trim();
        text.value = res.text;
        status.replaceChildren(alertBox('Tekstas sugeneruotas. Autorius išgalvotas – tai tik treniruotei.', 'ok'));
      } catch (e) {
        status.replaceChildren(alertBox(aiErrorText(e)));
      } finally {
        genBtn.disabled = false;
      }
    },
  }, 'Sugeneruoti tekstą');
  const genCard = !existing && h('section', { class: 'card stack' },
    h('p', { class: 'muted small' }, 'Neturi teksto? AI parašys panašų į įskaitos tekstus pagal pasirinktą temą ir žanrą.'),
    h('label', { for: 'g-topic' }, 'Tema'), topic,
    h('datalist', { id: 'g-topics' }, TOPICS.map((t) => h('option', { value: t }))),
    h('label', { for: 'g-genre' }, 'Žanras'), genre,
    genBtn);

  const form = h('form', {
    class: 'stack',
    onsubmit: (e) => {
      e.preventDefault();
      const data = { title: title.value.trim() || 'Be pavadinimo', author: author.value.trim(), text: text.value.trim() };
      if (!data.text) { status.replaceChildren(alertBox('Įrašyk arba nuskaityk tekstą.')); text.focus(); return; }
      if (existing) { store.updateText(existing.id, data); go(`#/t/${existing.id}`); }
      else go(`#/t/${store.addText(data).id}`);
    },
  },
    h('label', { for: 'f-title' }, 'Pavadinimas'), title,
    h('label', { for: 'f-author' }, 'Autorius'), author,
    h('label', { for: 'f-text' }, 'Tekstas'), text,
    h('button', { class: 'btn primary block', type: 'submit' }, 'Išsaugoti'));

  return [
    header(existing ? 'Redaguoti tekstą' : 'Naujas tekstas', existing ? `#/t/${existing.id}` : '#/'),
    h('section', { class: 'card stack' },
      h('p', { class: 'muted small' }, 'Nufotografuok teksto puslapius – AI perrašys juos į laukus žemiau. Arba tiesiog įklijuok tekstą ranka.'),
      file, photoBtn),
    genCard,
    status,
    form,
  ];
}

/* ---------- 2. Pasiruošimas ---------- */

function viewPrep(id) {
  const text = store.getText(id);
  if (!text) return notFound();
  const n = store.attempts(id).length;
  const saved = h('span', { class: 'muted small', 'aria-live': 'polite' });
  let timer;
  const saveNote = (stepId, value) => {
    clearTimeout(timer);
    timer = setTimeout(() => { saved.textContent = store.setNote(id, stepId, value) ? 'Užrašai išsaugoti' : 'Nepavyko išsaugoti'; }, 300);
  };

  return [
    header(text.title, '#/', text.author),
    h('details', { class: 'card source', open: text.text.length < 600 },
      h('summary', null, 'Tekstas'),
      h('div', { class: 'source-text' }, text.text),
      h('a', { class: 'small', href: `#/t/${id}/redaguoti` }, 'Redaguoti tekstą')),
    h('div', { class: 'row between' }, h('h2', null, 'Kalbos planas'), saved),
    STEPS.map((step, i) => {
      const ta = h('textarea', {
        id: `note-${step.id}`, rows: 3, value: text.notes?.[step.id] || '', placeholder: 'Tavo užrašai šiam punktui…',
        oninput: () => saveNote(step.id, ta.value),
      });
      return h('section', { class: 'card stack step' },
        h('h3', null, h('span', { class: 'num' }, String(i + 1)), step.title),
        h('p', { class: 'muted' }, step.hint),
        h('div', { class: 'chips' }, step.starters.map((s) => h('button', {
          class: 'chip', type: 'button',
          onclick: () => {
            ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n${s}` : s;
            store.setNote(id, step.id, ta.value);
            saved.textContent = 'Užrašai išsaugoti';
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          },
        }, s))),
        h('label', { class: 'visually-hidden', for: `note-${step.id}` }, `Užrašai: ${step.title}`),
        ta);
    }),
    h('div', { class: 'actionbar' },
      h('a', { class: 'btn primary grow', href: `#/t/${id}/kalbeti` }, 'Kalbėti'),
      n > 0 && h('a', { class: 'btn', href: `#/istorija/${id}` }, `Istorija (${n})`)),
  ];
}

/* ---------- 3. Kalbėjimas ---------- */

let sess = null; // {textId, phase:'idle'|'starting'|'running'|'done', durationSec, transcript, audioUrl, showPlan, notices, error}
let live = null; // {timer, recorder, recognizer, wake, onTick, onText}

function newSession(textId) {
  if (sess?.audioUrl) URL.revokeObjectURL(sess.audioUrl);
  sess = { textId, phase: 'idle', durationSec: 0, transcript: '', audioUrl: null, showPlan: sess?.textId === textId && sess.showPlan, notices: [], error: '' };
}

const SPEECH_ERRORS = {
  'not-allowed': 'Kalbos atpažinimui neleista naudoti mikrofono. Stenogramą galėsi įrašyti ranka.',
  'service-not-allowed': 'Kalbos atpažinimas šioje naršyklėje išjungtas. Stenogramą galėsi įrašyti ranka.',
  'audio-capture': 'Kalbos atpažinimas negauna garso iš mikrofono. Stenogramą galėsi įrašyti ranka.',
  network: 'Kalbos atpažinimui reikia interneto ryšio – dabar jis nepasiekiamas. Stenogramą galėsi įrašyti ranka.',
  'language-not-supported': 'Ši naršyklė neatpažįsta lietuvių kalbos. Stenogramą galėsi įrašyti ranka (arba naudok „Chrome“).',
  unavailable: 'Kalbos atpažinimas nutrūko. Stenogramą galėsi papildyti ranka.',
};

function notice(msg) {
  if (!sess.notices.includes(msg)) sess.notices.push(msg);
}

async function startSpeaking() {
  const mine = sess;
  mine.phase = 'starting';
  mine.notices = [];
  mine.error = '';
  render();
  const l = { recorder: new Recorder() };
  let micBlocked = false;
  try {
    await l.recorder.start();
  } catch (e) {
    micBlocked = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    notice(micBlocked
      ? 'Mikrofonas neleistas, todėl nebus nei įrašo, nei stenogramos. Leisk mikrofoną naršyklės nustatymuose arba po kalbėjimo įrašyk stenogramą ranka. Laikmatis veikia.'
      : 'Mikrofono naudoti nepavyko, todėl įrašo nebus. Laikmatis veikia, o stenogramą galėsi įrašyti ranka.');
  }
  if (sess !== mine || mine.phase !== 'starting') { l.recorder.stop(); return; } // per tą laiką išeita iš rodinio
  if (!speechSupported) {
    notice('Ši naršyklė nepalaiko kalbos atpažinimo (rekomenduojama „Chrome“). Po kalbėjimo stenogramą įrašyk ranka.');
  } else if (!micBlocked) {
    l.recognizer = new Recognizer({
      onText: (t) => { mine.transcript = t.final; l.onText?.(t); },
      onError: (code) => { notice(SPEECH_ERRORS[code] || SPEECH_ERRORS.unavailable); l.onNotice?.(); },
    });
    l.recognizer.start();
  }
  l.timer = new Timer((s) => { mine.durationSec = s; l.onTick?.(s); });
  l.timer.start();
  navigator.wakeLock?.request('screen').then((w) => { l.wake = w; if (live !== l) w.release(); }).catch(() => {});
  live = l;
  mine.phase = 'running';
  render();
}

async function stopSpeaking() {
  const l = live, mine = sess;
  if (!l || mine.phase !== 'running') return;
  live = null;
  mine.durationSec = l.timer.stop();
  if (l.recognizer) mine.transcript = l.recognizer.stop();
  l.wake?.release().catch(() => {});
  mine.phase = 'done';
  const blob = await l.recorder.stop().catch(() => null);
  if (blob && sess === mine) { mine.audioBlob = blob; mine.audioUrl = URL.createObjectURL(blob); }
}

const audioDuration = (url) => new Promise((resolve) => {
  const a = new Audio();
  a.preload = 'metadata';
  a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : 0);
  a.onerror = () => resolve(0);
  a.src = url;
});

/** Siunčia sesijos įrašą transkripcijai; rezultatą įrašo į stenogramą. */
async function transcribeSession() {
  const mine = sess;
  if (!mine?.audioBlob || mine.transcribing) return;
  const opts = aiOptions((m) => { mine.error = m; });
  if (!opts) { render(); return; }
  mine.transcribing = true; mine.error = '';
  render();
  try {
    const res = await ai.transcribe(mine.audioBlob, { apiKey: opts.apiKey, sttModel: store.settings().sttModel });
    if (res.model && res.model !== store.settings().sttModel) store.updateSettings({ sttModel: res.model });
    mine.transcript = res.text;
  } catch (e) {
    mine.error = aiErrorText(e);
  } finally {
    mine.transcribing = false;
    if (sess === mine) render();
  }
}

/** Įkeltas diktofono failas: rodome grotuvą, trukmę imame iš failo, stenogramą – iš transkripcijos. */
async function useAudioFile(file) {
  const mine = sess;
  if (file.size > 25 * 1024 * 1024) { mine.error = 'Failas per didelis (daugiausia 25 MB).'; render(); return; }
  if (mine.audioUrl) URL.revokeObjectURL(mine.audioUrl);
  mine.audioBlob = file;
  mine.audioUrl = URL.createObjectURL(file);
  mine.durationSec = await audioDuration(mine.audioUrl);
  if (sess !== mine) return;
  mine.phase = 'done';
  mine.notices = mine.durationSec ? [] : ['Šio failo trukmės nustatyti nepavyko – laikas vertinime bus netikslus.'];
  render();
  transcribeSession();
}

function viewSpeak(id) {
  const text = store.getText(id);
  if (!text) return notFound();
  if (!sess || sess.textId !== id) newSession(id);
  const s = sess;
  const { targetMinSec: min, targetMaxSec: max } = store.settings();
  const scale = max * 1.25;
  const pct = (v) => `${Math.min(100, (v / scale) * 100)}%`;

  const timeEl = h('div', { class: 'timer-time', role: 'timer' }, fmt(0));
  const fill = h('div', { class: 'bar-fill' });
  const stateEl = h('p', { class: 'timer-state' });
  const timerCard = h('section', { class: 'card timer' },
    timeEl,
    h('div', { class: 'bar', 'aria-hidden': 'true' },
      h('div', { class: 'bar-zone', style: `left:${pct(min)};width:${((max - min) / scale) * 100}%` }), fill),
    h('div', { class: 'bar-labels muted small', 'aria-hidden': 'true' },
      h('span', { style: `left:${pct(min)}` }, fmt(min)), h('span', { style: `left:${pct(max)}` }, fmt(max))),
    stateEl);
  const paint = (sec) => {
    const zone = sec < min ? 'under' : sec <= max ? 'in' : 'over';
    timeEl.textContent = fmt(Math.floor(sec));
    fill.style.width = pct(sec);
    timerCard.dataset.zone = zone;
    stateEl.textContent = s.phase === 'idle' || s.phase === 'starting'
      ? `Tikslas: ${fmt(min)}–${fmt(max)}`
      : { under: `Dar per trumpai – tikslas ${fmt(min)}–${fmt(max)}`, in: 'Tinkama trukmė', over: `Per ilgai – tikslas iki ${fmt(max)}` }[zone];
  };
  paint(s.durationSec);

  const notices = h('div', null, s.notices.map((m) => alertBox(m, 'warn')));
  const planList = h('ol', { class: 'cheat', hidden: !s.showPlan }, STEPS.map((st) => h('li', null, st.title)));
  const planToggle = h('button', {
    class: 'btn small-btn', type: 'button', 'aria-expanded': String(s.showPlan),
    onclick: () => {
      s.showPlan = !s.showPlan;
      planList.hidden = !s.showPlan;
      planToggle.setAttribute('aria-expanded', String(s.showPlan));
      planToggle.textContent = s.showPlan ? 'Slėpti plano punktus' : 'Rodyti plano punktus';
    },
  }, s.showPlan ? 'Slėpti plano punktus' : 'Rodyti plano punktus');
  const plan = h('section', { class: 'stack' }, planToggle, planList);

  const out = [header('Kalbėjimas', `#/t/${id}`, text.title), timerCard];

  if (s.phase === 'idle' || s.phase === 'starting') {
    out.push(
      h('button', { class: 'btn primary big block', type: 'button', disabled: s.phase === 'starting', onclick: startSpeaking },
        s.phase === 'starting' ? 'Jungiamas mikrofonas…' : 'Pradėti'),
      h('p', { class: 'muted small center' }, 'Paspaudus „Pradėti“, naršyklė paprašys leidimo naudoti mikrofoną. Kalbėk taip, lyg atsakinėtum mokytojai.'),
      s.error && alertBox(s.error),
      (() => {
        const file = h('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.ogg,.aac,.amr,.3gp', class: 'visually-hidden', id: 'f-audio' });
        file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) useAudioFile(f); });
        return h('section', { class: 'stack' }, file,
          h('label', { class: 'btn block', for: 'f-audio' }, 'Įkelti diktofono įrašą'),
          h('p', { class: 'muted small center' }, 'Jau įrašei kalbą diktofonu? Įkelk failą – jis bus paverstas tekstu ir įvertintas.'));
      })(),
      plan);
  } else if (s.phase === 'running') {
    const liveFinal = h('span', null, s.transcript);
    const liveInterim = h('span', { class: 'muted' });
    const liveBox = h('p', { class: 'card live', 'aria-live': 'off' }, liveFinal, ' ', liveInterim);
    live.onTick = paint;
    live.onText = (t) => { liveFinal.textContent = t.final; liveInterim.textContent = t.interim; liveBox.scrollTop = liveBox.scrollHeight; };
    live.onNotice = () => notices.replaceChildren(...s.notices.map((m) => alertBox(m, 'warn')));
    out.push(
      h('button', { class: 'btn stop big block', type: 'button', onclick: () => stopSpeaking().then(render) }, 'Baigti'),
      notices, plan,
      live.recognizer && [h('h2', null, 'Stenograma (gyvai)'), liveBox]);
    cleanup = () => { stopSpeaking(); }; // išėjus iš rodinio – sustabdome, bet bandymo nepametame
  } else {
    const ta = h('textarea', {
      id: 'transcript', rows: 10, value: s.transcript, placeholder: 'Įrašyk, ką pasakei…',
      oninput: () => { s.transcript = ta.value; },
    });
    const status = h('div', { 'aria-live': 'polite' },
      s.transcribing && spinner('Verčiu įrašą į tekstą… Tai gali užtrukti iki minutės.'), s.error && alertBox(s.error));
    const sttBtn = s.audioBlob && !s.transcribing && h('button', { class: 'btn block', type: 'button', onclick: transcribeSession },
      s.transcript.trim() ? 'Perrašyti stenogramą iš įrašo (AI)' : 'Paversti įrašą tekstu (AI)');
    const evalBtn = h('button', { class: 'btn primary big block', type: 'button' }, 'Vertinti');
    const againBtn = h('button', {
      class: 'btn block', type: 'button',
      onclick: () => {
        if (s.transcript.trim() && !confirm('Pradėti iš naujo? Šis bandymas nebus išsaugotas.')) return;
        newSession(id);
        render();
      },
    }, 'Kalbėti iš naujo');
    evalBtn.addEventListener('click', async () => {
      s.error = '';
      if (!s.transcript.trim()) { status.replaceChildren(alertBox('Stenograma tuščia – įrašyk, ką pasakei.')); ta.focus(); return; }
      const opts = aiOptions((m) => status.replaceChildren(alertBox(m)));
      if (!opts) return;
      evalBtn.disabled = againBtn.disabled = ta.disabled = true;
      status.replaceChildren(spinner('Vertinu tavo kalbėjimą… Tai gali užtrukti iki minutės.'));
      try {
        const durationSec = Math.round(s.durationSec);
        const evaluation = await ai.evaluate({
          sourceText: [[text.title, text.author].filter(Boolean).join(' – '), text.text].filter(Boolean).join('\n\n'),
          transcript: s.transcript.trim(), durationSec, targetMinSec: min, targetMaxSec: max, notes: text.notes || {},
        }, opts);
        const a = store.addAttempt({ textId: id, durationSec, transcript: s.transcript.trim(), evaluation });
        if (!a) throw { code: 'storage', message: 'Vertinimas gautas, bet jo išsaugoti nepavyko – naršyklės atmintis pilna. Ištrink senų bandymų ar tekstų.' };
        newSession(id);
        go(`#/a/${a.id}`);
      } catch (e) {
        s.error = aiErrorText(e);
        if (sess === s && status.isConnected) {
          status.replaceChildren(alertBox(s.error));
          evalBtn.disabled = againBtn.disabled = ta.disabled = false;
        }
      }
    });
    out.push(
      notices,
      s.audioUrl && h('section', { class: 'stack' }, h('h2', null, 'Įrašas'), h('audio', { controls: true, src: s.audioUrl })),
      h('section', { class: 'stack' },
        h('label', { class: 'h2', for: 'transcript' }, 'Stenograma'),
        h('p', { class: 'muted small' }, 'Kalbos atpažinimas netobulas: pataisyk, kas išgirsta neteisingai, bet negražink to, ką iš tikrųjų pasakei – vertinama tavo kalba, ne rašinys.'),
        ta, sttBtn),
      status, evalBtn, againBtn);
    if (s.transcribing) evalBtn.disabled = ta.disabled = true;
  }
  return out;
}

/* ---------- 4. Vertinimas ---------- */

const STATUS = {
  yra: { label: 'yra', mark: '✓' },
  silpna: { label: 'silpna', mark: '~' },
  truksta: { label: 'trūksta', mark: '✕' },
};
const badge = (status) => {
  const st = STATUS[status] || { label: status || '?', mark: '?' };
  return h('span', { class: `badge st-${STATUS[status] ? status : 'none'}` }, `${st.mark} ${st.label}`);
};
const stepTitle = (id) => STEPS.find((s) => s.id === id)?.title || id;
/** Vertinimo punktai plano tvarka (trūkstami – kaip nežinomi). */
const orderedSteps = (ev) => {
  const got = Array.isArray(ev?.steps) ? ev.steps : [];
  return STEPS.map((s) => got.find((g) => g.id === s.id) || { id: s.id });
};
const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : v.comment || v.text || JSON.stringify(v));

function viewEvaluation(attemptId) {
  const a = store.getAttempt(attemptId);
  if (!a) return notFound();
  const text = store.getText(a.textId);
  const ev = a.evaluation || {};
  const issues = Array.isArray(ev.language?.issues) ? ev.language.issues : [];
  const count = ev.language?.count ?? issues.length;
  const types = Array.isArray(ev.ownArguments?.types) ? ev.ownArguments.types : [];
  const { targetMinSec: min, targetMaxSec: max } = store.settings();
  const zone = a.durationSec < min ? 'per trumpai' : a.durationSec <= max ? 'tinkama trukmė' : 'per ilgai';

  return [
    header('Vertinimas', `#/istorija/${a.textId}`, `${text?.title || 'Ištrintas tekstas'} · ${fmtDate(a.createdAt)}`),
    ev.topFix && h('section', { class: 'card topfix' }, h('h2', null, 'Svarbiausia pataisyti'), h('p', null, asText(ev.topFix))),
    ev.summary && h('p', { class: 'summary' }, asText(ev.summary)),

    h('h2', null, 'Pagal planą'),
    h('ol', { class: 'list' }, orderedSteps(ev).map((st, i) => h('li', { class: 'card stack tight' },
      h('div', { class: 'row between' }, h('h3', null, h('span', { class: 'num' }, String(i + 1)), stepTitle(st.id)), badge(st.status)),
      st.evidence && h('p', { class: 'quote' }, asText(st.evidence)),
      st.advice && h('p', null, h('strong', null, 'Patarimas: '), asText(st.advice))))),

    h('section', { class: 'card stack tight' },
      h('div', { class: 'row between' }, h('h3', null, 'Citata iš teksto'),
        h('span', { class: `badge ${ev.quoted ? 'st-yra' : 'st-truksta'}` }, ev.quoted ? '✓ yra' : '✕ nėra')),
      !ev.quoted && h('p', { class: 'muted' }, 'Planas reikalauja pacituoti autoriaus mintis.')),

    h('section', { class: 'card stack tight' },
      h('h3', null, 'Savi argumentai'),
      types.length ? h('div', { class: 'chips' }, types.map((t) => h('span', { class: 'chip static' }, asText(t))))
        : h('p', { class: 'muted' }, 'Savų argumentų tipų neatpažinta.'),
      ev.ownArguments?.comment && h('p', null, asText(ev.ownArguments.comment))),

    h('section', { class: 'card stack tight' },
      h('div', { class: 'row between' }, h('h3', null, 'Trukmė'), h('span', { class: 'muted' }, `${fmt(a.durationSec)} · ${zone}`)),
      ev.timing && h('p', null, asText(ev.timing))),

    h('section', { class: 'card stack tight' },
      h('div', { class: 'row between' }, h('h2', null, 'Kalbos taisyklingumas'), h('span', { class: 'muted' }, issuesLabel(count))),
      issues.length === 0
        ? h('p', { class: 'muted' }, 'Kalbos klaidų nepastebėta.')
        : h('ul', { class: 'issues' }, issues.map((it) => h('li', null,
          it.type && h('span', { class: 'chip static small' }, asText(it.type)),
          h('p', null, h('span', { class: 'wrong' }, asText(it.quote)), h('span', { class: 'arrow', 'aria-label': 'taisyk į' }, ' → '),
            h('span', { class: 'right' }, asText(it.fix))))))),

    h('details', { class: 'card source' }, h('summary', null, 'Stenograma'), h('div', { class: 'source-text' }, a.transcript)),

    h('div', { class: 'stack' },
      text && h('a', { class: 'btn primary block', href: `#/t/${a.textId}/kalbeti` }, 'Bandyti dar kartą'),
      text && h('a', { class: 'btn block', href: `#/t/${a.textId}` }, 'Į pasiruošimą'),
      h('button', {
        class: 'btn block danger-text', type: 'button',
        onclick: () => { if (confirm('Ištrinti šį bandymą?')) { store.deleteAttempt(a.id); go(`#/istorija/${a.textId}`); } },
      }, 'Ištrinti bandymą')),
  ];
}

/* ---------- 5. Istorija ---------- */

function viewHistory(textId) {
  const text = textId ? store.getText(textId) : null;
  const list = store.attempts(text ? textId : undefined);
  return [
    header('Istorija', text ? `#/t/${textId}` : null, text ? text.title : 'Visi bandymai'),
    text && h('a', { class: 'small', href: '#/istorija' }, 'Rodyti visų tekstų bandymus'),
    list.length === 0
      ? h('div', { class: 'empty' }, h('p', null, 'Bandymų dar nėra.'),
        h('p', { class: 'muted' }, 'Įvertintas kalbėjimas atsiras čia – galėsi stebėti, kaip sekasi.'))
      : h('ul', { class: 'list' }, list.map((a) => {
        const ev = a.evaluation || {};
        const count = ev.language?.count ?? ev.language?.issues?.length ?? 0;
        return h('li', null, h('a', { class: 'card stack tight item-link', href: `#/a/${a.id}` },
          h('div', { class: 'row between' },
            h('strong', null, fmtDate(a.createdAt)), h('span', { class: 'muted' }, fmt(a.durationSec))),
          !text && h('span', { class: 'muted small' }, store.getText(a.textId)?.title || 'Ištrintas tekstas'),
          h('div', { class: 'row between' },
            h('span', { class: 'dots', role: 'img', 'aria-label': orderedSteps(ev).map((st) => `${stepTitle(st.id)}: ${STATUS[st.status]?.label || 'nežinoma'}`).join('; ') },
              orderedSteps(ev).map((st) => h('span', { class: `dot st-${STATUS[st.status] ? st.status : 'none'}`, 'aria-hidden': 'true' }, STATUS[st.status]?.mark || '?'))),
            h('span', { class: 'muted small' }, issuesLabel(count)))));
      })),
  ];
}

/* ---------- 6. Nustatymai ---------- */

function viewSettings() {
  const s = store.settings();
  const msg = flash;
  flash = '';
  const saved = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const done = (ok = true) => { saved.textContent = ok ? 'Išsaugota' : 'Nepavyko išsaugoti'; };

  const key = h('input', {
    id: 's-key', type: 'password', value: s.apiKey, autocomplete: 'off', spellcheck: false, autocapitalize: 'off',
    oninput: () => done(store.updateSettings({ apiKey: key.value.trim() })),
  });
  const showKey = h('button', {
    class: 'btn small-btn', type: 'button',
    onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; showKey.textContent = key.type === 'password' ? 'Rodyti' : 'Slėpti'; },
  }, 'Rodyti');
  const model = h('input', {
    id: 's-model', type: 'text', value: s.model, placeholder: ai?.DEFAULT_MODEL || '', autocomplete: 'off', spellcheck: false, autocapitalize: 'off',
    oninput: () => done(store.updateSettings({ model: model.value.trim() })),
  });
  const provider = h('select', { id: 's-provider', onchange: () => done(store.updateSettings({ provider: provider.value })) },
    [['auto', 'Automatiškai (pagal raktą)'], ['nexos', 'nexos.ai'], ['anthropic', 'Anthropic']]
      .map(([v, label]) => h('option', { value: v, selected: (s.provider || 'auto') === v }, label)));
  model.setAttribute('list', 's-models');
  const modelList = h('datalist', { id: 's-models' });
  const modelStatus = h('div', { 'aria-live': 'polite' });
  const loadModels = h('button', {
    class: 'btn block', type: 'button',
    onclick: async () => {
      if (!ai) return;
      loadModels.disabled = true;
      modelStatus.replaceChildren(spinner('Kraunu modelių sąrašą…'));
      try {
        const names = await ai.listModels({ apiKey: server ? ai.serverKey(server) : providerKey(store.settings(), key.value.trim()) });
        modelList.replaceChildren(...names.map((n) => h('option', { value: n })));
        modelStatus.replaceChildren(alertBox(`Rasta modelių: ${names.length}. Bakstelk pavadinimą žemiau (geriausia – Claude Sonnet ar Opus).`, 'ok'),
          h('div', { class: 'chips' }, names.map((n) => h('button', {
            class: 'chip', type: 'button',
            onclick: () => { model.value = n; done(store.updateSettings({ model: n })); },
          }, n))));
      } catch (e) {
        modelStatus.replaceChildren(alertBox(aiErrorText(e)));
      } finally {
        loadModels.disabled = false;
      }
    },
  }, 'Įkelti modelių sąrašą');
  const lock = s.lock && s.lock.hash ? s.lock : null;
  const lockPw = h('input', { id: 's-lock', type: 'password', autocomplete: 'new-password', placeholder: 'Naujas slaptažodis' });
  const lockStatus = h('div', { 'aria-live': 'polite' });
  const lockCard = h('section', { class: 'card stack' },
    h('h2', null, 'Užraktas'),
    h('p', { class: 'muted small' }, 'Atidarius programėlę bus prašoma slaptažodžio. Tai širma nuo smalsių akių šiame telefone, ne tikras šifravimas – duomenys naršyklės atmintyje lieka neužšifruoti.'),
    lock
      ? [h('p', null, 'Užraktas įjungtas.'),
        h('button', { class: 'btn block', type: 'button', onclick: () => { unlockedHash = null; sessionSet(null); render(); } }, 'Užrakinti dabar'),
        h('button', { class: 'btn danger block', type: 'button', onclick: () => { store.updateSettings({ lock: null }); render(); } }, 'Išjungti užraktą')]
      : [h('label', { for: 's-lock' }, 'Slaptažodis'), lockPw, lockStatus,
        h('button', {
          class: 'btn block', type: 'button',
          onclick: async () => {
            if (lockPw.value.length < 4) { lockStatus.replaceChildren(alertBox('Slaptažodis turi būti bent 4 ženklų.')); return; }
            try {
              const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
              const hash = await hashPassword(lockPw.value, salt);
              store.updateSettings({ lock: { salt, hash } });
              unlockedHash = hash; sessionSet(hash);
              render();
            } catch {
              lockStatus.replaceChildren(alertBox('Šioje naršyklėje užrakto įjungti nepavyko (reikia HTTPS).'));
            }
          },
        }, 'Įjungti užraktą')]);
  const timeErr = h('div', { 'aria-live': 'polite' });
  const saveTimes = () => {
    const a = Number(min.value), b = Number(max.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 10 || b <= a) {
      timeErr.replaceChildren(alertBox('Trukmės turi būti sekundėmis, o didžiausia – ilgesnė už mažiausią.'));
      return;
    }
    timeErr.replaceChildren();
    done(store.updateSettings({ targetMinSec: Math.round(a), targetMaxSec: Math.round(b) }));
  };
  const num = (id, value) => h('input', { id, type: 'number', inputMode: 'numeric', min: 10, step: 5, value, oninput: saveTimes });
  const min = num('s-min', s.targetMinSec), max = num('s-max', s.targetMaxSec);

  return [
    header('Nustatymai'),
    msg && alertBox(msg, 'warn'),
    server ? h('section', { class: 'card stack' },
      h('h2', null, 'AI'),
      h('p', { class: 'muted small' }, 'AI veikia per serverį: API raktas laikomas serveryje, ne telefone.'),
      server.model
        ? h('p', null, `Modelis: ${server.model}`)
        : [h('label', { for: 's-model' }, 'Modelis'), model, modelList,
          server.provider === 'nexos' && h('p', { class: 'muted small' }, 'Su nexos.ai modelį pasirinkti būtina:'),
          server.provider === 'nexos' && loadModels, modelStatus],
      h('button', {
        class: 'btn block', type: 'button',
        onclick: async () => { try { await ai.serverLogout(); } catch { /* vis tiek rodome prisijungimą */ } server.authed = false; render(); },
      }, 'Atsijungti')) : h('section', { class: 'card stack' },
      h('label', { for: 's-key' }, 'API raktas'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, key), showKey),
      h('p', { class: 'muted small' }, 'Raktas laikomas tik šios naršyklės atmintyje (localStorage) ir siunčiamas tik AI paslaugai. Jį gali perskaityti kiekvienas, kas naudojasi šia naršykle.'),
      returnTo && h('a', { class: 'btn primary block', href: returnTo, onclick: () => { returnTo = ''; } }, 'Grįžti atgal'),
      h('label', { for: 's-provider' }, 'Tiekėjas'), provider,
      h('label', { for: 's-model' }, 'Modelis'), model, modelList,
      h('p', { class: 'muted small' }, ai ? `Tinka Anthropic arba nexos.ai raktas. Su Anthropic raktu modelį gali palikti tuščią (${ai.DEFAULT_MODEL}). Su nexos.ai raktu modelį pasirinkti būtina:` : 'AI modulis neįkeltas.'),
      loadModels, modelStatus),
    h('section', { class: 'card stack' },
      h('h2', null, 'Tikslinė kalbėjimo trukmė'),
      h('div', { class: 'row' },
        h('div', { class: 'grow stack tight' }, h('label', { for: 's-min' }, 'Mažiausiai (sek.)'), min),
        h('div', { class: 'grow stack tight' }, h('label', { for: 's-max' }, 'Daugiausiai (sek.)'), max)),
      timeErr),
    saved,
    !server && lockCard,
    h('section', { class: 'card stack' },
      h('h2', null, 'Duomenys'),
      h('p', { class: 'muted small' }, 'Tekstai, užrašai ir bandymai laikomi tik šioje naršyklėje.'),
      h('button', {
        class: 'btn danger block', type: 'button',
        onclick: () => {
          if (!confirm('Ištrinti visus tekstus, užrašus, bandymus ir nustatymus (taip pat API raktą)? Šio veiksmo atšaukti negalima.')) return;
          store.clearAll();
          sess = null;
          flash = 'Visi duomenys ištrinti.';
          render();
        },
      }, 'Ištrinti visus duomenis')),
  ];
}

/* ---------- paleidimas ---------- */

window.addEventListener('hashchange', render);
window.addEventListener('unhandledrejection', (e) => { console.warn('Neapdorota klaida', e.reason); e.preventDefault(); });
render();
