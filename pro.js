// TakeKit Pro layer — backing-track upload, vocal chain, guide vocal, lyric timer. Loaded after app.js (shares its globals).
// Everything stays in this browser: files live in IndexedDB, settings in localStorage. Nothing is uploaded.
// Audio-clock rules hold: backing and guide are scheduled bar by bar from the same scheduler time as the band/comp.
(() => {
const P = {}; window.__bkLog = [];
const IR_URL = "samples/ir/konsa-hall-1.wav"; // CC0 recorded balloon-pop IR, Helsinki Conservatory hall (lehtoroni/kajahdus @9dae394), bundled
const DEF_BK = { offsetMs: 0, startBar: 0, whole: false, vol: 0.9, mute: false, inExport: true, name: "" };
const DEF_GD = { vol: 0.8, mute: false, solo: false, recOnly: true, stem: false, score: true, follow: true, offsetMs: 0, name: "", kind: "" };
const DEF_LY = { text: "", times: {}, words: {}, locks: {}, follow: true };
const PRESETS = {
  "Clean Pop":   { hpf: [90], sub: [300, -3, 1.2], deess: [6500, -28], comp: [-18, 4, -24, 2.5], tone: [2, 3500, 3], sat: [1.5, 0.2], verb: [0.12], delay: [0.08, "8d", 0.25] },
  "Warm Ballad": { hpf: [80], sub: [400, -2, 1.0], deess: [6000, -30], comp: [-20, 3, -26, 2], tone: [1, 3000, 1.5], sat: [2, 0.3], verb: [0.25], delay: [0.1, "4", 0.3] },
  "Rap Upfront": { hpf: [100], sub: [250, -4, 1.5], deess: [7000, -24], comp: [-22, 8, -20, 3], tone: [4, 4000, 2], sat: [2.5, 0.25], verb: [0.04], delay: [0.05, "8d", 0.15] },
  "Airy R&B":    { hpf: [95], sub: [350, -3, 1.2], deess: [7500, -30], comp: [-18, 4, -24, 2], tone: [1.5, 3500, 5], sat: [1.2, 0.15], verb: [0.22], delay: [0.14, "8d", 0.35] },
  "Rock Grit":   { hpf: [100], sub: [500, -3, 1.0], deess: [6000, -26], comp: [-24, 8, -20, 4], tone: [3, 3000, 1], sat: [4, 0.5], verb: [0.1], delay: [0.08, "4", 0.2] } };
const STAGES = ["hpf", "sub", "deess", "comp", "tone", "sat", "verb", "delay"];
function preset(name){ if (name === "Off") return Object.assign(preset("Clean Pop"), { on: false, preset: "Off" }); const p = PRESETS[name] || PRESETS["Clean Pop"];
  return { preset: PRESETS[name] ? name : "Clean Pop", on: true, trim: 0, export: (state.chain && state.chain.export) || "chain", monitorFx: !!(state.chain && state.chain.monitorFx),
    hpf: { on: true, mix: 1, f: p.hpf[0] }, sub: { on: true, mix: 1, f: p.sub[0], g: p.sub[1], q: p.sub[2] }, deess: { on: true, mix: 1, f: p.deess[0], th: p.deess[1] },
    comp: { on: true, mix: 1, fth: p.comp[0], fr: p.comp[1], lth: p.comp[2], lr: p.comp[3] }, tone: { on: true, mix: 1, pres: p.tone[0], presF: p.tone[1], air: p.tone[2] },
    sat: { on: true, mix: p.sat[1], drive: p.sat[0] }, verb: { on: true, mix: 1, send: p.verb[0] }, delay: { on: true, mix: 1, send: p.delay[0], div: p.delay[1], fb: p.delay[2] } }; }
state.src = state.src === "backing" ? "backing" : "band";
state.bk = Object.assign({}, DEF_BK, state.bk || {}); state.guide = Object.assign({}, DEF_GD, state.guide || {}); state.lyr = Object.assign({}, DEF_LY, state.lyr || {});
{ const base = preset(state.chain && state.chain.preset || "Clean Pop"), c = state.chain || {}; for (const k of STAGES) base[k] = Object.assign(base[k], c[k] || {});
  for (const k of ["on", "trim", "export", "monitorFx", "preset"]) if (c[k] !== undefined) base[k] = c[k]; state.chain = base; }

// ---------- files in IndexedDB ----------
const fdb = { tx(mode, fn){ return idb.open().then(db => new Promise((res, rej) => { const t = db.transaction("files", mode), s = t.objectStore("files"), r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); })); },
  put(o){ return this.tx("readwrite", s => s.put(o)); }, get(id){ return this.tx("readonly", s => s.get(id)).catch(() => null); }, del(id){ return this.tx("readwrite", s => s.delete(id)).catch(() => {}); } };
const barDur = () => 4 * 60 / state.bpm;
const monoOf = b => { const m = new Float32Array(b.length); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < m.length; i++) m[i] += d[i] / b.numberOfChannels; } return m; };
const FMT = "This browser can't decode that file. Chrome, Edge and Firefox read WAV, MP3, FLAC, M4A/AAC and OGG; AIFF decodes in Safari only, so export AIFF as WAV first.";

// ---------- backing track ----------
let bkRaw = null, bk48 = null, bkMono = null;
P.isBk = () => state.src === "backing" && !!bk48;
P.bkInMix = () => P.isBk() && state.bk.inExport;
const bkOff = bar => state.bk.offsetMs / 1000 + (state.bk.startBar + bar) * barDur();
async function setBacking(name, bytes, persist){ let b; try { b = await decodeCtx().decodeAudioData(bytes.slice(0)); } catch (e) { return { ok: false, msg: `Couldn't read ${name}. ${FMT}` }; }
  if (!b || b.duration < 1) return { ok: false, msg: `${name} is shorter than a second, so it can't be a backing track.` };
  bkRaw = bytes; bk48 = b; bkMono = monoOf(b); if (persist) { await fdb.put({ id: "backing", name, bytes }); state.bk = Object.assign({}, DEF_BK, { name, vol: state.bk.vol }); state.src = "backing"; }
  return { ok: true }; }
