// TakeKit · Build band from upload. Deterministic in-browser analysis of an audio or MIDI file:
// tempo + beat grid + downbeat, key, chord per bar (chroma templates), sections (repetition + energy), energy per section.
// Results are SUGGESTIONS: shown for review, your own BPM/key win, locked sections survive re-analysis.
(() => {
const AN = {}; let last = null; // { kind, name, mono, sr } or { kind:"midi", name, bytes }
const PCN = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
function fft(re, im){ const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr; re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } } }
function stft(x, N, H, fn){ const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); const re = new Float64Array(N), im = new Float64Array(N), mag = new Float32Array(N / 2);
  for (let f = 0, s = 0; s + N <= x.length; f++, s += H) { for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; } fft(re, im); for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]); fn(f, mag, s); } }
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const nrm = a => { const n = Math.sqrt(dot(a, a)) || 1; return a.map(v => v / n); };
const KMAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88], KMIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db + 1e-12); };
// 24 triads; score = cosine(bar chroma, template) + small bonus when the bass agrees with the root
const TPL = []; for (let r = 0; r < 12; r++) for (const [q, iv] of [["", [0, 4, 7]], ["m", [0, 3, 7]]]) { const t = Array(12).fill(0); for (const i of iv) t[(r + i) % 12] = 1; t[r] = 1.2; TPL.push({ r, q, t: nrm(t), name: PCN[r] + q }); }
function chordOf(ch, bass){ const c = nrm(ch); let best = null, second = -1; for (const T of TPL) { let s = dot(c, T.t); if (bass) { const bm = bass.indexOf(Math.max(...bass)); if (Math.max(...bass) > 0 && bm === T.r) s += 0.08; } if (!best || s > best.s) { if (best) second = Math.max(second, best.s); best = { name: T.name, r: T.r, q: T.q, s }; } else second = Math.max(second, s); }
  best.conf = Math.max(0, Math.min(1, (best.s - second) * 6 + (best.s - 0.6))); return best; }
function keyOf(total, firstChord){ const sc = []; for (let r = 0; r < 12; r++) { const rot = p => p.map((_, i) => p[(i - r + 12) % 12]); sc.push({ r, mode: "major", s: corr(total, rot(KMAJ)) }, { r, mode: "minor", s: corr(total, rot(KMIN)) }); }
  sc.sort((a, b) => b.s - a.s); let k = sc[0];
  // relative major/minor share notes: prefer the one whose tonic chord opens the song
  const rel = k.mode === "major" ? { r: (k.r + 9) % 12, mode: "minor" } : { r: (k.r + 3) % 12, mode: "major" }, rs = sc.find(x => x.r === rel.r && x.mode === rel.mode);
  if (firstChord && rs && k.s - rs.s < 0.15 && firstChord.r === rel.r && (firstChord.q === "m") === (rel.mode === "minor")) k = rs;
  return { root: k.r, mode: k.mode, conf: Math.max(0, Math.min(1, (k.s - sc[1].s) * 4 + 0.4)), name: PCN[k.r] + (k.mode === "minor" ? "m" : "") }; }
