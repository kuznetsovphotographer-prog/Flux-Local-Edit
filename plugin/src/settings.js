(function () {
  const STORAGE_KEY = "fluxLocalEditSettings.v1";
  const EDIT_PROMPT = "Smooth the neck skin, remove folds and wrinkles, keep realistic texture, keep lighting and identity unchanged.";

  const DEFAULTS = {
    activeMode: "edit",
    comfyUrl: "http://127.0.0.1:8188",
    megapixels: 1,
    roundingMultiple: 16,
    editPrompt: EDIT_PROMPT,
    fillPrompt: ""
  };

  function normalizeMode(value) {
    return value === "fill" ? "fill" : "edit";
  }

  function normalize(settings) {
    const merged = { ...DEFAULTS, ...(settings || {}) };
    return {
      activeMode: normalizeMode(merged.activeMode),
      comfyUrl: DEFAULTS.comfyUrl,
      megapixels: merged.megapixels,
      roundingMultiple: DEFAULTS.roundingMultiple,
      editPrompt: String(merged.editPrompt == null ? EDIT_PROMPT : merged.editPrompt),
      fillPrompt: String(merged.fillPrompt == null ? "" : merged.fillPrompt)
    };
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return normalize(DEFAULTS);
      }
      return normalize(JSON.parse(raw));
    } catch (error) {
      return normalize(DEFAULTS);
    }
  }

  function saveSettings(settings) {
    const next = normalize(settings);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  globalThis.FluxLocalEditSettings = {
    DEFAULTS,
    STORAGE_KEY,
    loadSettings,
    normalize,
    normalizeMode,
    saveSettings
  };
})();
