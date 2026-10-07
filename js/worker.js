/*
 * worker.js - does all the heavy work in the background so the page stays responsive.
 *
 * Messages in:
 *   {type: "process", left, right, sr, settings}   full pipeline for a new song
 *   {type: "regenerate", settings}                 new harmonies, same song (fast)
 * Messages out:
 *   {type: "progress", stage, progress}
 *   {type: "result", ...}  /  {type: "error", message}
 */
importScripts("config.js", "dsp.js", "harmony.js", "separation.js");
const CFG = self.HARMONY_CONFIG;

let ortLoaded = false;
let session = null, sessionInfo = null;
let song = null; // {vocal (mono), analysis, sr}

const post = (m, transfer) => self.postMessage(m, transfer || []);
const progress = (stage, p) => post({ type: "progress", stage, progress: p });

function loadOrt() {
  if (ortLoaded) return;
  importScripts(CFG.ORT_BASE + "ort.all.min.js");
  ort.env.wasm.wasmPaths = CFG.ORT_BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ortLoaded = true;
}

/** Download the model (in parts), keep it in the browser cache for next time. */
async function loadModelBytes() {
  const manifestUrl = new URL("../" + CFG.MODEL_MANIFEST, self.location.href).href;
  const mres = await fetch(manifestUrl, { cache: "no-cache" });
  if (!mres.ok) throw new Error("The vocal-separation model is missing from this website (models/manifest.json not found). See the README, step 3.");
  const manifest = await mres.json();
  const base = new URL(".", manifestUrl).href;
  const cache = self.caches ? await caches.open("harmony-model-v1") : null;
  const parts = [];
  let done = 0;
  const total = manifest.parts.reduce((s, p) => s + (p.bytes || 0), 0) || 1;
  for (const p of manifest.parts) {
    const url = base + p.file;
    let res = cache ? await cache.match(url) : null;
    const cached = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download model part ${p.file} (${res.status}).`);
      if (cache) await cache.put(url, res.clone());
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(buf);
    done += buf.length;
    progress(cached ? "Loading the vocal-separation model (saved on this computer)"
                    : "Downloading the vocal-separation model (first time only)", done / total);
  }
  const all = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of parts) { all.set(b, o); o += b.length; }
  return { bytes: all, manifest };
}

async function createSession(bytes, providers) {
  return ort.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: "all" });
}

async function getSession() {
  if (session) return session;
  loadOrt();
  const { bytes, manifest } = await loadModelBytes();
  progress("Starting the AI model", 0);
  let device = "CPU";
  if (self.navigator && navigator.gpu) {
    try { session = await createSession(bytes, ["webgpu"]); device = "graphics card"; }
    catch (e) { console.warn("WebGPU not usable, using CPU:", e); session = null; }
  }
  if (!session) session = await createSession(bytes, ["wasm"]);
  const meta = (session.inputMetadata && session.inputMetadata[0]) || {};
  const shape = meta.shape || [];
  const cfg = Object.assign({}, Separation.DEFAULTS, manifest.settings || {});
  if (typeof shape[2] === "number") cfg.dimF = shape[2];
  if (typeof shape[3] === "number") cfg.dimT = shape[3];
  sessionInfo = { cfg, device, bytes };
  return session;
}

function makeRunner() {
  const { cfg } = sessionInfo;
  return async (input) => {
    const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 4, cfg.dimF, cfg.dimT]) };
    const out = await session.run(feeds);
    return out[session.outputNames[0]].data;
  };
}

async function separateSong(left, right) {
  await getSession();
  const label = () => `Separating vocals from music (on your ${sessionInfo.device})`;
  progress(label(), 0);
  try {
    return await Separation.separate(left, right, makeRunner(), sessionInfo.cfg, (p) => progress(label(), p));
  } catch (e) {
    if (sessionInfo.device !== "cpu") {
      // some graphics cards can't run every part of the model: retry on the CPU
      console.warn("Graphics card failed, retrying on CPU:", e);
      session = await createSession(sessionInfo.bytes, ["wasm"]);
      sessionInfo.device = "CPU";
      return await Separation.separate(left, right, makeRunner(), sessionInfo.cfg, (p) => progress(label(), p));
    }
    throw e;
  }
}

function makeHarmonies(settings) {
  const { vocal, analysis, sr } = song;
  progress("Generating harmonies", 0);
  const res = Harmony.harmonize(vocal, sr, analysis, settings, (p) => progress("Generating harmonies", p));
  progress("Checking the harmonies are in key", 0);
  const inKey = {};
  for (const [k, y] of Object.entries(res.parts)) inKey[k] = Math.round(1000 * Harmony.measureInKey(y, sr, res.key, analysis.tuning)) / 10;
  return { parts: res.parts, keyUsed: res.key, inKey };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "process") {
      const t0 = Date.now();
      const sep = await separateSong(m.left, m.right);
      const [vL, vR] = sep.vocals;
      const vocal = new Float32Array(vL.length);
      for (let i = 0; i < vocal.length; i++) vocal[i] = 0.5 * (vL[i] + vR[i]);
      const instMono = new Float32Array(vL.length);
      for (let i = 0; i < instMono.length; i++) instMono[i] = 0.5 * (sep.instrumental[0][i] + sep.instrumental[1][i]);
      progress("Analysing the melody: tuning, scale and chords", 0);
      const analysis = Harmony.analyseSong(vocal, instMono, m.sr, (p) => progress("Analysing the melody: tuning, scale and chords", p));
      song = { vocal, analysis, sr: m.sr };
      const h = makeHarmonies(m.settings);
      const guide = Float32Array.from(vocal);
      const transfer = [sep.instrumental[0].buffer, sep.instrumental[1].buffer, guide.buffer,
                        ...Object.values(h.parts).map((y) => y.buffer)];
      post({ type: "result", instrumental: sep.instrumental, guide, parts: h.parts, sr: m.sr,
             detectedKey: analysis.key, keyUsed: h.keyUsed, tuningCents: Math.round(analysis.tuning * 100),
             inKey: h.inKey, settings: m.settings, seconds: (Date.now() - t0) / 1000,
             device: sessionInfo.device }, transfer);
    } else if (m.type === "regenerate") {
      if (!song) throw new Error("Load a song first.");
      const h = makeHarmonies(m.settings);
      post({ type: "result", regenerate: true, parts: h.parts, keyUsed: h.keyUsed, inKey: h.inKey,
             detectedKey: song.analysis.key, tuningCents: Math.round(song.analysis.tuning * 100),
             settings: m.settings, sr: song.sr },
           Object.values(h.parts).map((y) => y.buffer));
    }
  } catch (e) {
    console.error(e);
    post({ type: "error", message: String(e && e.message ? e.message : e) });
  }
};
