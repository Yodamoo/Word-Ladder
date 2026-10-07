# Procedural soundtrack for the Rungs ad, timed to stage.html's video timeline.
import numpy as np, soundfile as sf, sys
from scipy.signal import butter, lfilter

SR = 48000
DUR = 20.0
out = np.zeros((int(SR * DUR), 2))

def note(f):  # MIDI-ish helper: semitones from A4
    return 440.0 * 2 ** (f / 12)

def add(sig, t, pan=0.0, gain=1.0):
    i = int(t * SR)
    n = min(len(sig), len(out) - i)
    if n <= 0: return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    out[i:i + n, 0] += sig[:n] * l * gain
    out[i:i + n, 1] += sig[:n] * r * gain

def env(n, a, d):  # attack seconds, exponential decay time-constant seconds
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)

def pluck(freq, length=1.2, decay=0.35, bright=0.35):
    # soft mallet: slow-ish attack, gentle 2nd partial, no 3rd, lowpassed so nothing pings
    n = int(length * SR); t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t) + 0.4 * bright * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t / (decay * 0.3))
    b, a = butter(2, 1600 / (SR / 2))
    return lfilter(b, a, s * env(n, 0.018, decay))

def tick():
    n = int(0.03 * SR)
    b, a = butter(2, [2500 / (SR / 2), 7000 / (SR / 2)], btype='band')
    s = lfilter(b, a, np.random.default_rng(len(out)).standard_normal(n))
    return s * env(n, 0.0005, 0.006)

def pad(freqs, length, a=1.5, r=2.0):
    n = int(length * SR); t = np.arange(n) / SR
    s = sum(np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 1.003 * t) for f in freqs) / len(freqs)
    shape = np.minimum(1, t / a) * np.minimum(1, (length - t) / r)
    b, aa = butter(2, 1800 / (SR / 2))
    return lfilter(b, aa, s * np.clip(shape, 0, 1))

# --- timeline (must match stage.html) ---
#   python sound.py out.wav [climb|challenge]
CUT = sys.argv[2] if len(sys.argv) > 2 else 'climb'
if CUT == 'challenge':
    STEPS, TYPE, LAND = [7.0, 8.4, 9.8, 11.2], 0.5, 0.65
else:
    STEPS, TYPE, LAND = [4.4, 6.6, 8.8, 11.0], 0.7, 0.95
SOLVE = STEPS[3] + LAND

# pad: cool (A minor) until the solve, then warm (C major add9) — COLD to WARM
add(pad([note(-12), note(-9), note(-5)], SOLVE + 1.0, a=2.0, r=1.2), 0.0, gain=0.10)                 # A3 C4 E4
add(pad([note(-9), note(-5), note(-2), note(5)], DUR - SOLVE + 0.5, a=0.8, r=2.5), SOLVE - 0.3, gain=0.11)  # C4 E4 G4 D5

# intro: logo draws -> two soft plucks
add(pluck(note(-9)), 0.15, gain=0.30); add(pluck(note(-2)), 0.55, gain=0.26)

# typing ticks + landing notes rising toward the goal
land_notes = [note(-5), note(-2), note(0), note(3)]  # E4 G4 A4 C5
for i, t0 in enumerate(STEPS):
    for k in range(4):
        add(tick(), t0 + k * TYPE / 4 + 0.02, pan=0.15 * (k - 1.5), gain=0.18)
    add(pluck(land_notes[i], decay=0.45), t0 + LAND, gain=0.26)

# solve: cascade chime, one note per tile turning gold
for i, f in enumerate([note(3), note(7), note(10), note(15), note(19)]):  # C5 E5 G5 C6 E6
    add(pluck(f, length=1.6, decay=0.6, bright=0.2), SOLVE + i * 0.12, pan=-0.3 + 0.15 * i, gain=0.19)

# end card: low warm resolve
add(pluck(note(-9), length=2.0, decay=0.9, bright=0.15), 18.2, gain=0.30)
add(pluck(note(-2), length=2.0, decay=0.9, bright=0.15), 18.25, gain=0.22)

# fade the tail, normalise to -3 dBFS
fade = int(0.6 * SR); out[-fade:] *= np.linspace(1, 0, fade)[:, None]
peak = np.abs(out).max(); out *= 10 ** (-3 / 20) / peak
path = sys.argv[1]
sf.write(path, out, SR, subtype='PCM_16')
rms = np.sqrt((out ** 2).mean())
print(f"wrote {path}: peak -3.0 dBFS, rms {20*np.log10(rms):.1f} dBFS, clipped samples {(np.abs(out) >= 1).sum()}")
