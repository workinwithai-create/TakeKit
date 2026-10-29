# TakeKit

**Sing pass after pass over your loop. TakeKit scores every bar of every take and builds the best comp, with the seams hidden in the breaths.** Live: **https://takekit.vercel.app**

Set BPM, key and chords. A real-sample band (piano, finger bass, strings, acoustic kit) loops while you press Record. Every full pass of the loop becomes a take: your mic as dry audio, your MIDI keyboard as notes. You can also import takes from your DAW. TakeKit scores each bar of each take for pitch, timing, level and dropouts, then picks the best take per bar. It doesn't jump takes every bar unless it's worth it. Every pick shows its reason, and you can click any cell to override and lock it.

## What it does
- **Your song first:** BPM 60–180, key/mode, chords (one per bar), 4/8/16 bars, band style (Ballad 68, Pop 92, Groove 100, Sparse 80). All saved in your browser.
- **Takes:**
  - One take per loop pass, on two lanes: Vocal/audio (mic) and MIDI.
  - Takes are recorded dry, before the gate, with latency compensation and a nudge slider. Takes live in IndexedDB.
  - Import a WAV/MP3: one file per pass, or one long file split into loop-length passes.
- **Judge (smart, editable):**
  - Per-segment scores (half-bar, bar or 2 bars):
    - pitch: cents off the nearest key/chord note, plus out-of-key notes, via YIN
    - timing: onsets vs the 8th grid
    - level: vs the other takes, plus clipping
    - presence: dropouts or missing notes
  - Weights, "keep whole passes" penalty, crossfade length and seam-search window are all sliders.
- **Comp:**
  - Viterbi auto-comp. Locks always win.
  - Seams move to the quietest point within ±80 ms of the bar line, with a 20 ms equal-power crossfade.
  - A/B compares A (best whole take) and B (the comp) at matched loudness. Solo any take, also matched.
- **Live input:**
  - Input and output device selects (`setSinkId`, with a fallback note).
  - Mic monitored live by default.
  - Noise gate on by default: threshold, attack, hold, release.
  - Trim, meter, clip LED.
- **MIDI:**
  - Web MIDI in with velocity and sustain pedal, plus MIDI out (the band mirrors to your synth).
  - Notes never start the transport.
  - On-screen keys and computer keys (A W S E D F T G Y H U J K) as a fallback.
- **Export:**
  - 48 kHz / 24-bit stereo WAV at the exact loop length: downbeat at sample 0, tail folded in, peak −1.1 dBFS.
  - Type-1 MIDI: tempo, 4/4, band tracks, the MIDI comp, every MIDI take, and a marker per segment naming the take used.
  - Stems ZIP: every band part, the vocal comp, and every raw take.
  - Files are named `takekit-<recipe>-<bpm>bpm-<key>.wav/.mid`.

## Sounds (real samples only)
- FluidR3_GM (MIT), pinned to gleitz/midi-js-soundfonts commit `044fab8e1456bfafc5776e86dfd6bb8697149aef` on jsDelivr, with raw.githubusercontent at the same commit as a fallback.
- Virtuosity Drums acoustic kit (CC0), bundled in `public/samples/drums`.
- See [public/samples/CREDITS.md](public/samples/CREDITS.md).
- If a sample host is blocked, the app names the missing instruments and keeps playback and export off.

## Pricing
- **Free:** loops up to 8 bars, every feature in the app, WAV + MIDI export, 6 takes per lane.
- **TakeKit license: $24 once** (no subscription). Unlocks:
  - 16-bar exports
  - the stems ZIP with every raw take
  - unlimited takes
- **Why one-time:** everything runs in the browser, so there's no server, storage or AI cost per user to recover monthly. It's a focused tool you reach for at the end of a song, not every day. Producers on X push back hard on subscriptions for single-purpose plugins, and $24 sits under the "just buy it" threshold for a vocal utility.
- **Where to sell:** Lemon Squeezy.
  - It issues license keys (the app's gate validates against `storeId`/`productId`) and handles VAT and sales tax as merchant of record.
  - Gumroad also works for the one-time sale.
  - A Bandcamp bundle only makes sense if TakeKit ships with sample packs.
- **Setup:** until `LEMON` in `app.js` has a checkout URL, store ID and product ID, the buy button reads "Checkout opening soon" and keys can't activate.

## Mobile onboarding
1. Open https://takekit.vercel.app and tap **Tap to start audio**. Allow the mic if you want to sing takes.
2. **iPhone:** flip the silent switch off, or use headphones. iOS mutes web audio in silent mode.
3. Use headphones while recording so the band doesn't bleed into your takes.
4. Audio and recording stop when you switch tabs or lock the phone. A pass you're in the middle of is dropped; full passes stay.

## Run locally
- Static site: `npm run build`, then serve `dist/`.
- There's no auth, no database and no env vars.

## Tests
- `python3 qa/s9.py <url> out.json` runs the Playwright acceptance suite (AUDIO-ENGINE-RULES §9 plus product checks).
- `python3 qa/make_demo_takes.py` regenerates the demo takes: 4 passes of a real human voice: "Female-vibrato-1.wav" by Beetricks (Wikimedia Commons, CC0 1.0, https://commons.wikimedia.org/wiki/File:Female-vibrato-1.wav) singing a melody, with planted flaws (sharp, flat, late, missing, quiet, clipped).
- Results are in [ACCEPTANCE.md](ACCEPTANCE.md).

© 2026 WorkinWithAI. Code under the MIT license (see LICENSE). Samples under their own licenses.
