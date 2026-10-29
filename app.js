// TakeKit — WorkinWithAI. Sing (or play) every loop pass over YOUR chords; TakeKit scores every bar of every take
// for pitch, timing, level and dropouts, builds the best comp with seams moved to the quietest point, and lets you
// pick/lock any bar. Exports a grid-locked 48 kHz / 24-bit WAV + multitrack MIDI (+ stems with every raw take).
// Engine rules: audio-clock lookahead scheduler, live state read every step, OfflineAudioContext exports at the exact
// bar length, samples pinned to a commit SHA (FluidR3) or bundled (CC0 drums), pitch shift <= ±2 semitones (hard cap ±4).
const APP = "takekit", BRAND = "TakeKit";
const SR = 48000, STEPS = 16, TAIL_S = 3, FAST_RELEASE = 0.01, MAX_SHIFT = 4;
const LOOKAHEAD_MS = 25;      // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.12;  // seconds of audio scheduled in advance
const SF_SHA = "044fab8e1456bfafc5776e86dfd6bb8697149aef"; // pinned commit, never a branch
const SF = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@${SF_SHA}/FluidR3_GM`;
const SF_MIRROR = `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${SF_SHA}/FluidR3_GM`; // same commit, used if jsDelivr refuses a file
const KIT_DIR = "samples/drums";
const NAMES = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const pc = x => ((x % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const loadJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };

// ---------- instruments: every voice is the FluidR3 GM sample it is named after ----------
const INST = {
  piano:   { label: "Piano (FluidR3 acoustic grand)", dir: "acoustic_grand_piano", gm: 0, lo: 36, hi: 88, gain: 0.9 },
  epiano:  { label: "Electric piano (FluidR3 EP 1)", dir: "electric_piano_1", gm: 4, lo: 36, hi: 84, gain: 1.0 },
  organ:   { label: "Drawbar organ (FluidR3)", dir: "drawbar_organ", gm: 16, lo: 36, hi: 84, gain: 0.55, sus: true },
  finger:  { label: "Finger bass (FluidR3 electric bass)", dir: "electric_bass_finger", gm: 33, lo: 28, hi: 56, gain: 1.15 },
  strings: { label: "String ensemble (FluidR3)", dir: "string_ensemble_1", gm: 48, lo: 40, hi: 84, gain: 0.6, sus: true },
  nylon:   { label: "Nylon guitar (FluidR3)", dir: "acoustic_guitar_nylon", gm: 24, lo: 40, hi: 76, gain: 1.0 },
  flute:   { label: "Flute (FluidR3)", dir: "flute", gm: 73, lo: 60, hi: 92, gain: 0.7, sus: true }
};
const LIVE_INSTS = ["piano", "epiano", "organ", "strings", "nylon", "flute", "finger"];
// Acoustic kit: Virtuosity Drums (CC0), hosted in this repo (public/samples/drums).
const KIT = {
  kick:  { gm: 36, file: "kick",  label: "Acoustic kit: kick (Virtuosity Drums)", gain: 1.0 },
  snare: { gm: 38, file: "snare", label: "Acoustic kit: snare (Virtuosity Drums)", gain: 0.8 },
  ghost: { gm: 40, file: "ghost", label: "Acoustic kit: soft snare (Virtuosity Drums)", gain: 0.45 },
  rim:   { gm: 37, file: "rim",   label: "Acoustic kit: cross-stick rim click (Virtuosity Drums)", gain: 0.6 },
  hat:   { gm: 42, file: "hat",   label: "Acoustic kit: closed hi-hat (Virtuosity Drums)", gain: 0.45 },
  ohat:  { gm: 46, file: "ohat",  label: "Acoustic kit: open hi-hat (Virtuosity Drums)", gain: 0.35 }
};
const KIT_BY_GM = Object.fromEntries(Object.entries(KIT).map(([k, v]) => [v.gm, k]));
const D = Object.fromEntries(Object.entries(KIT).map(([k, v]) => [k, v.gm]));
const noteName = n => NAMES[pc(n)] + (Math.floor(n / 12) - 1);
function sampleList(){ const out = [];
  for (const [inst, d] of Object.entries(INST)) { const ns = []; for (let n = d.lo; n < d.hi + 2; n += 4) ns.push(n); if (ns[ns.length - 1] < d.hi - 2) ns.push(d.hi);
    for (const n of ns) out.push({ inst, id: inst + ":" + n, midi: n, url: `${SF}/${d.dir}-mp3/${noteName(n)}.mp3`, alt: `${SF_MIRROR}/${d.dir}-mp3/${noteName(n)}.mp3`, label: d.label }); }
  for (const [k, v] of Object.entries(KIT)) out.push({ inst: "kit", id: "kit:" + k, piece: k, url: `${KIT_DIR}/${v.file}.flac`, label: v.label });
  return out; }
const SAMPLES = sampleList();
const BY_INST = {}; for (const s of SAMPLES) if (s.inst !== "kit") (BY_INST[s.inst] = BY_INST[s.inst] || []).push(s);
function fold(n, lo, hi){ while (n < lo) n += 12; while (n > hi) n -= 12; return n; }
function nearestSample(inst, midi){ const d = INST[inst], list = BY_INST[inst]; const n = fold(midi, d.lo - 2, d.hi + 2); let best = null;
  for (const s of list) { const sh = n - s.midi; if (!best || Math.abs(sh) < Math.abs(best.shift)) best = { id: s.id, shift: sh, n }; } return best; }

// ---------- theory ----------
const QUAL = { "": [0,4,7], M: [0,4,7], m: [0,3,7], min: [0,3,7], "7": [0,4,7,10], m7: [0,3,7,10], maj7: [0,4,7,11], m7b5: [0,3,6,10], dim: [0,3,6], dim7: [0,3,6,9],
  aug: [0,4,8], sus2: [0,2,7], sus4: [0,5,7], sus: [0,5,7], "7sus4": [0,5,7,10], "6": [0,4,7,9], m6: [0,3,7,9], add9: [0,4,7,14], "9": [0,4,7,10,14], m9: [0,3,7,10,14], maj9: [0,4,7,11,14] };
const ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJ = [0,2,4,5,7,9,11], MIN = [0,2,3,5,7,8,10];
function mk(root, q){ q = q || ""; return { root: pc(root), q, ivs: QUAL[q] || QUAL[""] }; }
function parseChord(s){
  const m = /^([A-G])(#|b)?(maj9|maj7|m7b5|7sus4|min|m9|m7|m6|dim7|dim|aug|sus2|sus4|sus|add9|9|7|6|m|M)?(?:\/([A-G])(#|b)?)?$/.exec(String(s).trim()); if (!m) return null;
  const c = mk(ROOTS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0), m[3] || ""); if (m[4]) c.bass = pc(ROOTS[m[4]] + (m[5] === "#" ? 1 : m[5] === "b" ? -1 : 0)); return c; }
const tokens = str => String(str).trim().split(/[\s,|]+/).filter(Boolean);
function parseProg(str){ const t = tokens(str); if (t.length < 1 || t.length > 8) return null; const c = t.map(parseChord); return c.includes(null) ? null : c; }
function chName(c){ return NAMES[c.root] + (c.q === "M" ? "" : c.q === "min" ? "m" : c.q) + (c.bass != null ? "/" + NAMES[c.bass] : ""); }
function trC(c, k){ const o = mk(c.root + k, c.q); if (c.bass != null) o.bass = pc(c.bass + k); return o; }
function chordPcs(c){ return [...new Set(c.ivs.map(i => pc(c.root + i)))]; }
function voicing(c, lo, hi, prev, n){ const pcs = chordPcs(c).slice(0, n || 4), cands = [];
  for (let k = 0; k < pcs.length; k++) { let x = lo; while (pc(x) !== pcs[k]) x++; const v = [x];
    for (let j = 1; j < pcs.length; j++) { let y = v[v.length - 1] + 1; while (pc(y) !== pcs[(k + j) % pcs.length]) y++; v.push(y); }
    for (let o = 0; o <= 12; o += 12) if (v[v.length - 1] + o <= hi) cands.push(v.map(z => z + o)); }
  if (!cands.length) return [fold(c.root + 48, lo, hi)];
  const mid = (lo + hi) / 2, mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const score = v => prev && prev.length ? v.reduce((s, x, i) => s + Math.abs(x - prev[Math.min(i, prev.length - 1)]), 0) : Math.abs(mean(v) - mid);
  return cands.sort((a, b) => score(a) - score(b))[0]; }
const bassOf = (c, lo, hi) => fold((c.bass != null ? c.bass : c.root), lo, hi);
const scalePcs = st => (st.mode === "minor" ? MIN : MAJ).map(x => pc(x + st.keyRoot));
const keyLabel = st => NAMES[st.keyRoot] + (st.mode === "minor" ? "m" : "");

// ---------- state (persisted in localStorage; audio takes in IndexedDB) ----------
const RECIPES = {
  ballad: { name: "Ballad", bpm: 68, note: "piano halves, held strings, soft kick + rim" },
  pop:    { name: "Pop", bpm: 92, note: "piano eighths, root bass, backbeat drums" },
  groove: { name: "Groove", bpm: 100, note: "EP offbeat stabs, syncopated bass, 16th hats" },
  sparse: { name: "Sparse", bpm: 80, note: "piano whole notes only (quiet for tracking)" } };
const CHAIRS = [
  { id: "drums", name: "Drums (acoustic kit)", ch: 9 }, { id: "bass", name: "Bass (finger)", ch: 1 }, { id: "keys", name: "Keys", ch: 0 },
  { id: "pad", name: "Pad (strings)", ch: 2 }, { id: "play", name: "Your MIDI comp", ch: 3 } ];
const CHAIR = Object.fromEntries(CHAIRS.map(c => [c.id, c]));
const DEFAULT = { bpm: 92, keyRoot: 9, mode: "minor", chords: "Am F C G", bars: 8, recipe: "pop", seg: 1,
  weights: { pitch: 3, timing: 2, level: 2, presence: 2 }, switchPen: 12, xfadeMs: 20, seamMs: 80,
  gains: { drums: 0.8, bass: 0.9, keys: 0.8, pad: 0.6, play: 0.9 }, mutes: { drums: false, bass: false, keys: false, pad: false, play: false },
  voiceGain: 1, voiceMute: false, master: 0.9, liveGain: 0.9, liveInst: "piano", kbdOct: 4, recordKeys: false,
  audioIn: "", audioOut: "", midiIn: "", midiOut: "", monitor: true, gate: { on: true, th: -50, atk: 2, hold: 60, rel: 120 }, trimDb: 0, latFixMs: 0,
  listen: "comp", hearCompWhileRec: false, sections: null, loop: false, loopSec: 0, secSrc: "user", userSet: { bpm: false, key: false }, sv: 2, locks: { voice: {}, midi: {} }, excluded: {}, midiTakes: [], takeNames: {}, nextTake: 1 };
const state = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), loadJSON(APP + "-settings") || {});
if (state.sv !== 3) { state.sv = 3; state.loop = false; if (state.bk) state.bk.whole = true; } // full song by default (looping is opt-in)
for (const k of ["weights", "gains", "mutes", "gate", "locks", "userSet"]) state[k] = Object.assign(JSON.parse(JSON.stringify(DEFAULT[k])), state[k] || {});
let ver = 1; const save = () => { ver++; localStorage.setItem(APP + "-settings", JSON.stringify(state)); };
const prog = () => parseProg(state.chords) || parseProg("Am F C G");
// ---------- song structure: sections play start to finish; "Loop this section" is opt-in ----------
const DEF_SECS = [["Intro", 8, 0, 0.45], ["Verse 1", 8, 0, 0.7], ["Chorus", 8, 2, 1], ["Verse 2", 8, 0, 0.7], ["Chorus", 8, 2, 1], ["Bridge", 8, 1, 0.8], ["Chorus", 8, 2, 1], ["Outro", 8, 0, 0.45]];
const defaultSections = () => DEF_SECS.map(([name, bars, rot, energy]) => ({ name, bars, chords: "", rot, energy, lock: false }));
function parseSecProg(str){ const t = tokens(str); if (t.length < 1 || t.length > 64) return null; const c = t.map(parseChord); return c.includes(null) ? null : c; }
function secProg(s){ const p = s && s.chords ? parseSecProg(s.chords) : null; if (p) return p; const m = prog(), r = ((s && s.rot) || 0) % m.length; return m.slice(r).concat(m.slice(0, r)); }
function normSections(){ if (!Array.isArray(state.sections) || !state.sections.length) state.sections = defaultSections();
  state.sections = state.sections.slice(0, 48).map((x, i) => ({ name: String(x.name || "Section " + (i + 1)).slice(0, 24), bars: clamp(Math.round(+x.bars || 8), 1, 128), chords: String(x.chords || "").slice(0, 400), rot: Math.round(+x.rot || 0), energy: clamp(x.energy == null ? 1 : +x.energy, 0, 1), lock: !!x.lock, conf: x.conf == null ? null : +x.conf }));
  if (state.src === "band") state.bars = Math.min(1024, state.sections.reduce((a, x) => a + x.bars, 0)); }
let regCache = { key: "", v: [] };
function regions(){ const key = JSON.stringify([state.sections, state.bars, state.src, state.secSrc, state.chords]); if (regCache.key === key) return regCache.v;
  const out = [], useSecs = state.src === "band" || state.secSrc === "upload"; let b = 0;
  if (useSecs) for (const s of state.sections) { if (b >= state.bars) break; const b1 = Math.min(state.bars, b + s.bars); out.push({ name: s.name, b0: b, b1, sec: s, p: secProg(s) }); b = b1; }
  while (b < state.bars) { const b1 = Math.min(state.bars, b + 8); out.push({ name: b1 - b === state.bars ? "Loop" : `Bars ${b + 1}–${b1}`, b0: b, b1, sec: null, p: null }); b = b1; }
  regCache = { key, v: out }; return out; }
const regionAt = b => { const rs = regions(); for (const r of rs) if (b >= r.b0 && b < r.b1) return r; return rs[rs.length - 1]; };
const chordAt = b => { const r = regionAt(b); if (r && r.p) return r.p[(b - r.b0) % r.p.length]; const p = prog(); return p[b % p.length]; };
const energyAt = b => { const r = regionAt(b); return r && r.sec ? r.sec.energy : 1; };
function playRange(){ if (state.loop) { const r = regions()[clamp(state.loopSec, 0, regions().length - 1)]; if (r) return [r.b0 * STEPS, r.b1 * STEPS]; } return [0, loopSteps()]; }
const loopSteps = () => state.bars * STEPS;
const stepDur = () => 60 / state.bpm / 4;
const loopDur = () => state.bars * 4 * 60 / state.bpm;
const nSeg = () => Math.max(1, Math.round(state.bars / state.seg));

// ---------- band: one recipe per style, read fresh every step (live changes apply on the next step) ----------
const E = (ch, i, n, s, d, v) => ({ ch, i, n, s, d, v });
function bandEvents(st){ const all = [], R = st.recipe; let prev = null;
  for (let b = 0; b < st.bars; b++) { const c = chordAt(b), s0 = b * STEPS, en = energyAt(b), out = [], v = voicing(c, 55, 74, prev, 4), bn = bassOf(c, 33, 48), fifth = fold(bn + 7, 33, 52); prev = v;
    if (R === "ballad") { for (const s of [0, 8]) for (const n of v) out.push(E("keys", "piano", n, s0 + s, 8, s ? 0.42 : 0.5));
      for (const n of voicing(c, 52, 72, null, 3)) out.push(E("pad", "strings", n, s0, 16, 0.5)); out.push(E("bass", "finger", bn, s0, 16, 0.7));
      out.push(E("drums", "kit", D.kick, s0, 1, 0.8)); out.push(E("drums", "kit", D.rim, s0 + 8, 1, 0.6)); for (let s = 0; s < 16; s += 4) out.push(E("drums", "kit", D.hat, s0 + s, 1, 0.3)); }
    else if (R === "pop") { for (let s = 0; s < 16; s += 2) for (const n of v) out.push(E("keys", "piano", n, s0 + s, 1.8, s % 8 === 0 ? 0.5 : 0.36));
      for (const n of voicing(c, 52, 72, null, 3)) out.push(E("pad", "strings", n, s0, 16, 0.34)); for (let s = 0; s < 16; s += 2) out.push(E("bass", "finger", bn, s0 + s, 1.8, s % 4 === 0 ? 0.75 : 0.6));
      for (const s of [0, 6, 8]) out.push(E("drums", "kit", D.kick, s0 + s, 1, s === 0 ? 0.9 : 0.7)); for (const s of [4, 12]) out.push(E("drums", "kit", D.snare, s0 + s, 1, 0.8));
      for (let s = 0; s < 16; s += 2) out.push(E("drums", "kit", D.hat, s0 + s, 1, s % 4 === 0 ? 0.4 : 0.28)); }
    else if (R === "groove") { for (const s of [2, 6, 10, 14]) for (const n of v) out.push(E("keys", "epiano", n, s0 + s, 1.5, 0.5));
      for (const n of voicing(c, 52, 72, null, 3)) out.push(E("pad", "strings", n, s0, 16, 0.25));
      for (const [s, n, d, vv] of [[0, bn, 3, 0.8], [3, bn, 1, 0.55], [6, bn, 2, 0.65], [10, fifth, 2, 0.6], [14, fold(bn + 12, 33, 56), 1, 0.55]]) out.push(E("bass", "finger", n, s0 + s, d, vv));
      for (const s of [0, 7, 10]) out.push(E("drums", "kit", D.kick, s0 + s, 1, s === 0 ? 0.9 : 0.7)); for (const s of [4, 12]) out.push(E("drums", "kit", D.snare, s0 + s, 1, 0.85));
      out.push(E("drums", "kit", D.ghost, s0 + 15, 1, 0.4)); for (let s = 0; s < 16; s++) out.push(E("drums", "kit", s === 14 ? D.ohat : D.hat, s0 + s, 1, s % 2 ? 0.18 : 0.32)); }
    else { for (const n of v) out.push(E("keys", "piano", n, s0, 16, 0.5)); }
    // section energy (detected or set by you): quiet sections drop the drums and thin the hats, all parts scale in velocity
    for (const e of out) { if (en < 0.35 && e.ch === "drums") continue; if (en < 0.6 && e.ch === "drums" && e.n === D.hat && (e.s - s0) % 4) continue; e.v = Math.round(e.v * (0.55 + 0.45 * en) * 1000) / 1000; all.push(e); } }
  return all; }

// ---------- takes ----------
let takes = [];                  // audio takes: { id, name, lane:"voice", sr, data, bpm, bars, an }
const midiTakes = () => state.midiTakes; // { id, name, lane:"midi", notes:[{n,v,s,d}], bars }
const takeName = t => state.takeNames[t.id] || t.name;
const compatible = t => t.lane === "midi" ? true : (t.bpm === state.bpm && t.bars === state.bars);
const laneTakes = lane => lane === "voice" ? takes : midiTakes();
const idb = { db: null,
  open(){ if (this.db) return Promise.resolve(this.db); return new Promise((res, rej) => { const r = indexedDB.open(APP, 2); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("takes")) d.createObjectStore("takes", { keyPath: "id" }); if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" }); }; r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error); }); },
  async tx(mode, fn){ const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("takes", mode), s = t.objectStore("takes"), r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); },
  put(t){ return this.tx("readwrite", s => s.put({ id: t.id, name: t.name, sr: t.sr, data: t.data, bpm: t.bpm, bars: t.bars, region: t.region, created: t.created })).catch(() => {}); },
  del(id){ return this.tx("readwrite", s => s.delete(id)).catch(() => {}); },
  clear(){ return this.tx("readwrite", s => s.clear()).catch(() => {}); },
  all(){ return this.tx("readonly", s => s.getAll()).catch(() => []); } };
function resample(x, from, to){ if (from === to) return x; const n = Math.round(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; } return y; }

// ---------- analysis: YIN pitch, onsets, level per frame (12 kHz working rate) ----------
function analyzeAudio(t){ const q = Math.max(1, Math.round(t.sr / 12000)), sr = t.sr / q, n = Math.floor(t.data.length / q), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < q; j++) s += t.data[i * q + j]; x[i] = s / q; }
  const W = 512, H = 256, tmin = Math.floor(sr / 1000), tmax = Math.ceil(sr / 70), d = new Float32Array(tmax + 2), fr = { t: [], rms: [], f0: [], pk: [] };
  for (let off = 0; off + W + tmax < n + tmax; off += H) { let e = 0, pk = 0; for (let j = 0; j < W; j++) { const v = x[off + j] || 0; e += v * v; } const rms = Math.sqrt(e / W);
    const r0 = off * q, r1 = Math.min(t.data.length, (off + H) * q); for (let j = r0; j < r1; j++) { const a = Math.abs(t.data[j]); if (a > pk) pk = a; }
    let f0 = 0;
    if (rms > 0.004 && off + W + tmax < n) { d[0] = 1; let run = 0, found = -1;
      for (let tau = 1; tau <= tmax; tau++) { let s = 0; for (let j = 0; j < W; j++) { const df = x[off + j] - x[off + j + tau]; s += df * df; } run += s; d[tau] = run > 0 ? s * tau / run : 1; }
      for (let tau = tmin; tau < tmax; tau++) if (d[tau] < 0.15) { while (tau + 1 < tmax && d[tau + 1] < d[tau]) tau++; found = tau; break; }
      if (found > 0) { const a = d[found - 1], b = d[found], c = d[found + 1], den = a - 2 * b + c, sh = den ? 0.5 * (a - c) / den : 0; f0 = sr / (found + clamp(sh, -1, 1)); } }
    fr.t.push((off + W / 2) / sr); fr.rms.push(rms); fr.f0.push(f0); fr.pk.push(pk); }
  // onsets: level jumps and note changes (legato singing)
  const on = [], db = fr.rms.map(r => 20 * Math.log10(r + 1e-9)), mid = fr.f0.map(f => f > 0 ? 69 + 12 * Math.log2(f / 440) : null); let last = -1;
  for (let i = 3; i < db.length; i++) { const mn = Math.min(db[i - 1], db[i - 2], db[i - 3]); const lvl = db[i] > -42 && db[i] - mn > 9;
    const nt = !lvl && mid[i] != null && mid[i - 1] != null && mid[i - 2] != null && mid[i - 3] != null && Math.abs(mid[i] - mid[i - 1]) < 0.3 && Math.abs(mid[i - 1] - mid[i - 2]) < 0.3 && Math.abs(mid[i - 2] - mid[i - 3]) > 0.5;
    if ((lvl || nt) && (last < 0 || fr.t[i] - fr.t[last] > 0.1)) { on.push(lvl ? refineOnset(t, fr.t[i] - (W / 2 + H) / sr, fr.t[i] + W / 2 / sr) : fr.t[i - 2]); last = i; } }
  fr.on = on; fr.hop = H / sr; return fr; }
// sample-accurate onset inside a coarse frame: first point where a 2 ms envelope reaches half of the window's peak envelope
function refineOnset(t, a, b){ const x = t.data, sr = t.sr, i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(x.length, Math.ceil(b * sr)), w = Math.max(1, Math.round(0.002 * sr)), env = [];
  for (let i = i0; i + w <= i1; i += w) { let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(x[j])); env.push(m); }
  const pk = Math.max(0, ...env); let k = 0; while (k < env.length && env[k] < 0.5 * pk) k++; return (i0 + k * w) / sr; }
const fmtC = c => (c > 0 ? "+" : "−") + Math.abs(Math.round(c)) + "¢";
function segStatsAudio(t, s0, s1){ const fr = t.an, ix = []; for (let i = 0; i < fr.t.length; i++) if (fr.t[i] >= s0 && fr.t[i] < s1) ix.push(i);
  const sc = scalePcs(state), b0 = Math.floor(s0 / (loopDur() / state.bars) + 1e-6), chord = chordPcs(chordAt(b0)), allowed = new Set(sc.concat(chord));
  let voiced = 0, cAbs = 0, cSig = 0, oof = 0, eSum = 0, eN = 0, pk = 0;
  for (const i of ix) { pk = Math.max(pk, fr.pk[i]); if (fr.rms[i] > 0.006) { eSum += fr.rms[i] * fr.rms[i]; eN++; }
    if (fr.f0[i] > 0 && fr.rms[i] > 0.006) { voiced++; const m = 69 + 12 * Math.log2(fr.f0[i] / 440); let near = Math.round(m), dn = 99;
      for (let r = Math.floor(m) - 1; r <= Math.ceil(m) + 1; r++) if (allowed.has(pc(r)) && Math.abs(m - r) < dn) { dn = Math.abs(m - r); near = r; } // judge against the nearest note in the key/chord
      const gm = window.__pro ? window.__pro.guideMidi(fr.t[i]) : null; if (gm != null) { let dd = m - gm; dd -= 12 * Math.round(dd / 12); near = m - dd; } // guide vocal = target melody (any octave)
      const c = (m - near) * 100; if (Math.abs(c) > 70) oof++; else { cAbs += Math.abs(c); cSig += c; } } }
  const g = 60 / state.bpm / 2, ons = fr.on.filter(x => x >= s0 - 0.03 && x < s1 - 0.03), err = ons.map(x => { const k = Math.round(x / g); return (x - k * g) * 1000; });
  return { frames: ix.length, voicedFrac: ix.length ? voiced / ix.length : 0, cents: voiced - oof > 0 ? cAbs / (voiced - oof) : 0, centsSigned: voiced - oof > 0 ? cSig / (voiced - oof) : 0, oof: voiced ? oof / voiced : 0,
    db: eN ? 10 * Math.log10(eSum / eN + 1e-12) : -120, clip: pk >= 0.985, onsets: ons.length, timingMs: err.length ? err.reduce((a, b) => a + Math.abs(b), 0) / err.length : null, lateMs: err.length ? err.reduce((a, b) => a + b, 0) / err.length : 0 }; }
function segStatsMidi(t, s0, s1){ const sd = stepDur(), sc = scalePcs(state), notes = t.notes.filter(n => n.s >= s0 - 0.5 && n.s < s1 - 0.5 && n.s < loopSteps());
  const b0 = Math.floor(s0 / STEPS), allowed = new Set(sc.concat(chordPcs(chordAt(b0)))), err = notes.map(n => (n.s - Math.round(n.s)) * sd * 1000);
  const vs = notes.map(n => n.v), mv = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0, sdv = vs.length ? Math.sqrt(vs.reduce((a, b) => a + (b - mv) * (b - mv), 0) / vs.length) : 0;
  return { notes: notes.length, wrong: notes.length ? notes.filter(n => !allowed.has(pc(n.n))).length / notes.length : 0, timingMs: err.length ? err.reduce((a, b) => a + Math.abs(b), 0) / err.length : null,
    lateMs: err.length ? err.reduce((a, b) => a + b, 0) / err.length : 0, velSd: sdv, vel: mv }; }
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
// scores = { segs:[{ empty, cells:{ takeId: { score, parts, reason } } }], takes:[ids] }
let scoreCache = {};
function scoresFor(lane){ const key = lane + "|" + ver + "|" + takes.length + "|" + midiTakes().length + "|" + (window.__pro ? window.__pro.scoreKey() : ""); if (scoreCache[key]) return scoreCache[key];
  const list = laneTakes(lane).filter(compatible), N = nSeg(), segs = [], w = state.weights, wsum = (w.pitch + w.timing + w.level + w.presence) || 1;
  for (let k = 0; k < N; k++) { const cells = {}, stats = {};
    if (lane === "voice") { const L = loopDur() / N, s0 = k * L, s1 = s0 + L; for (const t of list) stats[t.id] = segStatsAudio(t, s0, s1);
      const vf = Math.max(0, ...Object.values(stats).map(s => s.voicedFrac)), med = median(Object.values(stats).filter(s => s.voicedFrac > 0.1).map(s => s.db));
      for (const t of list) { const s = stats[t.id]; if (vf < 0.08) { cells[t.id] = { score: 0, reason: "nothing sung here", s }; continue; }
        const pitch = s.voicedFrac > 0.05 ? clamp(1 - (s.cents - 6) / 30, 0, 1) * (1 - 0.6 * s.oof) : 0;
        const timing = s.timingMs == null ? 0.7 : clamp(1 - Math.max(0, s.timingMs - 15) / 85, 0, 1);
        let level = s.voicedFrac > 0.05 ? clamp(1 - Math.max(0, Math.abs(s.db - med) - 2) / 10, 0, 1) : 0; if (s.clip) level *= 0.2;
        const presence = clamp(s.voicedFrac / vf, 0, 1);
        const score = Math.round(100 * (w.pitch * pitch + w.timing * timing + w.level * level + w.presence * presence) / wsum), flaws = [];
        if (presence < 0.5) flaws.push([1 - presence, "dropout"]);
        if (s.clip) flaws.push([0.9, "clipped"]);
        if (pitch < 0.8 && s.voicedFrac > 0.05) flaws.push([1 - pitch, s.oof > 0.25 ? "off-key notes" : fmtC(s.centsSigned) + (s.centsSigned > 0 ? " sharp" : " flat")]);
        if (timing < 0.75 && s.timingMs != null) flaws.push([1 - timing, (s.lateMs >= 0 ? "late " : "early ") + Math.round(Math.abs(s.lateMs)) + " ms"]);
        if (level < 0.75 && !s.clip && s.voicedFrac > 0.05) flaws.push([1 - level, (s.db < med ? "−" : "+") + Math.round(Math.abs(s.db - med)) + " dB " + (s.db < med ? "quiet" : "hot")]);
        flaws.sort((a, b) => b[0] - a[0]);
        cells[t.id] = { score, parts: { pitch, timing, level, presence }, reason: flaws.length ? flaws.map(f => f[1]).slice(0, 2).join(", ") : "clean", s }; }
      segs.push({ empty: vf < 0.08, cells }); }
    else { const L = loopSteps() / N, s0 = k * L, s1 = s0 + L; for (const t of list) stats[t.id] = segStatsMidi(t, s0, s1);
      const mx = Math.max(0, ...Object.values(stats).map(s => s.notes));
      for (const t of list) { const s = stats[t.id]; if (!mx) { cells[t.id] = { score: 0, reason: "no notes here", s }; continue; }
        const timing = s.timingMs == null ? 0 : clamp(1 - Math.max(0, s.timingMs - 10) / 70, 0, 1), pitch = s.notes ? 1 - s.wrong : 0, level = s.notes ? clamp(1 - Math.max(0, s.velSd - 0.08) / 0.3, 0, 1) : 0, presence = s.notes / mx;
        const score = Math.round(100 * (w.pitch * pitch + w.timing * timing + w.level * level + w.presence * presence) / wsum), flaws = [];
        if (presence < 0.6) flaws.push([1 - presence, "missing notes"]); if (pitch < 0.9) flaws.push([1 - pitch, Math.round(s.wrong * 100) + "% wrong notes"]);
        if (timing < 0.75 && s.timingMs != null) flaws.push([1 - timing, (s.lateMs >= 0 ? "late " : "early ") + Math.round(Math.abs(s.lateMs)) + " ms"]); if (level < 0.7) flaws.push([1 - level, "uneven velocity"]);
        flaws.sort((a, b) => b[0] - a[0]); cells[t.id] = { score, parts: { pitch, timing, level, presence }, reason: flaws.length ? flaws.map(f => f[1]).slice(0, 2).join(", ") : "clean", s }; }
      segs.push({ empty: !mx, cells }); } }
  const v = { segs, takes: list.map(t => t.id) }; if (Object.keys(scoreCache).length > 6) scoreCache = {}; scoreCache[key] = v; return v; }

// ---------- auto comp: Viterbi over segments; the switch penalty keeps whole passes; locks always win ----------
function autoComp(lane){ const sc = scoresFor(lane), ids = sc.takes.filter(id => !state.excluded[id]), N = sc.segs.length, opts = ids.concat([null]), locks = state.locks[lane] || {};
  if (!ids.length) return { choice: Array(N).fill(null), why: Array(N).fill("no takes yet") };
  const cost = (k, o) => { const L = locks[k]; if (L !== undefined && (L === "none" || ids.includes(L))) { const want = L === "none" ? null : L; if (o !== want) return 1e6; }
    const sg = sc.segs[k]; if (o === null) return sg.empty ? 0 : 100; return sg.empty ? 5 : 100 - sg.cells[o].score; };
  const sw = (a, b) => (a === b || a === null || b === null) ? 0 : state.switchPen;
  let dp = opts.map(o => cost(0, o)); const back = [];
  for (let k = 1; k < N; k++) { const nd = [], bk = []; for (let j = 0; j < opts.length; j++) { let best = 1e12, bi = 0; for (let i = 0; i < opts.length; i++) { const c = dp[i] + sw(opts[i], opts[j]); if (c < best) { best = c; bi = i; } } nd.push(best + cost(k, opts[j])); bk.push(bi); } dp = nd; back.push(bk); }
  let j = dp.indexOf(Math.min(...dp)); const choice = Array(N); for (let k = N - 1; k >= 0; k--) { choice[k] = opts[j]; if (k > 0) j = back[k - 1][j]; }
  const why = choice.map((o, k) => { const sg = sc.segs[k]; if (locks[k] !== undefined && (locks[k] === "none" || ids.includes(locks[k]))) return "locked by you" + (o ? ": " + sg.cells[o].reason : ": silence");
    if (o === null) return sg.empty ? "nothing sung here" : "silence";
    const ranked = ids.slice().sort((a, b) => sg.cells[b].score - sg.cells[a].score), top = ranked[0], c = sg.cells[o];
    return (top === o ? "best: " : "kept for flow (best was " + takeLabel(top) + " " + sg.cells[top].score + "): ") + c.reason; });
  return { choice, why }; }
const takeLabel = id => { const t = takes.concat(midiTakes()).find(x => x.id === id); return t ? takeName(t) : "?"; };
function bestWhole(lane){ const sc = scoresFor(lane); let best = null, bv = -1; for (const id of sc.takes) { if (state.excluded[id]) continue; const v = sc.segs.reduce((a, s) => a + (s.empty ? 0 : s.cells[id].score), 0); if (v > bv) { bv = v; best = id; } } return best; }
let compCache = { key: "", v: null };
function comps(){ const key = ver + "|" + takes.length + "|" + midiTakes().length; if (compCache.key === key) return compCache.v; const v = { voice: autoComp("voice"), midi: autoComp("midi"), bestVoice: bestWhole("voice"), bestMidi: bestWhole("midi") }; compCache = { key, v }; return v; }
// what is heard: comp (B), best whole take (A), or one raw take
function choiceFor(lane, listen){ const c = comps(), N = nSeg(); listen = listen || state.listen;
  if (listen === "best") return Array(N).fill(lane === "voice" ? c.bestVoice : c.bestMidi);
  if (listen !== "comp") { const t = laneTakes(lane).find(x => x.id === listen); if (t) return Array(N).fill(t.id); const other = laneTakes(lane === "voice" ? "midi" : "voice").find(x => x.id === listen); if (other) return Array(N).fill(null); }
  return c[lane].choice; }

// ---------- comp render: seams moved to the quietest point near the boundary, equal-power crossfades ----------
function seamPoint(a, c, b, sr){ const win = Math.round(state.seamMs / 1000 * sr), h = Math.round(0.005 * sr), step = Math.max(1, Math.round(sr / 2000)); let best = b, bv = Infinity, mean = 0, cnt = 0;
  const en = (x, p) => { if (!x) return 0; let s = 0; for (let i = Math.max(0, p - h); i < Math.min(x.length, p + h); i++) s += x[i] * x[i]; return s; };
  const vals = []; for (let p = b - win; p <= b + win; p += step) { const v = en(a, p) + en(c, p); vals.push([p, v]); mean += v; cnt++; } mean /= Math.max(1, cnt);
  for (const [p, v] of vals) { const cst = v + 0.15 * mean * Math.abs(p - b) / Math.max(1, win); if (cst < bv) { bv = cst; best = p; } } return best; }
function renderVoice(choice, sr){ const N = Math.round(state.bars * 4 * 60 / state.bpm * sr), out = new Float32Array(N), segL = N / choice.length, byId = Object.fromEntries(takes.map(t => [t.id, t]));
  const data = id => { const t = byId[id]; if (!t) return null; return t.sr === sr ? t.data : (t["_r" + sr] || (t["_r" + sr] = resample(t.data, t.sr, sr))); };
  const regs = []; for (let k = 0; k < choice.length; k++) { const id = choice[k] && byId[choice[k]] ? choice[k] : null; if (regs.length && regs[regs.length - 1].id === id) regs[regs.length - 1].k1 = k + 1; else regs.push({ id, k0: k, k1: k + 1 }); }
  const xf = Math.max(2, Math.round(state.xfadeMs / 1000 * sr)), h = Math.floor(xf / 2), edge = Math.round(0.003 * sr), seams = [];
  for (let r = 0; r < regs.length; r++) { const R = regs[r]; R.a = r === 0 ? 0 : regs[r - 1].b; R.b = r === regs.length - 1 ? N : seamPoint(data(R.id), data(regs[r + 1].id), Math.round(R.k1 * segL), sr); if (r < regs.length - 1) seams.push({ at: R.b / sr, from: R.id, to: regs[r + 1].id }); }
  for (let r = 0; r < regs.length; r++) { const R = regs[r], x = data(R.id); if (!x) continue; const i0 = Math.max(0, r === 0 ? 0 : R.a - h), i1 = Math.min(N, r === regs.length - 1 ? N : R.b + h);
    for (let i = i0; i < i1; i++) { let g = 1; if (r > 0 && i < R.a + h) g = Math.sin(Math.PI / 2 * clamp((i - (R.a - h)) / (2 * h), 0, 1)); if (r < regs.length - 1 && i > R.b - h) g = Math.min(g, Math.cos(Math.PI / 2 * clamp((i - (R.b - h)) / (2 * h), 0, 1))); out[i] += (x[i] || 0) * g; } }
  for (let i = 0; i < edge && i < N; i++) { const g = i / edge; out[i] *= g; out[N - 1 - i] *= g; } // fade loop edges so tiled loops never click
  return { data: out, N, sr, seams }; }
const rmsOf = x => { let s = 0, n = 0; for (let i = 0; i < x.length; i += 4) { s += x[i] * x[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
// matched loudness: whatever you compare against the comp (best take = A, or any raw take) is gain-matched to the comp
function makeupFor(listen){ if (listen === "comp" || !takes.length) return 1; const sr = takes[0].sr, B = rmsOf(renderVoice(choiceFor("voice", "comp"), sr).data), A = rmsOf(renderVoice(choiceFor("voice", listen), sr).data); return A > 1e-6 && B > 1e-6 ? clamp(B / A, 0.25, 4) : 1; }

// ---------- events for playback/export: band + MIDI comp ----------
function midiCompEvents(listen){ const ch = choiceFor("midi", listen), N = ch.length, L = loopSteps() / N, out = [], byId = Object.fromEntries(midiTakes().map(t => [t.id, t]));
  for (let k = 0; k < N; k++) { const t = byId[ch[k]]; if (!t) continue; for (const n of t.notes) { const q = n.s + 0.5; if (q >= k * L && q < (k + 1) * L && n.s < loopSteps()) out.push({ ch: "play", i: state.liveInst, n: n.n, s: Math.max(0, n.s), d: Math.min(n.d, loopSteps() - n.s), v: n.v }); } }
  return out; }
let songCache = null;
function song(){ const key = ver + "|" + midiTakes().length; if (songCache && songCache.key === key) return songCache.v;
  const events = (state.src === "backing" ? [] : bandEvents(state)).concat(midiCompEvents()).map(e => Object.assign({ abs: e.s }, e)); const byStep = new Map();
  for (const e of events) { const k = Math.floor(e.abs); if (!byStep.has(k)) byStep.set(k, []); byStep.get(k).push(e); }
  songCache = { key, v: { events, byStep } }; return songCache.v; }
const instsOf = evs => [...new Set(evs.filter(e => e.i !== "kit").map(e => e.i))];

// ---------- sample loading (pinned CDN + bundled kit), progress + names of anything missing ----------
const bufs = {}, loading = new Map(), missing = new Map(); let decoder = null; window.__loadLog = [];
const decodeCtx = () => decoder || (decoder = new OfflineAudioContext(1, 1, SR));
function toMono(b){ if (b.numberOfChannels === 1) return b; const m = new AudioBuffer({ length: b.length, numberOfChannels: 1, sampleRate: b.sampleRate }), d = m.getChannelData(0), l = b.getChannelData(0), r = b.getChannelData(1); for (let i = 0; i < d.length; i++) d[i] = 0.5 * (l[i] + r[i]); return m; }
function loadSample(s){ if (bufs[s.id]) return Promise.resolve(true); if (loading.has(s.id)) return loading.get(s.id);
  const p = (async () => { try { let r = null, err = null;
      for (const [u, wait] of [[s.url, 0], [s.url, 400], [s.alt, 0], [s.alt, 800]]) { if (!u) continue; if (wait) await new Promise(z => setTimeout(z, wait));
        try { r = await fetch(u); if (r.ok) break; err = new Error("HTTP " + r.status); r = null; } catch (e) { err = e; r = null; } }
      if (!r) throw err || new Error("unavailable"); const ab = await r.arrayBuffer(); const b = await decodeCtx().decodeAudioData(ab);
      bufs[s.id] = s.inst === "kit" ? b : toMono(b); missing.delete(s.id); return true; } catch (e) { missing.set(s.id, s); window.__loadLog.push({ id: s.id, err: String(e) }); return false; } finally { loading.delete(s.id); } })();
  loading.set(s.id, p); return p; }
const filesFor = insts => SAMPLES.filter(s => s.inst === "kit" ? insts.includes("kit") : insts.includes(s.inst));
const neededInsts = () => [...new Set(instsOf(song().events).concat(["kit", state.liveInst]))];
async function ensureInstruments(insts){ const list = filesFor([...new Set(insts.concat(["kit"]))]), todo = list.filter(s => !bufs[s.id]);
  if (!todo.length) { paintLoad(); return missingLabels(list).length === 0; }
  let done = 0; paintLoad(`Loading samples 0/${todo.length}…`);
  const q = todo.slice(); await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const s = q.shift(); await loadSample(s); done++; paintLoad(`Loading samples ${done}/${todo.length}…`); } }));
  paintLoad(); return missingLabels(list).length === 0; }
function missingLabels(list){ return [...new Set((list || [...missing.values()]).filter(s => !bufs[s.id] && missing.has(s.id)).map(s => s.inst === "kit" ? s.label : INST[s.inst].label))]; }
const onsetCache = new WeakMap();
function onsetOf(buf){ if (onsetCache.has(buf)) return onsetCache.get(buf); const d = buf.getChannelData(0); let pk = 0;
  for (let i = 0; i < Math.min(d.length, buf.sampleRate); i++) pk = Math.max(pk, Math.abs(d[i]));
  let i = 0; while (i < d.length && Math.abs(d[i]) < pk * 0.02) i++; const t = Math.max(0, i - 8) / buf.sampleRate; onsetCache.set(buf, t); return t; }
const loopCache = new WeakMap();
function loopPoints(buf){ if (loopCache.has(buf)) return loopCache.get(buf); const d = buf.getChannelData(0), sr = buf.sampleRate, on = onsetOf(buf);
  const zc = t => { let i = Math.floor(t * sr); while (i < d.length - 1 && !(d[i] <= 0 && d[i + 1] > 0)) i++; return i / sr; };
  const r = [zc(on + Math.min(1.0, buf.duration * 0.35)), zc(Math.min(2.4, buf.duration * 0.8))]; loopCache.set(buf, r); return r; }

// ---------- voices (looped sustain for held instruments, release >= 10 ms) ----------
let active = new Set();
function playEvent(c, dest, e, when, sd, live){ let buf, rate = 1, sus = false, gain = e.v, src;
  if (e.i === "kit") { const piece = KIT_BY_GM[e.n]; buf = bufs["kit:" + piece]; if (!buf) return null; gain *= KIT[piece].gain; }
  else { const d = INST[e.i], ns = nearestSample(e.i, e.n); if (!ns || Math.abs(ns.shift) > MAX_SHIFT) return null; buf = bufs[ns.id]; if (!buf) return null; rate = Math.pow(2, ns.shift / 12); sus = !!d.sus; gain *= d.gain; }
  const t = live ? when : Math.round(when * c.sampleRate) / c.sampleRate, dur = Math.max(0.03, e.d * sd);
  src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; src.playbackRate.setValueAtTime(rate, t);
  const on = onsetOf(buf), g = c.createGain();
  if (e.i === "kit") { g.gain.setValueAtTime(gain, t); src.connect(g); g.connect(dest); src.start(t, on); src.stop(t + (buf.duration - on) + 0.01); }
  else { if (sus) { const [a, b] = loopPoints(buf); if (b - a > 0.2) { src.loop = true; src.loopStart = a; src.loopEnd = b; } }
    const atk = sus ? 0.015 : 0.003, rel = sus ? Math.min(0.18, Math.max(0.03, dur * 0.2)) : Math.min(0.12, Math.max(0.02, dur * 0.15));
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + atk); g.gain.setValueAtTime(gain, t + Math.max(atk, dur));
    g.gain.linearRampToValueAtTime(0, t + Math.max(atk, dur) + rel); src.connect(g); g.connect(dest); src.start(t, on); src.stop(t + Math.max(atk, dur) + rel + 0.01); }
  if (live) { const r = { src, g }; active.add(r); src.onended = () => active.delete(r); }
  return src; }
function fastRelease(r, now){ try { r.g.gain.cancelScheduledValues(now); r.g.gain.setValueAtTime(r.g.gain.value, now); r.g.gain.linearRampToValueAtTime(0, now + FAST_RELEASE); r.src.stop(now + FAST_RELEASE + 0.004); } catch (e) {} }

// ---------- live bus: chairs + voice (A/B makeup) + live MIDI + mic monitor -> master -> safety limiter -> output ----------
let ctx = null, bus = null;
function buildBus(c){ const comp = c.createDynamicsCompressor(); comp.threshold.value = -6; comp.knee.value = 3; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.1;
  const master = c.createGain(), voice = c.createGain(), ab = c.createGain(), live = c.createGain(), mon = c.createGain(), an = c.createAnalyser(), anT = c.createAnalyser(), chairs = {}; an.fftSize = 256; anT.fftSize = 256; // anT: transport only (band + vocal comp), not the mic monitor or live keys
  master.gain.value = state.master; live.gain.value = state.liveGain; voice.gain.value = state.voiceMute ? 0 : state.voiceGain;
  for (const ch of CHAIRS) { const g = c.createGain(); g.gain.value = state.mutes[ch.id] ? 0 : state.gains[ch.id]; g.connect(master); g.connect(anT); chairs[ch.id] = g; }
  ab.connect(voice); voice.connect(master); voice.connect(anT); live.connect(master); mon.connect(master); master.connect(comp); comp.connect(c.destination); comp.connect(an);
  const b = { comp, master, voice, ab, live, mon, chairs, an, anT }; if (window.__pro) window.__pro.bus(c, b); return b; }
async function ensureCtx(){ if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); bus = buildBus(ctx); applySink();
    for (const t of takes) if (t.sr !== ctx.sampleRate) { t.data = resample(t.data, t.sr, ctx.sampleRate); t.sr = ctx.sampleRate; t.an = analyzeAudio(t); } }
  if (ctx.state !== "running") await ctx.resume(); }
function applyMix(){ if (!bus) return; const now = ctx.currentTime; for (const ch of CHAIRS) bus.chairs[ch.id].gain.setTargetAtTime(state.mutes[ch.id] ? 0 : state.gains[ch.id], now, 0.01);
  bus.master.gain.setTargetAtTime(state.master, now, 0.01); bus.live.gain.setTargetAtTime(state.liveGain, now, 0.01); bus.voice.gain.setTargetAtTime(state.voiceMute ? 0 : state.voiceGain, now, 0.01); if (window.__pro) window.__pro.apply(); }

// ---------- transport: audio-clock lookahead scheduler; the loop repeats; every pass can be a take ----------
let play = null, timerId = null; const stepLog = []; window.__schedLog = []; window.__barLog = [];
let voiceLive = { key: "", buf: null, makeup: 1 };
function voiceBuffer(){ const key = ver + "|" + takes.length + "|" + state.listen + "|" + (ctx ? ctx.sampleRate : 0); if (voiceLive.key === key) return voiceLive;
  if (!takes.length || !ctx) { voiceLive = { key, buf: null, makeup: 1 }; return voiceLive; }
  const r = renderVoice(choiceFor("voice"), ctx.sampleRate), b = ctx.createBuffer(1, r.N, ctx.sampleRate); b.copyToChannel(r.data, 0);
  voiceLive = { key, buf: b, makeup: makeupFor(state.listen), seams: r.seams }; return voiceLive; }
// the comp is played bar by bar from a freshly rendered buffer, so picking a take or a lock is heard on the next bar line
function scheduleVoiceBar(bar, t, first){ if (rec && !state.hearCompWhileRec) return; const v = voiceBuffer(); if (!v.buf) return;
  const bd = 4 * 60 / state.bpm, off = bar * bd, pre = 0.0025, src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = v.buf;
  const head = !(first || bar === 0), st = head ? t - pre : t, so = head ? off - pre : off, len = bd + (head ? pre : 0) + pre;
  // linear crossfades at bar lines: identical audio on both sides sums to exactly 1; a changed comp switches at this bar line
  g.gain.setValueAtTime(head ? 0 : 1, st); if (head) g.gain.linearRampToValueAtTime(1, st + 2 * pre); g.gain.setValueAtTime(1, st + len - 2 * pre); g.gain.linearRampToValueAtTime(0, st + len);
  src.connect(g); g.connect(bus.ab); bus.ab.gain.setValueAtTime(v.makeup, st); src.start(st, Math.max(0, so), len); src.stop(st + len + 0.005); const r = { src, g }; active.add(r); src.onended = () => active.delete(r); }
function start(){ if (!ctx || ctx.state !== "running") return false; const miss = missingLabels(filesFor(neededInsts())); if (miss.length) { setStatus("Can't play: " + miss.join(", ") + " didn't load."); return false; }
  stop(true); const [lo, hi] = playRange(); let from = armNext || cue == null ? lo : cue * STEPS; if (from < lo || from >= hi) from = lo;
  if (armNext) { rec = { passes: [], made: 0 }; armNext = false; } play = { step: from, nextT: ctx.currentTime + 0.1, first: true, endT: null }; stepLog.length = 0; timerId = setInterval(scheduler, LOOKAHEAD_MS); scheduler(); requestAnimationFrame(draw); paintTransport(); return true; }
function scheduler(){ if (!play) return; const sd = stepDur();
  while (play.endT == null && play.nextT < ctx.currentTime + SCHEDULE_AHEAD) { const [lo, hi] = playRange();
    if (play.step >= hi || play.step < lo) { if (state.loop) { play.step = lo; play.first = true; } else { play.endT = play.nextT; break; } } // whole song: stop at the end; loop: wrap to the section start
    scheduleStep(play.step, play.nextT, sd); play.nextT += sd; play.step++; }
  if (rec) recTick();
  if (play && play.endT != null && ctx.currentTime > play.endT + latencyS() + 0.15) { if (rec) recTick(); const made = rec ? rec.made : 0; stop(true); cue = 0; paintPlayhead(0); setStatus(`Reached the end of the song (${state.bars} bars).` + (made ? ` Kept ${made} take${made > 1 ? "s" : ""}.` : "") + " Press Play to hear it from the top."); } }
let cue = 0;
// click a bar or section: jump there on the audio clock (looping follows the section you jump into)
function seekBar(bar){ bar = clamp(Math.floor(+bar || 0), 0, state.bars - 1); cue = bar; const ri = regions().indexOf(regionAt(bar));
  if (state.loop && ri !== state.loopSec) { state.loopSec = ri; saveMix(); }
  if (play) { const now = ctx.currentTime; for (const r of active) fastRelease(r, now); active.clear(); play.step = bar * STEPS; play.nextT = now + 0.06; play.first = true; play.endT = null; stepLog.length = 0;
    if (rec && rec.passes.length) { rec.passes.length = 0; setStatus("Jumped: the unfinished pass was dropped. A take starts when a full pass begins."); } scheduler(); }
  paintPlayhead(bar * STEPS); paintTimeline(); return true; }
function scheduleStep(k, time, sd){ const sg = song(), evs = sg.byStep.get(k) || [], heard = [];
  if (rec && k === playRange()[0]) { const [lo, hi] = playRange(); rec.passes.push({ t0: time, bpm: state.bpm, bars: state.bars, b0: lo / STEPS, b1: hi / STEPS }); }
  for (const e of evs) { if (state.mutes[e.ch]) continue; const t = time + (e.abs - k) * sd; playEvent(ctx, bus.chairs[e.ch], e, t, sd, true); midiSend(e, t, sd); heard.push(e.ch + ":" + e.n); }
  if (k % STEPS === 0) { const rg = regionAt(k / STEPS); window.__barLog.push({ bar: k / STEPS, time, sec: rg ? rg.name : "", b0: rg ? rg.b0 : 0 }); if (window.__barLog.length > 4000) window.__barLog.shift(); if (window.__pro) window.__pro.bar(k / STEPS, time, play.first); scheduleVoiceBar(k / STEPS, time, play.first); play.first = false; }
  stepLog.push({ s: k, time }); if (stepLog.length > 512) stepLog.shift();
  window.__schedLog.push({ step: k, time, ver, bpm: state.bpm, recipe: state.recipe, keyRoot: state.keyRoot, listen: state.listen, notes: heard, voice: k % STEPS === 0 && voiceLive.buf ? voiceLive.key : null }); if (window.__schedLog.length > 4000) window.__schedLog.shift(); }
function stop(quiet){ clearInterval(timerId); timerId = null; const was = !!play; play = null;
  if (rec) endRec(true);
  if (ctx) { const now = ctx.currentTime; for (const r of active) fastRelease(r, now); active.clear(); liveAllOff(true); }
  if (midiOut) for (let c = 0; c < 16; c++) { midiOut.send([0xB0 | c, 123, 0]); midiOut.send([0xB0 | c, 120, 0]); }
  paintTransport(); if (was && !quiet) setStatus("Stopped."); }
function draw(){ if (!play) return; const now = ctx.currentTime; let cur = null; for (const e of stepLog) { if (e.time <= now) cur = e; else break; }
  if (cur) { paintPlayhead(cur.s); if (window.__pro) window.__pro.draw(cur, now); } requestAnimationFrame(draw); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { if (play) { stop(true); setStatus("Stopped because the tab was hidden. Any unfinished pass was dropped. Press Play to start again."); } liveAllOff(); } });
async function measureStopSilence(){ const a = new Float32Array(bus.anT.fftSize), t0 = performance.now(); stop(); for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 2)); bus.anT.getFloatTimeDomainData(a); let p = 0; for (const x of a) p = Math.max(p, Math.abs(x)); if (p < 0.001) return { ms: performance.now() - t0, peak: p }; } return { ms: null }; }

// ---------- recording: every full loop pass becomes a take (mic = dry audio, MIDI = notes) ----------
let rec = null, armNext = false; const recNotes = [];
const FREE_BARS = 8, FREE_TAKES = 6;
async function startRec(){ await ensureCtx(); if (!mic && !midiInPort && !state.recordKeys) { setStatus("Turn the mic on or pick a MIDI input first (or tick ‘Record on-screen keys too’)."); return false; }
  if (gated() && takes.length >= FREE_TAKES && midiTakes().length >= FREE_TAKES) { setStatus(`The free version keeps ${FREE_TAKES} takes per lane. Delete one or unlock TakeKit.`); return false; }
  const wasPlaying = !!play; capChunks.length = 0; recNotes.length = 0;
  if (wasPlaying && state.loop) rec = { passes: [], made: 0 }; else { cue = null; armNext = true; if (!start()) { armNext = false; return false; } }
  if (mic) mic.node.port.postMessage({ rec: true });
  paintTransport(); setStatus(wasPlaying ? "Armed: takes start at the top of the next pass." : (state.loop ? "Recording the looped section: every full pass becomes a take. Press Stop when you're done." : `Recording the whole song (${state.bars} bars, start to finish) as one take. It stops at the end.`)); return true; }
function latencyS(){ return (ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0) + (mic ? mic.inLat : 0) + state.latFixMs / 1000; }
function recTick(){ while (rec && rec.passes.length) { const p = rec.passes[0], ld = (p.b1 - p.b0) * 4 * 60 / p.bpm; if (ctx.currentTime > p.t0 + ld + latencyS() + 0.06) finishPass(rec.passes.shift()); else break; } }
function finishPass(p){ const ld = (p.b1 - p.b0) * 4 * 60 / p.bpm, off = p.b0 * 4 * 60 / p.bpm, made = []; let num = 0; const passNo = () => num || (num = state.nextTake++);
  if (p.bpm !== state.bpm || p.bars !== state.bars) { setStatus("Tempo or length changed during the pass, so it wasn't kept as a take."); return; }
  if (gated() && takes.length >= FREE_TAKES && midiTakes().length >= FREE_TAKES) { setStatus(`Free version: ${FREE_TAKES} takes per lane reached. Unlock for unlimited takes.`); return; }
  if (mic && (!gated() || takes.length < FREE_TAKES)) { const part = sliceCapture(p.t0, ld), data = new Float32Array(Math.round(p.bars * 4 * 60 / p.bpm * ctx.sampleRate)), o0 = Math.round(off * ctx.sampleRate); data.set(part.subarray(0, Math.max(0, data.length - o0)), o0); let pk = 0; for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
    if (pk > 0.003) { const t = { id: "v" + Date.now().toString(36) + state.nextTake, name: "Take " + passNo(), lane: "voice", sr: ctx.sampleRate, data, bpm: p.bpm, bars: p.bars, region: [p.b0, p.b1], created: Date.now() }; t.an = analyzeAudio(t); takes.push(t); idb.put(t); made.push(t.name); } }
  const sd = 60 / p.bpm / 4, ns = recNotes.filter(n => n.on >= p.t0 - 0.03 && n.on < p.t0 + ld - 0.03).map(n => ({ n: n.note, v: Math.round(n.vel * 1000) / 1000, s: Math.max(0, Math.round((n.on - p.t0) / sd * 1000) / 1000) + p.b0 * STEPS, d: Math.max(0.25, Math.round((Math.min(n.off != null ? n.off : p.t0 + ld, p.t0 + ld) - n.on) / sd * 1000) / 1000) }));
  if (ns.length && (!gated() || midiTakes().length < FREE_TAKES)) { const t = { id: "m" + Date.now().toString(36) + state.nextTake, name: "MIDI " + passNo(), lane: "midi", notes: ns, bars: p.bars }; state.midiTakes.push(t); made.push(t.name); }
  const keep = p.t0 + ld - 1; for (let i = capChunks.length - 1; i >= 0; i--) if ((capChunks[i].f + capChunks[i].d.length) / ctx.sampleRate < keep + latencyS()) capChunks.splice(i, 1);
  save(); if (rec) rec.made += made.length; paintTakes(); setStatus(made.length ? `Kept ${made.join(" + ")}. Keep going: the next pass is the next take.` : "That pass was silent, so no take was kept."); }
function endRec(discard){ if (!rec) return; const p = rec.passes.length; rec = null; if (mic) mic.node.port.postMessage({ rec: false }); paintTransport(); if (p && discard) setStatus("Stopped. The unfinished pass was dropped; full passes are kept as takes."); }

// ---------- audio input: device choice, trim, noise gate (threshold/attack/hold/release), live monitoring ----------
const CAPTURE_SRC = `class TKCap extends AudioWorkletProcessor{ constructor(){ super(); this.on=true; this.th=0.003; this.atk=0.002; this.hold=0.06; this.rel=0.12; this.env=0; this.g=0; this.h=0; this.rec=false; this.pk=0; this.n=0; this.port.onmessage=e=>Object.assign(this,e.data); }
  process(ins,outs){ const i=ins[0]&&ins[0][0], o=outs[0]; if(!i) return true; const y=o[0], sr=sampleRate, aC=1/Math.max(1,this.atk*sr), rC=1/Math.max(1,this.rel*sr), hs=this.hold*sr, dec=Math.exp(-1/(0.01*sr));
    for(let k=0;k<i.length;k++){ const a=Math.abs(i[k]); this.env=a>this.env?a:this.env*dec;
      if(!this.on) this.g=1; else if(this.env>this.th){ this.h=hs; this.g=Math.min(1,this.g+aC); } else if(this.h>0){ this.h--; } else this.g=Math.max(0,this.g-rC);
      y[k]=i[k]*this.g; if(a>this.pk) this.pk=a; }
    for(let c=1;c<o.length;c++) o[c].set(y);
    if(this.rec){ const c=i.slice(0); this.port.postMessage({f:currentFrame, d:c}, [c.buffer]); }
    if(++this.n>=16){ this.port.postMessage({pk:this.pk, g:this.g}); this.pk=0; this.n=0; } return true; } }