P.loadBacking = async file => { const r = await setBacking(file.name, await file.arrayBuffer(), true); if (!r.ok) { $("bkErr").textContent = r.msg; paint(); return false; }
  $("bkErr").textContent = ""; const sug = detectBpm(); state.bk.bpmHint = sug; if (state.bk.whole) fitWhole(); save(); paintSong(); paintTakes(); paint(); setStatus(`Loaded ${file.name} as your backing (${bk48.duration.toFixed(1)} s, decoded locally). Set BPM + key, then the first downbeat.`); return true; };
P.clearBacking = async () => { await fdb.del("backing"); bkRaw = bk48 = bkMono = null; state.src = "band"; state.bk = Object.assign({}, DEF_BK); if (![4, 8, 16].includes(state.bars)) state.bars = 8; save(); paintSong(); paintTakes(); paint(); setStatus("Backing track cleared. The built-in band is back."); };
function detectBpm(){ if (!bkMono) return null; const sr = 48000, H = 512, n = Math.min(bkMono.length, sr * 60), env = []; let prev = 1e-9;
  for (let i = 0; i + H <= n; i += H) { let e = 1e-9; for (let j = i; j < i + H; j++) e += bkMono[j] * bkMono[j]; env.push(Math.max(0, Math.log(e) - Math.log(prev))); prev = e; }
  let best = null, bv = -1; for (let bpm = 60; bpm <= 180; bpm += 0.5) { const lag = 60 / bpm * sr / H, L = Math.floor(lag); let s = 0, c = 0; for (let i = 0; i + L + 1 < env.length; i++) { const f = lag - L, v = env[i + L] * (1 - f) + env[i + L + 1] * f; s += env[i] * v; c++; } s /= Math.max(1, c); if (s > bv * 1.0001) { bv = s; best = bpm; } }
  if (!best) return null; while (best < 70) best *= 2; while (best > 160) best /= 2; return Math.round(best); }
function fitWhole(){ if (!bk48) return; const n = Math.max(1, Math.min(256, Math.floor((bk48.duration - state.bk.offsetMs / 1000 + 0.005) / barDur())));
  state.bk.startBar = 0; state.bars = n; state.locks = { voice: {}, midi: {} }; }
function snapOnset(t){ if (!bkMono) return t; const sr = 48000, w = 48, i0 = Math.max(0, Math.round((t - 0.04) * sr)), i1 = Math.min(bkMono.length, Math.round((t + 0.04) * sr)), env = [];
  for (let i = i0; i + w <= i1; i += w) { let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(bkMono[j])); env.push(m); }
  const pk = Math.max(0, ...env); if (pk < 1e-4) return t; let k = 0; while (k < env.length && env[k] < 0.5 * pk) k++; return (i0 + k * w) / sr; }
let tapPrev = null;
P.tapDownbeat = async () => { await ensureCtx(); if (!bk48) return; if (play) stop(true);
  if (!tapPrev) { const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = bk48; g.gain.value = state.bk.vol; s.connect(g); g.connect(bus.master); const t0 = ctx.currentTime + 0.05; s.start(t0); tapPrev = { s, t0 };
    $("bkTap").textContent = "Tap on the first downbeat!"; $("bkTap").classList.add("on"); setStatus("Listening: tap the button (or press Enter) on the first downbeat of bar 1."); return; }
  const t = ctx.currentTime - tapPrev.t0 - (ctx.outputLatency || ctx.baseLatency || 0); try { tapPrev.s.stop(); } catch (e) {} tapPrev = null; $("bkTap").textContent = "Tap downbeat"; $("bkTap").classList.remove("on");
  const snapped = snapOnset(Math.max(0, t)); setBk("offsetMs", Math.round(snapped * 1000 * 10) / 10); setStatus(`First downbeat set to ${state.bk.offsetMs} ms (your tap, snapped to the nearest transient). Nudge it if needed.`); };
function setBk(k, v){ if (k === "offsetMs") v = clamp(+v || 0, -2000, bk48 ? bk48.duration * 1000 - 100 : 600000); if (k === "startBar") v = Math.max(0, Math.round(+v || 0));
  state.bk[k] = v; if (k === "whole") { if (v) fitWhole(); else state.bars = 8; } else if (state.bk.whole && k === "offsetMs") fitWhole(); save(); P.apply(); paintSong(); paintTakes(); paint(); }
P.setBk = setBk;

// ---------- guide vocal ----------
let gd = null; // { kind:"file", mono48 } or { kind:"loop", sr, data }
const gCache = {}; let gdId = 0;
P.scoreKey = () => gd && state.guide.score ? [gdId, state.guide.follow, state.guide.offsetMs, state.bk.offsetMs, state.bk.startBar, state.bpm, state.bars].join(",") : "";
function guideLoop(sr){ if (!gd) return null; const g = state.guide, key = [gdId, gd.kind, g.name, state.bpm, state.bars, state.bk.offsetMs, state.bk.startBar, g.follow, g.offsetMs, sr].join("|"); if (gCache.key === key) return gCache.data;
  const N = Math.round(state.bars * barDur() * sr); let out;
  if (gd.kind === "file") { const off = (g.follow ? state.bk.offsetMs / 1000 + state.bk.startBar * barDur() : g.offsetMs / 1000), i0 = Math.round(off * 48000), M = Math.round(state.bars * barDur() * 48000), x = new Float32Array(M);
    for (let i = 0; i < M; i++) { const j = i0 + i; x[i] = j >= 0 && j < gd.mono48.length ? gd.mono48[j] : 0; } out = resample(x, 48000, sr); }
  else out = resample(gd.data, gd.sr, sr);
  const y = new Float32Array(N); y.set(out.subarray(0, N)); gCache.key = key; gCache.data = y; gCache.an = null; gCache.buf = null; return y; }