// sections: 4-bar blocks; a new section starts where the chord pattern or the energy changes; repeats get the same label
function sectionize(chords, energyDb, conf){ const B = chords.length, blocks = []; for (let b = 0; b < B; b += 4) { const e = energyDb.slice(b, b + 4); blocks.push({ b0: b, b1: Math.min(B, b + 4), sig: chords.slice(b, b + 4).join(" "), e: e.reduce((a, v) => a + v, 0) / e.length }); }
  const secs = []; for (const k of blocks) { const cur = secs[secs.length - 1]; if (cur && cur.sig === k.sig && Math.abs(cur.eSum / cur.n - k.e) < 0.7 && k.b1 - k.b0 === 4) { cur.b1 = k.b1; cur.eSum += k.e * (k.b1 - k.b0); cur.n += k.b1 - k.b0; cur.nov = cur.nov; }
    else secs.push({ b0: k.b0, b1: k.b1, sig: k.sig, eSum: k.e * (k.b1 - k.b0), n: k.b1 - k.b0, nov: cur ? Math.min(1, (cur.sig !== k.sig ? 0.6 : 0) + Math.abs(cur.eSum / cur.n - k.e) / 4) : 1 }); }
  for (const s of secs) s.e = s.eSum / s.n;
  const maxE = Math.max(...secs.map(s => s.e)), med = secs.map(s => s.e).sort((a, b) => a - b)[Math.floor(secs.length / 2)], groups = {};
  secs.forEach((s, i) => (groups[s.sig] = groups[s.sig] || []).push(i));
  const rep = Object.values(groups).filter(g => g.length > 1).map(g => ({ g, e: g.reduce((a, i) => a + secs[i].e, 0) / g.length })).sort((a, b) => b.e - a.e);
  const names = Array(secs.length).fill(null); if (rep[0]) rep[0].g.forEach(i => names[i] = "Chorus"); let vn = 0; for (const r of rep.slice(1)) for (const i of r.g) names[i] = "Verse";
  if (secs.length > 2 && secs[0].e < med - 0.3) names[0] = "Intro"; if (secs.length > 2 && secs[secs.length - 1].e < med - 0.3) names[secs.length - 1] = "Outro";
  if (secs.length > 2 && !names[0] && secs[0].b1 - secs[0].b0 <= 8) names[0] = "Intro";
  for (let i = 0; i < secs.length; i++) if (!names[i]) names[i] = i === secs.length - 1 && secs.length > 2 ? "Outro" : (names.slice(0, i).includes("Chorus") ? "Bridge" : "Verse");
  const vc = names.filter(n => n === "Verse").length; vn = 0;
  return secs.map((s, i) => { const bars = chords.slice(s.b0, s.b1), per = periodOf(bars), cs = conf.slice(s.b0, s.b1);
    return { name: names[i] === "Verse" && vc > 1 ? "Verse " + (++vn) : names[i], b0: s.b0, bars: s.b1 - s.b0, chords: per.join(" "), energy: Math.round(Math.max(0.2, Math.min(1, 1 + (s.e - maxE) / 12)) * 100) / 100, conf: Math.round(Math.min(1, 0.5 * s.nov + 0.5 * cs.reduce((a, v) => a + v, 0) / cs.length) * 100) / 100 }; }); }
function periodOf(a){ for (let p = 1; p <= Math.min(8, a.length); p++) { if (a.length % p && p > 4) continue; let ok = true; for (let i = p; i < a.length; i++) if (a[i] !== a[i - p]) { ok = false; break; } if (ok) return a.slice(0, p); } return a.slice(); }