registerProcessor("tkcap", TKCap);`;
let mic = null; const capChunks = []; let peakHold = 0, gateG = 0, clipUntil = 0;
const dbToGain = d => Math.pow(10, d / 20);
const gateMsg = () => ({ on: state.gate.on, th: dbToGain(state.gate.th), atk: state.gate.atk / 1000, hold: state.gate.hold / 1000, rel: state.gate.rel / 1000 });
async function enableMic(){ await ensureCtx(); if (mic) return true;
  try { const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }; if (state.audioIn) c.deviceId = { exact: state.audioIn };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: c });
    if (!ctx.__tkcap) { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_SRC], { type: "application/javascript" }))); ctx.__tkcap = true; }
    const src = ctx.createMediaStreamSource(stream), trim = ctx.createGain(), node = new AudioWorkletNode(ctx, "tkcap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }), mon = ctx.createGain();
    trim.gain.value = dbToGain(state.trimDb); mon.gain.value = state.monitor ? 1 : 0; src.connect(trim); trim.connect(node); node.connect(mon); mon.connect(window.__pro ? window.__pro.monitorDest() : bus.mon); // gate (worklet) first, then the vocal chain
    node.port.onmessage = e => { const m = e.data; if (m.pk !== undefined) { peakHold = Math.max(m.pk, peakHold * 0.85); gateG = m.g; if (m.pk >= 0.98) clipUntil = performance.now() + 1200; paintMeter(); return; } capChunks.push(m); };
    const tr = stream.getAudioTracks()[0], s = tr.getSettings ? tr.getSettings() : {};
    mic = { stream, src, trim, node, mon, inLat: typeof s.latency === "number" ? s.latency : 0.01, label: tr.label }; node.port.postMessage(gateMsg()); if (rec) node.port.postMessage({ rec: true });
    paintMicState(); ui.micBtn.textContent = "Turn mic off"; listDevices(); return true; }
  catch (e) { ui.micState.textContent = `Mic not available (${e.name}). You can still record MIDI takes or import takes from your DAW.`; return false; } }
function paintMicState(){ if (!mic) { ui.micState.textContent = "Mic off."; return; } ui.micState.textContent = `Mic on: ${mic.label || "default input"} · ${ctx.sampleRate} Hz · ${state.monitor ? "you hear yourself live through your output (use headphones to avoid feedback)" : "monitor off"} · takes are recorded dry, before the gate`; }
function disableMic(){ if (!mic) return; mic.stream.getTracks().forEach(t => t.stop()); try { mic.src.disconnect(); mic.node.disconnect(); mic.mon.disconnect(); } catch (e) {} mic = null; paintMicState(); ui.micBtn.textContent = "Turn mic on"; peakHold = 0; paintMeter(); }
function paintMeter(){ const m = $("meterBar"), cl = $("clip"), gl = $("gateLed"); if (!m) return; const db = peakHold > 1e-5 ? 20 * Math.log10(peakHold) : -90;
  m.style.width = clamp((db + 60) / 60 * 100, 0, 100) + "%"; cl.classList.toggle("on", performance.now() < clipUntil); gl.classList.toggle("on", state.gate.on && gateG > 0.5); gl.textContent = state.gate.on ? (gateG > 0.5 ? "gate open" : "gate closed") : "gate off"; }
function sliceCapture(t0, dur){ const sr = ctx.sampleRate, n = Math.round(dur * sr), out = new Float32Array(n), f0 = Math.round((t0 + latencyS()) * sr);
  for (const c of capChunks) { const a = c.f - f0; if (a + c.d.length <= 0 || a >= n) continue; for (let i = Math.max(0, -a); i < c.d.length && a + i < n; i++) out[a + i] = c.d[i]; }
  return out; }

// ---------- import takes from a DAW: one file per pass, or one long file split into loop-length passes ----------
async function importFiles(files){ await ensureCtx(); let made = 0; const L = Math.round(loopDur() * ctx.sampleRate);
  for (const f of files) { let b; try { b = await ctx.decodeAudioData(await f.arrayBuffer()); } catch (e) { setStatus(`Couldn't read ${f.name} (${e.name}).`); continue; }
    const m = new Float32Array(b.length); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) m[i] += d[i] / b.numberOfChannels; }
    const passes = Math.max(1, Math.round(m.length / L));
    for (let p = 0; p < passes; p++) { if (gated() && takes.length >= FREE_TAKES) { setStatus(`The free version keeps ${FREE_TAKES} takes. Unlock to import more.`); break; }
      const data = new Float32Array(L); data.set(m.subarray(p * L, Math.min(m.length, (p + 1) * L)));
      const t = { id: "v" + Date.now().toString(36) + state.nextTake, name: (passes > 1 ? f.name.replace(/\.[^.]+$/, "").slice(0, 18) + " p" + (p + 1) : f.name.replace(/\.[^.]+$/, "").slice(0, 22)), lane: "voice", sr: ctx.sampleRate, data, bpm: state.bpm, bars: state.bars, created: Date.now() };
      state.nextTake++; t.an = analyzeAudio(t); takes.push(t); idb.put(t); made++; } }
  save(); paintTakes(); if (made) setStatus(`Imported ${made} take${made > 1 ? "s" : ""} at ${state.bpm} BPM, ${state.bars} bars. TakeKit comped them; press Play.`); return made; }

