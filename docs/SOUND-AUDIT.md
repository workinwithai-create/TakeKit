# TakeKit sound-source audit (2026-10-28)

Request: "Get rid of those synth sounds and use real sampled audio."

Result: TakeKit has no synthesized sound sources at all, in the repo or on production. Every sound it makes comes from a real recording.

| Sound | What plays it | Source |
|---|---|---|
| Band: piano, EP, organ, finger bass, strings, nylon, flute | FluidR3 GM recorded samples, one every 4 semitones, shift ≤ ±2 st (capped at ±4) | gleitz/midi-js-soundfonts @044fab8e (MIT) |
| Drums: kick, snare, soft snare, rim, closed/open hat | Virtuosity Drums recordings, bundled in public/samples/drums | sfzinstruments/virtuosity_drums @9f04cf9a (CC0) |
| MIDI-in / computer-keys playing and MIDI takes | The chosen FluidR3 instrument (default acoustic grand piano) | same as above |
| Vocal takes, comp, A/B | Your own mic recordings (or imported audio) | user audio |
| Mic monitoring (noise gate) | Your live mic | user audio |
| Metronome / count-in | Doesn't exist. The band's acoustic-kit rim and hats are the time reference | n/a |
| FX | No FX voices exist. Crossfades are gain envelopes on recorded audio | n/a |

The code's two `createBuffer(` calls only hold the rendered comp of the user's recorded takes; neither one generates sound.
The only generated noise in the repo is in `qa/make_demo_takes.py`: a −66 dBFS "room" floor mixed under the FluidR3 `voice_oohs` test takes, which act as a fake mic for automated QA. It's a test fixture, the app never ships or plays it, and it's quieter than a real room.

Proof: run `qa/no_synth.sh https://takekit.vercel.app`. It searches app.js, index.html and the live bundle for createOscillator, OscillatorNode, PeriodicWave, ConstantSource and Math.random.
