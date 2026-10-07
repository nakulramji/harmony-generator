/*
 * Settings you can change.
 */
self.HARMONY_CONFIG = {
  // Where the vocal-separation model lives (inside this website).
  // models/manifest.json lists the model's parts (made with tools/split-model.html).
  MODEL_MANIFEST: "models/manifest.json",

  // The browser AI engine (onnxruntime-web), loaded from a free public CDN.
  ORT_BASE: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/",

  // Optional: free Jamendo API client id (https://devportal.jamendo.com).
  // Leave empty to hide the "Search free songs" box.
  JAMENDO_CLIENT_ID: "",

  // Longest song we accept (minutes) - longer songs can run out of memory.
  MAX_MINUTES: 8,
};