// ---------- export: OfflineAudioContext, 48 kHz, exact bar length, downbeat at sample 0, tail folded, peak -1 dBFS ----------
// Exports are always the comp (B) unless a raw take is asked for; what you are auditioning never changes the file.
function exportEvents(){ return (state.src === "backing" ? [] : bandEvents(state)).concat(midiCompEvents("comp")).map(e => Object.assign({ abs: e.s }, e)); }
// o.range = [firstBar, endBar) renders just those bars (section / bar-range export, no loop fold); long renders run in
// bar-aligned chunks (each chunk's ring-out is added into the next), so a phone never holds one giant OfflineAudioContext.
const CHUNK_S = () => window.__tkChunkS || (isIOS() ? 45 : 120), barSmpOf = () => 4 * 60 / state.bpm * SR, smpAt = b => Math.round(b * 4 * 60 / state.bpm * SR);
async function renderMix(o){ o = o || {}; const sd = stepDur(), r0 = o.range ? o.range[0] : 0, r1 = o.range ? o.range[1] : state.bars, S0 = smpAt(r0), N = smpAt(r1) - S0, T = Math.round(TAIL_S * SR), evs = exportEvents();
  const only = o.only || CHAIRS.map(c => c.id).concat(["voice"], window.__pro && window.__pro.bkInMix() ? ["backing"] : []);
  const need = instsOf(evs.filter(e => only.includes(e.ch))); if (!(await ensureInstruments(need))) throw new Error("Missing instruments: " + missingLabels(filesFor(need.concat(["kit"]))).join(", ") + ". Tap Retry next to the sample list, then export again.");
  const barSmp = barSmpOf(), cb = Math.max(1, Math.floor(CHUNK_S() * SR / barSmp)), forceChunk = o.chunked === true, nCh = (forceChunk || (r1 - r0) * barSmp > CHUNK_S() * SR) ? Math.ceil((r1 - r0) / cb) : 1;
  let ch; try { ch = [new Float32Array(N), new Float32Array(N)]; } catch (e) { throw memErr(r1 - r0); }
  const v = only.includes("voice") && !state.voiceMute && takes.length ? renderVoice(choiceFor("voice", o.listen || "comp"), takes[0].sr) : null, cache = {};
  let carry = null;
  for (let k = 0; k < nCh; k++) { const a = nCh === 1 ? r0 : r0 + k * cb, b = nCh === 1 ? r1 : Math.min(r1, a + cb), A = smpAt(a), L = smpAt(b) - A, last = b >= r1;
    if (o.onProgress) o.onProgress(k / nCh, k + 1, nCh);
    let buf; try {
      const oc = new OfflineAudioContext(2, L + T, SR), sum = oc.createGain(); sum.connect(oc.destination); const chairs = {};
      for (const c of CHAIRS) { const g = oc.createGain(); g.gain.value = state.gains[c.id]; g.connect(sum); chairs[c.id] = g; }
      for (const e of evs) { if (state.mutes[e.ch] || !only.includes(e.ch)) continue; const bi = Math.floor(e.abs / STEPS); if (bi < a || bi >= b) continue; playEvent(oc, chairs[e.ch], e, (Math.round(bi * barSmp) + Math.round((e.abs - bi * STEPS) * sd * SR) - A) / SR, sd, false); }
      if (v) { const vs = Math.round(A * v.sr / SR), vl = Math.min(v.N - vs, Math.round(L * v.sr / SR)); if (vl > 0) { const ab = oc.createBuffer(1, vl, v.sr); ab.copyToChannel(v.data.subarray(vs, vs + vl), 0);
        const s = oc.createBufferSource(), g = oc.createGain(); s.buffer = ab; g.gain.value = state.voiceGain; s.connect(g); g.connect(window.__pro ? await window.__pro.voiceDest(oc, sum, o) : sum); s.start(0); } }
      if (window.__pro) await window.__pro.offlineExtras(oc, sum, only, L, A / SR, cache, last);
      buf = await oc.startRendering();
    } catch (e) { if (nCh === 1 && !forceChunk && (r1 - r0) > 1 && isMemErr(e)) return renderMix(Object.assign({}, o, { chunked: true })); throw isMemErr(e) ? memErr(r1 - r0) : e; }
    const off = A - S0; for (let c = 0; c < 2; c++) { const src = buf.getChannelData(c), x = ch[c]; x.set(src.subarray(0, L), off);
      if (carry) for (let j = 0; j < T && off + j < N; j++) x[off + j] += carry[c][j]; }
    carry = [0, 1].map(c => buf.getChannelData(c).slice(L, L + T)); await new Promise(r => setTimeout(r, 0)); }
  // full-song exports fold the ring-out into the top (seamless loop, as before); section/range exports keep a hard, exact end
  if (!o.range && carry) for (let c = 0; c < 2; c++) for (let j = 0; j < T && j < N; j++) ch[c][j] += carry[c][j];
  let pk = 0; for (const x of ch) for (let i = 0; i < N; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
  const target = Math.pow(10, -1.1 / 20), g = o.gain != null ? o.gain : (pk > 0 ? target / pk : 1); if (!o.noNorm) for (const x of ch) for (let i = 0; i < N; i++) x[i] *= g;
  if (o.onProgress) o.onProgress(1, nCh, nCh); return { ch, N, gain: g, peak: pk, chunks: nCh }; }
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isMemErr = e => !!e && (e instanceof RangeError || /memory|allocat|NotSupported|too large|out of/i.test((e.name || "") + " " + (e.message || "")));
const memErr = bars => new Error(`This device ran out of memory rendering ${bars} bars. Export a section or a shorter bar range (pick it under "What to export"), or close other tabs and try again.`);
function wav24(ch, N){ const nc = 2, len = N * nc * 3, b = new ArrayBuffer(44 + len), v = new DataView(b); let p = 0;
  const str = s => { for (const c of s) v.setUint8(p++, c.charCodeAt(0)); }, u32 = x => { v.setUint32(p, x, true); p += 4; }, u16 = x => { v.setUint16(p, x, true); p += 2; };
  str("RIFF"); u32(36 + len); str("WAVE"); str("fmt "); u32(16); u16(1); u16(nc); u32(SR); u32(SR * nc * 3); u16(nc * 3); u16(24); str("data"); u32(len);
  for (let i = 0; i < N; i++) for (let c = 0; c < nc; c++) { let x = Math.round(Math.max(-1, Math.min(1, ch[c][i])) * 8388607); if (x < 0) x += 16777216; v.setUint8(p++, x & 255); v.setUint8(p++, (x >> 8) & 255); v.setUint8(p++, (x >> 16) & 255); }
  return new Uint8Array(b); }
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "take";
const fileBase = o => `${APP}-${state.recipe}${o && o.part ? "-" + slug(o.part) : ""}-${state.bpm}bpm-${keyLabel(state)}${o && o.range ? `-bars${o.range[0] + 1}-${o.range[1]}` : ""}`;
function midiFile(o){ o = o || {}; const R0 = o.range ? o.range[0] * STEPS : 0, R1 = o.range ? o.range[1] * STEPS : loopSteps(), PPQ = 480, T = PPQ / 4, total = (R1 - R0) * T, vlq = n => { const a = [n & 127]; while (n >>= 7) a.unshift((n & 127) | 128); return a; };
  const trk = evs => { evs.sort((a, b) => a.t - b.t || a.o - b.o); let last = 0; const d = []; for (const e of evs) { d.push(...vlq(e.t - last), ...e.b); last = e.t; }
    d.push(...vlq(Math.max(0, total - last)), 0xFF, 0x2F, 0); return [0x4D, 0x54, 0x72, 0x6B, (d.length >>> 24) & 255, (d.length >> 16) & 255, (d.length >> 8) & 255, d.length & 255, ...d]; };
  const meta = (type, s) => { const c = [...new TextEncoder().encode(s)]; return [0xFF, type, ...vlq(c.length), ...c]; }, us = Math.round(60000000 / state.bpm);
  const cond = [{ t: 0, o: 0, b: meta(0x03, `${BRAND} ${state.bpm} BPM ${keyLabel(state)}`) }, { t: 0, o: 1, b: [0xFF, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] }, { t: 0, o: 2, b: [0xFF, 0x58, 4, 4, 2, 24, 8] }];
  const c = comps(), N = nSeg(), L = loopSteps() / N;
  for (let k = 0; k < N; k++) { const parts = []; if (takes.length) parts.push("vox " + (c.voice.choice[k] ? takeLabel(c.voice.choice[k]) : "-")); if (midiTakes().length) parts.push("midi " + (c.midi.choice[k] ? takeLabel(c.midi.choice[k]) : "-"));
    if (k * L < R0 || k * L >= R1) continue; cond.push({ t: Math.round((k * L - R0) * T), o: 3, b: meta(0x06, `Seg ${k + 1}: ${chName(chordAt(Math.floor(k * L / STEPS)))}${parts.length ? " | " + parts.join(" | ") : ""}`) }); }
  for (const r of regions()) if (r.b0 * STEPS >= R0 && r.b0 * STEPS < R1) cond.push({ t: (r.b0 * STEPS - R0) * T, o: 4, b: meta(0x06, "Section: " + r.name) });
  const tracks = [trk(cond)], evs = exportEvents().filter(e => e.abs >= R0 && e.abs < R1).map(e => Object.assign({}, e, { abs: e.abs - R0, d: Math.min(e.d, R1 - e.abs) })); if (window.__pro && !o.range) { const ly = window.__pro.midiLyrics(T, meta); if (ly.length > 1) tracks.push(trk(ly)); }
  const noteTrack = (name, ch, list, gm) => { const out = [{ t: 0, o: 0, b: meta(0x03, name) }]; if (gm != null) out.push({ t: 0, o: 1, b: [0xC0 | ch, gm] });
    for (const e of list) { const t0 = Math.round(e.abs * T), t1 = Math.min(total, Math.round((e.abs + e.d) * T)), v = clamp(Math.round(e.v * 127), 1, 127); out.push({ t: t0, o: 3, b: [0x90 | ch, e.n, v] }); out.push({ t: Math.max(t0 + 1, e.i === "kit" ? t0 + T / 2 : t1), o: 2, b: [0x80 | ch, e.n, 0] }); }
    return trk(out); };
  for (const ch of CHAIRS) { if (state.mutes[ch.id]) continue; const list = evs.filter(e => e.ch === ch.id); if (!list.length) continue; tracks.push(noteTrack(ch.name, ch.ch, list, list[0].i === "kit" ? null : INST[list[0].i].gm)); }
  midiTakes().forEach((t, i) => { tracks.push(noteTrack(takeName(t) + " (raw take)", 4 + (i % 5), t.notes.filter(n => n.s >= R0 && n.s < R1).map(n => ({ abs: n.s - R0, d: Math.min(n.d, R1 - n.s), n: n.n, v: n.v, i: state.liveInst })), INST[state.liveInst].gm)); });
  return new Uint8Array([].concat([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255], ...tracks)); }
async function exportWavBytes(o){ o = o || {}; const r = await renderMix(o); let bytes; try { bytes = wav24(r.ch, r.N); } catch (e) { throw isMemErr(e) ? memErr((o.range ? o.range[1] - o.range[0] : state.bars)) : e; } return { bytes, name: fileBase(o) + ".wav", frames: r.N, gain: r.gain, peak: r.peak, chunks: r.chunks }; }
function exportMidBytes(o){ o = o || {}; return { bytes: midiFile(o), name: fileBase(o) + ".mid" }; }
function crc32(b){ let c, crc = -1; for (let i = 0; i < b.length; i++) { c = (crc ^ b[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function zipStore(fl, asParts){ const parts = [], cen = []; let off = 0; const enc = new TextEncoder(); const le = (n, w) => { const a = []; for (let i = 0; i < w; i++) a.push((n >>> (8 * i)) & 255); return a; };
  for (const f of fl) { const nm = enc.encode(f.name), c = crc32(f.bytes), sz = f.bytes.length;
    const h = new Uint8Array([0x50, 0x4B, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le(c, 4), ...le(sz, 4), ...le(sz, 4), ...le(nm.length, 2), 0, 0, ...nm]);
    parts.push(h, f.bytes); cen.push(new Uint8Array([0x50, 0x4B, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le(c, 4), ...le(sz, 4), ...le(sz, 4), ...le(nm.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(off, 4), ...nm])); off += h.length + sz; }
  const cl = cen.reduce((a, x) => a + x.length, 0), end = new Uint8Array([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...le(fl.length, 2), ...le(fl.length, 2), ...le(cl, 4), ...le(off, 4), 0, 0]);
  const all = [...parts, ...cen, end]; if (asParts) return all; const out = new Uint8Array(off + cl + end.length); let p = 0; for (const x of all) { out.set(x, p); p += x.length; } return out; }
// stems: full mix, MIDI, every band chair, the comp vocal and every raw take; same exact length and one shared gain, so they line up and sum in any DAW
async function exportStemsBytes(o){ o = o || {}; const R = o.range ? { range: o.range } : {}, jobs = [], evs = exportEvents(), fl = [];
  jobs.push(["mix", {}]); for (const c of CHAIRS) if (!state.mutes[c.id] && evs.some(e => e.ch === c.id)) jobs.push([c.name, { only: [c.id], part: c.id }]);
  if (window.__pro && window.__pro.isBk()) jobs.push(["backing", { only: ["backing"], part: "backing" }]);
  if (takes.length && !state.voiceMute) { jobs.push(["vocal comp (chain)", { only: ["voice"], part: "vocal-comp-chain", dry: false }], ["vocal comp (dry)", { only: ["voice"], part: "vocal-comp-dry", dry: true }]);
    for (const t of takes.filter(compatible)) jobs.push(["raw " + takeName(t), { only: ["voice"], part: "raw-" + takeName(t), listen: t.id, dry: true }]); }
  if (window.__pro && window.__pro.guideStem()) jobs.push(["guide", { only: ["guide"], part: "guide" }]);
  let gain = null;
  for (let i = 0; i < jobs.length; i++) { const [lab, jo] = jobs[i]; if (o.onProgress) o.onProgress(i / jobs.length, `stem ${i + 1}/${jobs.length}: ${lab}`);
    const w = await exportWavBytes(Object.assign({}, jo, R, gain != null ? { gain } : {})); if (gain == null) { gain = w.gain; fl.push({ name: w.name, bytes: w.bytes }); fl.push(exportMidBytes(R)); } else fl.push({ name: w.name, bytes: w.bytes }); }
  const name = fileBase(R) + "-stems.zip"; if (o.blob) { const parts = zipStore(fl, true); return { blob: new Blob(parts, { type: "application/zip" }), name, files: fl.map(f => ({ name: f.name, size: f.bytes.length })) }; }
  return { zip: zipStore(fl), name, files: fl }; }
// Save a file. iPhone/iPad: the share sheet (Save to Files, AirDrop, Voice Memos…) via navigator.share({files}); elsewhere a
// blob link with a[download]; last resort opens the file in a new tab. A tap-to-save button stays up as a backup, because iOS
// drops the "user gesture" during a long render and may refuse the share sheet until you tap again.
let lastSave = null;
async function saveFile(data, name, type, auto){ const blob = data instanceof Blob ? data : new Blob([data], { type }); let file = null;
  try { file = new File([blob], name, { type }); } catch (e) {}
  if (lastSave && lastSave.url) URL.revokeObjectURL(lastSave.url); lastSave = { blob, file, name, type, url: URL.createObjectURL(blob) }; paintSave();
  if (auto === false) return "ready";
  return trySave(); }
async function trySave(){ const f = lastSave; if (!f) return "none"; const mb = (f.blob.size / 1048576).toFixed(1) + " MB";
  if (isIOS() && f.file && navigator.canShare && navigator.share) { let ok = false; try { ok = navigator.canShare({ files: [f.file] }); } catch (e) {}
    if (ok) { try { await navigator.share({ files: [f.file], title: f.name }); expMsg(`Shared ${f.name} (${mb}). In the share sheet pick "Save to Files" to keep it.`, "ok"); return "shared"; }
      catch (e) { if (e.name === "AbortError") { expMsg(`Share cancelled. ${f.name} is ready: tap "Save ${f.name}" below to try again.`, "warn"); return "cancelled"; }
        if (e.name !== "NotAllowedError") expMsg(`Share sheet failed (${e.name}: ${e.message}). Use the "Save" link below instead.`, "bad"); else expMsg(`${f.name} is ready (${mb}). Tap "Save ${f.name}" below to open the share sheet.`, "warn"); return "needs-tap"; } } }
  try { if ("download" in HTMLAnchorElement.prototype) { const a = document.createElement("a"); a.href = f.url; a.download = f.name; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); return "downloaded"; } } catch (e) {}
  const w = window.open(f.url, "_blank"); if (!w) { expMsg(`Your browser blocked the download. Tap "Save ${f.name}" below.`, "warn"); return "blocked"; } return "opened"; }
function download(bytes, name, type){ return saveFile(bytes, name, type); }
function paintSave(){ const el = document.getElementById("saveRow"); if (!el) return; const f = lastSave; el.hidden = !f; if (!f) return;
  el.innerHTML = `<button id="saveBtn" class="mini">Save ${esc(f.name)}</button> <a id="saveLink" href="${f.url}" download="${esc(f.name)}" target="_blank" rel="noopener">or open it</a> <span class="hint">${(f.blob.size / 1048576).toFixed(1)} MB</span>`;
  document.getElementById("saveBtn").onclick = () => trySave(); }
function expMsg(m, cls){ setStatus(m); const el = document.getElementById("expMsg"); if (el) { el.textContent = m; el.className = "expmsg " + (cls || ""); } }
function expProgress(p){ const el = document.getElementById("expProg"); if (!el) return; el.hidden = p == null; if (p != null) el.value = p; }

// ---------- Lemon Squeezy license gate (restricted to our store + product; empty config = checkout not live yet) ----------
const LEMON = { checkoutUrl: "", storeId: null, productId: null, price: "$24 once" };
const LS_API = "https://api.lemonsqueezy.com/v1/licenses/";
const lic = loadJSON(APP + "-license") || { valid: false };
const configured = () => !!(LEMON.storeId && LEMON.productId);
// No Lemon Squeezy product configured = nobody can buy, so nothing is gated. Gating resumes on its own once a product is set.
const gated = () => configured() && !lic.valid;
const LAUNCH_NOTE = "Launch: full exports free until checkout opens.";
if (!configured()) lic.valid = false;
async function lsCall(action, params){ const r = await fetch(LS_API + action, { method: "POST", headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }); return r.json(); }
const ours = j => !!j && j.meta && +j.meta.store_id === +LEMON.storeId && +j.meta.product_id === +LEMON.productId;
async function activateKey(key){ if (!configured()) return { ok: false, reason: "Checkout opening soon. License keys can't be checked until the store is live." };
  const j = await lsCall("activate", { license_key: key, instance_name: BRAND + " web" }); if (!j.activated) return { ok: false, reason: j.error || "That key could not be activated." };
  if (!ours(j)) { if (j.instance) lsCall("deactivate", { license_key: key, instance_id: j.instance.id }).catch(() => {}); return { ok: false, reason: "That key is for a different product." }; }
  return { ok: true, instance: j.instance.id }; }
async function validateKey(key, instance){ if (!configured()) return false; const j = await lsCall("validate", { license_key: key, instance_id: instance }); return !!j.valid && ours(j); }
const saveLic = () => localStorage.setItem(APP + "-license", JSON.stringify(lic));

// ---------- Web MIDI in/out ----------
let midiAccess = null, midiOut = null, midiInPort = null;
function midiSend(e, time, sd){ if (!midiOut || !ctx) return; const ch = CHAIR[e.ch].ch, at = performance.now() + (time - ctx.currentTime) * 1000, v = clamp(Math.round(e.v * 127), 1, 127);
  midiOut.send([0x90 | ch, e.n, v], at); midiOut.send([0x80 | ch, e.n, 0], at + Math.max(15, (e.i === "kit" ? 0.5 : e.d) * sd * 1000 - 3)); }
function onMidi(ev){ const d = ev.data, s = d[0], cmd = s & 0xF0, n = d[1], v = d[2]; if (s >= 0xF0) return; // clock/start/stop ignored: MIDI never starts the transport
  if (cmd === 0xB0 && n === 64) { setSustain(v >= 64); return; } if (cmd === 0xB0 && (n === 123 || n === 120)) { liveAllOff(); return; }
  if (cmd === 0x90 && v > 0) liveOn(n, v / 127, "midi"); else if (cmd === 0x80 || (cmd === 0x90 && v === 0)) liveOff(n, "midi"); }
function refreshMidi(){ if (!midiAccess) return;
  const fill = (sel, ports, cur) => { sel.innerHTML = '<option value="">(none)</option>' + [...ports.values()].map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(""); sel.value = [...ports.keys()].includes(cur) ? cur : ""; };
  if (!state.midiIn && midiAccess.inputs.size) state.midiIn = [...midiAccess.inputs.keys()][0];
  fill(ui.midiIn, midiAccess.inputs, state.midiIn); fill(ui.midiOut, midiAccess.outputs, state.midiOut);
  if (midiInPort) midiInPort.onmidimessage = null; midiInPort = midiAccess.inputs.get(ui.midiIn.value) || null; if (midiInPort) midiInPort.onmidimessage = onMidi;
  midiOut = midiAccess.outputs.get(ui.midiOut.value) || null;
  ui.midiNote.textContent = (midiAccess.inputs.size ? (midiInPort ? `Playing ${INST[state.liveInst].label} from ${midiInPort.name}. Velocity and sustain pedal (CC64) work; notes never start the transport. While recording, every pass is also a MIDI take.` : "Pick your MIDI keyboard above.") : "No MIDI keyboard found. Plug one in and it shows up here; the on-screen keys below are a fallback.")
    + (midiOut ? ` Sending the band (drums on ch 10) to ${midiOut.name} while playing.` : ""); }

// ---------- live play (MIDI keyboard first; on-screen and computer keys as fallback) ----------
const liveVoices = new Map(); let sustain = false; window.__liveLog = [];
function liveVoice(note, vel, t){ const i = state.liveInst, ns = nearestSample(i, note); if (!ns || Math.abs(ns.shift) > MAX_SHIFT) return null; const buf = bufs[ns.id]; if (!buf) return null;
  const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.playbackRate.value = Math.pow(2, ns.shift / 12);
  if (INST[i].sus) { const [a, b] = loopPoints(buf); if (b - a > 0.2) { src.loop = true; src.loopStart = a; src.loopEnd = b; } }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * INST[i].gain, t + 0.005); src.connect(g); g.connect(bus.live); src.start(t, onsetOf(buf)); src.stop(t + 30); return { src, g }; }
function liveOn(note, vel, src){ if (!ctx || ctx.state !== "running") { setStatus("Tap to start audio first."); return; } const t = ctx.currentTime + 0.005, key = src + ":" + note;
  window.__liveLog.push({ note, vel, src, t, playing: !!play }); keyVis(note, true); const old = liveVoices.get(key); if (old) releaseVoice(old, t);
  if (!bufs[nearestSample(state.liveInst, note).id]) ensureInstruments([state.liveInst]);
  const v = liveVoice(note, vel, t), r = { vs: v ? [v] : [], note };
  if (rec && (src === "midi" || state.recordKeys)) { r.recN = { note, vel, on: ctx.currentTime, off: null }; recNotes.push(r.recN); }
  liveVoices.set(key, r); }
function releaseVoice(r, t, fast){ if (r.done) return; r.done = true; if (r.recN && r.recN.off == null) r.recN.off = ctx.currentTime; const rel = fast ? FAST_RELEASE : 0.15;
  for (const v of r.vs) { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + rel); v.src.stop(t + rel + 0.01); } catch (e) {} } }
function liveOff(note, src){ const key = src + ":" + note, vo = liveVoices.get(key); keyVis(note, false); if (!vo) return; if (sustain) { vo.sustained = true; return; } liveVoices.delete(key); releaseVoice(vo, ctx.currentTime); }
function setSustain(down){ sustain = down; if (!down && ctx) for (const [k, vo] of [...liveVoices]) if (vo.sustained) { liveVoices.delete(k); releaseVoice(vo, ctx.currentTime); } }
function liveAllOff(fast){ if (!ctx) return; for (const [, vo] of liveVoices) releaseVoice(vo, ctx.currentTime, fast); liveVoices.clear(); sustain = false; document.querySelectorAll(".down").forEach(k => k.classList.remove("down")); }
const KEYMAP = "AWSEDFTGYHUJK";
function keyVis(n, on){ document.querySelectorAll(`[data-n="${n}"]`).forEach(k => k.classList.toggle("down", on)); }

// ---------- audio devices: output (setSinkId) + input ----------
const sinkOK = () => typeof (window.AudioContext || function(){}).prototype.setSinkId === "function";
async function listDevices(){ let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const ins = devs.filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"), outs = devs.filter(d => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default");
  ui.audioIn.innerHTML = '<option value="">System default input</option>' + ins.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Audio input " + (i + 1))}</option>`).join(""); ui.audioIn.value = ins.some(d => d.deviceId === state.audioIn) ? state.audioIn : "";
  if (!sinkOK()) { ui.audioOut.innerHTML = '<option value="">System default</option>'; ui.audioOut.disabled = true; ui.audioOutNote.textContent = "This browser can't send Web Audio to a chosen device (no setSinkId), so sound uses your system output."; return; }
  ui.audioOut.innerHTML = '<option value="">System default</option>' + outs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Audio output " + (i + 1))}</option>`).join(""); ui.audioOut.value = outs.some(d => d.deviceId === state.audioOut) ? state.audioOut : "";
  if (outs.length && !outs[0].label) ui.audioOutNote.textContent = "Device names appear after you allow the mic once."; }
async function applySink(){ if (!ctx || !sinkOK()) return; try { const want = state.audioOut || ""; if ((typeof ctx.sinkId === "string" ? ctx.sinkId : "") !== want) await ctx.setSinkId(want); ui.audioOutNote.textContent = state.audioOut ? "Playing through the selected output." : "Playing through the system default output."; }
  catch (e) { ui.audioOutNote.textContent = "Couldn't switch output (" + e.name + "), so the system default is in use."; state.audioOut = ""; save(); ui.audioOut.value = ""; } }
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);

