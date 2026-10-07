/*
 * harmony.js - the music brain (JavaScript port of the Python harmony engine).
 *
 *  - measures the recording's tuning (not every song is tuned to A440)
 *  - learns the song's scale from the notes the singer actually sings
 *  - finds the chords the instruments play
 *  - splits the melody into notes and phrases
 *  - picks a harmony line per phrase (dynamic programming): stays strictly in
 *    the scale, prefers chord notes, can hold notes, move in parallel, or join
 *    the lead in unison at phrase starts/ends
 *  - builds the harmony pitch curve (clean notes + a little of the singer's
 *    vibrato) and renders it with PSOLA
 */
(function (root) {
  "use strict";
  const DSP = root.DSP || (typeof require !== "undefined" ? require("./dsp.js") : null);
  const H = {};

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MODE_STEPS = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  };
  const INTERVALS = { third_above: 2, third_below: -2, fifth_above: 4, fourth_below: -3,
                      sixth_below: -5, octave_above: 7, octave_below: -7 };
  const INTERVAL_LABELS = { third_above: "3rd above", third_below: "3rd below", fifth_above: "5th above",
                            fourth_below: "4th below", sixth_below: "6th below",
                            octave_above: "Octave above", octave_below: "Octave below" };
  const STYLES = { natural: "Backing vocals (natural)",
                   twin: "Twin lead (mostly parallel, merges to unison)",
                   scale: "Strict scale (always parallel)" };
  const UNISON_LEVELS = { rarely: "Rarely", sometimes: "Sometimes", often: "Often" };
  const DELAY_MS = { third_above: 18, fifth_above: 26, octave_above: 22, third_below: 22,
                     fourth_below: 14, sixth_below: 28, octave_below: 20 };
  const PAN = { third_above: -0.35, fifth_above: 0.45, octave_above: 0.2, third_below: 0.35,
                fourth_below: -0.45, sixth_below: -0.2, octave_below: 0 };
  const MAJ_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const FRAME_MS = 5;

  Object.assign(H, { NOTE_NAMES, MODE_STEPS, INTERVALS, INTERVAL_LABELS, STYLES, UNISON_LEVELS,
                     DELAY_MS, PAN, FRAME_MS });

  // ------------------------------------------------------------ keys & scales
  const keyName = (tonic, mode) => `${NOTE_NAMES[tonic]} ${mode}`;
  function parseKey(s) {
    const i = s.indexOf(" ");
    const name = s.slice(0, i), mode = s.slice(i + 1).toLowerCase();
    if (!(mode in MODE_STEPS) || NOTE_NAMES.indexOf(name) < 0) throw new Error("Unknown key: " + s);
    return [NOTE_NAMES.indexOf(name), mode];
  }
  const allKeyNames = () => Object.keys(MODE_STEPS).flatMap((m) => NOTE_NAMES.map((n) => `${n} ${m}`));
  const scalePcs = (tonic, mode) => new Set(MODE_STEPS[mode].map((s) => (tonic + s) % 12));
  function scaleNotes(tonic, mode) {
    const pcs = scalePcs(tonic, mode), out = [];
    for (let n = 0; n < 128; n++) if (pcs.has(n % 12)) out.push(n);
    return out;
  }
  Object.assign(H, { keyName, parseKey, allKeyNames });

  function corr(a, b) {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db + 1e-12);
  }
  const roll = (arr, k) => arr.map((_, i) => arr[(i - k + 12 * 10) % 12]);

  // ------------------------------------------------------------ chords
  // 24 chords: 0-11 major on C..B, 12-23 minor on C..B, 24 = no chord
  function chordPcs(c) {
    const root = c % 12, third = c < 12 ? 4 : 3;
    return [root, (root + third) % 12, (root + 7) % 12];
  }
  const chordName = (c) => (c < 0 || c >= 24 ? "N" : NOTE_NAMES[c % 12] + (c < 12 ? "" : "m"));
  Object.assign(H, { chordPcs, chordName });

  /** Chord label per chroma frame (Viterbi smoothing, prefers chords in key). */
  function detectChords(pack, tonic, mode) {
    const { chroma, energy, secPerFrame } = pack;
    const N = energy.length;
    const T = [];
    for (let c = 0; c < 24; c++) {
      const v = new Float64Array(12), [r, t, f] = chordPcs(c);
      v[r] = 1; v[t] = 0.8; v[f] = 0.8;
      const norm = Math.hypot(...v);
      T.push(v.map((x) => x / norm));
    }
    const scale = scalePcs(tonic, mode);
    const prior = T.map((_, c) => (chordPcs(c).every((p) => scale.has(p)) ? 0 : -0.08));
    const sortedE = Float32Array.from(energy).sort();
    const loud = sortedE[Math.floor(N * 0.95)] || 0;
    const beta = 12, sw = 4, S = 25;
    let dp = new Float64Array(S);
    const back = Array.from({ length: N }, () => new Int16Array(S));
    const emit = new Float64Array(S);
    for (let t = 0; t < N; t++) {
      let cn = 0;
      for (let p = 0; p < 12; p++) cn += chroma[p][t] ** 2;
      cn = Math.sqrt(cn) + 1e-9;
      for (let c = 0; c < 24; c++) {
        let s = 0;
        for (let p = 0; p < 12; p++) s += T[c][p] * (chroma[p][t] / cn);
        emit[c] = beta * (s + prior[c]);
      }
      emit[24] = beta * (energy[t] < 0.05 * (loud + 1e-9) ? 1 : 0);
      if (t === 0) { dp.set(emit); continue; }
      let bp = 0;
      for (let c = 1; c < S; c++) if (dp[c] > dp[bp]) bp = c;
      const move = dp[bp] - sw;
      const nd = new Float64Array(S);
      for (let c = 0; c < S; c++) {
        if (move > dp[c]) { nd[c] = move + emit[c]; back[t][c] = bp; }
        else { nd[c] = dp[c] + emit[c]; back[t][c] = c; }
      }
      dp = nd;
    }
    const labels = new Int16Array(N);
    let best = 0;
    for (let c = 1; c < S; c++) if (dp[c] > dp[best]) best = c;
    labels[N - 1] = best;
    for (let t = N - 1; t > 0; t--) labels[t - 1] = back[t][labels[t]];
    return { labels, secPerFrame };
  }
  H.detectChords = detectChords;

  function chordsAt(chords, nFrames) {
    const out = new Int16Array(nFrames);
    const L = chords.labels.length;
    for (let i = 0; i < nFrames; i++) {
      const idx = Math.min(L - 1, Math.max(0, Math.floor((i * FRAME_MS) / 1000 / chords.secPerFrame)));
      out[i] = chords.labels[idx];
    }
    return out;
  }

  // ------------------------------------------------------------ tuning & scale
  function estimateTuning(f0) {
    let sx = 0, sy = 0, c = 0;
    for (const f of f0) {
      if (!(f > 0)) continue;
      const m = 69 + 12 * Math.log2(f / 440);
      const dev = m - Math.round(m);
      sx += Math.cos(2 * Math.PI * dev); sy += Math.sin(2 * Math.PI * dev); c++;
    }
    return c < 50 ? 0 : Math.atan2(sy, sx) / (2 * Math.PI);
  }

  function noteHistogram(f0, tuning) {
    const h = new Array(12).fill(0);
    for (const f of f0) {
      if (!(f > 0)) continue;
      const m = 69 + 12 * Math.log2(f / 440) - tuning, r = Math.round(m);
      if (Math.abs(m - r) < 0.3) h[((r % 12) + 12) % 12]++;
    }
    const s = h.reduce((a, b) => a + b, 0) + 1e-9;
    return h.map((v) => v / s);
  }

  function detectScale(f0, tuning, instChroma) {
    const hv = noteHistogram(f0, tuning);
    let w = hv.slice();
    if (instChroma) {
      const ch = instChroma.map((row) => row.reduce((a, b) => a + b, 0) / row.length);
      const s = ch.reduce((a, b) => a + b, 0) + 1e-9;
      w = hv.map((v, i) => 0.65 * v + (0.35 * ch[i]) / s);
    }
    const wsum = w.reduce((a, b) => a + b, 0);
    let best = null;
    for (const mode of ["major", "harmonic minor"]) {
      for (let tonic = 0; tonic < 12; tonic++) {
        const pcs = scalePcs(tonic, mode);
        let inside = 0;
        pcs.forEach((p) => (inside += w[p]));
        const score = inside - (wsum - inside) - (mode !== "major" ? 0.02 : 0);
        if (!best || score > best[0]) best = [score, tonic, mode];
      }
    }
    let [, tonic, mode] = best;
    if (mode === "major") {
      const rel = (tonic + 9) % 12;
      if (corr(w, roll(MIN_PROFILE, rel)) > corr(w, roll(MAJ_PROFILE, tonic))) { tonic = rel; mode = "minor"; }
    }
    let conf = 0;
    scalePcs(tonic, mode).forEach((p) => (conf += hv[p]));
    return { tonic, mode, confidence: conf };
  }

  /**
   * Analyse a separated song.
   * vocal, inst: mono Float32Array at sr.  Returns {f0, tuning, key, confidence, chords}.
   */
  function analyseSong(vocal, inst, sr, onProgress = () => {}) {
    const nFrames = Math.floor((vocal.length / sr) * 1000 / FRAME_MS) + 1;
    onProgress(0.05);
    const v16 = DSP.resample(vocal, sr, 16000);
    onProgress(0.25);
    const f0 = DSP.yinPitch(v16, 16000, nFrames, { frameMs: FRAME_MS });
    onProgress(0.6);
    const tuning = estimateTuning(f0);
    const i11 = DSP.resample(inst, sr, 11025);
    onProgress(0.8);
    const pack = DSP.chroma(i11, 11025, tuning);
    const sc = detectScale(f0, tuning, pack.chroma);
    const chords = detectChords(pack, sc.tonic, sc.mode);
    onProgress(1);
    return { f0, tuning, key: keyName(sc.tonic, sc.mode), confidence: sc.confidence, chords, chromaPack: pack };
  }
  Object.assign(H, { estimateTuning, detectScale, analyseSong });

  // ------------------------------------------------------------ notes & phrases
  function segmentNotes(midi, voiced) {
    const n = midi.length, k = 13; // ~60 ms median (odd)
    const vIdx = [];
    for (let i = 0; i < n; i++) if (voiced[i]) vIdx.push(i);
    const vm = Float32Array.from(vIdx.map((i) => midi[i]));
    const sm = DSP.medianFilter(vm, k);
    const q = new Int32Array(n).fill(-1);
    vIdx.forEach((i, j) => (q[i] = Math.round(sm[j])));
    const minLen = Math.round(90 / FRAME_MS);
    const segs = [];
    for (let i = 0; i < n;) {
      let j = i; while (j < n && q[j] === q[i]) j++;
      segs.push([i, j, q[i]]); i = j;
    }
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s[2] >= 0 && last[2] >= 0 && s[1] - s[0] < minLen) last[1] = s[1];
      else merged.push(s);
    }
    const out = [];
    for (let i = 0; i < merged.length; i++) {
      const s = merged[i];
      if (s[2] >= 0 && s[1] - s[0] < minLen && i + 1 < merged.length && merged[i + 1][2] >= 0) {
        merged[i + 1][0] = s[0]; continue;
      }
      out.push(s);
    }
    return out;
  }

  const nearestIdx = (note, sn) => {
    let b = 0, bd = Infinity;
    for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - note); if (d < bd) { bd = d; b = i; } }
    return b;
  };
  const diatonicTarget = (note, sn, steps) =>
    sn[Math.max(0, Math.min(sn.length - 1, nearestIdx(note, sn) + steps))];

  // ------------------------------------------------------------ harmony line
  const PART_RULES = {
    third_above:  { side: +1, pref: [3, 4], ok: [5, 7, 8, 9] },
    fifth_above:  { side: +1, pref: [7], ok: [3, 4, 5, 8, 9] },
    third_below:  { side: -1, pref: [3, 4], ok: [5, 7, 8, 9] },
    fourth_below: { side: -1, pref: [5], ok: [3, 4, 7] },
    sixth_below:  { side: -1, pref: [8, 9], ok: [3, 4, 5, 7] },
  };
  const CLASH = [1, 2, 6, 10, 11];
  const STYLE_WEIGHTS = {
    natural: { uni: 2.2, ok: 1.1, hold: -0.3, step: 0.0, leap: 0.9, par: 0.0, nct: 1.1 },
    twin:    { uni: 3.0, ok: 1.4, hold: 0.3, step: 0.1, leap: 0.6, par: -0.8, nct: 0.9 },
  };
  const UNISON_FACTOR = { rarely: 2.0, sometimes: 1.0, often: 0.55 };
  const EDGE_UNISON = {
    natural: { rarely: [2.0, 1.4], sometimes: [1.4, -0.2], often: [-0.4, -0.9] },
    twin:    { rarely: [2.5, 1.5], sometimes: [1.5, -1.0], often: [-1.0, -1.4] },
  };

  function chooseLine(notes, part, chords, sn, pcs, style, unison) {
    const R = PART_RULES[part], W = STYLE_WEIGHTS[style];
    if (!(unison in UNISON_FACTOR)) unison = "sometimes";
    const uf = UNISON_FACTOR[unison], n = notes.length;
    const cands = [], costs = [];
    for (let i = 0; i < n; i++) {
      const nt = notes[i];
      const ref = sn[nearestIdx(nt.note, sn)];
      const lo = R.side > 0 ? ref : ref - 12, hi = R.side > 0 ? ref + 12 : ref;
      const ch = chords[i], cp = ch < 24 ? chordPcs(ch) : null;
      const cs = [], cc = [];
      for (let h = lo; h <= hi; h++) {
        if (!pcs.has(((h % 12) + 12) % 12)) continue;       // never leave the scale
        const d = Math.abs(h - ref);
        let c;
        if (d === 0) {
          c = W.uni * uf;
          if (nt.first || nt.last) {
            const [fc, lc] = EDGE_UNISON[style][unison];
            c = Math.min(nt.first ? fc : 9, nt.last ? lc : 9);
            if (n === 1) c = Math.max(c, 1.0);
          }
          if (nt.durMs < 180) c = Math.min(c, c * 0.35);
        } else if (R.pref.includes(d)) c = 0;
        else if (R.ok.includes(d)) c = W.ok;
        else if (d === 12) c = 1.8;
        else if (CLASH.includes(d)) c = 8;
        else c = 3;
        if (d !== 0 && cp && !cp.includes(((h % 12) + 12) % 12)) c += W.nct * (nt.durMs < 180 ? 0.4 : 1);
        cs.push(h); cc.push(c);
      }
      cands.push(cs); costs.push(cc);
    }
    let total = costs[0].slice();
    const back = [];
    for (let i = 1; i < n; i++) {
      const P = cands[i - 1], C = cands[i];
      const mp = notes[i - 1].note, mc = notes[i].note;
      const ip = nearestIdx(mp, sn), ic = nearestIdx(mc, sn);
      const bk = new Int32Array(C.length), nt = new Array(C.length);
      for (let b = 0; b < C.length; b++) {
        let bestV = Infinity, bestA = 0;
        for (let a = 0; a < P.length; a++) {
          const jump = Math.abs(C[b] - P[a]);
          let t = jump === 0 ? W.hold : jump <= 2 ? W.step : jump <= 5 ? W.step + 0.3 : W.leap + 0.1 * jump;
          if (mp !== mc) {
            const sp = nearestIdx(P[a], sn) - ip, sc = nearestIdx(C[b], sn) - ic;
            if (sp === sc && sp !== 0) t += W.par;
            const dpv = Math.abs(P[a] - mp), dcv = Math.abs(C[b] - mc);
            if (dpv === dcv && (dcv === 7 || dcv === 12)) t += 0.6;
          }
          const v = total[a] + t;
          if (v < bestV) { bestV = v; bestA = a; }
        }
        bk[b] = bestA; nt[b] = bestV + costs[i][b];
      }
      back.push(bk); total = nt;
    }
    let idx = 0;
    for (let k = 1; k < total.length; k++) if (total[k] < total[idx]) idx = k;
    const path = [idx];
    for (let i = back.length - 1; i >= 0; i--) path.push(back[i][path[path.length - 1]]);
    path.reverse();
    return path.map((k, i) => cands[i][k]);
  }

  /** Harmony pitch curve (Hz per frame, 0 = unvoiced) for one part. */
  function harmonyPitchCurve(f0, tuning, tonic, mode, interval, style, chordFrames, unison) {
    const steps = INTERVALS[interval];
    const n = f0.length;
    const voiced = new Uint8Array(n), midi = new Float64Array(n);
    for (let i = 0; i < n; i++) if (f0[i] > 0) { voiced[i] = 1; midi[i] = 69 + 12 * Math.log2(f0[i] / 440) - tuning; }
    const out = new Float32Array(n);
    if (!voiced.some((v) => v)) return out;
    const sn = scaleNotes(tonic, mode), pcs = scalePcs(tonic, mode);

    let segs = segmentNotes(midi, voiced);
    if (chordFrames) {
      const split = [];
      for (const [a, b, note] of segs) {
        if (note < 0) { split.push([a, b, note]); continue; }
        let s = a;
        for (let i = a + 1; i < b; i++) if (chordFrames[i] !== chordFrames[i - 1]) { split.push([s, i, note]); s = i; }
        split.push([s, b, note]);
      }
      segs = split;
    }
    const phrases = [];
    let cur = [];
    for (const [a, b, note] of segs) {
      if (note < 0) {
        if ((b - a) * FRAME_MS >= 250 && cur.length) { phrases.push(cur); cur = []; }
        continue;
      }
      cur.push({ start: a, end: b, note, durMs: (b - a) * FRAME_MS });
    }
    if (cur.length) phrases.push(cur);

    const target = new Float64Array(n).fill(NaN), centre = new Float64Array(n).fill(NaN);
    for (const ph of phrases) {
      ph.forEach((nt, k) => { nt.first = k === 0; nt.last = k === ph.length - 1; });
      let line;
      if (Math.abs(steps) === 7) line = ph.map((nt) => nt.note + (steps > 0 ? 12 : -12));
      else if (style === "scale" || !(interval in PART_RULES)) line = ph.map((nt) => diatonicTarget(nt.note, sn, steps));
      else {
        const chords = ph.map((nt) => {
          if (!chordFrames) return 24;
          const cnt = new Map();
          for (let i = nt.start; i < nt.end; i++) if (chordFrames[i] < 24) cnt.set(chordFrames[i], (cnt.get(chordFrames[i]) || 0) + 1);
          let best = 24, bc = 0;
          cnt.forEach((v, k) => { if (v > bc) { bc = v; best = k; } });
          return best;
        });
        line = chooseLine(ph, interval, chords, sn, pcs, style, unison);
      }
      ph.forEach((nt, k) => {
        for (let i = nt.start; i < nt.end; i++) { target[i] = line[k]; centre[i] = nt.note; }
      });
    }

    const has = new Uint8Array(n);
    for (let i = 0; i < n; i++) has[i] = voiced[i] && !isNaN(target[i]) ? 1 : 0;
    let hm;
    if (Math.abs(steps) === 7) {
      hm = Float64Array.from(midi, (m) => m + (steps > 0 ? 12 : -12));
    } else {
      // ~35 ms glide between notes, computed inside each sung run only
      // (so the start of a phrase isn't averaged with silence)
      const sm = new Float64Array(n);
      for (let i = 0; i < n;) {
        if (!has[i]) { i++; continue; }
        let j = i; while (j < n && has[j]) j++;
        const run = DSP.movingAverage(Float32Array.from(target.subarray(i, j)), 7);
        sm.set(run, i);
        i = j;
      }
      hm = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (!has[i]) continue;
        const dev = midi[i] - centre[i];
        hm[i] = sm[i] + 0.25 * Math.tanh(dev / 0.25);   // at most +-25 cents of expression
      }
    }
    for (let i = 0; i < n; i++) if (has[i]) out[i] = 440 * Math.pow(2, (hm[i] + tuning - 69) / 12);
    return out;
  }
  H.harmonyPitchCurve = harmonyPitchCurve;

  /**
   * Render harmony parts.  Returns {part: Float32Array}.
   */
  function harmonize(vocal, sr, analysis, opts, onProgress = () => {}) {
    const key = opts.key || analysis.key;
    const [tonic, mode] = parseKey(key);
    const style = opts.style in STYLES ? opts.style : "natural";
    let chords = analysis.chords;
    if (key !== analysis.key && analysis.chromaPack) chords = detectChords(analysis.chromaPack, tonic, mode);
    const chordFrames = chordsAt(chords, analysis.f0.length);
    const out = {};
    opts.intervals.forEach((iv, k) => {
      const tgt = harmonyPitchCurve(analysis.f0, analysis.tuning, tonic, mode, iv, style, chordFrames, opts.unison);
      let y = DSP.psola(vocal, sr, analysis.f0, tgt, FRAME_MS);
      const d = Math.round((sr * (DELAY_MS[iv] || 0)) / 1000);
      if (d) { const z = new Float32Array(y.length); z.set(y.subarray(0, y.length - d), d); y = z; }
      out[iv] = y;
      onProgress((k + 1) / opts.intervals.length);
    });
    return { parts: out, key };
  }
  H.harmonize = harmonize;

  /** Share of time a sung signal sits within 35 cents of a scale note. */
  function measureInKey(y, sr, key, tuning) {
    const [tonic, mode] = parseKey(key);
    const pcs = scalePcs(tonic, mode);
    const y16 = DSP.resample(y, sr, 16000);
    const nF = Math.floor((y.length / sr) * 100);
    const f0 = DSP.yinPitch(y16, 16000, nF, { frameMs: 10 });
    let ok = 0, tot = 0;
    for (const f of f0) {
      if (!(f > 0)) continue;
      tot++;
      const m = 69 + 12 * Math.log2(f / 440) - tuning, r = Math.round(m);
      if (Math.abs(m - r) < 0.35 && pcs.has(((r % 12) + 12) % 12)) ok++;
    }
    return tot < 10 ? 1 : ok / tot;
  }
  H.measureInKey = measureInKey;

  if (typeof module !== "undefined" && module.exports) module.exports = H;
  else root.Harmony = H;
})(typeof self !== "undefined" ? self : this);
