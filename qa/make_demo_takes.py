"""Build the demo 'takes' for TakeKit's QA and promo video from a REAL recorded human voice.

Source: "Female-vibrato-1.wav" by Beetricks, Wikimedia Commons, CC0 1.0 (public domain dedication)
  https://commons.wikimedia.org/wiki/File:Female-vibrato-1.wav
  sha256 b023f0094e62f8c3b7c94fd649261b454923e030a0beb42ca32eaf31f2b61d10
A woman sustaining a sung vowel in chest voice with natural vibrato, gliding C#4 -> F#3.
Each melody note is a slice of a steady region of that recording, resampled by at most a few
semitones to the target pitch. No oscillators, no generated noise: every sample is the recording.

Four 8-bar passes at 92 BPM in A minor (chords Am F C G) with deliberate flaws so auto-comp has work:
  pass 1: bars 2 and 5 are +45 cents sharp
  pass 2: bar 3 is 120 ms late, bar 7 is missing
  pass 3: bars 1 and 6 are 14 dB quiet
  pass 4: bar 4 is 50 cents flat, bar 8 is clipped
"""
import subprocess, urllib.request, os, hashlib, numpy as np, wave
URL = "https://upload.wikimedia.org/wikipedia/commons/c/c3/Female-vibrato-1.wav"
SHA256 = "b023f0094e62f8c3b7c94fd649261b454923e030a0beb42ca32eaf31f2b61d10"
SR, BPM, BARS = 48000, 92, 8
L = round(BARS * 4 * 60 / BPM * SR); BEAT = 60 / BPM
# same tune as before, sung an octave lower (TakeKit judges pitch against key/chord notes in any octave)
MEL = [[57,60,64,60],[57,53,57,60],[55,52,55,60],[59,62,59,55],[64,60,57,52],[53,57,60,57],[52,55,60,64],[62,59,55,None]]
REGIONS = [(0.80, 2.60), (5.10, 6.20), (7.10, 8.50)]  # steady sustained stretches of the recording (seconds)
d = os.path.dirname(os.path.abspath(__file__)); cache = os.path.join(d, "out"); os.makedirs(cache, exist_ok=True)
def load():
    p = os.path.join(cache, "Female-vibrato-1.wav")
    if not os.path.exists(p):
        req = urllib.request.Request(URL, headers={"User-Agent": "TakeKitQA/1.0 (github.com/workinwithai-create/TakeKit)"})
        open(p, "wb").write(urllib.request.urlopen(req).read())
    assert hashlib.sha256(open(p, "rb").read()).hexdigest() == SHA256, "source recording changed"
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", p, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy(); return x / np.abs(x).max()
def midi_of(s):  # median autocorrelation pitch of a slice
    out = []
    for i in range(0, len(s) - 4096, 1024):
        w = s[i:i + 4096] - s[i:i + 4096].mean(); ac = np.correlate(w, w, "full")[4095:]; lo, hi = SR // 700, SR // 120
        out.append(69 + 12 * np.log2(SR / (lo + np.argmax(ac[lo:hi])) / 440))
    return float(np.median(out))
def shift(x, semis):  # resample = pitch shift of the recording
    r = 2 ** (semis / 12); return np.interp(np.arange(0, len(x) - 1, r), np.arange(len(x)), x).astype(np.float32)
VOX = load()
REG = [(VOX[int(a * SR):int(b * SR)], midi_of(VOX[int(a * SR):int(b * SR)])) for a, b in REGIONS]
def note(n, cents, rng, dur):
    seg, m = min(REG, key=lambda r: abs(r[1] - n)); semis = n - m + cents / 100
    need = int(dur * 2 ** (semis / 12)) + 64; st = int(rng.uniform(0, max(1, len(seg) - need)))
    s = shift(seg[st:st + need], semis)[:dur].copy(); s /= np.abs(s).max() + 1e-9; return s
def pass_audio(k, rng):
    out = np.zeros(L, np.float32)
    for b, bar in enumerate(MEL):
        for q, n in enumerate(bar):
            if n is None or (k == 2 and b == 6): continue           # pass 2: bar 7 missing
            cents = rng.uniform(-4, 4); late = rng.uniform(-0.006, 0.006); g = 0.42 * rng.uniform(0.93, 1.07)
            if k == 1 and b in (1, 4): cents += 45
            if k == 4 and b == 3: cents -= 50
            if k == 2 and b == 2: late += 0.120
            if k == 3 and b in (0, 5): g *= 10 ** (-14 / 20)
            if k == 4 and b == 7: g *= 6
            dur = int(0.86 * BEAT * SR); s = note(n, cents, rng, dur)
            fi, fo = int(0.012 * SR), int(0.05 * SR); s[:fi] *= np.linspace(0, 1, fi); s[-fo:] *= np.linspace(1, 0, fo)
            t0 = max(0, int(round(((b * 4 + q) * BEAT + late) * SR))); seg = s[:max(0, min(len(s), L - t0))]; out[t0:t0 + len(seg)] += g * seg
    return np.clip(out, -1, 1)  # no added noise: the gaps are digital silence, the notes are the recording
def write(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
if __name__ == "__main__":
    rng = np.random.default_rng(28)
    print("source regions (midi):", [round(m, 2) for _, m in REG])
    passes = [pass_audio(k, rng) for k in (1, 2, 3, 4)]
    write(os.path.join(d, "demo-takes-92bpm-Am.wav"), np.concatenate(passes))
    # the same file doubles as the fake mic for Playwright (--use-file-for-fake-audio-capture)
    print("wrote", len(passes), "passes of", L, "samples")