// ---------- UI ----------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ui = {}; let lane = "voice";
function setStatus(m){ if (ui.status) ui.status.textContent = m; }
function paintLoad(msg){ if (!ui.load) return; const miss = missingLabels(); if (msg) { ui.load.textContent = msg; ui.load.className = "load busy"; return; }
  if (miss.length) { ui.load.innerHTML = "<b>Missing instruments:</b> " + miss.map(esc).join(", ") + ". These samples didn't load (sample host blocked or offline). Playback and export stay off until they load. <button id='retry'>Retry</button>"; ui.load.className = "load bad"; $("retry").onclick = async () => { for (const s of [...missing.values()]) missing.delete(s.id); await ensureInstruments(neededInsts()); };
  } else { const n = Object.keys(bufs).length; ui.load.textContent = n ? `Real samples ready: ${n} files (FluidR3 GM pinned @${SF_SHA.slice(0, 7)} + CC0 Virtuosity kit).` : "Samples load when the page opens."; ui.load.className = "load ok"; } }
function paintTransport(){ if (!ui.play) return; ui.play.textContent = play ? "■ Stop" : state.loop ? "▶ Play loop (" + ((regions()[state.loopSec] || {}).name || "section") + ")" : "▶ Play song"; if (ui.loopOn) ui.loopOn.checked = state.loop; ui.play.classList.toggle("on", !!play);
  ui.rec.textContent = rec ? "● Recording takes… (Stop to finish)" : "● Record takes"; ui.rec.classList.toggle("rec", !!rec); document.body.classList.toggle("recording", !!rec); }
