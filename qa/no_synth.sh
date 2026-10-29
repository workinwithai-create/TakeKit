#!/usr/bin/env bash
# Proves TakeKit has no synthesized sound sources: no oscillators, no noise buffers, no generated tones.
# Usage: qa/no_synth.sh [live-url]
set -u; fail=0
pat='createOscillator|OscillatorNode|PeriodicWave|createPeriodicWave|createConstantSource|ConstantSourceNode|Math\.random'
echo "== repo (app.js, pro.js, analyze.js, index.html) =="; if rg -n "$pat" app.js pro.js analyze.js index.html; then fail=1; else echo "none"; fi
echo "== every createBuffer( in app.js (must only be filled from recorded takes) =="; rg -n "createBuffer\(" app.js pro.js
if [ -n "${1:-}" ]; then echo "== live $1/app.js =="; if (curl -s "$1/app.js"; curl -s "$1/pro.js"; curl -s "$1/analyze.js") | rg -n "$pat"; then fail=1; else echo "none"; fi; fi
[ $fail = 0 ] && echo "PASS: no synth sound sources" || echo "FAIL"; exit $fail
