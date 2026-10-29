# TakeKit sample credits and licenses

TakeKit plays real recorded instruments only. There are no synth stand-ins.

## Melodic instruments: FluidR3 GM SoundFont (MIT), MP3 renders by gleitz/midi-js-soundfonts (MIT)
These are loaded at runtime from jsDelivr, pinned to commit `044fab8e1456bfafc5776e86dfd6bb8697149aef` (never @main or @gh-pages):
`https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM/<instrument>-mp3/<note>.mp3`
If jsDelivr refuses a file, the app falls back to raw.githubusercontent.com at the same commit.

Instruments used: acoustic_grand_piano, electric_piano_1, drawbar_organ, electric_bass_finger, string_ensemble_1, acoustic_guitar_nylon, flute.
There is one sample every 4 semitones per instrument, so playback pitch shift is at most ±2 semitones. The engine refuses anything beyond ±4.

FluidR3_GM.sf2 by Frank Wen and contributors, released under the MIT License.
midi-js-soundfonts © Benjamin Gleitzman, MIT License: https://github.com/gleitz/midi-js-soundfonts/blob/044fab8e1456bfafc5776e86dfd6bb8697149aef/LICENSE.txt

## Acoustic drum kit: Virtuosity Drums (CC0 1.0), bundled in `samples/drums/`
sfzinstruments/virtuosity_drums @ `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`. License: CC0 1.0 Universal (public domain dedication), https://creativecommons.org/publicdomain/zero/1.0/
- kick, snare, hat: the same files as the PorchBand and FinishKit desk kit
- ghost = Samples/mid/mid_snare_center_vl4
- rim = mid_snare_crossstick_vl10
- ohat = mid_hh_open_vl3_rr1

Drum files are trimmed with a 120 ms fade-out and stored as 48 kHz 16-bit FLAC.

## The demo video's "takes"
The promo video feeds TakeKit four passes built from a real human voice: "Female-vibrato-1.wav" by Beetricks (Wikimedia Commons, CC0 1.0, https://commons.wikimedia.org/wiki/File:Female-vibrato-1.wav), with deliberate flaws added (pitch offsets by resampling, timing, gain, a dropped bar, a clipped bar). No oscillators or generated noise. See `qa/make_demo_takes.py`.