function segLabel(k){ const s = state.seg; if (s === 1) return "Bar " + (k + 1); if (s === 2) return "Bars " + (2 * k + 1) + "–" + (2 * k + 2); return "Bar " + (Math.floor(k / 2) + 1) + (k % 2 ? "b" : "a"); }
function segChord(k){ return chName(chordAt(Math.floor(k * state.seg))); }
let lastSeg = -1;
const fmtMS = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
let lastBar = -1;
function paintPlayhead(step){ const bar = Math.floor(step / STEPS);
  if (bar !== lastBar) { lastBar = bar; const r = regionAt(bar); ui.pos.textContent = `Bar ${bar + 1} / ${state.bars} · ${r ? r.name : ""} · ${chName(chordAt(bar))} · ${fmtMS(bar * 4 * 60 / state.bpm)} / ${fmtMS(loopDur())}`;
    if (ui.tl) { ui.tl.querySelectorAll(".now").forEach(e => e.classList.remove("now")); const c = ui.tl.querySelector(`[data-bar="${bar}"]`); if (c) c.classList.add("now"); } }
  const k = Math.floor(step / (loopSteps() / nSeg())); if (k === lastSeg) return; lastSeg = k; document.querySelectorAll(".grid .now").forEach(e => e.classList.remove("now")); document.querySelectorAll(`.grid [data-col="${k}"]`).forEach(e => e.classList.add("now")); }
