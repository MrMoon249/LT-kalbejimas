// Laikmatis, garso įrašymas (MediaRecorder) ir kalbos atpažinimas (SpeechRecognition).

export class Timer {
  constructor(onTick) { this.onTick = onTick; this.t0 = 0; this.id = null; }
  start() {
    this.t0 = Date.now();
    this.id = setInterval(() => this.onTick(this.elapsed()), 200);
  }
  elapsed() { return (Date.now() - this.t0) / 1000; }
  stop() {
    clearInterval(this.id);
    this.id = null;
    return this.elapsed();
  }
}

export class Recorder {
  /** Atmeta su DOMException (NotAllowedError, NotFoundError…), jei mikrofono gauti nepavyko. */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
  }

  /** Grąžina įrašo Blob arba null, jei nebuvo įrašoma. */
  stop() {
    return new Promise((resolve) => {
      const release = () => this.stream?.getTracks().forEach((t) => t.stop());
      if (!this.rec || this.rec.state === 'inactive') { release(); return resolve(null); }
      this.rec.onstop = () => {
        release();
        resolve(this.chunks.length ? new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }) : null);
      };
      this.rec.stop();
    });
  }
}

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
export const speechSupported = Boolean(SR);

const FATAL = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'];

export class Recognizer {
  /** onText({final, interim}); onError(code) – kviečiama, kai atpažinimas nutrūksta galutinai. */
  constructor({ onText, onError }) {
    this.onText = onText;
    this.onError = onError;
    this.committed = ''; // ankstesnių atpažinimo seansų galutinis tekstas
    this.current = ''; // šio seanso galutinis tekstas
    this.interim = '';
    this.active = false;
    this.fails = 0;
  }

  get text() { return `${this.committed} ${this.current}`.replace(/\s+/g, ' ').trim(); }

  start() { this.active = true; this.#spawn(); }

  #spawn() {
    const r = (this.rec = new SR());
    r.lang = 'lt-LT';
    r.continuous = true;
    r.interimResults = true;
    const t0 = Date.now();
    let got = false;
    r.onresult = (e) => {
      got = true;
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) fin += res[0].transcript + ' '; else interim += res[0].transcript;
      }
      this.current = fin;
      this.interim = interim.trim();
      this.onText({ final: this.text, interim: this.interim });
    };
    r.onerror = (e) => {
      if (this.active && FATAL.includes(e.error)) { this.active = false; this.onError(e.error); }
    };
    r.onend = () => {
      this.committed = this.text;
      this.current = '';
      if (!this.active) return;
      // Naršyklė pati nutraukia atpažinimą po pauzės – paleidžiame iš naujo, kol kalbama.
      this.fails = !got && Date.now() - t0 < 1500 ? this.fails + 1 : 0;
      if (this.fails >= 3) { this.active = false; this.onError('unavailable'); return; }
      setTimeout(() => { if (this.active) this.#spawn(); }, 250);
    };
    try { r.start(); } catch { this.active = false; this.onError('unavailable'); }
  }

  /** Sustabdo ir grąžina visą tekstą (su dar nepatvirtinta pabaiga). */
  stop() {
    this.active = false;
    const text = `${this.text} ${this.interim}`.trim();
    if (this.rec) {
      this.rec.onresult = this.rec.onerror = this.rec.onend = null;
      try { this.rec.abort(); } catch { /* nieko */ }
    }
    return text;
  }
}
