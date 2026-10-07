/*
 * dsp.js - signal processing for the Harmony Generator (runs in the browser,
 * inside a Web Worker, and in Node for testing).
 *
 *  - FFT for any size (radix-2, Bluestein for other sizes)
 *  - resampler
 *  - YIN pitch tracker
 *  - chroma (which notes the instruments play)
 *  - PSOLA pitch shifter (changes pitch, keeps the voice's natural tone)
 */
(function (root) {
  "use strict";
  const DSP = {};

  // =========================================================== FFT
  function isPow2(n) { return (n & (n - 1)) === 0; }

  const twiddleCache = new Map();
  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2), rev: new Uint32Array(n) };
      for (let i = 0; i < n / 2; i++) {
        t.cos[i] = Math.cos((2 * Math.PI * i) / n);
        t.sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        t.rev[i] = r;
      }
      twiddleCache.set(n, t);
    }
    return t;
  }

  /** In-place complex FFT, n must be a power of 2. inverse=true -> unscaled inverse. */
  function fftPow2(re, im, inverse) {
    const n = re.length;
    const { cos, sin, rev } = twiddles(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const c = cos[tw], s = sgn * sin[tw];
          const a = start + k, b = a + half;
          const xr = re[b] * c - im[b] * s;
          const xi = re[b] * s + im[b] * c;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** FFT plan for any length n (Bluestein when n is not a power of 2). */
  function makeFFT(n) {
    if (isPow2(n)) {
      return {
        n,
        forward(re, im) { fftPow2(re, im, false); },
        inverse(re, im) { fftPow2(re, im, true); }, // unscaled
      };
    }
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    const wr = new Float64Array(n), wi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n;
      wr[k] = Math.cos(a); wi[k] = -Math.sin(a); // exp(-i*pi*k^2/n)
    }
    const Br = new Float64Array(m), Bi = new Float64Array(m);
    Br[0] = wr[0]; Bi[0] = -wi[0];
    for (let k = 1; k < n; k++) {
      Br[k] = Br[m - k] = wr[k];
      Bi[k] = Bi[m - k] = -wi[k];
    }
    fftPow2(Br, Bi, false);
    const Ar = new Float64Array(m), Ai = new Float64Array(m);

    function forward(re, im) {
      Ar.fill(0); Ai.fill(0);
      for (let k = 0; k < n; k++) {
        Ar[k] = re[k] * wr[k] - im[k] * wi[k];
        Ai[k] = re[k] * wi[k] + im[k] * wr[k];
      }
      fftPow2(Ar, Ai, false);
      for (let k = 0; k < m; k++) {
        const r = Ar[k] * Br[k] - Ai[k] * Bi[k];
        const i = Ar[k] * Bi[k] + Ai[k] * Br[k];
        Ar[k] = r; Ai[k] = i;
      }
      fftPow2(Ar, Ai, true);
      for (let k = 0; k < n; k++) {
        const r = Ar[k] / m, i = Ai[k] / m;
        re[k] = r * wr[k] - i * wi[k];
        im[k] = r * wi[k] + i * wr[k];
      }
    }
    return {
      n,
      forward,
      inverse(re, im) { // unscaled inverse via conjugation
        for (let k = 0; k < n; k++) im[k] = -im[k];
        forward(re, im);
        for (let k = 0; k < n; k++) im[k] = -im[k];
      },
    };
  }
  DSP.makeFFT = makeFFT;

  function hann(n, periodic) {
    const w = new Float64Array(n);
    const d = periodic ? n : n - 1;
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
    return w;
  }
  DSP.hann = hann;

  // =========================================================== resampling
  /** Windowed-sinc resampler (good quality, used for analysis copies). */
  function resample(x, srIn, srOut) {
    if (srIn === srOut) return Float32Array.from(x);
    const ratio = srOut / srIn;
    const nOut = Math.floor(x.length * ratio);
    const y = new Float32Array(nOut);
    const cutoff = Math.min(1, ratio) * 0.95;
    const half = 16;                                  // zero crossings each side
    const width = Math.ceil(half / cutoff);
    for (let i = 0; i < nOut; i++) {
      const c = i / ratio;
      const c0 = Math.floor(c);
      let acc = 0, wsum = 0;
      for (let j = c0 - width + 1; j <= c0 + width; j++) {
        if (j < 0 || j >= x.length) continue;
        const t = (c - j) * cutoff;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const win = 0.5 + 0.5 * Math.cos((Math.PI * (c - j)) / width);
        const k = sinc * win;
        acc += x[j] * k; wsum += k;
      }
      y[i] = wsum ? acc / wsum : 0;
    }
    return y;
  }
  DSP.resample = resample;

  // =========================================================== YIN pitch
  /**
   * Pitch every `frameMs` (Hz, 0 = unvoiced). x should be ~16 kHz mono.
   * Returns Float32Array with nFrames entries (frame i centred at i*frameMs).
   */
  function yinPitch(x, sr, nFrames, opts = {}) {
    const fmin = opts.fmin || 70, fmax = opts.fmax || 1100;
    const thr = opts.threshold || 0.15;
    const frameMs = opts.frameMs || 5;
    const hop = (sr * frameMs) / 1000;
    const tauMax = Math.ceil(sr / fmin), tauMin = Math.floor(sr / fmax);
    const W = Math.round(sr * 0.04);                 // 40 ms integration window
    const L = W + tauMax;
    let N = 1; while (N < L + W) N <<= 1;
    const f0 = new Float32Array(nFrames);

    // energy gate
    const rms = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      const s = Math.round(i * hop - W / 2);
      let e = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] || 0; e += v * v; }
      rms[i] = Math.sqrt(e / W);
    }
    const sorted = Float32Array.from(rms).sort();
    const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const gate = Math.max(1e-4, 0.03 * loud);

    const Ar = new Float64Array(N), Ai = new Float64Array(N);
    const Br = new Float64Array(N), Bi = new Float64Array(N);
    const sq = new Float64Array(L + 1);
    const d = new Float64Array(tauMax + 1);
    for (let i = 0; i < nFrames; i++) {
      if (rms[i] < gate) continue;
      const s = Math.round(i * hop - W / 2);
      Ar.fill(0); Ai.fill(0); Br.fill(0); Bi.fill(0);
      sq[0] = 0;
      for (let j = 0; j < L; j++) {
        const v = x[s + j] || 0;
        Br[j] = v;
        if (j < W) Ar[j] = v;
        sq[j + 1] = sq[j] + v * v;
      }
      fftPow2(Ar, Ai, false);
      fftPow2(Br, Bi, false);
      for (let k = 0; k < N; k++) { // conj(A) * B
        const r = Ar[k] * Br[k] + Ai[k] * Bi[k];
        const im = Ar[k] * Bi[k] - Ai[k] * Br[k];
        Ar[k] = r; Ai[k] = im;
      }
      fftPow2(Ar, Ai, true);
      const e0 = sq[W];
      d[0] = 0;
      let run = 0, best = -1;
      for (let tau = 1; tau <= tauMax; tau++) {
        const et = sq[tau + W] - sq[tau];
        const raw = Math.max(0, e0 + et - (2 * Ar[tau]) / N);
        run += raw;
        d[tau] = run > 0 ? (raw * tau) / run : 1;
      }
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (d[tau] < thr) {
          while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
          best = tau;
          break;
        }
      }
      if (best < 0) {
        // no clear dip: accept the deepest one if it is still fairly periodic
        // (catches the soft starts/ends of sung notes)
        let gm = tauMin;
        for (let tau = tauMin + 1; tau <= tauMax; tau++) if (d[tau] < d[gm]) gm = tau;
        if (d[gm] < (opts.looseThreshold || 0.35)) best = gm;
      }
      if (best < 0) continue;
      let t = best;
      if (best > 1 && best < tauMax) {
        const a = d[best - 1], b = d[best], c = d[best + 1];
        const den = a - 2 * b + c;
        if (den !== 0) t = best + (0.5 * (a - c)) / den;
      }
      f0[i] = sr / t;
    }
    return cleanPitch(f0, frameMs);
  }

  /** Remove octave jumps and tiny voiced islands. */
  function cleanPitch(f0, frameMs) {
    const n = f0.length;
    const m = new Float64Array(n);
    for (let i = 0; i < n; i++) m[i] = f0[i] > 0 ? Math.log2(f0[i]) : NaN;
    const out = Float32Array.from(f0);
    const k = 3;
    for (let i = 0; i < n; i++) {
      if (!(f0[i] > 0)) continue;
      const win = [];
      for (let j = i - k; j <= i + k; j++) if (j >= 0 && j < n && f0[j] > 0) win.push(m[j]);
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1];
      if (Math.abs(m[i] - med) > 0.5) out[i] = Math.pow(2, med);
    }
    const minRun = Math.round(30 / frameMs);
    let i = 0;
    while (i < n) {
      if (out[i] > 0) {
        let j = i; while (j < n && out[j] > 0) j++;
        if (j - i < minRun) for (let q = i; q < j; q++) out[q] = 0;
        i = j;
      } else i++;
    }
    return out;
  }
  DSP.yinPitch = yinPitch;

  // =========================================================== chroma
  /** 12 x frames chroma of a mono signal (expects ~11 kHz). */
  function chroma(x, sr, tuning, hop = 512, nfft = 4096) {
    const nFrames = Math.max(1, Math.floor(x.length / hop) + 1);
    const w = hann(nfft, true);
    const C = Array.from({ length: 12 }, () => new Float32Array(nFrames));
    const energy = new Float32Array(nFrames);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const binPc = new Int8Array(nfft / 2).fill(-1);
    for (let k = 1; k < nfft / 2; k++) {
      const f = (k * sr) / nfft;
      if (f < 55 || f > 2000) continue;
      const midi = 69 + 12 * Math.log2(f / 440) - tuning;
      const r = Math.round(midi);
      if (Math.abs(midi - r) < 0.4) binPc[k] = ((r % 12) + 12) % 12;
    }
    for (let t = 0; t < nFrames; t++) {
      const s = t * hop - nfft / 2;
      let e = 0;
      for (let j = 0; j < nfft; j++) {
        const v = x[s + j] || 0;
        re[j] = v * w[j]; im[j] = 0;
        e += v * v;
      }
      energy[t] = Math.sqrt(e / nfft);
      fftPow2(re, im, false);
      let mx = 0;
      const col = new Float64Array(12);
      for (let k = 1; k < nfft / 2; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        col[pc] += Math.hypot(re[k], im[k]);
      }
      for (let p = 0; p < 12; p++) mx = Math.max(mx, col[p]);
      for (let p = 0; p < 12; p++) C[p][t] = mx > 0 ? col[p] / mx : 0;
    }
    // median filter over time (9 frames) to ignore drum hits
    for (let p = 0; p < 12; p++) C[p] = medianFilter(C[p], 9);
    return { chroma: C, energy, secPerFrame: hop / sr };
  }
  DSP.chroma = chroma;

  function medianFilter(a, size) {
    const n = a.length, h = size >> 1, out = new Float32Array(n);
    const buf = new Float64Array(size);
    for (let i = 0; i < n; i++) {
      let c = 0;
      for (let j = i - h; j <= i + h; j++) buf[c++] = a[Math.min(n - 1, Math.max(0, j))];
      const s = Array.prototype.slice.call(buf, 0, c).sort((x, y) => x - y);
      out[i] = s[c >> 1];
    }
    return out;
  }
  DSP.medianFilter = medianFilter;

  // =========================================================== PSOLA
  /**
   * Pitch-shift x (mono) so that its pitch follows `target` (Hz per frame).
   * f0 = original pitch per frame (Hz, 0 = unvoiced). Frames are frameMs apart.
   * Unvoiced parts (consonants, breaths) are copied unchanged.
   * TD-PSOLA keeps the spectral envelope, so the voice keeps its natural tone.
   */
  function psola(x, sr, f0, target, frameMs = 5) {
    const n = x.length;
    const hop = (sr * frameMs) / 1000;
    const nF = f0.length;
    const fAt = (arr, s) => arr[Math.min(nF - 1, Math.max(0, Math.round(s / hop)))];
    const voicedAt = (s) => fAt(f0, s) > 0 && fAt(target, s) > 0;

    // 1. analysis pitch marks, aligned to waveform peaks
    const marks = [];
    let s = 0;
    while (s < n) {
      const f = fAt(f0, s);
      if (!(f > 0)) { s += Math.round(hop); continue; }
      const P = sr / f;
      const lo = Math.max(0, Math.round(s - P / 4)), hi = Math.min(n - 1, Math.round(s + P / 4));
      let best = lo, bv = -Infinity;
      if (marks.length === 0 || s - marks[marks.length - 1].pos > 1.5 * P) {
        // first mark of a voiced run: search a whole period for the peak
        for (let j = Math.round(s); j < Math.min(n, Math.round(s + P)); j++) if (x[j] > bv) { bv = x[j]; best = j; }
      } else {
        for (let j = lo; j <= hi; j++) if (x[j] > bv) { bv = x[j]; best = j; }
      }
      marks.push({ pos: best, P: Math.round(P) });
      s = best + P;
    }

    // 2. synthesis: place grains at the target period
    const acc = new Float32Array(n), wsum = new Float32Array(n);
    const winCache = new Map();
    const win = (P) => {
      let w = winCache.get(P);
      if (!w) { w = new Float32Array(2 * P + 1); for (let i = 0; i <= 2 * P; i++) w[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / P); winCache.set(P, w); }
      return w;
    };
    let mi = 0;
    let t = 0;
    while (t < n) {
      if (!voicedAt(t)) { t += Math.round(hop / 2); continue; }
      const Q = sr / fAt(target, t);
      while (mi + 1 < marks.length && Math.abs(marks[mi + 1].pos - t) <= Math.abs(marks[mi].pos - t)) mi++;
      while (mi > 0 && Math.abs(marks[mi - 1].pos - t) < Math.abs(marks[mi].pos - t)) mi--;
      const m = marks[mi];
      if (m && Math.abs(m.pos - t) < 2 * m.P) {
        const P = m.P, w = win(P), c = Math.round(t);
        for (let i = -P; i <= P; i++) {
          const src = m.pos + i, dst = c + i;
          if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
          acc[dst] += x[src] * w[i + P];
          wsum[dst] += w[i + P];
        }
      }
      t += Q;
    }

    // 3. combine (10 ms crossfades):
    //    - harmony note to sing      -> PSOLA output
    //    - consonants / breaths      -> copied from the lead (no pitch to clash)
    //    - lead singing but no harmony note (scoops, tiny blips) -> silence,
    //      so the lead's own pitch never leaks into the harmony
    const vm = new Float32Array(nF), um = new Float32Array(nF);
    for (let i = 0; i < nF; i++) {
      vm[i] = f0[i] > 0 && target[i] > 0 ? 1 : 0;
      um[i] = f0[i] > 0 ? 0 : 1;
    }
    const k = Math.max(1, Math.round(10 / frameMs));
    const sv = movingAverage(vm, k), su = movingAverage(um, k);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fi = i / hop, i0 = Math.min(nF - 1, Math.floor(fi)), i1 = Math.min(nF - 1, i0 + 1), fr = fi - i0;
      const v = sv[i0] + (sv[i1] - sv[i0]) * fr;
      const u = su[i0] + (su[i1] - su[i0]) * fr;
      const p = wsum[i] > 0.05 ? acc[i] / Math.max(wsum[i], 0.5) : 0;
      y[i] = v * p + u * x[i];
    }
    return y;
  }
  DSP.psola = psola;

  function movingAverage(a, size) {
    const n = a.length, h = Math.floor(size / 2), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = i - h; j < i - h + size; j++) { s += a[Math.min(n - 1, Math.max(0, j))]; c++; }
      out[i] = s / c;
    }
    return out;
  }
  DSP.movingAverage = movingAverage;

  if (typeof module !== "undefined" && module.exports) module.exports = DSP;
  else root.DSP = DSP;
})(typeof self !== "undefined" ? self : this);