function paintTimeline(){ if (!ui.tl) return; const rs = regions(), lr = state.loop ? rs[state.loopSec] : null;
  ui.tl.innerHTML = rs.map((r, i) => `<div class="tsec ${r === lr ? "looped" : ""}" style="flex:${r.b1 - r.b0}"><button class="tname" data-seek="${r.b0}" data-ri="${i}" title="Jump to ${esc(r.name)}">${esc(r.name)}${r.sec && r.sec.lock ? " 🔒" : ""}</button><div class="tbars">`
    + Array.from({ length: r.b1 - r.b0 }, (_, j) => `<i data-bar="${r.b0 + j}" title="Bar ${r.b0 + j + 1} · ${esc(chName(chordAt(r.b0 + j)))}"></i>`).join("") + "</div></div>").join("");
  ui.tl.querySelectorAll("[data-seek]").forEach(b => b.onclick = () => seekBar(+b.dataset.seek)); ui.tl.querySelectorAll("[data-bar]").forEach(b => b.onclick = () => seekBar(+b.dataset.bar));
  lastBar = -1; paintPlayhead((cue || 0) * STEPS); }
const cls = s => s >= 80 ? "good" : s >= 60 ? "ok" : "bad";
function paintTakes(){ if (!ui.grid) return; const all = laneTakes(lane), okT = all.filter(compatible), bad = all.filter(t => !compatible(t)), N = nSeg(), c = comps(), sc = scoresFor(lane), cmp = c[lane], locks = state.locks[lane] || {};
  ui.laneV.classList.toggle("on", lane === "voice"); ui.laneM.classList.toggle("on", lane === "midi"); ui.laneV.textContent = `Vocal / audio takes (${takes.length})`; ui.laneM.textContent = `MIDI takes (${midiTakes().length})`;
  if (!okT.length) { ui.grid.innerHTML = `<p class="empty">${lane === "voice" ? "No audio takes yet. Turn the mic on and press <b>● Record takes</b>: every pass of the loop becomes a take. Or import passes you sang in your DAW." : "No MIDI takes yet. Pick your MIDI keyboard and press <b>● Record takes</b>: every pass you play becomes a take."}</p>` + incompatHtml(bad); ui.why.innerHTML = ""; bindGrid(); paintListen(); return; }
  let h = `<table class="grid"><thead><tr><th class="nm">Take</th><th>avg</th>`; for (let k = 0; k < N; k++) h += `<th data-col="${k}">${esc(segLabel(k))}<small>${esc(segChord(k))}</small></th>`; h += `<th></th></tr></thead><tbody>`;
  h += `<tr class="comprow"><td class="nm">Comp (B)</td><td>${Math.round(cmp.choice.reduce((a, id, k) => a + (id && !sc.segs[k].empty ? sc.segs[k].cells[id].score : 0), 0) / Math.max(1, sc.segs.filter(s => !s.empty).length))}</td>`;
  for (let k = 0; k < N; k++) { const id = cmp.choice[k]; h += `<td data-col="${k}" class="${locks[k] !== undefined ? "lockd" : ""}">${id ? esc(takeLabel(id)) : "—"}${locks[k] !== undefined ? " 🔒" : ""}</td>`; }
  h += `<td><button class="mini" data-act="unlock">Unlock all</button></td></tr>`;
  for (const t of okT) { const ex = !!state.excluded[t.id], avg = Math.round(sc.segs.reduce((a, s) => a + (s.empty ? 0 : s.cells[t.id].score), 0) / Math.max(1, sc.segs.filter(s => !s.empty).length));
    h += `<tr class="${ex ? "ex" : ""}"><td class="nm"><span class="tn">${esc(takeName(t))}</span>${c.bestVoice === t.id || c.bestMidi === t.id ? ' <em class="tag">A</em>' : ""}</td><td>${avg}</td>`;
    for (let k = 0; k < N; k++) { const cell = sc.segs[k].cells[t.id], chosen = cmp.choice[k] === t.id, lk = locks[k] === t.id;
      h += `<td data-col="${k}" data-seg="${k}" data-take="${esc(t.id)}" class="cell ${sc.segs[k].empty ? "na" : cls(cell.score)} ${chosen ? "pick" : ""} ${lk ? "lk" : ""}" title="${esc(cell.reason)}">${sc.segs[k].empty ? "·" : cell.score}${lk ? "🔒" : ""}<i>${esc(sc.segs[k].empty ? "" : cell.reason)}</i></td>`; }
    h += `<td class="acts"><button class="mini" data-act="solo" data-id="${esc(t.id)}" title="Hear only this take (loudness matched)">${state.listen === t.id ? "◉" : "○"} solo</button><button class="mini" data-act="ex" data-id="${esc(t.id)}">${ex ? "use" : "skip"}</button><button class="mini" data-act="ren" data-id="${esc(t.id)}">rename</button><button class="mini del" data-act="del" data-id="${esc(t.id)}">delete</button></td></tr>`; }
  h += `<tr class="silrow"><td class="nm">Silence</td><td></td>`; for (let k = 0; k < N; k++) h += `<td data-col="${k}" data-seg="${k}" data-take="none" class="cell sil ${locks[k] === "none" ? "lk pick" : ""}">${locks[k] === "none" ? "🔒" : "—"}</td>`; h += `<td></td></tr></tbody></table>`;
  ui.grid.innerHTML = h + incompatHtml(bad);
  ui.why.innerHTML = "<b>Why each pick</b><ol>" + cmp.choice.map((id, k) => `<li><b>${esc(segLabel(k))} (${esc(segChord(k))})</b>: ${id ? esc(takeLabel(id)) + " · " + sc.segs[k].cells[id].score + " · " : ""}${esc(cmp.why[k])}</li>`).join("") + "</ol>"
    + (lane === "voice" && voiceLive.seams && voiceLive.seams.length ? `<p class="hint">${voiceLive.seams.length} seam${voiceLive.seams.length > 1 ? "s" : ""}, each moved to the quietest point within ±${state.seamMs} ms of the bar line, with a ${state.xfadeMs} ms equal-power crossfade.</p>` : "");
  bindGrid(); paintListen(); if (lastSeg >= 0) { const k = lastSeg; lastSeg = -1; paintPlayhead(k * loopSteps() / nSeg()); } }