function guideAn(){ const d = guideLoop(48000); if (!d) return null; if (!gCache.an) gCache.an = analyzeAudio({ sr: 48000, data: d }); return gCache.an; }
P.guideMidi = t => { if (!gd || !state.guide.score) return null; const fr = guideAn(); if (!fr || !fr.t.length) return null; const i = Math.round((t - fr.t[0]) / fr.hop);
  if (i < 0 || i >= fr.t.length || !(fr.f0[i] > 0) || fr.rms[i] < 0.006) return null; return 69 + 12 * Math.log2(fr.f0[i] / 440); };
P.guideStem = () => !!gd && state.guide.stem;
P.hasGuide = () => !!gd;
async function setGuideFile(name, bytes){ let b; try { b = await decodeCtx().decodeAudioData(bytes.slice(0)); } catch (e) { return `Couldn't read ${name}. ${FMT}`; } gd = { kind: "file", mono48: monoOf(b) }; gdId++; return null; }
P.loadGuide = async file => { const bytes = await file.arrayBuffer(), err = await setGuideFile(file.name, bytes); if (err) { $("gdErr").textContent = err; return false; }
  $("gdErr").textContent = ""; await fdb.put({ id: "guide", kind: "file", name: file.name, bytes }); state.guide = Object.assign({}, state.guide, { name: file.name, kind: "file", score: true, offsetMs: state.bk.offsetMs }); gCache.key = ""; save(); paintTakes(); paint(); setStatus(`Guide vocal ${file.name} loaded. Takes are now scored against its melody.`); return true; };
P.guideFromTake = async id => { await ensureCtx(); const sr = ctx.sampleRate; let data, name;
  if (id === "comp") { if (!takes.length) return false; data = renderVoice(choiceFor("voice", "comp"), sr).data; name = "Comp (B)"; } else { const t = takes.find(x => x.id === id); if (!t) return false; data = t.data.slice(0); name = takeName(t); sr !== t.sr; }
  const r = { id: "guide", kind: "loop", name, sr: id === "comp" ? sr : takes.find(x => x.id === id).sr, data }; gd = { kind: "loop", sr: r.sr, data }; gdId++; await fdb.put(r);
  state.guide = Object.assign({}, state.guide, { name, kind: "loop", score: true }); gCache.key = ""; save(); paintTakes(); paint(); setStatus(`${name} is now the guide vocal.`); return true; };
P.clearGuide = async () => { await fdb.del("guide"); gd = null; gCache.key = ""; state.guide = Object.assign({}, DEF_GD); save(); paintTakes(); paint(); };
const guideAudible = () => !state.guide.mute && (state.guide.solo || !state.guide.recOnly || !!rec);

// ---------- live routing ----------
P.bus = (c, b) => { const bk = c.createGain(), g = c.createGain(), cin = c.createGain(), cout = c.createGain(); bk.connect(b.master); bk.connect(b.anT); g.connect(b.master);
  b.ab.disconnect(); b.ab.connect(cin); cout.connect(b.voice); b.pro = { bk, gd: g, cin, cout, chain: null, mon: null };
  b.pro.chain = makeChain(c, cin, cout, true); loadIR(); setTimeout(P.apply, 0); };
P.monitorDest = () => { const b = bus.pro; if (!b.monIn) { b.monIn = ctx.createGain(); b.monOut = ctx.createGain(); b.monOut.connect(bus.mon); b.mon = makeChain(ctx, b.monIn, b.monOut, state.chain.monitorFx); } return b.monIn; };
P.apply = () => { if (!bus || !bus.pro) return; const now = ctx.currentTime, solo = state.guide.solo && !!gd, b = bus.pro;
  b.bk.gain.setTargetAtTime(state.bk.mute || solo ? 0 : state.bk.vol, now, 0.01); b.gd.gain.setTargetAtTime(state.guide.vol, now, 0.01);
  if (solo) { for (const ch of CHAIRS) bus.chairs[ch.id].gain.setTargetAtTime(0, now, 0.01); bus.voice.gain.setTargetAtTime(0, now, 0.01); }
  b.chain = syncChain(ctx, b.chain, b.cin, b.cout, true); if (b.monIn) b.mon = syncChain(ctx, b.mon, b.monIn, b.monOut, state.chain.monitorFx); };
function schedSlice(buf, dest, t, off, bd, head, gain){ const pre = 0.0025; let st = head ? t - pre : t, so = head ? off - pre : off, len = bd + (head ? pre : 0) + pre;
  if (so < 0) { st -= so; len += so; so = 0; } if (len <= 0.006 || so >= buf.duration) return null;
  const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf;
  g.gain.setValueAtTime(head ? 0 : gain, st); if (head) g.gain.linearRampToValueAtTime(gain, st + 2 * pre); g.gain.setValueAtTime(gain, st + len - 2 * pre); g.gain.linearRampToValueAtTime(0, st + len);
  src.connect(g); g.connect(dest); src.start(st, so, len); src.stop(st + len + 0.005); const r = { src, g }; active.add(r); src.onended = () => active.delete(r); return { st, so }; }
// called from scheduleStep at every bar line, with the scheduler's audio-clock time
P.bar = (bar, t, first) => { if (!bus || !bus.pro) return; const bd = barDur(), head = !(first || bar === 0);
  if (P.isBk()) { const off = bkOff(bar), r = schedSlice(bk48, bus.pro.bk, t, off, bd, head, 1); window.__bkLog.push({ bar, t, off, bpm: state.bpm, sched: !!r }); if (window.__bkLog.length > 4000) window.__bkLog.shift(); }
  if (gd) { const d = guideLoop(ctx.sampleRate); if (!gCache.buf) { gCache.buf = ctx.createBuffer(1, d.length, ctx.sampleRate); gCache.buf.copyToChannel(d, 0); } schedSlice(gCache.buf, bus.pro.gd, t, bar * bd, bd, head, guideAudible() ? 1 : 0); } };

