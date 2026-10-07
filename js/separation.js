/*
 * separation.js - splits a song into vocals and instrumental, in the browser.
 *
 * Uses an MDX-Net vocal model (ONNX format, from the free Ultimate Vocal
 * Remover project) run by onnxruntime-web: on the graphics card (WebGPU) when
 * the browser supports it, otherwise on the CPU (WebAssembly).
 *
 * The model works on spectrograms, so we do the same STFT that it was
 * trained with (PyTorch's torch.stft, centre=True, reflect padding, periodic
 * Hann window), feed it chunk by chunk, and turn its output back into sound.
 */
(function (root) {
  "use strict";
  const DSP = root.DSP || (typeof require !== "undefined" ? require("./dsp.js") : null);

  /** Default settings for UVR "Kim_Vocal_2" / "UVR-MDX-NET-Voc_FT" style models. */
  const DEFAULTS = { nFft: 7680, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.009 };

  function reflect(i, n) { // torch reflect padding index
    if (i < 0) return -i;
    if (i >= n) return 2 * (n - 1) - i;
    return i;
  }

  /**
   * Spectrogram of one stereo chunk in the model's layout:
   * Float32Array [1, 4, dimF, dimT] = [L_re, L_im, R_re, R_im].
   * Both channels share one complex FFT (left in the real part, right in the imaginary part).
   */
  function stftChunk(L, R, cfg, fft, win, out) {
    const { nFft, hop, dimF, dimT } = cfg;
    const n = L.length, half = nFft / 2;
    const re = new Float64Array(nFft), im = new Float64Array(nFft);
    const FT = dimF * dimT;
    for (let t = 0; t < dimT; t++) {
      const start = t * hop - half;
      for (let j = 0; j < nFft; j++) {
        const idx = reflect(start + j, n);
        re[j] = L[idx] * win[j];
        im[j] = R[idx] * win[j];
      }
      fft.forward(re, im);
      for (let k = 0; k < dimF; k++) {
        const nk = k === 0 ? 0 : nFft - k;
        // unpack the two real spectra
        const lr = 0.5 * (re[k] + re[nk]), li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]), ri = -0.5 * (re[k] - re[nk]);
        const o = k * dimT + t;
        out[o] = lr; out[FT + o] = li; out[2 * FT + o] = rr; out[3 * FT + o] = ri;
      }
    }
    return out;
  }

  /** Inverse of stftChunk (torch.istft, centre=True), returns [L, R] of length hop*(dimT-1). */
  function istftChunk(spec, cfg, fft, win) {
    const { nFft, hop, dimF, dimT } = cfg;
    const half = nFft / 2, len = hop * (dimT - 1);
    const full = len + nFft;
    const accL = new Float64Array(full), accR = new Float64Array(full), wss = new Float64Array(full);
    const re = new Float64Array(nFft), im = new Float64Array(nFft);
    const FT = dimF * dimT;
    for (let t = 0; t < dimT; t++) {
      re.fill(0); im.fill(0);
      for (let k = 0; k < dimF && k <= half; k++) {
        const o = k * dimT + t;
        const lr = spec[o], li = spec[FT + o], rr = spec[2 * FT + o], ri = spec[3 * FT + o];
        // Z = XL + i*XR, with Hermitian mirrors for the negative frequencies
        re[k] = lr - ri; im[k] = li + rr;
        if (k > 0 && k < half) {
          const m = nFft - k;
          re[m] = lr + ri; im[m] = -li + rr;
        }
      }
      fft.inverse(re, im);
      const s = t * hop;
      for (let j = 0; j < nFft; j++) {
        const w = win[j];
        accL[s + j] += (re[j] / nFft) * w;
        accR[s + j] += (im[j] / nFft) * w;
        wss[s + j] += w * w;
      }
    }
    const outL = new Float32Array(len), outR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const w = wss[i + half];
      outL[i] = w > 1e-11 ? accL[i + half] / w : 0;
      outR[i] = w > 1e-11 ? accR[i + half] / w : 0;
    }
    return [outL, outR];
  }

  /**
   * Separate vocals.  run(inputFloat32Array) -> Promise<Float32Array> runs the model.
   * Returns {vocals: [L, R], instrumental: [L, R]}.
   */
  async function separate(left, right, run, cfgIn = {}, onProgress = () => {}) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const { nFft, hop, dimF, dimT } = cfg;
    const chunk = hop * (dimT - 1), trim = nFft / 2, gen = chunk - 2 * trim;
    const n = left.length;
    const pad = gen - (n % gen);
    const total = trim + n + pad + trim;
    const pL = new Float32Array(total), pR = new Float32Array(total);
    pL.set(left, trim); pR.set(right, trim);
    const vocL = new Float32Array(n + pad), vocR = new Float32Array(n + pad);
    const fft = DSP.makeFFT(nFft), win = DSP.hann(nFft, true);
    const input = new Float32Array(4 * dimF * dimT);
    const steps = Math.ceil((n + pad) / gen);
    for (let s = 0, i = 0; i < n + pad; i += gen, s++) {
      const cL = pL.subarray(i, i + chunk), cR = pR.subarray(i, i + chunk);
      stftChunk(cL, cR, cfg, fft, win, input);
      const outSpec = await run(input);
      const [oL, oR] = istftChunk(outSpec, cfg, fft, win);
      vocL.set(oL.subarray(trim, chunk - trim), i);
      vocR.set(oR.subarray(trim, chunk - trim), i);
      onProgress((s + 1) / steps);
    }
    const vL = new Float32Array(n), vR = new Float32Array(n), iL = new Float32Array(n), iR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      vL[i] = vocL[i] * cfg.compensate; vR[i] = vocR[i] * cfg.compensate;
      iL[i] = left[i] - vL[i]; iR[i] = right[i] - vR[i];
    }
    return { vocals: [vL, vR], instrumental: [iL, iR] };
  }

  const Separation = { DEFAULTS, separate, stftChunk, istftChunk };
  if (typeof module !== "undefined" && module.exports) module.exports = Separation;
  else root.Separation = Separation;
})(typeof self !== "undefined" ? self : this);
