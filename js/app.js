/*
 * app.js - the page: choosing a song, settings, progress, and the mixer.
 * Heavy work happens in js/worker.js.
 */
(function () {
  "use strict";
  const CFG = window.HARMONY_CONFIG;
  const H = window.Harmony;
  const $ = (id) => document.getElementById(id);
  const SR = 44100;

  // ------------------------------------------------------------ setup
  function buildChips(el, name, checked) {
    el.innerHTML = "";
    for (const [val, label] of Object.entries(H.INTERVAL_LABELS)) {
      const l = document.createElement("label");
      l.className = "chip";
      l.innerHTML = `<input type="checkbox" name="${name}" value="${val}" ${checked.includes(val) ? "checked" : ""}><span>${label}</span>`;
      el.appendChild(l);
    }
  }
  function fillSelect(sel, entries, value) {
    sel.innerHTML = entries.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    if (value !== undefined) sel.value = value;
  }
  const keyEntries = (autoLabel) => [["", autoLabel], ...H.allKeyNames().map((k) => [k, k])];
  const picked = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);

  buildChips($("intervalChips"), "iv", ["third_above"]);
  fillSelect($("style"), Object.entries(H.STYLES), "natural");
  fillSelect($("reStyle"), Object.entries(H.STYLES), "natural");
  fillSelect($("unison"), Object.entries(H.UNISON_LEVELS), "sometimes");
  fillSelect($("reUnison"), Object.entries(H.UNISON_LEVELS), "sometimes");
  fillSelect($("key"), keyEntries("Auto-detect"), "");
  $("maxMin").textContent = CFG.MAX_MINUTES;
  try { if (localStorage.getItem("modelSeen")) $("firstTime").textContent = ""; } catch (e) { /* storage blocked */ }

  // ------------------------------------------------------------ choosing a song
  let audio = null;      // {left, right, title, credit}
  const decodeCtx = () => new OfflineAudioContext(2, 1, SR);

  async function loadArrayBuffer(buf, title, credit) {
    $("picked").textContent = "Reading the audio…";
    $("go").disabled = true;
    try {
      const ab = await decodeCtx().decodeAudioData(buf);
      if (ab.duration > CFG.MAX_MINUTES * 60) {
        $("picked").textContent = `That song is ${Math.round(ab.duration / 60)} minutes long. Please use one under ${CFG.MAX_MINUTES} minutes.`;
        return;
      }
      const left = Float32Array.from(ab.getChannelData(0));
      const right = ab.numberOfChannels > 1 ? Float32Array.from(ab.getChannelData(1)) : Float32Array.from(left);
      audio = { left, right, title, credit };
      $("picked").textContent = `Ready: ${title} (${fmt(ab.duration)})`;
      $("go").disabled = false;
    } catch (e) {
      $("picked").textContent = "Couldn't read that file. Try an MP3 or WAV.";
    }
  }

  $("file").onchange = async (e) => {
    const f = e.target.files[0];
    if (f) loadArrayBuffer(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ""), "");
  };
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadArrayBuffer(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ""), "");
  });

  // ---- free songs from Jamendo (optional)
  if (CFG.JAMENDO_CLIENT_ID) {
    $("jamendoBox").classList.remove("hidden");
    $("searchForm").onsubmit = async (e) => {
      e.preventDefault();
      const q = $("query").value.trim();
      if (!q) return;
      const box = $("results");
      box.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const url = "https://api.jamendo.com/v3.0/tracks/?" + new URLSearchParams({
          client_id: CFG.JAMENDO_CLIENT_ID, format: "json", limit: "10", search: q,
          vocalinstrumental: "vocal", audioformat: "mp32", include: "licenses",
        });
        const data = await (await fetch(url)).json();
        box.innerHTML = "";
        if (!data.results || !data.results.length) { box.innerHTML = '<p class="muted">No songs found. Try another search.</p>'; return; }
        for (const t of data.results) {
          const row = document.createElement("div");
          row.className = "result";
          row.innerHTML = `<img alt="" src="${t.album_image || t.image || ""}"><div class="meta"><div><b></b></div><div class="muted"></div></div><button class="secondary" type="button">Use</button>`;
          row.querySelector("b").textContent = t.name;
          row.querySelector(".meta .muted").textContent = `${t.artist_name} · ${fmt(t.duration)}`;
          row.querySelector("button").onclick = async () => {
            $("picked").textContent = "Downloading the song…";
            try {
              const res = await fetch(t.audio);
              if (!res.ok) throw new Error(res.status);
              const credit = `“${t.name}” by ${t.artist_name}, from Jamendo` + (t.license_ccurl ? ` (license: ${t.license_ccurl})` : "");
              loadArrayBuffer(await res.arrayBuffer(), `${t.name} – ${t.artist_name}`, credit);
            } catch (err) {
              $("picked").innerHTML = "";
              $("picked").append("This song can't be loaded directly. Download it from ");
              const a = document.createElement("a"); a.href = t.shareurl; a.target = "_blank"; a.rel = "noopener"; a.textContent = "its Jamendo page";
              $("picked").append(a, " and drop the file above.");
            }
          };
          box.appendChild(row);
        }
      } catch (err) {
        box.innerHTML = '<p class="muted">Search isn\'t working right now. You can still upload a file.</p>';
      }
    };
  }

  // ------------------------------------------------------------ worker
  const worker = new Worker("js/worker.js");
  let startedAt = 0, timer = null, lastStage = { stage: "Starting", progress: 0 };

  function showProgress(title) {
    $("progressCard").classList.remove("hidden");
    $("songTitle").textContent = title;
    $("error").textContent = "";
    startedAt = Date.now();
    clearInterval(timer);
    timer = setInterval(renderProgress, 500);
    renderProgress();
  }
  // rough share of the total time each stage takes, for one smooth bar
  const STAGE_SPAN = [
    [/Downloading|Loading the vocal/, 0, 0.15], [/Starting the AI/, 0.15, 0.17],
    [/Separating/, 0.17, 0.85], [/Analysing/, 0.85, 0.92],
    [/Generating/, 0.92, 0.98], [/Checking/, 0.98, 1],
  ];
  function renderProgress() {
    const { stage, progress } = lastStage;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    $("stage").textContent = `${stage}${progress > 0 ? ` — ${Math.round(progress * 100)}%` : ""} · ${fmt(secs)} elapsed`;
    let pct = 2;
    for (const [re, a, b] of STAGE_SPAN) if (re.test(stage)) pct = 100 * (a + (b - a) * progress);
    if (regenerating) pct = 100 * progress;
    $("barFill").style.width = Math.max(2, pct) + "%";
  }

  let regenerating = false;
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "progress") {
      lastStage = m;
      if (/Loading the vocal|Starting/.test(m.stage)) { try { localStorage.setItem("modelSeen", "1"); } catch (e) { /* ignore */ } }
      return;
    }
    clearInterval(timer);
    $("go").disabled = !audio;
    $("regen").disabled = false;
    if (m.type === "error") {
      $("stage").textContent = "Something went wrong.";
      $("error").textContent = m.message;
      return;
    }
    $("progressCard").classList.add("hidden");
    showMixer(m);
  };

  function settingsFrom(prefix) {
    const ivs = picked(prefix === "re" ? "re" : "iv");
    return {
      intervals: ivs,
      style: $(prefix === "re" ? "reStyle" : "style").value,
      unison: $(prefix === "re" ? "reUnison" : "unison").value,
      key: $(prefix === "re" ? "reKey" : "key").value || null,
    };
  }

  $("go").onclick = () => {
    if (!audio) return;
    const settings = settingsFrom("");
    if (!settings.intervals.length) { alertBox("Pick at least one harmony part."); return; }
    stopAudio();
    $("mixerCard").classList.add("hidden");
    $("go").disabled = true;
    regenerating = false;
    lastStage = { stage: "Starting", progress: 0 };
    showProgress(audio.title);
    const left = Float32Array.from(audio.left), right = Float32Array.from(audio.right);
    worker.postMessage({ type: "process", left, right, sr: SR, settings }, [left.buffer, right.buffer]);
  };

  $("regen").onclick = () => {
    const settings = settingsFrom("re");
    if (!settings.intervals.length) return;
    stopAudio();
    $("regen").disabled = true;
    regenerating = true;
    lastStage = { stage: "Generating harmonies", progress: 0 };
    showProgress(current.title);
    worker.postMessage({ type: "regenerate", settings });
  };

  function alertBox(msg) {
    $("progressCard").classList.remove("hidden");
    $("songTitle").textContent = "Almost there";
    $("stage").textContent = "";
    $("error").textContent = msg;
  }

  // ------------------------------------------------------------ mixer (Web Audio)
  let ctx = null, buffers = {}, gains = {}, sources = [], started = 0, offset = 0, playing = false, duration = 0, raf = 0;
  let TRACKS = [], vols = {}, reverbAmt = 0.25, wetGain = null;
  let current = { title: "", instrumental: null, guide: null, credit: "" };

  const toBuffer = (c, chans) => {
    const b = c.createBuffer(chans.length, chans[0].length, SR);
    chans.forEach((d, i) => b.copyToChannel(d, i));
    return b;
  };

  // reverb: generated "room" with a short pre-delay so words stay clear,
  // filtered so it doesn't get muddy or hissy
  function makeImpulse(c, seconds = 2.4, decay = 3.2) {
    const len = Math.floor(c.sampleRate * seconds), ir = c.createBuffer(2, len, c.sampleRate);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, decay);
    }
    return ir;
  }
  const wetLevel = (a) => a * 1.6;

  function connectGraph(c) {
    const bus = c.createGain();
    const pre = c.createDelay(0.2); pre.delayTime.value = 0.045;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 250;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7000;
    const conv = c.createConvolver(); conv.buffer = makeImpulse(c);
    const wet = c.createGain(); wet.gain.value = wetLevel(reverbAmt);
    bus.connect(pre).connect(hp).connect(lp).connect(conv).connect(wet).connect(c.destination);
    const g = {};
    for (const t of TRACKS) {
      const gn = c.createGain(); gn.gain.value = vols[t.id];
      const pan = c.createStereoPanner(); pan.pan.value = H.PAN[t.id] || 0;
      gn.connect(pan).connect(c.destination);
      if (t.harmony) pan.connect(bus);
      g[t.id] = gn;
    }
    return { gains: g, wet };
  }

  function showMixer(m) {
    stopAudio();
    ctx = ctx || new AudioContext({ sampleRate: SR });
    if (!m.regenerate) {
      current = { title: audio.title, credit: audio.credit, instrumental: m.instrumental, guide: m.guide };
      buffers = {};
      buffers.instrumental = toBuffer(ctx, m.instrumental);
      buffers.vocals = toBuffer(ctx, [m.guide]);
    }
    for (const k of Object.keys(buffers)) if (!["instrumental", "vocals"].includes(k)) delete buffers[k];
    for (const [k, y] of Object.entries(m.parts)) buffers[k] = toBuffer(ctx, [y]);

    $("mixerCard").classList.remove("hidden");
    $("mixTitle").textContent = current.title;
    $("credit").textContent = current.credit || "";
    const auto = m.keyUsed === m.detectedKey;
    let info = `Key: ${m.keyUsed}${auto ? " (detected from the melody)" : ` (you chose it; detected ${m.detectedKey})`}`;
    if (m.tuningCents) info += ` · recording is tuned ${m.tuningCents > 0 ? "+" : ""}${m.tuningCents} cents from A440 (handled automatically)`;
    info += " · Harmony on scale notes: " + Object.entries(m.inKey).map(([k, v]) => `${H.INTERVAL_LABELS[k]} ${v}%`).join(", ");
    if (m.seconds) info += ` · took ${fmt(Math.round(m.seconds))} on your ${m.device}`;
    $("keyInfo").textContent = info;

    buildChips($("reChips"), "re", m.settings.intervals);
    fillSelect($("reStyle"), Object.entries(H.STYLES), m.settings.style);
    fillSelect($("reUnison"), Object.entries(H.UNISON_LEVELS), m.settings.unison);
    fillSelect($("reKey"), keyEntries(`Auto (${m.detectedKey})`), auto ? "" : m.keyUsed);

    TRACKS = [
      { id: "instrumental", label: "Backing track", vol: 0.9 },
      ...m.settings.intervals.map((iv) => ({ id: iv, label: H.INTERVAL_LABELS[iv], vol: 0.8, harmony: true })),
      { id: "vocals", label: "Original lead (guide)", vol: 0 },
    ];
    vols = Object.fromEntries(TRACKS.map((t) => [t.id, t.vol]));
    if (wetGain) wetGain.disconnect();
    const graph = connectGraph(ctx);
    gains = graph.gains; wetGain = graph.wet;
    duration = Math.max(...Object.values(buffers).map((b) => b.duration));
    offset = 0;

    const box = $("tracks");
    box.innerHTML = "";
    for (const t of TRACKS) {
      const row = document.createElement("div");
      row.className = "track";
      row.innerHTML = `<span>${t.label}</span><input type="range" min="0" max="1.5" step="0.01" value="${t.vol}" aria-label="${t.label} volume"><a href="#">save</a>`;
      row.querySelector("input").oninput = (e) => { vols[t.id] = +e.target.value; gains[t.id].gain.value = vols[t.id]; };
      row.querySelector("a").onclick = (e) => { e.preventDefault(); saveWav(buffers[t.id], `${current.title} - ${t.label}.wav`); };
      box.appendChild(row);
    }
    const fx = document.createElement("div");
    fx.className = "track fx";
    fx.innerHTML = `<span>Harmony reverb</span><input type="range" min="0" max="1" step="0.01" value="${reverbAmt}" aria-label="Harmony reverb amount"><span class="val">${Math.round(reverbAmt * 100)}%</span>`;
    fx.querySelector("input").oninput = (e) => {
      reverbAmt = +e.target.value;
      wetGain.gain.setTargetAtTime(wetLevel(reverbAmt), ctx.currentTime, 0.03);
      fx.querySelector(".val").textContent = Math.round(reverbAmt * 100) + "%";
    };
    box.appendChild(fx);
    updateTime();
  }

  function play() {
    if (ctx.state === "suspended") ctx.resume();
    sources = Object.entries(buffers).map(([id, buf]) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.connect(gains[id]); return s;
    });
    const when = ctx.currentTime + 0.05;
    sources.forEach((s) => s.start(when, offset));
    started = when - offset; playing = true; $("play").textContent = "❚❚";
    loop();
  }
  function stopSources() {
    sources.forEach((s) => { try { s.stop(); } catch (e) { /* already stopped */ } });
    sources = []; playing = false; $("play").textContent = "▶"; cancelAnimationFrame(raf);
  }
  function pause() { offset = pos(); stopSources(); }
  function stopAudio() { if (ctx) stopSources(); offset = 0; }
  const pos = () => (playing ? Math.min(duration, ctx.currentTime - started) : offset);
  function fmt(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
  function updateTime() { $("time").textContent = `${fmt(pos())} / ${fmt(duration)}`; $("seek").value = duration ? (pos() / duration) * 1000 : 0; }
  function loop() { updateTime(); if (pos() >= duration) { pause(); offset = 0; updateTime(); return; } raf = requestAnimationFrame(loop); }
  $("play").onclick = () => (playing ? pause() : play());
  $("seek").oninput = (e) => { const was = playing; if (was) stopSources(); offset = (e.target.value / 1000) * duration; updateTime(); if (was) play(); };

  // ------------------------------------------------------------ downloads
  function toWav(buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
    const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
    let peak = 0;
    for (const d of data) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    const scale = peak > 0.98 ? 0.98 / peak : 1;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, t) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVEfmt ");
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true);
    out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2)
      out.setInt16(o, Math.max(-1, Math.min(1, data[c][i] * scale)) * 32767, true);
    return new Blob([out], { type: "audio/wav" });
  }
  function saveWav(buf, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(toWav(buf));
    a.download = name.replace(/[\\/:*?"<>|]/g, "");
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  $("mixDl").onclick = async () => {
    const btn = $("mixDl"); btn.disabled = true; btn.textContent = "Preparing your mix…";
    try {
      const oc = new OfflineAudioContext(2, Math.ceil((duration + 2.5) * SR), SR);
      const g = connectGraph(oc).gains;
      for (const [id, buf] of Object.entries(buffers)) { const s = oc.createBufferSource(); s.buffer = buf; s.connect(g[id]); s.start(0); }
      saveWav(await oc.startRendering(), `${current.title} - harmony mix.wav`);
    } finally { btn.disabled = false; btn.textContent = "Download my mix (.wav)"; }
  };
})();