function incompatHtml(bad){ return bad.length ? `<p class="hint warn">${bad.length} take${bad.length > 1 ? "s were" : " was"} recorded at another tempo or length (${bad.map(t => esc(takeName(t)) + ": " + t.bpm + " BPM / " + t.bars + " bars").join("; ")}). Set the song back to use ${bad.length > 1 ? "them" : "it"}; audio is never time-stretched.</p>` : ""; }
function bindGrid(){ ui.grid.querySelectorAll(".cell").forEach(td => td.onclick = () => { const k = +td.dataset.seg, id = td.dataset.take, L = state.locks[lane]; if (L[k] === id) delete L[k]; else L[k] = id; save(); paintTakes(); });
  ui.grid.querySelectorAll("[data-act]").forEach(b => b.onclick = async () => { const id = b.dataset.id, a = b.dataset.act;
    if (a === "unlock") { state.locks[lane] = {}; }
    if (a === "ex") { if (state.excluded[id]) delete state.excluded[id]; else state.excluded[id] = true; }
    if (a === "solo") state.listen = state.listen === id ? "comp" : id;
    if (a === "ren") { const n = prompt("Name this take", takeLabel(id)); if (n) state.takeNames[id] = n.slice(0, 24); }
    if (a === "del") { if (!confirm("Delete " + takeLabel(id) + "? This can't be undone.")) return; takes = takes.filter(t => t.id !== id); state.midiTakes = state.midiTakes.filter(t => t.id !== id); idb.del(id); for (const L of Object.values(state.locks)) for (const k in L) if (L[k] === id) delete L[k]; if (state.listen === id) state.listen = "comp"; }
    save(); paintTakes(); }); }
function paintListen(){ const opts = [["comp", "B · the comp"], ["best", "A · best whole take"]].concat(takes.concat(midiTakes()).filter(compatible).map(t => [t.id, "Solo · " + takeName(t)]));
  ui.listen.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(""); ui.listen.value = opts.some(o => o[0] === state.listen) ? state.listen : "comp";
  ui.abA.classList.toggle("on", state.listen === "best"); ui.abB.classList.toggle("on", state.listen === "comp");
  const m = state.listen !== "comp" && takes.length && ctx ? makeupFor(state.listen) : 1; ui.match.textContent = state.listen === "comp" ? "Hearing the comp." : `Loudness matched to the comp (${m >= 1 ? "+" : ""}${(20 * Math.log10(m)).toFixed(1)} dB on this take), so louder never wins by accident.`; }
function setOpts(sel, list, v){ sel.innerHTML = list.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join(""); sel.value = String(v); }
function paintSong(){ ui.bpm.value = state.bpm; ui.key.value = state.keyRoot; ui.mode.value = state.mode; ui.chords.value = state.chords; paintBarsSel(); ui.recipe.value = state.recipe; ui.seg.value = state.seg;
  ui.recipeNote.textContent = RECIPES[state.recipe].note + ` · preset tempo ${RECIPES[state.recipe].bpm} BPM`; ui.chordErr.textContent = parseProg(state.chords) ? `One chord per bar. These drive every section that has no chords of its own (Chorus/Bridge start on a different chord of the same progression).` : "Couldn't read those chords (1–8 chords like Am F C G7 Dm/F). Using Am F C G until fixed.";
  ui.barsNote.textContent = ""; paintSections(); paintTimeline(); paintTransport(); paintExportBtns(); }
function paintBarsSel(){ const sel = ui.bars, opts = [[state.bars, `${state.bars} bars · ${fmtMS(loopDur())} (whole ${state.src === "band" ? "song" : "track"})`]]; for (const n of [4, 8, 16]) if (n !== state.bars) opts.push([n, n + " bars (one section)"]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(""); sel.value = String(state.bars); }
function paintSections(){ const el = $("secList"); if (!el) return; const band = state.src === "band" || state.secSrc === "upload";
  $("songLen").textContent = `${state.sections.length} sections · ${state.bars} bars · ${fmtMS(loopDur())} at ${state.bpm} BPM · plays start to finish` + (state.secSrc === "upload" ? " · built from your upload (review, edit or lock any section)" : "");
  el.innerHTML = state.sections.map((x, i) => `<div class="sec ${x.lock ? "locked" : ""}" data-i="${i}"><input class="sn" data-k="name" value="${esc(x.name)}" ${x.lock ? "disabled" : ""}><label>bars <input type="number" min="1" max="128" data-k="bars" value="${x.bars}" ${x.lock ? "disabled" : ""}></label>`
    + `<input class="sc" data-k="chords" value="${esc(x.chords)}" placeholder="${esc(secProg(x).map(chName).join(" "))}" spellcheck="false" ${x.lock ? "disabled" : ""}><label>energy <input type="range" min="0" max="1" step="0.05" data-k="energy" value="${x.energy}" ${x.lock ? "disabled" : ""}></label>`
    + (x.conf != null ? `<span class="conf" title="detection confidence">${Math.round(x.conf * 100)}%</span>` : "") + `<label class="lk" title="Locked sections keep their name, length, chords and energy when you re-analyze"><input type="checkbox" data-lock="${i}" ${x.lock ? "checked" : ""}>🔒</label>`
    + `<button class="mini" data-mv="-1">↑</button><button class="mini" data-mv="1">↓</button><button class="mini" data-dup>dup</button><button class="mini del" data-rm ${state.sections.length < 2 ? "disabled" : ""}>✕</button></div>`).join("");
  const upd = (i, fn) => { const a = JSON.parse(JSON.stringify(state.sections)); fn(a, i); setSetting("sections", a); };
  el.querySelectorAll("[data-k]").forEach(inp => inp.onchange = () => upd(+inp.closest(".sec").dataset.i, (a, i) => { const k = inp.dataset.k; a[i][k] = k === "bars" || k === "energy" ? +inp.value : inp.value; a[i].conf = null; }));
  el.querySelectorAll("[data-lock]").forEach(c => c.onchange = () => upd(+c.dataset.lock, (a, i) => { a[i].lock = c.checked; }));
  el.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => upd(+b.closest(".sec").dataset.i, (a, i) => { const j = i + +b.dataset.mv; if (j >= 0 && j < a.length) [a[i], a[j]] = [a[j], a[i]]; }));
  el.querySelectorAll("[data-dup]").forEach(b => b.onclick = () => upd(+b.closest(".sec").dataset.i, (a, i) => { a.splice(i + 1, 0, Object.assign({}, a[i], { lock: false })); }));
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => upd(+b.closest(".sec").dataset.i, (a, i) => { a.splice(i, 1); }));
  $("secBox").classList.toggle("dim", !band); }
// What to export: the whole song, one section, or a bar range. Sections and ranges up to FREE_BARS are always free.
function expScope(){ const sel = $("expScope"), v = sel ? sel.value : "song", R = regions();
  if (v && v.startsWith("sec:")) { const r = R[+v.slice(4)] || R[0]; return { range: [r.b0, r.b1], label: `${r.name} (bars ${r.b0 + 1}–${r.b1})`, bars: r.b1 - r.b0, section: true }; }
  if (v === "range") { const a = clamp(Math.round(+$("expFrom").value || 1), 1, state.bars), b = clamp(Math.round(+$("expTo").value || a), a, state.bars); return { range: [a - 1, b], label: `bars ${a}–${b}`, bars: b - a + 1, section: false }; }
  return { range: null, label: `the whole ${state.bars}-bar song`, bars: state.bars, section: false }; }
const scopeFree = sc => !gated() || sc.section || sc.bars <= FREE_BARS;
function paintExportBtns(){ if (!ui.wav) return; const sel = $("expScope"); if (sel) { const cur = sel.value || "song", R = regions();
    sel.innerHTML = `<option value="song">Whole song · ${state.bars} bars</option>` + R.map((r, i) => `<option value="sec:${i}">Section: ${esc(r.name)} · bars ${r.b0 + 1}–${r.b1}</option>`).join("") + `<option value="range">Bar range…</option>`;
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : "song"; $("expRange").hidden = sel.value !== "range"; $("expFrom").max = $("expTo").max = state.bars; }
  const sc = expScope(), lock = !scopeFree(sc), lab = lock ? ` 🔒 ${sc.bars} bars needs unlock` : ` · ${sc.range ? sc.label : sc.bars + " bars"}`;
  ui.wav.textContent = "Export WAV" + lab; ui.mid.textContent = "Export MIDI" + lab;
  $("expNote").textContent = !configured() ? `${LAUNCH_NOTE} Exports are exact length with the downbeat at sample 0.` : lock ? `Exports of a section or up to ${FREE_BARS} bars are free; ${sc.label} exports after the unlock.` : `Exporting ${sc.label}: exact length, downbeat at sample 0.`; }
function paintMix(){ ui.mix.innerHTML = CHAIRS.map(c => `<div class="ch"><label>${esc(c.name)}</label><input type="range" min="0" max="1.2" step="0.01" value="${state.gains[c.id]}" data-g="${c.id}"><button class="mini ${state.mutes[c.id] ? "on" : ""}" data-m="${c.id}">${state.mutes[c.id] ? "muted" : "mute"}</button></div>`).join("")
    + `<div class="ch"><label>Vocal comp</label><input type="range" min="0" max="1.5" step="0.01" value="${state.voiceGain}" id="vg"><button class="mini ${state.voiceMute ? "on" : ""}" id="vm">${state.voiceMute ? "muted" : "mute"}</button></div>`
    + `<div class="ch"><label>Live keyboard</label><input type="range" min="0" max="1.2" step="0.01" value="${state.liveGain}" id="lg"></div><div class="ch"><label>Master</label><input type="range" min="0" max="1.2" step="0.01" value="${state.master}" id="mg"></div>`;
  ui.mix.querySelectorAll("[data-g]").forEach(r => r.oninput = () => { state.gains[r.dataset.g] = +r.value; saveMix(); });
  ui.mix.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { state.mutes[b.dataset.m] = !state.mutes[b.dataset.m]; save(); applyMix(); paintMix(); });
  $("vg").oninput = e => { state.voiceGain = +e.target.value; saveMix(); }; $("vm").onclick = () => { state.voiceMute = !state.voiceMute; save(); applyMix(); paintMix(); };
  $("lg").oninput = e => { state.liveGain = +e.target.value; saveMix(); }; $("mg").oninput = e => { state.master = +e.target.value; saveMix(); }; }
// mixer moves don't change the comp, so they save without invalidating the comp caches
function saveMix(){ localStorage.setItem(APP + "-settings", JSON.stringify(state)); applyMix(); }
function paintBrain(){ const w = state.weights; for (const k of ["pitch", "timing", "level", "presence"]) { $("w_" + k).value = w[k]; $("w_" + k + "_v").textContent = w[k]; }
  ui.sw.value = state.switchPen; $("sw_v").textContent = state.switchPen; ui.xf.value = state.xfadeMs; $("xf_v").textContent = state.xfadeMs + " ms"; ui.seam.value = state.seamMs; $("seam_v").textContent = "±" + state.seamMs + " ms"; }
function paintInput(){ const g = state.gate; ui.gateOn.checked = g.on; ui.monitor.checked = state.monitor;
  for (const [k, u] of [["th", " dB"], ["atk", " ms"], ["hold", " ms"], ["rel", " ms"]]) { $("g_" + k).value = g[k]; $("g_" + k + "_v").textContent = g[k] + u; }
  ui.trim.value = state.trimDb; $("trim_v").textContent = (state.trimDb > 0 ? "+" : "") + state.trimDb + " dB"; ui.lat.value = state.latFixMs; $("lat_v").textContent = (state.latFixMs > 0 ? "+" : "") + state.latFixMs + " ms";
  ui.hearComp.checked = state.hearCompWhileRec; ui.recKeys.checked = state.recordKeys; }
function paintLicense(){ const b = ui.buy; if (configured() && LEMON.checkoutUrl) { b.textContent = "Unlock TakeKit · " + LEMON.price; b.disabled = false; b.onclick = () => window.open(LEMON.checkoutUrl, "_blank", "noopener"); }
  else { b.textContent = "Checkout opening soon · " + LEMON.price; b.disabled = true; }
  ui.licState.textContent = !configured() ? `${LAUNCH_NOTE} WAV, MIDI, stems ZIP and LRC of the whole song, unlimited takes. (${LEMON.price} once when checkout opens.)` : lic.valid ? "Unlocked: full-song exports, stems ZIP with every raw take, unlimited takes." : `Free: play, record, score and comp the whole song; WAV + MIDI exports up to ${FREE_BARS} bars; ${FREE_TAKES} takes per lane. Unlock adds full-song exports, stems (every raw take + the comp) and unlimited takes.`;
  ui.stems.textContent = gated() ? "Export stems ZIP 🔒" : "Export stems ZIP"; paintExportBtns(); }
function paintKeys(){ const lo = state.kbdOct * 12 + 12, wk = [], bk = []; let wi = 0;
  for (let n = lo; n < lo + 25; n++) { const blk = [1, 3, 6, 8, 10].includes(pc(n)), lab = KEYMAP[n - lo] || ""; if (blk) bk.push(`<div class="bk" data-n="${n}" style="left:${wi * 34 - 11}px">${lab}</div>`); else { wk.push(`<div class="wk" data-n="${n}">${lab}<small>${pc(n) === 0 ? noteName(n) : ""}</small></div>`); wi++; } }
  ui.kbd.innerHTML = wk.join("") + bk.join(""); ui.kbd.querySelectorAll("[data-n]").forEach(k => { const n = +k.dataset.n;
    k.onpointerdown = e => { e.preventDefault(); k.setPointerCapture(e.pointerId); liveOn(n, 0.8, "screen"); }; k.onpointerup = k.onpointercancel = () => liveOff(n, "screen"); });
  $("oct_v").textContent = "C" + state.kbdOct; }
function paintAll(){ paintSong(); paintMix(); paintBrain(); paintInput(); paintLicense(); paintKeys(); paintTakes(); paintTransport(); paintLoad(); }