// ---------- vocal chain (deterministic Web Audio graph; same builder live and offline) ----------
let irRaw = null, irLive = null, irErr = null;
async function loadIR(){ if (irRaw || irErr) return; try { const r = await fetch(IR_URL); if (!r.ok) throw new Error("HTTP " + r.status); irRaw = await r.arrayBuffer(); irLive = await decodeCtx().decodeAudioData(irRaw.slice(0)); P.apply(); paint(); } catch (e) { irErr = String(e); paint(); } }
const makeup = (th, r) => Math.pow(10, 0.6 * th * (1 - 1 / r) / 20); // cancels the compressor's automatic makeup gain (spec: (1/fullRangeGain)^0.6)
function satCurve(drive){ const n = 2049, c = new Float32Array(n), k = Math.tanh(drive); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(drive * x) / k; } return c; }
const topoKey = (p, fx) => p.on ? STAGES.map(k => p[k].on ? 1 : 0).join("") + (fx ? "f" : "") + (irLive ? "i" : "") : "off";
function makeChain(c, input, output, fx, ir){ const p = state.chain, n = { topo: topoKey(p, fx), c, fx }, T = c.createGain(); n.trim = T;
  if (!p.on) { input.connect(output); n.direct = true; return n; }
  let cur = input; const stage = (name, build) => { const s = p[name]; if (!s.on) return; const out = c.createGain(), [a, z, ex] = build(), w = c.createGain(), d = c.createGain(); cur.connect(a); z.connect(w); w.connect(out); cur.connect(d); d.connect(out); n[name] = Object.assign({ w, d }, ex); cur = out; };
  stage("hpf", () => { const f = c.createBiquadFilter(); f.type = "highpass"; f.Q.value = 0.707; return [f, f, { f }]; });
  stage("sub", () => { const f = c.createBiquadFilter(); f.type = "peaking"; return [f, f, { f }]; });
  stage("deess", () => { const sp = c.createGain(), lp = c.createBiquadFilter(), hp = c.createBiquadFilter(), inv = c.createGain(), cp = c.createDynamicsCompressor(), mk = c.createGain(), sum = c.createGain();
    lp.type = "lowpass"; hp.type = "highpass"; lp.Q.value = hp.Q.value = 0.5; inv.gain.value = -1; cp.ratio.value = 6; cp.attack.value = 0.001; cp.release.value = 0.05; cp.knee.value = 3; // LR2 split: LP − HP is allpass, so the band split itself is flat
    sp.connect(lp); lp.connect(sum); sp.connect(hp); hp.connect(inv); inv.connect(cp); cp.connect(mk); mk.connect(sum); return [sp, sum, { lp, hp, cp, mk }]; });
  stage("comp", () => { const a = c.createDynamicsCompressor(), am = c.createGain(), b = c.createDynamicsCompressor(), bm = c.createGain();
    a.attack.value = 0.0008; a.release.value = 0.06; a.knee.value = 4; b.attack.value = 0.03; b.release.value = 0.6; b.knee.value = 12; a.connect(am); am.connect(b); b.connect(bm); return [a, bm, { a, am, b, bm }]; }); // 1176-style fast stage, then LA-2A-style leveller
  stage("tone", () => { const pr = c.createBiquadFilter(), air = c.createBiquadFilter(); pr.type = "peaking"; pr.Q.value = 0.9; air.type = "highshelf"; air.frequency.value = 10000; pr.connect(air); return [pr, air, { pr, air }]; });
  stage("sat", () => { const ws = c.createWaveShaper(); ws.oversample = "2x"; return [ws, ws, { ws }]; });
  cur.connect(T);
  if (fx && p.verb.on && (ir || irLive)) { const s = c.createGain(), cv = c.createConvolver(), w = c.createGain(); cv.buffer = ir || irLive; cur.connect(s); s.connect(cv); cv.connect(w); w.connect(T); n.verb = { s, cv, w }; }
  if (fx && p.delay.on) { const s = c.createGain(), dl = c.createDelay(2), fb = c.createGain(), lp = c.createBiquadFilter(), w = c.createGain(); lp.type = "lowpass"; lp.frequency.value = 5000;
    cur.connect(s); s.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(w); w.connect(T); n.delay = { s, dl, fb, w }; }
  T.connect(output); setParams(n, p, 0); return n; }
function setParams(n, p, now){ if (n.direct) return; const set = (prm, v) => { if (now) prm.setTargetAtTime(v, now, 0.01); else prm.value = v; };
  for (const k of ["hpf", "sub", "deess", "comp", "tone", "sat"]) if (n[k]) { set(n[k].w.gain, p[k].mix); set(n[k].d.gain, 1 - p[k].mix); }
  if (n.hpf) set(n.hpf.f.frequency, p.hpf.f);
  if (n.sub) { set(n.sub.f.frequency, p.sub.f); set(n.sub.f.gain, p.sub.g); set(n.sub.f.Q, p.sub.q); }
  if (n.deess) { set(n.deess.lp.frequency, p.deess.f); set(n.deess.hp.frequency, p.deess.f); set(n.deess.cp.threshold, p.deess.th); set(n.deess.mk.gain, makeup(p.deess.th, 6)); }
  if (n.comp) { set(n.comp.a.threshold, p.comp.fth); set(n.comp.a.ratio, p.comp.fr); set(n.comp.am.gain, makeup(p.comp.fth, p.comp.fr)); set(n.comp.b.threshold, p.comp.lth); set(n.comp.b.ratio, p.comp.lr); set(n.comp.bm.gain, makeup(p.comp.lth, p.comp.lr)); }
  if (n.tone) { set(n.tone.pr.frequency, p.tone.presF); set(n.tone.pr.gain, p.tone.pres); set(n.tone.air.gain, p.tone.air); }
  if (n.sat && n.sat.drive !== p.sat.drive) { n.sat.ws.curve = satCurve(p.sat.drive); n.sat.drive = p.sat.drive; }
  if (n.verb) { set(n.verb.s.gain, p.verb.send); set(n.verb.w.gain, p.verb.mix); }
  if (n.delay) { set(n.delay.s.gain, p.delay.send); set(n.delay.w.gain, p.delay.mix); set(n.delay.fb.gain, p.delay.fb); set(n.delay.dl.delayTime, (p.delay.div === "8d" ? 0.75 : 1) * 60 / state.bpm); }
  set(n.trim.gain, Math.pow(10, p.trim / 20)); }