function analyzeAudioData(mono, sr){ const t0 = performance.now(), q = Math.max(1, Math.round(sr / 12000)), fs = sr / q, n = Math.floor(mono.length / q), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < q; j++) s += mono[i * q + j]; x[i] = s / q; }
  // onset strength (spectral flux, log magnitude) at ~94 frames/s
  const N1 = 1024, H1 = 128, fps = fs / H1, odf = [], low = []; let prev = null, prevL = null;
  stft(x, N1, H1, (f, m) => { const lm = Array.from(m, v => Math.log(1 + 100 * v)); let fl = 0, fll = 0; if (prev) for (let k = 1; k < N1 / 2; k++) { const d = lm[k] - prev[k]; if (d > 0) { fl += d; if (k * fs / N1 < 160) fll += d; } } prev = lm; odf.push(fl); low.push(fll); });
  const mu = odf.reduce((a, v) => a + v, 0) / odf.length, o = odf.map(v => Math.max(0, v - mu));
  const at = t => { const i = Math.floor(t), f = t - i; return i + 1 < o.length && i >= 0 ? o[i] * (1 - f) + o[i + 1] * f : 0; };
  const comb = (bpm) => { const P = fps * 60 / bpm; let best = -1, bp = 0; for (let ph = 0; ph < P; ph += 1) { let s = 0, c = 0; for (let t = ph; t < o.length - 1; t += P) { s += at(t) + 0.5 * at(t + P / 2); c++; } s /= Math.max(1, c); if (s > best) { best = s; bp = ph; } } return { s: best, ph: bp }; };
  const prior = bpm => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
  let cand = []; for (let bpm = 60; bpm <= 180; bpm += 0.5) cand.push({ bpm, s: comb(bpm).s * prior(bpm) }); cand.sort((a, b) => b.s - a.s);
  let best = cand[0]; for (let bpm = best.bpm - 0.6; bpm <= best.bpm + 0.6; bpm += 0.02) { const s = comb(bpm).s * prior(bpm); if (s > best.s) best = { bpm, s }; }
  const bpm = Math.round(best.bpm * 100) / 100, P = fps * 60 / bpm, ph = comb(bpm).ph, beatS = 60 / bpm, barS = 4 * beatS;
  const tempoConf = Math.max(0, Math.min(1, 1 - (cand.find(c => Math.abs(c.bpm - best.bpm) > 3) || { s: 0 }).s / best.s + 0.3));
  // chroma at ~12 frames/s (4096-point frames), plus bass chroma
  const N2 = 4096, H2 = 1024, cf = [], bf = [], ef = [], bin = []; for (let k = 0; k < N2 / 2; k++) { const fr = k * fs / N2; const mm = 12 * Math.log2(Math.max(fr, 1) / 440), dv = Math.abs(mm - Math.round(mm)); bin.push(fr < 80 || fr > 2000 || (fr < 260 && dv > 0.3) ? -1 : ((Math.round(mm) + 69) % 12 + 12) % 12); }
  stft(x, N2, H2, (f, m) => { const c = new Float32Array(12), b = new Float32Array(12); let e = 0; let mx = 0; for (let k = 1; k < N2 / 2; k++) { e += m[k] * m[k]; if (bin[k] >= 0 && m[k] > mx) mx = m[k]; } for (let k = 1; k < N2 / 2 - 1; k++) { const p = bin[k]; if (p < 0 || !(m[k] > m[k - 1] && m[k] >= m[k + 1]) || m[k] < 0.03 * mx) continue; const v = m[k]; if (k * fs / N2 < 260) b[p] += v; else c[p] += v; } cf.push(c); bf.push(b); ef.push(e); });
  const cT = i => (i * H2 + N2 / 2) / fs;
  // beat chroma, for the downbeat: chords change on bar lines
  const beat0 = ph / fps, nb = Math.floor((x.length / fs - beat0) / beatS), bch = [];
  for (let j = 0; j < nb; j++) { const a = beat0 + j * beatS, b = a + beatS, c = new Float32Array(12); for (let i = 0; i < cf.length; i++) { const t = cT(i); if (t >= a + 0.1 * beatS && t < b - 0.1 * beatS) for (let p = 0; p < 12; p++) c[p] += cf[i][p] + bf[i][p]; } bch.push(nrm(Array.from(c))); }
  let dsc = [0, 0, 0, 0]; for (let j = 1; j < nb; j++) dsc[j % 4] += 1 - dot(bch[j], bch[j - 1]); for (let d = 0; d < 4; d++) { let s = 0; for (let j = d; j < nb; j += 4) s += low[Math.round((beat0 + j * beatS) * fps)] || 0; dsc[d] += 0.002 * s / Math.max(1, nb / 4); }
  const dd = dsc.indexOf(Math.max(...dsc)); let first = beat0 + dd * beatS; while (first - barS > -0.03) first -= barS;
  // sound starts: the first downbeat is the earliest bar line at or after the start of the audio
  let thr = 0; for (const v of x) thr = Math.max(thr, Math.abs(v)); let s0 = 0; while (s0 < x.length && Math.abs(x[s0]) < 0.02 * thr) s0++; const soundAt = s0 / fs;
  if (Math.abs(first - soundAt) < 0.2 * barS) first = soundAt; while (first < soundAt - 0.06) first += barS; if (first < 0) first += barS;
  const bars = Math.max(1, Math.floor((x.length / fs - first + 0.005) / barS)), chords = [], conf = [], eDb = [], total = Array(12).fill(0);
  for (let b = 0; b < bars; b++) { const a = first + b * barS, z = a + barS, c = Array(12).fill(0), bs = Array(12).fill(0); let e = 0, en = 0;
    for (let i = 0; i < cf.length; i++) { const t = cT(i); if (t >= a + 0.06 * barS && t < z - 0.06 * barS) { for (let p = 0; p < 12; p++) { c[p] += cf[i][p]; bs[p] += bf[i][p]; } e += ef[i]; en++; } }
    const ch = chordOf(c.map((v, p) => v + 0.25 * bs[p]), bs); chords.push(ch); conf.push(ch.conf); eDb.push(10 * Math.log10(e / Math.max(1, en) + 1e-12)); for (let p = 0; p < 12; p++) total[p] += c[p] + bs[p]; }
  const names = chords.map(c => c.name), key = keyOf(total, chords[0]);
  return { kind: "audio", bpm, bpmConf: Math.round(tempoConf * 100) / 100, offsetMs: Math.round(first * 10000) / 10, bars, key, chords: names, chordConf: conf.map(v => Math.round(v * 100) / 100), energyDb: eDb.map(v => Math.round(v * 10) / 10), sections: sectionize(names, eDb, conf), ms: Math.round(performance.now() - t0) }; }