// one path for every setting change (UI and test hook): validate, persist, apply live
function setSetting(k, v){
  if (k === "bpm") { const n = Math.round(+v); if (!(n >= 60 && n <= 180)) { paintSong(); setStatus("BPM must be 60–180."); return false; } state.bpm = n; if (!(arguments[2] && arguments[2].auto)) state.userSet.bpm = true; }
  else if (k === "keyRoot") { const d = ((+v - state.keyRoot) % 12 + 18) % 12 - 6; const p = parseProg(state.chords); if (p && d) state.chords = p.map(c => chName(trC(c, d))).join(" ");
    for (const t of state.midiTakes) for (const n of t.notes) n.n = clamp(n.n + d, 0, 127); state.keyRoot = pc(+v); if (!(arguments[2] && arguments[2].auto)) state.userSet.key = true; if (takes.length && d) setStatus(`Chords and MIDI takes moved ${d > 0 ? "up" : "down"} ${Math.abs(d)} semitone${Math.abs(d) > 1 ? "s" : ""}. Audio takes are never pitch-shifted, so they now score against the new key.`); }
  else if (k === "mode") state.mode = v === "major" ? "major" : "minor";
  else if (k === "chords") { state.chords = String(v).slice(0, 80); }
  else if (k === "bars") { const n = +v; if (n === state.bars) { /* no change */ }
    else if (state.src === "band") { if (!(Number.isInteger(n) && n >= 1 && n <= 128)) return false; state.sections = [{ name: n <= 16 ? "Loop" : "Song", bars: n, chords: "", rot: 0, energy: 1, lock: false }]; state.secSrc = "user"; state.loopSec = 0; normSections(); state.locks = { voice: {}, midi: {} }; }
    else { if ([4, 8, 16].includes(n) && state.bk) state.bk.whole = false; else if (!(state.bk && state.bk.whole && Number.isInteger(n) && n >= 1 && n <= 1024)) return false; state.bars = n; state.locks = { voice: {}, midi: {} }; } }
  else if (k === "sections") { if (!Array.isArray(v) || !v.length || v.length > 48) return false; const old = state.bars; state.sections = v; normSections(); if (state.src !== "band" && state.secSrc !== "upload") state.secSrc = "upload"; if (state.bars !== old) state.locks = { voice: {}, midi: {} }; state.loopSec = clamp(state.loopSec, 0, regions().length - 1); }
  else if (k === "fullSong") { state.sections = defaultSections(); state.secSrc = "user"; normSections(); state.locks = { voice: {}, midi: {} }; }
  else if (k === "loop") { state.loop = !!v; if (state.loop) { const at = play ? Math.floor(play.step / STEPS) : (cue || 0); state.loopSec = Math.max(0, regions().indexOf(regionAt(at))); } }
  else if (k === "loopSec") { const n = Math.round(+v); if (!(n >= 0 && n < regions().length)) return false; state.loopSec = n; }
  else if (k === "recipe") { if (!RECIPES[v]) return false; state.recipe = v; }
  else if (k === "seg") { const n = +v; if (![0.5, 1, 2].includes(n)) return false; state.seg = n; state.locks = { voice: {}, midi: {} }; }
  else if (k === "listen") state.listen = v;
  else if (k === "liveInst") { if (!INST[v]) return false; state.liveInst = v; }
  else if (k === "mutes") { Object.assign(state.mutes, v); applyMix(); }
  else state[k] = v;
  save(); if (["recipe", "liveInst", "bpm", "chords"].includes(k)) ensureInstruments(neededInsts()); paintSong(); paintTakes(); if (k === "liveInst" || k === "mutes") { paintMix(); refreshMidi(); } if (window.__pro) window.__pro.onSetting(k); return true; }

function cantPlay(){ setStatus("Can't play yet: " + missingLabels(filesFor(neededInsts())).join(", ") + " didn't load. Press Retry in the samples line."); }
async function tapStart(){ ui.tap.classList.add("hide"); await ensureCtx(); const ok = await ensureInstruments(neededInsts()); enableMic(); listDevices(); if (!ok) { cantPlay(); return; } setStatus("Audio on. Press ▶ Play loop to hear your band, then ● Record takes and sing a few passes."); }
function bind(){ for (const id of ["status", "load", "play", "rec", "pos", "grid", "why", "listen", "abA", "abB", "match", "bpm", "key", "mode", "chords", "bars", "recipe", "seg", "recipeNote", "chordErr", "barsNote", "mix", "sw", "xf", "seam",
    "gateOn", "monitor", "trim", "lat", "hearComp", "recKeys", "buy", "licState", "licKey", "licBtn", "stems", "wav", "mid", "kbd", "audioIn", "audioOut", "audioOutNote", "midiIn", "midiOut", "midiNote", "liveInst", "micBtn", "micState", "tap", "laneV", "laneM", "imp", "impFile", "clearTakes", "presetBpm", "ios", "tl", "loopOn"]) ui[id] = $(id);
  ui.loopOn.onchange = () => setSetting("loop", ui.loopOn.checked); $("secAdd").onclick = () => setSetting("sections", JSON.parse(JSON.stringify(state.sections)).concat([{ name: "Section " + (state.sections.length + 1), bars: 8, chords: "", rot: 0, energy: 0.8 }]));
  $("secReset").onclick = () => { if (confirm("Replace the song structure with the default full song (Intro, Verse, Chorus, Verse, Chorus, Bridge, Chorus, Outro = 64 bars)?")) setSetting("fullSong", true); };
  setOpts(ui.key, NAMES.map((n, i) => [i, n]), state.keyRoot); setOpts(ui.recipe, Object.entries(RECIPES).map(([k, r]) => [k, r.name]), state.recipe); setOpts(ui.liveInst, LIVE_INSTS.map(k => [k, INST[k].label]), state.liveInst);
  ui.tap.onclick = tapStart;
  ui.play.onclick = async () => { await ensureCtx(); ui.tap.classList.add("hide"); if (play) { stop(); return; } if (await ensureInstruments(neededInsts())) start(); else cantPlay(); };
  ui.rec.onclick = async () => { await ensureCtx(); ui.tap.classList.add("hide"); if (rec) { stop(); return; } if (await ensureInstruments(neededInsts())) startRec(); else cantPlay(); };
  ui.bpm.onchange = () => setSetting("bpm", ui.bpm.value); ui.key.onchange = () => setSetting("keyRoot", +ui.key.value); ui.mode.onchange = () => setSetting("mode", ui.mode.value);
  ui.chords.onchange = () => setSetting("chords", ui.chords.value); ui.bars.onchange = () => setSetting("bars", +ui.bars.value); ui.recipe.onchange = () => setSetting("recipe", ui.recipe.value); ui.seg.onchange = () => setSetting("seg", +ui.seg.value);
  ui.presetBpm.onclick = () => setSetting("bpm", RECIPES[state.recipe].bpm);
  ui.listen.onchange = () => setSetting("listen", ui.listen.value); ui.abA.onclick = () => setSetting("listen", "best"); ui.abB.onclick = () => setSetting("listen", "comp");
  ui.laneV.onclick = () => { lane = "voice"; paintTakes(); }; ui.laneM.onclick = () => { lane = "midi"; paintTakes(); };
  for (const k of ["pitch", "timing", "level", "presence"]) $("w_" + k).oninput = e => { state.weights[k] = +e.target.value; save(); paintBrain(); paintTakes(); };
  ui.sw.oninput = () => { state.switchPen = +ui.sw.value; save(); paintBrain(); paintTakes(); }; ui.xf.oninput = () => { state.xfadeMs = +ui.xf.value; save(); paintBrain(); paintTakes(); }; ui.seam.oninput = () => { state.seamMs = +ui.seam.value; save(); paintBrain(); paintTakes(); };
  ui.gateOn.onchange = () => { state.gate.on = ui.gateOn.checked; saveMix(); paintInput(); if (mic) mic.node.port.postMessage(gateMsg()); paintMeter(); };
  for (const k of ["th", "atk", "hold", "rel"]) $("g_" + k).oninput = e => { state.gate[k] = +e.target.value; saveMix(); paintInput(); if (mic) mic.node.port.postMessage(gateMsg()); };
  ui.monitor.onchange = () => { state.monitor = ui.monitor.checked; saveMix(); if (mic) mic.mon.gain.setTargetAtTime(state.monitor ? 1 : 0, ctx.currentTime, 0.01); paintMicState(); };
  ui.trim.oninput = () => { state.trimDb = +ui.trim.value; saveMix(); paintInput(); if (mic) mic.trim.gain.setTargetAtTime(dbToGain(state.trimDb), ctx.currentTime, 0.01); };
  ui.lat.oninput = () => { state.latFixMs = +ui.lat.value; saveMix(); paintInput(); };
  ui.hearComp.onchange = () => { state.hearCompWhileRec = ui.hearComp.checked; saveMix(); }; ui.recKeys.onchange = () => { state.recordKeys = ui.recKeys.checked; saveMix(); };
  ui.micBtn.onclick = async () => { if (mic) disableMic(); else { await enableMic(); ui.tap.classList.add("hide"); } };
  ui.audioIn.onchange = async () => { state.audioIn = ui.audioIn.value; saveMix(); if (mic) { disableMic(); await enableMic(); } };
  ui.audioOut.onchange = async () => { state.audioOut = ui.audioOut.value; saveMix(); await applySink(); };
  ui.midiIn.onchange = () => { state.midiIn = ui.midiIn.value; saveMix(); refreshMidi(); }; ui.midiOut.onchange = () => { state.midiOut = ui.midiOut.value; saveMix(); refreshMidi(); };
  ui.liveInst.onchange = () => setSetting("liveInst", ui.liveInst.value);
  $("octDn").onclick = () => { state.kbdOct = Math.max(1, state.kbdOct - 1); saveMix(); paintKeys(); }; $("octUp").onclick = () => { state.kbdOct = Math.min(6, state.kbdOct + 1); saveMix(); paintKeys(); };
  const held = new Set(); const kn = e => { const i = KEYMAP.indexOf(e.key.toUpperCase()); return i < 0 ? null : state.kbdOct * 12 + 12 + i; };
  addEventListener("keydown", e => { if (e.target.matches("input,select,textarea") || e.repeat || e.metaKey || e.ctrlKey) return; if (e.code === "Space") { e.preventDefault(); ui.play.click(); return; } const n = kn(e); if (n == null || held.has(n)) return; held.add(n); liveOn(n, 0.8, "screen"); });
  addEventListener("keyup", e => { const n = kn(e); if (n == null) return; held.delete(n); liveOff(n, "screen"); });
  ui.imp.onclick = () => ui.impFile.click(); ui.impFile.onchange = async () => { if (ui.impFile.files.length) await importFiles([...ui.impFile.files]); ui.impFile.value = ""; };
  ui.clearTakes.onclick = async () => { if (!confirm("Delete every take? This can't be undone.")) return; takes = []; state.midiTakes = []; state.locks = { voice: {}, midi: {} }; state.excluded = {}; state.takeNames = {}; state.listen = "comp"; await idb.clear(); save(); paintTakes(); setStatus("All takes cleared."); };
  const lockMsg = sc => `Exporting ${sc.label} needs the unlock. A section, or any range up to ${FREE_BARS} bars, exports free: pick it under "What to export". Playing and recording the whole song stay free.`;
  let busy = false; const run = async (what, fn) => { if (busy) { expMsg("An export is already running…", "warn"); return; } busy = true; [ui.wav, ui.mid, ui.stems].forEach(b => b.disabled = true); expProgress(0);
    try { await fn(); } catch (e) { console.error(e); expMsg(`${what} export failed: ${e && e.message ? e.message : e}`, "bad"); } finally { busy = false; [ui.wav, ui.mid, ui.stems].forEach(b => b.disabled = false); expProgress(null); } };
  const prog = what => (p, k, n) => { expProgress(p); expMsg(`Rendering ${what}… ${Math.round(p * 100)}%${typeof k === "string" ? " · " + k : n > 1 ? ` · chunk ${Math.min(k, n)}/${n}` : ""}`, "busy"); };
  ["expScope", "expFrom", "expTo"].forEach(id => { const el = $(id); if (el) el.onchange = el.oninput = () => paintExportBtns(); });
  ui.wav.onclick = () => { const sc = expScope(); if (!scopeFree(sc)) { expMsg(lockMsg(sc), "warn"); return; } return run("WAV", async () => { const t0 = performance.now(); expMsg(`Rendering WAV of ${sc.label}…`, "busy");
    const w = await exportWavBytes({ range: sc.range, onProgress: prog("WAV") }); const r = await saveFile(w.bytes, w.name, "audio/wav");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${w.name}: ${w.frames.toLocaleString()} samples at 48 kHz / 24-bit, peak −1 dBFS, exactly ${sc.bars} bars (${((performance.now() - t0) / 1000).toFixed(1)} s${w.chunks > 1 ? `, ${w.chunks} chunks` : ""}).${configured() ? "" : " " + LAUNCH_NOTE}`, "ok"); }); };
  ui.mid.onclick = () => { const sc = expScope(); if (!scopeFree(sc)) { expMsg(lockMsg(sc), "warn"); return; } return run("MIDI", async () => { const m = exportMidBytes({ range: sc.range }); const r = await saveFile(m.bytes, m.name, "audio/midi");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${m.name} (${sc.label}): band, your MIDI comp, every MIDI take as its own track, and a marker on each segment naming the take used.`, "ok"); }); };
  ui.stems.onclick = () => { const sc = expScope(); if (gated()) { expMsg("Stems (every raw take + the comp + each band part) are part of the unlock.", "warn"); return; } return run("Stems", async () => { expMsg(`Rendering stems of ${sc.label}…`, "busy");
    const z = await exportStemsBytes({ range: sc.range, blob: true, onProgress: prog("stems") }); const r = await saveFile(z.blob, z.name, "application/zip");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${z.name}: ${z.files.length} files, ${(z.blob.size / 1048576).toFixed(1)} MB.${configured() ? "" : " " + LAUNCH_NOTE}`, "ok"); }); };
  ui.licBtn.onclick = async () => { const key = ui.licKey.value.trim(); if (!key) return; ui.licState.textContent = "Checking…"; try { const r = await activateKey(key); if (r.ok) { Object.assign(lic, { valid: true, key, instance: r.instance }); saveLic(); paintLicense(); paintSong(); } else ui.licState.textContent = r.reason; } catch (e) { ui.licState.textContent = "Couldn't reach Lemon Squeezy. Try again."; } };
  ui.ios.hidden = !isIOS(); }

async function boot(){ bind(); paintAll();
  const rows = await idb.all(); takes = (rows || []).map(r => Object.assign(r, { lane: "voice" })); for (const t of takes) t.an = analyzeAudio(t); ver++; paintTakes();
  if (navigator.requestMIDIAccess) { try { midiAccess = await navigator.requestMIDIAccess({ sysex: false }); midiAccess.onstatechange = refreshMidi; refreshMidi(); } catch (e) { ui.midiNote.textContent = "MIDI access was blocked. The on-screen keys below still play."; } }
  else ui.midiNote.textContent = "This browser has no Web MIDI (Safari). Use Chrome or Edge for a MIDI keyboard; the on-screen keys below still play.";
  listDevices(); ensureInstruments(neededInsts());
  if (lic.valid && lic.key && configured()) validateKey(lic.key, lic.instance).then(ok => { if (!ok) { lic.valid = false; saveLic(); paintLicense(); } }).catch(() => {}); }

// test hook for QA (same code paths as the UI)
window.__takekit = { state, setSetting, ensureCtx, start, stop, startRec, exportWavBytes, exportMidBytes, exportStemsBytes, saveFile, trySave, paintAll, expScope, gated, configured, renderMix, regions, importFiles, comps, scoresFor, renderVoice, voiceBuffer, makeupFor,
  takes: () => takes, midiTakes, ready: () => loading.size === 0 && Object.keys(bufs).length > 0 && missingLabels(filesFor(neededInsts())).length === 0, play: () => play, active: () => active.size, liveVoices: () => liveVoices.size, sustainOn: () => sustain, INST, KIT, SAMPLES, bufs: () => Object.keys(bufs).length, latencyS, segLabel, ctx: () => ctx, measureStopSilence, missingLabels, neededInsts, filesFor, liveOn, liveOff, setSustain, onMidi, lic, LEMON, choiceFor, playing: () => !!play, recording: () => !!rec,
  async importBytes(b64, name){ const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return importFiles([new File([u], name || "take.wav", { type: "audio/wav" })]); },
  seekBar, regions, playRange, chordAt, energyAt, normSections, defaultSections, barLog: () => window.__barLog, cue: () => cue, lock(l, k, id){ state.locks[l][k] = id; save(); paintTakes(); }, paintTakes, enableMic };
normSections(); boot();