function teardown(n, input){ try { input.disconnect(); } catch (e) {} for (const v of Object.values(n)) if (v && typeof v === "object") for (const x of Object.values(v)) if (x && x.disconnect) try { x.disconnect(); } catch (e) {} if (n.trim) try { n.trim.disconnect(); } catch (e) {} }
function syncChain(c, n, input, output, fx){ if (n && n.topo === topoKey(state.chain, fx)) { setParams(n, state.chain, c.currentTime); return n; } if (n) teardown(n, input); return makeChain(c, input, output, fx); }
P.voiceDest = async (oc, sum, o) => { const dry = o.dry != null ? o.dry : state.chain.export === "dry"; if (dry || !state.chain.on) return sum;
  const ir = irRaw ? await oc.decodeAudioData(irRaw.slice(0)) : null, input = oc.createGain(); makeChain(oc, input, sum, true, ir); return input; };
P.offlineExtras = async (oc, sum, only, N) => {
  if (only.includes("backing") && P.isBk()) { const b = await oc.decodeAudioData(bkRaw.slice(0)), s = oc.createBufferSource(), g = oc.createGain(), off = bkOff(0), when = off < 0 ? -off : 0, dur = N / SR - when, e = 64 / SR;
    s.buffer = b; s.connect(g); g.connect(sum); g.gain.setValueAtTime(state.bk.vol, 0); g.gain.setValueAtTime(state.bk.vol, N / SR - e); g.gain.linearRampToValueAtTime(0, N / SR); // backing is cut to the exact grid length; no tail fold (it's a recording, not a ring-out)
    if (dur > 0) s.start(when, Math.max(0, off), dur); }
  if (only.includes("guide") && gd) { const d = guideLoop(SR), b = oc.createBuffer(1, d.length, SR), s = oc.createBufferSource(), g = oc.createGain(); b.copyToChannel(d, 0); s.buffer = b; g.gain.value = state.guide.vol; s.connect(g); g.connect(sum); s.start(0); } };
P.loadPreset = name => { state.chain = Object.assign(preset(name), { export: state.chain.export, monitorFx: state.chain.monitorFx }); if (name === "Off") state.chain.on = false; saveMix(); P.apply(); paintChain(); };

// ---------- lyrics: text kept byte-for-byte; times are seconds from the loop start (= sample 0 of the export) ----------
const lines = () => state.lyr.text.split("\n");
const isTimed = l => l.trim() !== "" && !/^\s*[\[(].*[\])]\s*$/.test(l);
const wordSpans = l => { const out = [], re = /\S+/g; let m; while ((m = re.exec(l))) out.push([m.index, m.index + m[0].length]); return out; };
P.autoTime = () => { const L = lines(), idx = L.map((l, i) => isTimed(l) ? i : -1).filter(i => i >= 0); if (!idx.length) return 0; const loopS = state.bars * barDur(), ly = state.lyr;
  const fr = guideAn(); let segs = [], ons = [];
  if (fr) { let s = null; for (let i = 0; i < fr.t.length; i++) { const v = fr.rms[i] > 0.006 && fr.f0[i] > 0; if (v && s == null) s = fr.t[i]; if (!v && s != null) { segs.push([s, fr.t[i]]); s = null; } } if (s != null) segs.push([s, fr.t[fr.t.length - 1]]);
    const m = []; for (const g of segs) { if (m.length && g[0] - m[m.length - 1][1] < 0.12) m[m.length - 1][1] = g[1]; else m.push(g.slice()); } segs = m.filter(g => g[1] - g[0] > 0.08); ons = [...new Set(segs.map(g => g[0]).concat(fr.on))].sort((a, b) => a - b); }
  if (!segs.length) segs = [[0, loopS]];
  const V = segs.reduce((a, g) => a + g[1] - g[0], 0), at = v => { for (const g of segs) { if (v <= g[1] - g[0]) return g[0] + v; v -= g[1] - g[0]; } return segs[segs.length - 1][1]; };
  const snap = (t, lo, hi) => { let best = t, bd = 0.25; for (const o of ons) if (o >= lo && o < hi && Math.abs(o - t) < bd) { bd = Math.abs(o - t); best = o; } return Math.round(clamp(best, lo, hi) * 1000) / 1000; };
  const wc = idx.map(i => wordSpans(L[i]).length), W = wc.reduce((a, b) => a + b, 0) || 1; let acc = 0, prev = -1;
  idx.forEach((li, k) => { const target = at(acc / W * V); acc += wc[k];
    if (!ly.locks[li]) { let best = null, bd = Math.min(1.2, barDur() * 0.6); for (const g of segs) if (g[0] > prev + 0.1 && Math.abs(g[0] - target) < bd) { bd = Math.abs(g[0] - target); best = g[0]; }
      ly.times[li] = best != null ? Math.round(best * 1000) / 1000 : snap(target, prev + 0.1, loopS); } prev = ly.times[li]; });
  idx.forEach((li, k) => { const t0 = ly.times[li], t1 = k + 1 < idx.length ? ly.times[idx[k + 1]] : Math.min(loopS, t0 + Math.max(1, barDur())), sp = wordSpans(L[li]), ch = sp.map(s => s[1] - s[0]), C = ch.reduce((a, b) => a + b, 0) || 1; let a = 0, pw = t0 - 0.001;
    if (ly.locks[li] && ly.words[li]) return; ly.words[li] = sp.map((s, j) => { const t = j === 0 ? t0 : snap(t0 + (t1 - t0) * 0.9 * a / C, pw + 0.04, t1); a += ch[j]; pw = t; return t; }); });
  saveMix(); paintLyrics(); return idx.length; };
const fmtT = t => { const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, "0") + ":" + s.toFixed(2).padStart(5, "0"); };
P.lrc = () => { const L = lines(), out = [`[ti:${BRAND} lyrics]`, `[length:${fmtT(state.bars * barDur())}]`, `[by:${BRAND} ${state.bpm} BPM ${keyLabel(state)}]`];
  L.forEach((l, i) => { if (isTimed(l) && state.lyr.times[i] != null) out.push(`[${fmtT(state.lyr.times[i])}]${l}`); }); return out.join("\n") + "\n"; };
