# TakeKit acceptance (AUDIO-ENGINE-RULES §9 + product checks)

Run on 2026-10-28 with `python3 qa/s9.py https://takekit.vercel.app/ qa/prod.json` (Playwright Chromium, fake mic = `qa/demo-takes-92bpm-Am.wav`, mocked Web MIDI port).
- Production deploy: commit 2641999.
- Raw results: [docs/acceptance-prod.json](docs/acceptance-prod.json). The local run is in [docs/acceptance-local.json](docs/acceptance-local.json).
- Every check below passed on production and locally.

## The seven §9 checks
| # | Check | Result on https://takekit.vercel.app |
|---|---|---|
| 1 | Exact length, downbeat at 0, peak | **PASS**. 92 BPM × 8 bars = **1,001,739** frames (expected `round(8*4*60/92*48000)`), 48 kHz / 24-bit / stereo. First transient at 0.10 ms (drums-only 0.35 ms). Peak −1.10 dBFS. The vocal comp is present in the mix (−12.7 dBFS RMS). Also exact at 60/4, 137/8 and 180/16, all peaks ≤ −1 dBFS. |
| 2 | Loops 4× in a DAW | **PASS**. 4× tile = 4,006,956 frames, drift 0 samples. Kick onsets on all 32 bar lines sit within 1 sample of each other. Seam sample step is 0.0048 (the file's p99.99 step is 0.100). Tail fold vs a continuous 16-bar render within 10 ms of the seam: 8.7e-7 relative. Repeat renders are identical (determinism). |
| 3 | Hidden tab 30 s while recording | **PASS**. Not playing and not recording on return. 0 steps scheduled while hidden, 0 active voices, 0 takes created from the partial pass. The status says why it stopped. |
| 4 | Live changes within one bar, no restart | **PASS** (one bar = 2.609 s at 92 BPM). Each change was heard after: lock bar 1 to "demo p1" 2.29 s (comp changed p4 → p1); A/B to best take 1.87 s; mute drums 0.12 s; band → Groove 0.69 s; key → D 0.24 s; BPM → 120 0.13 s. Still playing afterwards. |
| 5 | Blocked sample host | **PASS**. With jsDelivr and raw.githubusercontent aborted, the samples line reads "Missing instruments: Piano (FluidR3 acoustic grand), Finger bass (FluidR3 electric bass), String ensemble (FluidR3)…" with a Retry button. Play names the same instruments and stays stopped; export throws the same names. Sample URLs are all pinned to commit 044fab8e (87 requests); the 12 kit requests are bundled same-origin. |
| 6 | Longest held note at the slowest preset tempo | **PASS**. In Ballad at 68 BPM, strings are held a full bar (3.53 s) with looped sustain. RMS at 92–99 % of the note is 0.96× RMS at 30–50 %. |
| 7 | Code greps | **PASS**. 0 `@main`/`@gh-pages`, FluidR3 SHA pinned (40 hex). 0 `Math.random` anywhere. No setTimeout note scheduling. `LOOKAHEAD_MS = 25`, `SCHEDULE_AHEAD = 0.12`. No compressor in the export path. MAX_SHIFT = 4. No auth/db. iOS silent-switch note present. Every voice name matches its sample folder. |

## Product checks (also PASS on prod)
- **Auto comp on the demo takes.** These are 4 passes of a sampled voice with planted flaws:
  - p1: bars 2 and 5 sharp +45¢
  - p2: bar 3 late 120 ms, bar 7 missing
  - p3: bars 1 and 6 at −14 dB
  - p4: bar 4 flat −50¢, bar 8 clipped
  - Every planted flaw was detected and named: "+48¢ sharp", "+40¢ sharp", "late 124 ms", "dropout", "−14 dB quiet", "−42¢ flat", "clipped".
  - The comp is p4 · p3 · p3 · p3 · p3 · p1 · p1 · p1. It uses none of the flawed bars and switches takes only twice.
- **Live recording:** fake mic plus mock MIDI keyboard, 4 bars at 180 BPM, two passes. Result: 2 audio takes of exactly 5.333 s and 2 MIDI takes of 16 notes each, with velocities kept.
- **MIDI file:** type 1, 180 BPM, 4/4, length 5.333 s. Tracks: the band, the MIDI comp, and one per MIDI take. Markers on each segment name the take used.
- **Stems ZIP** (unlock simulated in memory for the test): mix, MIDI, 5 band parts, vocal comp and 4 raw takes. Every WAV is 1,001,739 frames.
- **MIDI in:** velocities 30/120/100 heard as sent. With no pedal, note-off frees the voice; with CC64 down it holds, and pedal up releases it. 0xFA/0xF8 and notes never start the transport. MIDI out mirrors the band on channels 1–6 and 10; Stop sends All Notes Off on all 16 channels and goes silent in 19 ms.
- **A/B:** the best whole take vs the comp, with makeup 1.163. The difference after makeup is 0.00 dB.
- **Audio I/O:**
  - Input and output selects; setSinkId switched the output.
  - Mic monitor is on by default.
  - The gate is on by default: −50 dB, 2 ms attack, 60 ms hold, 120 ms release.
  - The meter moves.
- **Persistence:** settings, chords and locks survive a reload, and audio takes reload from IndexedDB.
- **License:** with empty config, the buy button reads "Checkout opening soon · $24 once" and activation is refused with a clear message. Stems and 16-bar exports are gated. Free downloads are named `takekit-pop-92bpm-Am.wav` / `.mid`.
- **Mobile:** iPhone 13 and Pixel 7 fit 390/412 px with no horizontal overflow. The audio context runs, the scheduler runs, and the iOS silent-switch note shows on the iPhone.
- **No page errors.**

## Honest limits
- The scorer knows the key and chords but not your melody. A wrong note that is still in the key/chord isn't flagged as off-pitch.
- Timing is judged against the 8th-note grid, so deliberately laid-back phrasing scores lower. Lower the Timing weight or lock the bar.
- The headless test mic runs at 44.1 kHz and has no real acoustic latency. Real-world latency comes from `outputLatency`, the track's reported latency and the nudge slider; check it with a clap test on your interface.