// ---------- MIDI file: tempo, key signature, markers as sections, chords from the notes ----------
function parseMidi(u8){ const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), str = (p, n) => String.fromCharCode(...u8.subarray(p, p + n)); if (str(0, 4) !== "MThd") throw new Error("Not a MIDI file");
  const ntr = dv.getUint16(10), div = dv.getUint16(12), notes = [], metas = []; let p = 8 + dv.getUint32(4);
  for (let t = 0; t < ntr && p < u8.length; t++) { if (str(p, 4) !== "MTrk") break; const len = dv.getUint32(p + 4), end = p + 8 + len; let q = p + 8, tick = 0, run = 0; const on = {};
    const vlq = () => { let v = 0, b; do { b = u8[q++]; v = (v << 7) | (b & 127); } while (b & 128); return v; };
    while (q < end) { tick += vlq(); let st = u8[q]; if (st & 128) { q++; if (st < 0xF0) run = st; } else st = run;
      if (st === 0xFF) { const ty = u8[q++], l = vlq(); metas.push({ tick, ty, d: u8.subarray(q, q + l) }); q += l; }
      else if (st === 0xF0 || st === 0xF7) { q += vlq(); }
      else { const hi = st & 0xF0, ch = st & 15, a = u8[q++], b = (hi === 0xC0 || hi === 0xD0) ? 0 : u8[q++];
        if (hi === 0x90 && b > 0) on[ch * 128 + a] = { tick, v: b }; else if ((hi === 0x80 || hi === 0x90) && on[ch * 128 + a]) { const s = on[ch * 128 + a]; delete on[ch * 128 + a]; if (ch !== 9) notes.push({ n: a, t0: s.tick, t1: tick, v: s.v }); } } }
    p = end; }
  return { div, notes, metas }; }
function analyzeMidi(u8){ const { div, notes, metas } = parseMidi(u8), tm = metas.find(m => m.ty === 0x51), us = tm ? (tm.d[0] << 16) | (tm.d[1] << 8) | tm.d[2] : 500000, bpm = Math.round(60000000 / us * 100) / 100;
  const ts = metas.find(m => m.ty === 0x58), num = ts ? ts.d[0] : 4, barT = div * num, last = Math.max(0, ...notes.map(n => n.t1)), bars = Math.max(1, Math.ceil(last / barT - 0.01));
  const chords = [], conf = [], eDb = [], total = Array(12).fill(0);
  for (let b = 0; b < bars; b++) { const a = b * barT, z = a + barT, c = Array(12).fill(0), bs = Array(12).fill(0); let lo = 128, e = 0;
    for (const n of notes) { const ov = Math.min(z, n.t1) - Math.max(a, n.t0); if (ov <= 0) continue; const w = ov / barT * n.v / 127; c[n.n % 12] += w; e += w; lo = Math.min(lo, n.n); }
    for (const n of notes) if (n.n === lo && Math.min(z, n.t1) > Math.max(a, n.t0)) bs[n.n % 12] += 1;
    const ch = chordOf(c, bs); chords.push(ch); conf.push(ch.conf); eDb.push(10 * Math.log10(e + 1e-6)); for (let p = 0; p < 12; p++) total[p] += c[p]; }
  const ks = metas.find(m => m.ty === 0x59); let key;
  if (ks) { const sf = (ks.d[0] << 24) >> 24, mi = ks.d[1], maj = ((sf * 7) % 12 + 12) % 12; key = { root: mi ? (maj + 9) % 12 : maj, mode: mi ? "minor" : "major", conf: 1 }; key.name = PCN[key.root] + (mi ? "m" : ""); } else key = keyOf(total, chords[0]);
  const names = chords.map(c => c.name), mk = metas.filter(m => m.ty === 0x06 || m.ty === 0x07).map(m => ({ bar: Math.round(m.tick / barT), sec: /^Section:/i.test(new TextDecoder().decode(m.d)), name: new TextDecoder().decode(m.d).replace(/^Section:\s*/i, "").slice(0, 24) })).filter(m => m.bar < bars);
  { const sm = mk.filter(m => m.sec); if (sm.length) mk.splice(0, mk.length, ...sm); else mk.splice(0, mk.length, ...mk.filter(m => !/^Seg \d+:/.test(m.name))); }
  let sections;
  if (mk.length) { const starts = [...new Map(mk.map(m => [m.bar, m])).values()].sort((a, b) => a.bar - b.bar); if (starts[0].bar > 0) starts.unshift({ bar: 0, name: "Intro" });
    sections = starts.map((m, i) => { const b1 = i + 1 < starts.length ? starts[i + 1].bar : bars, e = eDb.slice(m.bar, b1); return { name: m.name, b0: m.bar, bars: b1 - m.bar, chords: periodOf(names.slice(m.bar, b1)).join(" "), energy: 1, eDb: e.reduce((a, v) => a + v, 0) / Math.max(1, e.length), conf: 1 }; });
    const mx = Math.max(...sections.map(s => s.eDb)); for (const s of sections) { s.energy = Math.round(Math.max(0.2, Math.min(1, 1 + (s.eDb - mx) / 12)) * 100) / 100; delete s.eDb; } }
  else sections = sectionize(names, eDb, conf);
  return { kind: "midi", bpm, bpmConf: tm ? 1 : 0.3, offsetMs: 0, bars, key, chords: names, chordConf: conf.map(v => Math.round(v * 100) / 100), energyDb: eDb, sections, markers: mk.length }; }