P.midiLyrics = (T, meta) => { const sd = stepDur(), L = lines(), ev = [{ t: 0, o: 0, b: meta(0x03, "Lyrics") }];
  L.forEach((l, i) => { const t0 = state.lyr.times[i]; if (!isTimed(l) || t0 == null) return; ev.push({ t: Math.round(t0 / sd * T), o: 1, b: meta(0x06, l.trim()) });
    const sp = wordSpans(l), ws = state.lyr.words[i] || []; sp.forEach((s, j) => ev.push({ t: Math.round((ws[j] != null ? ws[j] : t0) / sd * T), o: 2, b: meta(0x05, l.slice(s[0], s[1])) })); });
  return ev; };
let tapIdx = -1, curPos = 0;
P.draw = (cur, now) => { curPos = cur.s * stepDur() + Math.max(0, now - cur.time);
  const L = lines(); let li = -1; L.forEach((l, i) => { const t = state.lyr.times[i]; if (isTimed(l) && t != null && t <= curPos + 1e-3 && (li < 0 || t >= state.lyr.times[li])) li = i; });
  const box = $("lyrList"); if (box) { const old = box.querySelector(".cur"); const el = li >= 0 ? box.querySelector(`[data-li="${li}"]`) : null;
    if (old !== el) { if (old) old.classList.remove("cur"); if (el) { el.classList.add("cur"); if (state.lyr.follow) box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 2 + el.clientHeight / 2; } }
    if (el) { const ws = state.lyr.words[li] || []; el.querySelectorAll(".w").forEach((w, j) => w.classList.toggle("on", ws[j] != null && ws[j] <= curPos)); } }
  meters(); };
P.tap = () => { if (!play) { setStatus("Press Play first, then tap each line as it starts."); return; } const L = lines(); let i = tapIdx + 1; while (i < L.length && (!isTimed(L[i]) || state.lyr.locks[i])) i++;
  if (i >= L.length) { setStatus("All lines tapped. Tap mode is done."); return; } const t = Math.max(0, curPos - (ctx.outputLatency || ctx.baseLatency || 0)); state.lyr.times[i] = Math.round(t * 1000) / 1000; state.lyr.words[i] = null; tapIdx = i; saveMix(); paintLyrics(); };

// ---------- UI ----------
function meters(){ const n = bus && bus.pro && bus.pro.chain; if (!n) return; const put = (id, v) => { const e = $(id); if (e) { e.style.width = clamp(-v / 20 * 100, 0, 100) + "%"; e.title = v.toFixed(1) + " dB"; } };
  put("gr_deess", n.deess ? n.deess.cp.reduction : 0); put("gr_fast", n.comp ? n.comp.a.reduction : 0); put("gr_level", n.comp ? n.comp.b.reduction : 0); }
const KN = { hpf: [["f", "Freq", 40, 200, 1, "Hz"]], sub: [["f", "Freq", 150, 1200, 10, "Hz"], ["g", "Cut", -12, 0, 0.5, "dB"], ["q", "Q", 0.3, 4, 0.1, ""]], deess: [["f", "Freq", 4000, 9000, 100, "Hz"], ["th", "Threshold", -50, 0, 1, "dB"]],
  comp: [["fth", "Fast thr", -40, 0, 1, "dB"], ["fr", "Fast ratio", 1, 20, 0.5, ":1"], ["lth", "Level thr", -40, 0, 1, "dB"], ["lr", "Level ratio", 1, 10, 0.5, ":1"]], tone: [["pres", "Presence", -6, 8, 0.5, "dB"], ["presF", "Pres freq", 2000, 6000, 100, "Hz"], ["air", "Air (10k shelf)", -6, 8, 0.5, "dB"]],
  sat: [["drive", "Drive", 1, 8, 0.1, ""]], verb: [["send", "Send", 0, 0.6, 0.01, ""]], delay: [["send", "Send", 0, 0.6, 0.01, ""], ["fb", "Feedback", 0, 0.7, 0.01, ""]] };
const SN = { hpf: "High-pass", sub: "Subtractive EQ", deess: "De-esser (split-band, 5–8 kHz)", comp: "Compressor (fast + leveller)", tone: "Tone EQ", sat: "Saturation", verb: "Reverb (real hall IR)", delay: "Tempo delay" };
function paintChain(){ const p = state.chain, el = $("chainUI"); if (!el) return;
  $("chPreset").value = p.on ? p.preset : "Off"; $("chOn").checked = p.on; $("chOn").parentElement.lastChild.textContent = p.on ? " Chain on" : " Bypassed (dry)"; $("chTrim").value = p.trim; $("chTrim_v").textContent = (p.trim > 0 ? "+" : "") + p.trim + " dB"; $("chMonFx").checked = p.monitorFx; $("chExport").value = p.export;
  el.innerHTML = STAGES.map(k => `<fieldset class="stage ${p[k].on ? "" : "off"}"><legend><label><input type="checkbox" data-st="${k}" ${p[k].on ? "checked" : ""}> ${SN[k]}</label></legend>`
    + KN[k].map(([f, l, a, b, s, u]) => `<label>${l} <input type="range" min="${a}" max="${b}" step="${s}" value="${p[k][f]}" data-k="${k}.${f}"> <b>${p[k][f]}${u}</b></label>`).join("")
    + (k === "delay" ? `<label>Time <select data-k="delay.div"><option value="8d" ${p.delay.div === "8d" ? "selected" : ""}>1/8 dotted</option><option value="4" ${p.delay.div === "4" ? "selected" : ""}>1/4</option></select> <b>${Math.round((p.delay.div === "8d" ? 0.75 : 1) * 60000 / state.bpm)} ms @ ${state.bpm}</b></label>` : "")
    + `<label>Wet/dry <input type="range" min="0" max="1" step="0.01" value="${p[k].mix}" data-k="${k}.mix"> <b>${Math.round(p[k].mix * 100)}%</b></label>`
    + (k === "deess" ? `<div class="gr">GR <i id="gr_deess"></i></div>` : k === "comp" ? `<div class="gr">Fast GR <i id="gr_fast"></i></div><div class="gr">Level GR <i id="gr_level"></i></div>` : "")
    + (k === "verb" ? `<p class="hint">${irErr ? "Reverb IR didn't load (" + esc(irErr) + "), so reverb is off." : "Convolution with a real recorded hall (balloon-pop IR, CC0)."}</p>` : "") + `</fieldset>`).join("");
  el.querySelectorAll("[data-st]").forEach(c => c.onchange = () => { p[c.dataset.st].on = c.checked; saveMix(); P.apply(); paintChain(); });
  el.querySelectorAll("[data-k]").forEach(r => r.oninput = () => { const [k, f] = r.dataset.k.split("."); p[k][f] = f === "div" ? r.value : +r.value; saveMix(); P.apply(); const b = r.nextElementSibling; if (b && f !== "div") b.textContent = r.value + (f === "mix" ? "" : ""); if (f === "div") paintChain(); }); }
