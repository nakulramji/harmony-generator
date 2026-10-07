# Harmony Generator (web version)

Upload a song, choose harmony parts, and sing the lead over the backing track and AI-generated harmony vocals.

**Everything runs in the visitor's browser.** Nothing to install, no server, completely free to host on GitHub Pages, and music never leaves the visitor's computer.

## How it works
1. **Vocal separation**: an MDX-Net AI model (from the free Ultimate Vocal Remover project) runs inside the browser with onnxruntime-web. It uses the graphics card (WebGPU) when it can, otherwise the CPU.
2. **Analysis**: tracks the singer's pitch, measures the recording's tuning, learns the scale from the notes actually sung, and finds the chords.
3. **Harmony**: for each phrase, picks the best harmony line that stays in the scale and fits the chords. It can hold notes, move in parallel, or join the lead in unison.
4. **Pitch shifting (PSOLA)**: makes the harmony voices while keeping the voice's natural tone.
5. **Mixer**: synced playback, volume sliders, harmony reverb, and a download of exactly what you hear.

## Put it online (one time, about 15 minutes)

### 1. Create the repository
- Sign in at https://github.com (free account).
- Click **+** (top right) → **New repository**. Name it `harmony-generator`, set it to **Public**, tick **Add a README file**, and click **Create repository**.

### 2. Upload the website files
- In the repository, click **Add file → Upload files**.
- Drag in everything from this folder (`index.html`, `coi-serviceworker.js`, and the `js`, `tools` and `models` folders), then click **Commit changes**.

### 3. Add the AI model
GitHub's website only accepts files up to 25 MB, so the model is uploaded in pieces.
1. Download the model: https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx (about 65 MB).
2. Open `tools/split-model.html` from this folder in Chrome (double-click it), choose `Kim_Vocal_2.onnx`, and click **Split and download**. You'll get 4 `.part` files and a `manifest.json`.
3. In the repository, open the `models` folder → **Add file → Upload files**, drag in those 5 files, and click **Commit changes**.

### 4. Turn on GitHub Pages
- In the repository: **Settings → Pages**. Under "Branch", choose **main** and **/ (root)**, then click **Save**.
- After about a minute, the page shows your link: `https://YOUR-USERNAME.github.io/harmony-generator/`

That's it: share the link.

## Optional: free-song search
To show a "search free songs" box (Creative Commons music from Jamendo):
1. Create a free account at https://devportal.jamendo.com and create an app to get a **Client ID**.
2. In `js/config.js`, put it in `JAMENDO_CLIENT_ID: "..."` and upload the file again.

## For visitors
- Use **Chrome or Edge** on a laptop or desktop. Phones may run out of memory on full songs.
- The first visit downloads the AI model (about 65 MB) once; after that it loads from the browser.
- Keep the tab open while it works. A 4-minute song takes roughly 1–3 minutes with a graphics card, or a few minutes on the CPU.
- Only use songs you have the right to use.

## Files
- `index.html`: the page
- `js/app.js`: song picking, progress, mixer, downloads
- `js/worker.js`: runs the heavy work in the background
- `js/separation.js`: vocal separation (spectrogram + AI model)
- `js/harmony.js`: key, scale, chords and harmony-line choice
- `js/dsp.js`: FFT, resampling, pitch tracking, chroma, PSOLA pitch shifting
- `js/config.js`: settings (model location, Jamendo key, max song length)
- `coi-serviceworker.js`: lets the AI model use all CPU cores on GitHub Pages
- `tools/split-model.html`: cuts the model into pieces under 25 MB