async function analyzeFile(name, bytes){ const u8 = new Uint8Array(bytes); if (u8.length > 4 && String.fromCharCode(...u8.subarray(0, 4)) === "MThd") { last = { kind: "midi", name, u8 }; return analyzeMidi(u8); }
  let b; try { b = await decodeCtx().decodeAudioData(bytes.slice(0)); } catch (e) { throw new Error(`Couldn't read ${name}: not an audio or MIDI file this browser can decode.`); }
  const m = new Float32Array(b.length); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) m[i] += d[i] / b.numberOfChannels; }
  last = { kind: "audio", name, mono: m, sr: b.sampleRate, isBacking: false }; return analyzeAudioData(m, b.sampleRate); }
function rerun(){ if (!last) return null; if (last.kind === "midi") return analyzeMidi(last.u8); if (last.isBacking) { const m = window.__pro.bkMono(); if (m) last.mono = m; } return analyzeAudioData(last.mono, last.sr); }

// apply: BPM/key only where you haven't set your own; locked sections keep their bars, chords and energy
function apply(sug){ const notes = [], P = window.__pro;
  if (!state.userSet.bpm) { setSetting("bpm", clamp(Math.round(sug.bpm), 60, 180), { auto: true }); notes.push(`BPM ${Math.round(sug.bpm)} (detected ${sug.bpm})`); } else notes.push(`kept your ${state.bpm} BPM (detected ${sug.bpm})`);
  if (!state.userSet.key) { state.keyRoot = sug.key.root; state.mode = sug.key.mode; notes.push(`key ${sug.key.name}`); } else notes.push(`kept your key ${keyLabel(state)} (detected ${sug.key.name})`);
  if (last && last.isBacking && P && P.isBk()) { P.setBk("offsetMs", sug.offsetMs); notes.push(`first downbeat ${sug.offsetMs} ms`); }
  const cur = regions().filter(r => r.sec && r.sec.lock).map(r => ({ b0: r.b0, b1: r.b1, sec: Object.assign({}, r.sec) })), out = [];
  for (const s of sug.sections) { let pieces = [[s.b0, s.b0 + s.bars]]; for (const L of cur) pieces = pieces.flatMap(([a, b]) => b <= L.b0 || a >= L.b1 ? [[a, b]] : [[a, Math.min(b, L.b0)], [Math.max(a, L.b1), b]].filter(([x, y]) => y > x));
    for (const [a, b] of pieces) { const off = a - s.b0, bars = sug.chords.slice(a, b); out.push({ b0: a, sec: { name: s.name, bars: b - a, chords: off || b - a !== s.bars ? periodOf(bars).join(" ") : s.chords, rot: 0, energy: s.energy, lock: false, conf: s.conf } }); } }
  for (const L of cur) out.push({ b0: L.b0, sec: L.sec }); out.sort((a, b) => a.b0 - b.b0);
  const secs = out.map(o => o.sec); state.secSrc = state.src === "band" ? "user" : "upload"; state.an = { bpm: sug.bpm, key: sug.key.name, bars: sug.bars, at: Date.now(), name: last ? last.name : "" };
  setSetting("sections", secs); if (P && P.isBk() && state.bk.whole) { P.fitWhole(); save(); paintSong(); paintTakes(); }
  ensureInstruments(neededInsts()); return notes; }