function paintLyrics(){ const box = $("lyrList"); if (!box) return; const L = lines(), loopS = state.bars * barDur();
  box.innerHTML = L.map((l, i) => { if (!isTimed(l)) return `<div class="ln sec" data-li="${i}">${esc(l) || "&nbsp;"}</div>`; const t = state.lyr.times[i], sp = wordSpans(l); let h = "", p = 0;
    for (const s of sp) { h += esc(l.slice(p, s[0])) + `<span class="w">${esc(l.slice(s[0], s[1]))}</span>`; p = s[1]; } h += esc(l.slice(p));
    return `<div class="ln" data-li="${i}"><span class="lt">${t != null ? fmtT(t) : "--:--"}</span><button class="mini" data-n="-0.05" data-i="${i}">−</button><button class="mini" data-n="0.05" data-i="${i}">+</button>`
      + `<input type="range" min="0" max="${loopS.toFixed(2)}" step="0.01" value="${t != null ? t : 0}" data-drag="${i}" title="Drag to move this line"><label class="lk"><input type="checkbox" data-lock="${i}" ${state.lyr.locks[i] ? "checked" : ""}>🔒</label><span class="tx">${h}</span></div>`; }).join("");
  const mv = (i, t) => { const old = state.lyr.times[i] || 0, nt = Math.round(clamp(t, 0, loopS) * 1000) / 1000, ws = state.lyr.words[i]; state.lyr.times[i] = nt; if (ws) state.lyr.words[i] = ws.map(w => Math.round((w + nt - old) * 1000) / 1000); saveMix(); };
  box.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { mv(+b.dataset.i, (state.lyr.times[b.dataset.i] || 0) + +b.dataset.n); paintLyrics(); });
  box.querySelectorAll("[data-drag]").forEach(r => { r.oninput = () => { mv(+r.dataset.drag, +r.value); r.parentElement.querySelector(".lt").textContent = fmtT(+r.value); }; });
  box.querySelectorAll("[data-lock]").forEach(c => c.onchange = () => { if (c.checked) state.lyr.locks[c.dataset.lock] = true; else delete state.lyr.locks[c.dataset.lock]; saveMix(); });
  $("lyrNote").textContent = gd ? `Auto-time follows the guide vocal (${state.guide.name}). Times are from bar 1 of the loop, which is sample 0 of every export.` : "Add a guide vocal to auto-time from the singing; without one, lines are spread evenly across the loop."; }
function paint(){ const b = state.bk, has = !!bk48; $("src").value = state.src; $("bkBox").classList.toggle("dim", state.src !== "backing");
  $("bkName").textContent = has ? `${b.name} · ${bk48.duration.toFixed(1)} s · stored in this browser` : (b.name && state.src === "backing" ? "Backing file missing: upload it again." : "No backing loaded.");
  $("bkOff").value = b.offsetMs; $("bkOffR").max = has ? Math.min(30000, Math.floor(bk48.duration * 1000)) : 30000; $("bkOffR").value = b.offsetMs; $("bkStart").value = b.startBar + 1; $("bkWhole").checked = b.whole; $("bkVol").value = b.vol; $("bkMute").textContent = b.mute ? "muted" : "mute"; $("bkMute").classList.toggle("on", b.mute); $("bkInc").checked = b.inExport;
  $("bkBpm").innerHTML = has && b.bpmHint ? `Detected tempo suggestion: <b>${b.bpmHint} BPM</b> <button class="mini" id="bkUseBpm">use it</button> (your BPM ${state.bpm} stays until you choose)` : "";
  if ($("bkUseBpm")) $("bkUseBpm").onclick = () => { setSetting("bpm", b.bpmHint); paint(); };
  const sel = $("bars"); if (![...sel.options].some(o => +o.value === state.bars)) { const o = document.createElement("option"); o.value = state.bars; o.textContent = state.bars + " (whole track)"; sel.appendChild(o); } sel.value = state.bars;
  $("bkGrid").textContent = has ? `Bar 1 starts ${(bkOff(0)).toFixed(3)} s into the file; loop = ${state.bars} bars (${(state.bars * barDur()).toFixed(3)} s) at ${state.bpm} BPM.` : "";
  const g = state.guide; $("gdName").textContent = gd ? `${g.name} (${g.kind === "file" ? "uploaded file" : "from a take"}) · stored in this browser` : "No guide vocal.";
  $("gdVol").value = g.vol; for (const [id, k] of [["gdMute", "mute"], ["gdSolo", "solo"]]) { $(id).classList.toggle("on", g[k]); } $("gdRec").checked = g.recOnly; $("gdScore").checked = g.score; $("gdStem").checked = g.stem; $("gdFollow").checked = g.follow; $("gdOff").value = g.offsetMs; $("gdOff").disabled = g.follow;
  $("gdPick").innerHTML = `<option value="">Use a take as the guide…</option>` + (takes.length ? `<option value="comp">Comp (B)</option>` : "") + takes.map(t => `<option value="${esc(t.id)}">${esc(takeName(t))}</option>`).join("");
  if (document.activeElement !== $("lyrText")) $("lyrText").value = state.lyr.text; $("lyrFollow").checked = state.lyr.follow; paintChain(); paintLyrics(); }
