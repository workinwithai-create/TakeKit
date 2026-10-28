"""Build the demo 'takes' for TakeKit's QA and promo video.

Four 8-bar passes at 92 BPM in A minor (chords Am F C G), sung by the FluidR3 GM voice_oohs sample
(MIT, pinned commit), with deliberate flaws so the auto-comp has something to fix:
  pass 1: bars 2 and 5 are +45 cents sharp
  pass 2: bar 3 is 120 ms late, bar 7 is missing
  pass 3: bars 1 and 6 are 14 dB quiet
  pass 4: bar 4 is 50 cents flat, bar 8 is clipped
This is a sampled choir 'ooh', not a human singer; the captions say so.
"""
import subprocess, urllib.request, os, numpy as np, wave, random
SHA = "044fab8e1456bfafc5776e86dfd6bb8697149aef"
URL = f"https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@{SHA}/FluidR3_GM/voice_oohs-mp3/{{}}.mp3"
NAMES = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"]
SR, BPM, BARS = 48000, 92, 8
L = round(BARS * 4 * 60 / BPM * SR); BEAT = 60 / BPM
MEL = [[69,72,76,72],[69,65,69,72],[67,64,67,72],[71,74,71,67],[76,72,69,64],[65,69,72,69],[64,67,72,76],[74,71,67,None]]
cache = os.path.join(os.path.dirname(__file__), "out", "oohs"); os.makedirs(cache, exist_ok=True)
def nn(n): return NAMES[n % 12] + str(n // 12 - 1)
def sample(n):
    p = os.path.join(cache, nn(n) + ".mp3")
    if not os.path.exists(p): urllib.request.urlretrieve(URL.format(nn(n)), p)
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", p, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy(); pk = np.abs(x).max(); i = int(np.argmax(np.abs(x) > 0.1 * pk)); return x[max(0, i - 240):] / pk
def stretch(x, cents):  # resample = pitch shift (and tiny length change), fine for a few cents
    r = 2 ** (cents / 1200); idx = np.arange(0, len(x) - 1, r); return np.interp(idx, np.arange(len(x)), x).astype(np.float32)
def pass_audio(k, rng):
    out = np.zeros(L, np.float32)
    for b, bar in enumerate(MEL):
        for q, n in enumerate(bar):
            if n is None: continue
            if k == 2 and b == 6: continue                       # pass 2: bar 7 missing
            cents = rng.uniform(-4, 4); late = rng.uniform(-0.006, 0.006); g = 0.42 * rng.uniform(0.93, 1.07)
            if k == 1 and b in (1, 4): cents += 45
            if k == 4 and b == 3: cents -= 50
            if k == 2 and b == 2: late += 0.120
            if k == 3 and b in (0, 5): g *= 10 ** (-14 / 20)
            if k == 4 and b == 7: g *= 6
            s = stretch(sample(n), cents); dur = int(0.86 * BEAT * SR); s = s[:dur].copy()
            fo = int(0.04 * SR); s[-fo:] *= np.linspace(1, 0, fo); s[:96] *= np.linspace(0, 1, 96)
            t0 = max(0, int(round(((b * 4 + q) * BEAT + late) * SR))); seg = s[: max(0, min(len(s), L - t0))]; out[t0:t0 + len(seg)] += g * seg
    out += rng.normal(0, 10 ** (-66 / 20), L).astype(np.float32)  # a quiet room
    return np.clip(out, -1, 1)
def write(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
if __name__ == "__main__":
    rng = np.random.default_rng(28)
    passes = [pass_audio(k, rng) for k in (1, 2, 3, 4)]
    d = os.path.dirname(__file__); write(os.path.join(d, "demo-takes-92bpm-Am.wav"), np.concatenate(passes))
    # the same file doubles as the fake mic for Playwright (--use-file-for-fake-audio-capture)
    print("wrote", len(passes), "passes of", L, "samples")