function paintSug(sug, err){ const el = $("anOut"); if (err) { el.innerHTML = `<span class="bad">${esc(err)}</span>`; return; } if (!sug) return;
  const pct = v => Math.round(v * 100) + "%";
  el.innerHTML = `<p><b>${esc(last ? last.name : "upload")}</b> · ${sug.kind === "midi" ? "MIDI file" : "audio"} · ${sug.bars} bars${sug.ms != null ? ` · analyzed in ${(sug.ms / 1000).toFixed(1)} s` : ""}</p>`
    + `<p>Tempo <b>${sug.bpm} BPM</b> (${pct(sug.bpmConf)})${state.userSet.bpm ? ` · your ${state.bpm} BPM wins` : ""} · Key <b>${esc(sug.key.name)}</b> (${pct(sug.key.conf)})${state.userSet.key ? ` · your ${esc(keyLabel(state))} wins` : ""}${sug.kind === "audio" ? ` · first downbeat <b>${sug.offsetMs} ms</b>` : ""}</p>`
    + `<table class="an-t"><tr><th>Section</th><th>Bars</th><th>Chords (one per bar, repeating)</th><th>Energy</th><th>Confidence</th></tr>` + sug.sections.map(s => `<tr><td>${esc(s.name)}</td><td>${s.b0 + 1}–${s.b0 + s.bars}</td><td>${esc(s.chords)}</td><td>${Math.round(s.energy * 100)}%</td><td>${pct(s.conf)}</td></tr>`).join("") + "</table>"
    + `<div class="row"><button id="anApply">Use these as my song</button><label>then play <select id="anMode"><option value="band">band only</option>${last && last.isBacking ? '<option value="both">band + my upload</option><option value="backing">my upload only</option>' : ""}</select></label></div>`
    + `<p class="hint">Suggestions only until you press the button. Afterwards every section is editable above; lock (🔒) any you've fixed and Re-analyze leaves them alone.</p>`;
  $("anApply").onclick = () => { const mode = $("anMode").value; state.src = mode; if (mode === "band") state.secSrc = "user"; save(); const n = apply(sug); if (window.__pro) window.__pro.paint(); paintSong(); setStatus("Applied: " + n.join(" · ") + `. The band plays all ${state.bars} bars start to finish.`); }; }
async function run(name, bytes, isBacking){ $("anOut").textContent = "Analyzing " + name + "…"; await new Promise(r => setTimeout(r, 30));
  try { let sug; if (isBacking) { const m = window.__pro.bkMono(); last = { kind: "audio", name, mono: m, sr: 48000, isBacking: true }; sug = analyzeAudioData(m, 48000); } else sug = await analyzeFile(name, bytes);
    AN.sug = sug; $("anRe").disabled = false; paintSug(sug); return sug; } catch (e) { paintSug(null, String(e.message || e)); return null; } }
function bindAn(){ $("anBk").onclick = () => { if (!window.__pro || !window.__pro.bkMono()) { paintSug(null, "Upload a backing track first (section 1b), or use “Analyze an audio or MIDI file…”."); return; } run(state.bk.name || "backing", null, true); };
  $("anFileBtn").onclick = () => $("anFile").click(); $("anFile").onchange = async () => { const f = $("anFile").files[0]; if (f) await run(f.name, await f.arrayBuffer(), false); $("anFile").value = ""; };
  $("anRe").onclick = () => { const sug = rerun(); if (!sug) return; AN.sug = sug; paintSug(sug); const n = apply(sug); if (window.__pro) window.__pro.paint(); paintSong(); setStatus("Re-analyzed: " + n.join(" · ") + ". Locked sections were kept as you set them."); }; }
Object.assign(AN, { analyzeAudioData, analyzeMidi, analyzeFile, apply, rerun, run, chordOf, keyOf, last: () => last,
  async analyzeBytes(b64, name){ const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return run(name, u.buffer, false); },
  async analyzeBacking(){ return run(state.bk.name || "backing", null, true); } });
window.__an = AN; bindAn();
})();