P.paint = paint;
P.onSetting = k => { if (k === "bpm") { if (state.bk.whole) { fitWhole(); save(); } P.apply(); } paint(); };
function bindPro(){ const on = (id, ev, fn) => { $(id)[ev] = fn; };
  on("src", "onchange", () => { state.src = $("src").value; if (state.src === "band" && ![4, 8, 16].includes(state.bars)) state.bars = 8; if (state.src === "backing" && !bk48) $("bkErr").textContent = "Upload a backing file to hear it (the band is silent in this mode)."; save(); paintSong(); paintTakes(); paint(); ensureInstruments(neededInsts()); });
  on("bkUp", "onclick", () => $("bkFile").click()); on("bkFile", "onchange", async () => { const f = $("bkFile").files[0]; if (f) await P.loadBacking(f); $("bkFile").value = ""; });
  on("bkClear", "onclick", P.clearBacking); on("bkTap", "onclick", P.tapDownbeat);
  on("bkOff", "onchange", () => setBk("offsetMs", +$("bkOff").value)); on("bkOffR", "oninput", () => setBk("offsetMs", +$("bkOffR").value));
  document.querySelectorAll("[data-nudge]").forEach(b => b.onclick = () => setBk("offsetMs", Math.round((state.bk.offsetMs + +b.dataset.nudge) * 10) / 10));
  on("bkStart", "onchange", () => setBk("startBar", +$("bkStart").value - 1)); on("bkWhole", "onchange", () => setBk("whole", $("bkWhole").checked));
  on("bkVol", "oninput", () => { state.bk.vol = +$("bkVol").value; saveMix(); }); on("bkMute", "onclick", () => { state.bk.mute = !state.bk.mute; saveMix(); paint(); }); on("bkInc", "onchange", () => { state.bk.inExport = $("bkInc").checked; saveMix(); });
  on("gdUp", "onclick", () => $("gdFile").click()); on("gdFile", "onchange", async () => { const f = $("gdFile").files[0]; if (f) await P.loadGuide(f); $("gdFile").value = ""; });
  on("gdPick", "onchange", async () => { if ($("gdPick").value) await P.guideFromTake($("gdPick").value); }); on("gdClear", "onclick", P.clearGuide);
  on("gdVol", "oninput", () => { state.guide.vol = +$("gdVol").value; saveMix(); });
  for (const [id, k] of [["gdMute", "mute"], ["gdSolo", "solo"]]) on(id, "onclick", () => { state.guide[k] = !state.guide[k]; saveMix(); paint(); });
  for (const [id, k] of [["gdRec", "recOnly"], ["gdStem", "stem"], ["gdFollow", "follow"]]) on(id, "onchange", () => { state.guide[k] = $(id).checked; gCache.key = ""; save(); paint(); });
  on("gdScore", "onchange", () => { state.guide.score = $("gdScore").checked; save(); paintTakes(); }); on("gdOff", "onchange", () => { state.guide.offsetMs = +$("gdOff").value || 0; gCache.key = ""; save(); paintTakes(); });
  on("chPreset", "onchange", () => P.loadPreset($("chPreset").value)); on("chOn", "onchange", () => { state.chain.on = $("chOn").checked; saveMix(); P.apply(); paintChain(); });
  on("chTrim", "oninput", () => { state.chain.trim = +$("chTrim").value; saveMix(); P.apply(); paintChain(); }); on("chMonFx", "onchange", () => { state.chain.monitorFx = $("chMonFx").checked; saveMix(); P.apply(); });
  on("chExport", "onchange", () => { state.chain.export = $("chExport").value; saveMix(); });
  on("lyrText", "oninput", () => { state.lyr.text = $("lyrText").value; saveMix(); paintLyrics(); });
  on("lyrAuto", "onclick", () => { const n = P.autoTime(); setStatus(n ? `Timed ${n} lines${gd ? " to the guide vocal" : ""}. Locked lines were left alone.` : "Paste some lyrics first."); });
  on("lyrTap", "onclick", () => { tapIdx = -1; const a = !$("lyrTap").classList.contains("on"); $("lyrTap").classList.toggle("on", a); $("lyrTapBtn").hidden = !a; setStatus(a ? "Tap mode: press Play, then hit TAP (or Enter) as each line starts." : "Tap mode off."); });
  on("lyrTapBtn", "onclick", P.tap); on("lyrFollow", "onchange", () => { state.lyr.follow = $("lyrFollow").checked; saveMix(); });
  on("lyrLrc", "onclick", () => { download(new TextEncoder().encode(P.lrc()), fileBase() + ".lrc", "text/plain"); setStatus("Saved " + fileBase() + ".lrc (times from bar 1 = sample 0 of the WAV)."); });
  addEventListener("keydown", e => { if (e.key !== "Enter" || e.target.matches("input,textarea,select,button")) return; if (tapPrev) { e.preventDefault(); P.tapDownbeat(); } else if ($("lyrTap").classList.contains("on")) { e.preventDefault(); P.tap(); } }); }
async function bootPro(){ bindPro(); const b = await fdb.get("backing"); if (b && b.bytes) { const r = await setBacking(b.name, b.bytes, false); if (!r.ok) $("bkErr").textContent = r.msg; }
  const g = await fdb.get("guide"); if (g) { if (g.kind === "file") await setGuideFile(g.name, g.bytes); else { gd = { kind: "loop", sr: g.sr, data: g.data }; gdId++; } }
  ver++; paint(); paintTakes(); loadIR(); }
Object.assign(P, { state: () => state, PRESETS: Object.keys(PRESETS), guideLoop, guideAn, detectBpm: () => detectBpm(), bkOff, lines, isTimed, fmtT, ready: null });
P.ready = bootPro(); window.__pro = P;
})();
