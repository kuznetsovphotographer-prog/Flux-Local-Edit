(function () {
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;
  const formats = storage.formats;
  const $ = (id) => document.getElementById(id);

  let logger;
  let currentPreviewUrl = null;
  let referenceFile = null;
  let referencePreviewUrl = null;
  let isGenerating = false;
  let currentClient = null;
  let currentPromptId = "";
  let cancelToken = null;
  let lastProgrammaticPasteAt = 0;
  let activeMode = "edit";
  let modePrompts = {
    edit: globalThis.FluxLocalEditSettings.DEFAULTS.editPrompt,
    fill: globalThis.FluxLocalEditSettings.DEFAULTS.fillPrompt
  };

  const MEGAPIXELS_MIN = 1;
  const MEGAPIXELS_MAX = 4; // Сохраняем подтвержденный диапазон удаленного MP-слайдера.
  const MEGAPIXELS_PRECISION = 100;
  const ACTION_METHOD_NAMES = {
    edit: "fluxLocalEditGenerateEditActionHandler",
    fill: "fluxLocalEditGenerateFillActionHandler"
  };
  const MODE_METADATA = {
    edit: {
      label: "Edit",
      modelLabel: "FLUX.2 Klein 9B FP8",
      modelFile: "flux-2-klein-9b-fp8.safetensors",
      placeholder: "Type your text prompt here to generate a new layer..."
    },
    fill: {
      label: "Fill",
      modelLabel: "FLUX.1 Fill Dev FP8",
      modelFile: "flux1-fill-dev-fp8.safetensors",
      placeholder: "Optional: describe the change, or leave blank to fill from surroundings."
    }
  };
  const DIRECT_REFERENCE_EXTENSIONS = ["png", "jpg", "jpeg", "jpe", "jfif", "webp", "gif", "bmp"];
  const CONVERTIBLE_REFERENCE_EXTENSIONS = ["avif"];
  const RAW_REFERENCE_EXTENSIONS = [
    "raw", "arw", "cr2", "cr3", "nef", "nrw", "orf", "rw2", "raf", "dng",
    "pef", "srw", "x3f", "erf", "kdc", "mrw", "3fr", "fff"
  ];

  function cancelledError() {
    const error = new Error("Generation cancelled.");
    error.kind = "cancelled";
    return error;
  }

  function throwIfCancelled(token) {
    if (token && token.cancelled) {
      throw cancelledError();
    }
  }

  function getLogger() {
    if (!logger) {
      logger = globalThis.Flux2Logger.createLogger(null);
    }
    return logger;
  }

  function hasPanelDom() {
    return Boolean($("generateBtn") && $("promptInput") && $("targetReadout"));
  }

  function setPromptText(text) {
    const input = $("promptInput");
    if (input) {
      input.value = String(text || "");
    }
  }

  function replaceSelectedPromptText(text) {
    const input = $("promptInput");
    if (!input) {
      return;
    }
    const value = input.value || "";
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : value.length;
    input.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const nextPosition = start + text.length;
    input.selectionStart = nextPosition;
    input.selectionEnd = nextPosition;
  }

  function normalizePasteText(value) {
    if (typeof value !== "string") {
      return "";
    }
    if (!value || value === "[object Object]") {
      return "";
    }
    return value.replace(/\r\n/g, "\n");
  }

  function getTransferText(transfer) {
    if (!transfer) {
      return "";
    }

    if (typeof transfer === "string") {
      return normalizePasteText(transfer);
    }

    if (typeof transfer.getData === "function") {
      const preferredTypes = ["text/plain", "text", "Text"];
      for (const type of preferredTypes) {
        const text = normalizePasteText(transfer.getData(type));
        if (text) {
          return text;
        }
      }

      const types = Array.prototype.slice.call(transfer.types || []);
      for (const type of types) {
        if (/text/i.test(type)) {
          const text = normalizePasteText(transfer.getData(type));
          if (text) {
            return text;
          }
        }
      }
    }

    return "";
  }

  function guessImageMimeType(fileName) {
    const lower = String(fileName || "").toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".jpe") || lower.endsWith(".jfif")) {
      return "image/jpeg";
    }
    if (lower.endsWith(".webp")) {
      return "image/webp";
    }
    if (lower.endsWith(".gif")) {
      return "image/gif";
    }
    if (lower.endsWith(".bmp")) {
      return "image/bmp";
    }
    if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
      return "image/tiff";
    }
    if (lower.endsWith(".avif")) {
      return "image/avif";
    }
    if (lower.endsWith(".heic") || lower.endsWith(".heif")) {
      return "image/heif";
    }
    return "image/png";
  }

  function getFileExtension(file) {
    const name = String(file && file.name || "");
    const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function baseNameWithoutExtension(file) {
    const name = String(file && file.name || "reference");
    return name.replace(/\.[^.]+$/, "") || "reference";
  }

  function isReferenceDirectUpload(extension) {
    return DIRECT_REFERENCE_EXTENSIONS.includes(extension);
  }

  function isReferenceConvertible(extension) {
    return CONVERTIBLE_REFERENCE_EXTENSIONS.includes(extension);
  }

  function isReferenceRaw(extension) {
    return RAW_REFERENCE_EXTENSIONS.includes(extension);
  }

  function referenceFormatError(file) {
    const extension = getFileExtension(file);
    if (!extension) {
      return "Please choose an image file with a visible extension.";
    }
    if (isReferenceRaw(extension)) {
      return "RAW reference files are not supported. Please export the reference as PNG, JPEG, or WebP.";
    }
    if (extension === "tif" || extension === "tiff" || extension === "heic" || extension === "heif" || extension === "psd" || extension === "psb") {
      return "This reference format is not reliably supported in Photoshop UXP. Please export it as PNG, JPEG, or WebP.";
    }
    return "Unsupported reference format. Please choose PNG, JPEG, WebP, GIF, or BMP.";
  }

  async function makeImageObjectUrl(file) {
    const bytes = await file.read({ format: formats.binary });
    const blob = new Blob([bytes], { type: guessImageMimeType(file.name) });
    return URL.createObjectURL(blob);
  }

  function loadImageFromUrl(url, fileName) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not decode reference image: ${fileName || "image"}.`));
      image.src = url;
    });
  }

  function dataUrlToArrayBuffer(dataUrl) {
    const base64 = String(dataUrl || "").split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function canvasToPngBytes(canvas) {
    if (typeof canvas.toBlob === "function") {
      return new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
          if (!blob) {
            reject(new Error("Could not convert reference image to PNG."));
            return;
          }
          resolve(await blob.arrayBuffer());
        }, "image/png");
      });
    }

    return Promise.resolve(dataUrlToArrayBuffer(canvas.toDataURL("image/png")));
  }

  function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl || "").split(",");
    const metadata = parts[0] || "";
    const base64 = parts[1] || "";
    const mimeMatch = metadata.match(/^data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  function canvasToBlob(canvas, mimeType = "image/png") {
    if (typeof canvas.toBlob === "function") {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Could not render reference preview."));
            return;
          }
          resolve(blob);
        }, mimeType);
      });
    }

    return Promise.resolve(dataUrlToBlob(canvas.toDataURL(mimeType)));
  }

  function makePreviewCanvas(source, sourceWidth, sourceHeight) {
    const maxPreviewSide = 1200;
    const scale = Math.min(1, maxPreviewSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  async function makeWebpPreviewUrlWithImageBitmap(file) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("createImageBitmap is not available in this UXP runtime.");
    }

    const bytes = await file.read({ format: formats.binary });
    const blob = new Blob([bytes], { type: "image/webp" });
    const bitmap = await createImageBitmap(blob);
    try {
      const width = bitmap.width;
      const height = bitmap.height;
      if (!width || !height) {
        throw new Error("WebP preview has no readable pixel size.");
      }
      const canvas = makePreviewCanvas(bitmap, width, height);
      const previewBlob = await canvasToBlob(canvas, "image/png");
      return URL.createObjectURL(previewBlob);
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }

  async function closeDocumentWithoutSaving(doc, constants) {
    if (!doc) {
      return;
    }
    if (typeof doc.closeWithoutSaving === "function") {
      await doc.closeWithoutSaving();
      return;
    }
    await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
  }

  async function activatePhotoshopDocumentById(action, docId) {
    if (!docId) {
      return;
    }
    await action.batchPlay([
      {
        _obj: "select",
        _target: [{ _ref: "document", _id: docId }],
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  }

  async function makeWebpPreviewUrlWithPhotoshop(file) {
    const photoshop = require("photoshop");
    const { app, constants, core, action } = photoshop;
    return core.executeAsModal(async () => {
      const previousDocId = app.documents && app.documents.length && app.activeDocument ? app.activeDocument.id : null;
      const tempFolder = await fs.getTemporaryFolder();
      const previewFile = await tempFolder.createFile(`flux2-webp-reference-preview-${Date.now()}.png`, { overwrite: true });
      let webpDoc = null;

      try {
        webpDoc = await app.open(file);
        await webpDoc.saveAs.png(previewFile, {}, true);
      } finally {
        if (webpDoc) {
          await closeDocumentWithoutSaving(webpDoc, constants);
        }
        try {
          await activatePhotoshopDocumentById(action, previousDocId);
        } catch (restoreError) {
          getLogger().warn(`Could not restore active Photoshop document after WebP preview conversion: ${restoreError.message || String(restoreError)}`);
        }
      }

      return makeImageObjectUrl(previewFile);
    }, { commandName: "Prepare WebP reference preview" });
  }

  async function makeWebpPreviewUrl(file) {
    try {
      return await makeWebpPreviewUrlWithImageBitmap(file);
    } catch (imageBitmapError) {
      getLogger().warn(`WebP preview via ImageBitmap failed: ${imageBitmapError.message || String(imageBitmapError)}. Trying Photoshop conversion.`);
    }

    try {
      return await makeWebpPreviewUrlWithPhotoshop(file);
    } catch (photoshopError) {
      getLogger().warn(`WebP preview conversion failed: ${photoshopError.message || String(photoshopError)}. Reference will still be used without panel preview.`);
      return null;
    }
  }

  function makePreparedReference(name, displayName, bytes, convertedFrom) {
    return {
      name,
      displayName,
      convertedFrom,
      read: async () => bytes
    };
  }

  async function convertReferenceToPng(file) {
    const sourceUrl = await makeImageObjectUrl(file);
    try {
      const image = await loadImageFromUrl(sourceUrl, file.name);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        throw new Error("Reference image has no readable pixel size.");
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, width, height);
      const bytes = await canvasToPngBytes(canvas);
      const safeName = `${baseNameWithoutExtension(file)}.png`;
      return makePreparedReference(safeName, file.name || safeName, bytes, getFileExtension(file));
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  async function prepareReferenceFile(file) {
    const extension = getFileExtension(file);
    if (isReferenceDirectUpload(extension)) {
      return {
        name: file.name,
        displayName: file.name,
        convertedFrom: "",
        read: (options) => file.read(options)
      };
    }

    if (isReferenceConvertible(extension)) {
      try {
        return await convertReferenceToPng(file);
      } catch (error) {
        throw new Error("This reference format could not be decoded in Photoshop UXP. Please export it as PNG, JPEG, or WebP.");
      }
    }

    throw new Error(referenceFormatError(file));
  }

  function insertPromptTextFromPaste(text) {
    const normalized = normalizePasteText(text);
    if (!normalized) {
      return false;
    }
    replaceSelectedPromptText(normalized);
    saveCurrentSettings();
    lastProgrammaticPasteAt = Date.now();
    return true;
  }

  function normalizeMegapixels(value, fallback = globalThis.FluxLocalEditSettings.DEFAULTS.megapixels) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    let parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      parsed = Number(fallback);
    }
    if (!Number.isFinite(parsed)) {
      parsed = globalThis.FluxLocalEditSettings.DEFAULTS.megapixels;
    }

    const clamped = Math.max(MEGAPIXELS_MIN, Math.min(MEGAPIXELS_MAX, parsed));
    return Math.round(clamped * MEGAPIXELS_PRECISION) / MEGAPIXELS_PRECISION;
  }

  function normalizeGenerationSettings(settings, forcedMode) {
    const source = settings || {};
    const mode = globalThis.FluxLocalEditSettings.normalizeMode(
      forcedMode || source.mode || source.activeMode || activeMode
    );
    const promptKey = mode === "fill" ? "fillPrompt" : "editPrompt";
    const hasDirectPrompt = Object.prototype.hasOwnProperty.call(source, "prompt");
    const prompt = hasDirectPrompt
      ? source.prompt
      : Object.prototype.hasOwnProperty.call(source, promptKey)
        ? source[promptKey]
        : modePrompts[mode];
    const merged = { ...globalThis.FluxLocalEditSettings.DEFAULTS, ...source };
    return {
      mode,
      comfyUrl: globalThis.FluxLocalEditSettings.DEFAULTS.comfyUrl,
      megapixels: normalizeMegapixels(merged.megapixels),
      roundingMultiple: 16,
      seed: merged.seed == null || merged.seed === "" ? "random" : merged.seed,
      autoPlace: true,
      prompt: String(prompt == null ? "" : prompt),
      negativePrompt: ""
    };
  }

  function getMegapixelsValue() {
    const readout = $("targetReadout");
    return normalizeMegapixels(
      readout && readout.dataset.value,
      globalThis.FluxLocalEditSettings.DEFAULTS.megapixels
    );
  }

  function setMegapixelsValue(value) {
    const megapixels = normalizeMegapixels(value);
    const readout = $("targetReadout");
    const readoutValue = $("targetReadoutValue");
    if (readout) {
      readout.dataset.value = String(megapixels);
      readout.setAttribute("aria-label", `${megapixels} megapixels`);
      readout.parentElement.classList.toggle("is-fractional", String(megapixels).includes("."));
    }
    if (readoutValue) {
      readoutValue.textContent = String(megapixels);
    }
    document.querySelectorAll(".mp-option").forEach((option) => {
      const isSelected = Number(option.dataset.value) === megapixels;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-selected", isSelected ? "true" : "false");
    });
    return megapixels;
  }

  function closeMegapixelsMenu() {
    const menu = $("mpMenu");
    const readout = $("targetReadout");
    if (!menu || !readout) {
      return;
    }
    menu.hidden = true;
    setPromptMenuBackdropVisible(false);
    readout.setAttribute("aria-expanded", "false");
  }

  function positionMegapixelsMenu() {
    const menu = $("mpMenu");
    const readout = $("targetReadout");
    const panel = document.querySelector(".panel-content");
    if (!menu || !readout || !panel) {
      return;
    }

    const panelBounds = panel.getBoundingClientRect();
    const readoutBounds = readout.getBoundingClientRect();
    menu.style.top = `${Math.round(readoutBounds.bottom - panelBounds.top + 6)}px`;
    menu.style.right = `${Math.max(0, Math.round(panelBounds.right - readoutBounds.right))}px`;
  }

  function setPromptMenuBackdropVisible(isVisible) {
    const input = $("promptInput");
    const backdrop = $("promptMenuBackdrop");
    if (!input || !backdrop) {
      return;
    }

    const shouldShow = isVisible && !input.hidden;
    backdrop.textContent = input.value || "";
    backdrop.hidden = !shouldShow;
    input.classList.toggle("is-menu-suppressed", shouldShow);
  }

  function toggleMegapixelsMenu() {
    const menu = $("mpMenu");
    const readout = $("targetReadout");
    if (!menu || !readout) {
      return;
    }
    const shouldOpen = menu.hidden;
    if (shouldOpen) {
      closeModeMenu();
      positionMegapixelsMenu();
    }
    menu.hidden = !shouldOpen;
    setPromptMenuBackdropVisible(shouldOpen);
    readout.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  }

  function chooseMegapixels(value) {
    setMegapixelsValue(value);
    closeMegapixelsMenu();
    saveCurrentSettings();
    refreshSelectionHint();
  }

  function positionModeMenu() {
    const menu = $("modeMenu");
    const trigger = $("modeTriggerWrap");
    const panel = document.querySelector(".panel-content");
    if (!menu || !trigger || !panel) return;
    const panelBounds = panel.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    menu.style.top = `${Math.round(triggerBounds.bottom - panelBounds.top + 6)}px`;
    menu.style.left = `${Math.max(0, Math.round(triggerBounds.left - panelBounds.left))}px`;
    menu.style.width = `${Math.max(154, Math.round(triggerBounds.width))}px`;
  }

  function closeModeMenu() {
    const menu = $("modeMenu");
    const button = $("modeMenuButton");
    const trigger = $("modeTriggerWrap");
    if (!menu || !button) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (trigger) trigger.classList.remove("is-open");
    setPromptMenuBackdropVisible(false);
  }

  function toggleModeMenu() {
    const menu = $("modeMenu");
    const button = $("modeMenuButton");
    const trigger = $("modeTriggerWrap");
    if (!menu || !button || isGenerating) return;
    const shouldOpen = menu.hidden;
    closeMegapixelsMenu();
    if (shouldOpen) positionModeMenu();
    menu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    if (trigger) trigger.classList.toggle("is-open", shouldOpen);
    setPromptMenuBackdropVisible(shouldOpen);
  }

  function updateModeUi() {
    if (!hasPanelDom()) return;
    const metadata = MODE_METADATA[activeMode];
    const modeName = $("pluginModeName");
    const model = $("modelIndicator");
    const modeButton = $("modeMenuButton");
    const prompt = $("promptInput");
    const referencePanel = $("referencePanel");
    if (modeName) modeName.textContent = `Flux Local Edit · ${metadata.label}`;
    if (model) {
      model.textContent = `Model: ${metadata.modelLabel}`;
      model.title = metadata.modelFile;
      model.setAttribute("aria-label", `Model ${metadata.modelLabel}; file ${metadata.modelFile}`);
    }
    if (modeButton) {
      modeButton.title = `Choose Edit or Fill · ${metadata.modelFile}`;
      modeButton.setAttribute(
        "aria-label",
        `Choose mode. Current mode ${metadata.label}. Model ${metadata.modelLabel}. File ${metadata.modelFile}.`
      );
    }
    if (prompt) {
      prompt.placeholder = metadata.placeholder;
      setPromptText(modePrompts[activeMode]);
    }
    if (referencePanel) referencePanel.hidden = activeMode === "fill";
    document.querySelectorAll(".mode-card").forEach((card) => {
      const selected = card.dataset.mode === activeMode;
      const option = card.querySelector(".mode-option");
      card.classList.toggle("is-selected", selected);
      if (option) option.setAttribute("aria-checked", selected ? "true" : "false");
    });
    setReferenceControlsBusy(isGenerating || activeMode === "fill");
  }

  function chooseMode(mode) {
    const nextMode = globalThis.FluxLocalEditSettings.normalizeMode(mode);
    if (isGenerating || nextMode === activeMode) {
      closeModeMenu();
      return;
    }
    captureActivePrompt();
    activeMode = nextMode;
    updateModeUi();
    closeModeMenu();
    saveCurrentSettings();
    refreshSelectionHint();
    getLogger().info(`Mode switched to ${MODE_METADATA[activeMode].label}; model ${MODE_METADATA[activeMode].modelLabel}.`);
  }

  function captureActivePrompt() {
    const input = $("promptInput");
    if (input) modePrompts[activeMode] = String(input.value || "");
  }

  function getUiSettings(mode = activeMode) {
    if (!hasPanelDom()) {
      const stored = globalThis.FluxLocalEditSettings.loadSettings();
      return normalizeGenerationSettings(stored, mode);
    }

    captureActivePrompt();
    const megapixels = getMegapixelsValue();
    return normalizeGenerationSettings({
      megapixels,
      prompt: modePrompts[mode],
      seed: "random"
    }, mode);
  }

  function applySettings(settings) {
    if (!hasPanelDom()) {
      return;
    }
    const merged = globalThis.FluxLocalEditSettings.normalize(settings);
    activeMode = merged.activeMode;
    modePrompts = {
      edit: merged.editPrompt,
      fill: merged.fillPrompt
    };
    setMegapixelsValue(merged.megapixels);
    updateModeUi();
  }

  function saveCurrentSettings() {
    captureActivePrompt();
    globalThis.FluxLocalEditSettings.saveSettings({
      activeMode,
      comfyUrl: globalThis.FluxLocalEditSettings.DEFAULTS.comfyUrl,
      megapixels: hasPanelDom() ? getMegapixelsValue() : globalThis.FluxLocalEditSettings.DEFAULTS.megapixels,
      roundingMultiple: 16,
      editPrompt: modePrompts.edit,
      fillPrompt: modePrompts.fill
    });
  }

  function setButtonLabel(button, text) {
    if (!button) {
      return;
    }
    const visualLabel = button.parentElement && button.parentElement.querySelector(".button-visual-label");
    if (visualLabel) {
      visualLabel.textContent = text;
    }
    const label = button.querySelector(".button-label");
    if (label) {
      label.textContent = text;
      return;
    }
    button.setAttribute("aria-label", text);
  }

  function setGenerateButtonText(text) {
    setButtonLabel($("generateBtn"), text);
  }

  function setProgress(value) {
    const loader = $("loaderProgress");
    if (!loader) {
      return;
    }

    if (!Number.isFinite(value)) {
      loader.style.width = "100%";
      loader.classList.add("is-active", "is-indeterminate");
      return;
    }

    // Сохраняем тонкую полосу независимой от остальной геометрии панели.
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    loader.classList.add("is-active");
    loader.classList.remove("is-indeterminate");
    loader.style.width = `${percent}%`;
  }

  function clearProgress() {
    const loader = $("loaderProgress");
    if (!loader) {
      return;
    }

    loader.classList.remove("is-active", "is-indeterminate");
    loader.style.width = "0";
  }

  function setBusy(isBusy) {
    const button = $("generateBtn");
    const modeButton = $("modeMenuButton");
    const modeTrigger = $("modeTriggerWrap");
    isGenerating = isBusy;
    if (modeButton) modeButton.disabled = isBusy;
    if (modeTrigger) modeTrigger.classList.toggle("is-disabled", isBusy);
    if (isBusy) {
      closeModeMenu();
      closeMegapixelsMenu();
    }
    if (!button) {
      return;
    }
    button.disabled = false;
    button.classList.toggle("is-busy", isBusy);
    button.classList.remove("is-stopping");
    button.setAttribute("aria-busy", isBusy ? "true" : "false");
    setButtonLabel(button, isBusy ? "Working..." : "Generate");
    setReferenceControlsBusy(isBusy || activeMode === "fill");
    if (isBusy) {
      setProgress(Number.NaN);
    } else {
      clearProgress();
    }
  }

  function updateBusyButtonLabel() {
    if (!isGenerating) {
      return;
    }

    const button = $("generateBtn");
    if (!button) {
      return;
    }
    if (cancelToken && cancelToken.cancelled) {
      setGenerateButtonText("Stopping...");
      return;
    }

    setGenerateButtonText(button.matches(":hover") ? "Stop" : "Working...");
  }

  function setPreview(downloaded) {
    const image = $("previewImage");
    const empty = $("previewEmpty");
    if (!image || !empty) {
      return;
    }
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
    }
    currentPreviewUrl = downloaded.objectUrl;
    image.src = downloaded.objectUrl;
    image.hidden = false;
    empty.hidden = true;
  }

  function setReferenceControlsBusy(isBusy) {
    const toggle = $("referenceToggle");
    const toggleWrap = toggle && toggle.parentElement;
    const checkbox = $("referenceButton");
    const clearButton = $("clearReferenceBtn");
    const clearWrap = $("clearReferenceWrap");
    const zone = $("referenceZone");
    if (checkbox) {
      checkbox.disabled = isBusy;
    }
    if (toggle) {
      toggle.classList.toggle("is-disabled", isBusy);
    }
    if (toggleWrap) {
      toggleWrap.classList.toggle("is-disabled", isBusy);
    }
    if (clearButton) {
      clearButton.disabled = isBusy || !referenceFile;
    }
    if (clearWrap) {
      clearWrap.classList.toggle("is-disabled", isBusy || !referenceFile);
    }
    if (zone) {
      zone.setAttribute("aria-disabled", "true");
    }
  }

  function updatePromptReferenceState() {
    const input = $("promptInput");
    const menu = $("mpMenu");
    if (!input) {
      return;
    }
    input.hidden = false;
    input.disabled = false;
    input.removeAttribute("readonly");
    if (!menu || menu.hidden) {
      input.classList.remove("is-menu-suppressed");
    }
  }

  function setReferenceEmptyLabel(text) {
    const empty = $("referenceEmpty");
    const label = empty && empty.querySelector("span");
    if (label) {
      label.textContent = text;
    }
  }

  function updateReferencePreview() {
    const checkbox = $("referenceButton");
    const image = $("referenceImage");
    const empty = $("referenceEmpty");
    const name = $("referenceName");
    const clearButton = $("clearReferenceBtn");
    const clearWrap = $("clearReferenceWrap");
    const zone = $("referenceZone");

    if (!image || !empty || !name || !clearButton || !clearWrap || !zone) {
      return;
    }

    const hasReference = Boolean(referenceFile);
    clearButton.disabled = !hasReference || isGenerating;
    clearWrap.hidden = !hasReference;
    clearWrap.classList.toggle("is-disabled", !hasReference || isGenerating);
    zone.hidden = !hasReference;
    if (checkbox) {
      checkbox.checked = hasReference;
      checkbox.setAttribute("aria-checked", hasReference ? "true" : "false");
    }
    updatePromptReferenceState();
    zone.setAttribute("aria-disabled", "true");

    if (hasReference) {
      name.textContent = referenceFile.displayName || referenceFile.name || "Reference image";
      setReferenceEmptyLabel("Preview unavailable. Reference will still be used.");

      if (referencePreviewUrl) {
        image.onload = () => {
          image.hidden = false;
          empty.hidden = true;
        };
        image.onerror = () => {
          image.hidden = true;
          empty.hidden = false;
        };
        image.hidden = false;
        empty.hidden = true;
        image.src = referencePreviewUrl;
      } else {
        image.removeAttribute("src");
        image.hidden = true;
        empty.hidden = false;
      }
    } else {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      image.hidden = true;
      setReferenceEmptyLabel("Preview unavailable. Reference will still be used.");
      empty.hidden = false;
      name.textContent = "";
    }
  }

  async function setReferenceFile(file) {
    if (!file) {
      return;
    }

    if (referencePreviewUrl) {
      URL.revokeObjectURL(referencePreviewUrl);
      referencePreviewUrl = null;
    }

    const sourceExtension = getFileExtension(file);
    referenceFile = await prepareReferenceFile(file);
    referencePreviewUrl = sourceExtension === "webp"
      ? await makeWebpPreviewUrl(file)
      : await makeImageObjectUrl(referenceFile);
    updateReferencePreview();
    const conversionNote = referenceFile.convertedFrom ? ` Converted from ${referenceFile.convertedFrom.toUpperCase()} to PNG.` : "";
    getLogger().info(`Reference image selected: ${referenceFile.displayName || referenceFile.name || "image"}.${conversionNote}`);
  }

  function clearReferenceFile() {
    if (referencePreviewUrl) {
      URL.revokeObjectURL(referencePreviewUrl);
    }
    referenceFile = null;
    referencePreviewUrl = null;
    closeMegapixelsMenu();
    updateReferencePreview();
    const input = $("promptInput");
    if (input) {
      input.focus();
    }
    getLogger().info("Reference image removed. Single-image workflow will be used.");
  }

  async function handleChooseReference() {
    try {
      const picked = await fs.getFileForOpening({
        allowMultiple: false
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      if (file) {
        await setReferenceFile(file);
      }
    } catch (error) {
      getLogger().error(`Could not choose reference image: ${error.message || String(error)}`);
    }
  }

  function updateMegapixelsReadout(settings) {
    setMegapixelsValue(settings.megapixels);
  }

  function updateSizeHint(selection, settings, mode = activeMode, fillSession) {
    const sizeHint = $("sizeHint");
    if (!sizeHint) {
      return;
    }
    if (mode === "fill") {
      const info = fillSession || selection;
      sizeHint.textContent =
        `Fill context ${info.contextWidth} x ${info.contextHeight}px; render ${info.targetWidth} x ${info.targetHeight}px ` +
        `(${Number(info.targetMegapixels).toFixed(2)} MP). Original selection becomes the layer mask.`;
      updateMegapixelsReadout(settings);
      return;
    }
    const target = globalThis.Flux2ImageSizing.computeTargetSize(
      selection.width,
      selection.height,
      settings.megapixels,
      settings.roundingMultiple
    );
    updateMegapixelsReadout(settings);
    sizeHint.textContent =
      `Render ${target.targetWidth} x ${target.targetHeight}px (${target.targetMegapixels.toFixed(2)} MP). ` +
      `Final layer returns to ${selection.width} x ${selection.height}px.`;
  }

  async function refreshSelectionHint() {
    if (!$("sizeHint")) {
      return;
    }
    try {
      const settings = getUiSettings(activeMode);
      if (activeMode === "fill") {
        const context = await globalThis.FluxLocalEditFillPhotoshop.getSelectionContext(settings);
        updateSizeHint(context, settings, "fill", context);
      } else {
        const selection = await globalThis.Flux2Photoshop.getSolidSelection();
        updateSizeHint(selection, settings, "edit");
      }
    } catch (error) {
      updateMegapixelsReadout(getUiSettings());
      $("sizeHint").textContent = error.message;
    }
  }

  async function handleStop() {
    if (!isGenerating || !cancelToken || cancelToken.cancelled) {
      return;
    }

    cancelToken.cancelled = true;
    const button = $("generateBtn");
    if (button) {
      button.classList.add("is-stopping");
    }
    updateBusyButtonLabel();
    const activeLogger = getLogger();
    activeLogger.warn("Stop requested. Interrupting ComfyUI generation.");

    try {
      if (currentClient && currentPromptId) {
        await currentClient.deletePrompt(currentPromptId);
        activeLogger.warn(`Removed queued ComfyUI prompt ${currentPromptId}.`);
      }
    } catch (error) {
      activeLogger.warn(`Could not remove queued prompt: ${error.message || String(error)}`);
    }

    try {
      if (currentClient) {
        await currentClient.interrupt();
        activeLogger.warn("ComfyUI interrupt sent.");
      }
    } catch (error) {
      activeLogger.warn(`Could not interrupt ComfyUI: ${error.message || String(error)}`);
    }
  }

  function actionInfoFromSettings(settings, seed, mode) {
    const normalized = normalizeGenerationSettings(settings, mode);
    return {
      mode: normalized.mode,
      prompt: normalized.prompt,
      megapixels: normalized.megapixels,
      roundingMultiple: 16,
      seed: seed == null ? normalized.seed : seed,
      comfyUrl: globalThis.FluxLocalEditSettings.DEFAULTS.comfyUrl
    };
  }

  async function recordGenerateAction(settings, seed, mode) {
    try {
      const photoshop = require("photoshop");
      if (!photoshop || !photoshop.action || typeof photoshop.action.recordAction !== "function") {
        return;
      }

      await photoshop.action.recordAction({
        name: `Flux Local Edit - ${MODE_METADATA[mode].label}`,
        methodName: ACTION_METHOD_NAMES[mode]
      }, actionInfoFromSettings(settings, seed, mode));
    } catch (error) {
      console.debug(`Flux Local Edit action recording skipped: ${error.message || String(error)}`);
    }
  }

  async function runGenerate(options = {}) {
    if (isGenerating) {
      if (options.allowStop) {
        await handleStop();
        return;
      }
      throw new Error("Flux Local Edit generation is already running.");
    }

    const requestedMode = globalThis.FluxLocalEditSettings.normalizeMode(
      options.mode || options.settings && (options.settings.mode || options.settings.activeMode) || activeMode
    );
    const settings = normalizeGenerationSettings(options.settings || getUiSettings(requestedMode), requestedMode);
    if (hasPanelDom() && requestedMode !== activeMode) {
      captureActivePrompt();
      activeMode = requestedMode;
      updateModeUi();
    }
    const selectedReferenceFile = requestedMode === "edit"
      ? options.referenceFile === undefined ? referenceFile : options.referenceFile
      : null;
    if (hasPanelDom() && !options.settings) {
      saveCurrentSettings();
    }

    const activeLogger = getLogger();
    activeLogger.clear();
    cancelToken = { cancelled: false };
    const token = cancelToken;
    currentClient = null;
    currentPromptId = "";
    setBusy(true);

    try {
      const adapters = {
        edit: globalThis.FluxLocalEditEditAdapter,
        fill: globalThis.FluxLocalEditFillAdapter
      };
      const adapter = adapters[requestedMode];
      if (!adapter || typeof adapter.run !== "function") {
        throw new Error(`Mode adapter ${requestedMode} is unavailable.`);
      }
      activeLogger.info(`Starting ${MODE_METADATA[requestedMode].label} with ${MODE_METADATA[requestedMode].modelLabel}.`);
      return await adapter.run({
        settings,
        referenceFile: selectedReferenceFile,
        logger: activeLogger,
        cancelToken: token,
        shouldRecordAction: Boolean(options.recordAction),
        throwIfCancelled,
        updateSelectionHint: updateSizeHint,
        recordAction: recordGenerateAction,
        setClient(client) {
          currentClient = client;
        },
        setPromptId(promptId) {
          currentPromptId = promptId;
        },
        onProgress(progress) {
          if (progress && progress.max) {
            setProgress((Number(progress.value) / Number(progress.max)) * 100);
            activeLogger.info(`Sampling ${progress.value}/${progress.max}.`);
          }
        },
        setPreview
      });
    } catch (error) {
      if (error && error.kind === "cancelled") {
        activeLogger.warn("Generation stopped by user.");
      } else {
        const message = error && error.message || String(error);
        if (/out of memory|cuda.*memory|allocation/i.test(message)) {
          activeLogger.error(`${message} Reduce MP and try again.`);
        } else {
          activeLogger.error(message);
        }
      }
      return { mode: requestedMode, error };
    } finally {
      if (cancelToken === token) {
        cancelToken = null;
      }
      currentClient = null;
      currentPromptId = "";
      setBusy(false);
    }
  }

  async function handleGenerate() {
    await runGenerate({ allowStop: true, recordAction: true });
  }

  function bindSurfaceHover(control, surface) {
    if (!control || !surface) {
      return;
    }
    const setHovered = (isHovered) => {
      surface.classList.toggle("is-hovered", isHovered && !surface.classList.contains("is-disabled"));
    };
    [surface, control].forEach((target) => {
      target.addEventListener("mouseenter", () => setHovered(true));
      target.addEventListener("mouseleave", () => setHovered(false));
    });
    control.addEventListener("focus", () => setHovered(true));
    control.addEventListener("blur", () => setHovered(false));
  }

  function scrollPromptWithWheel(event) {
    const input = $("promptInput");
    if (!input || event.defaultPrevented || (event.target && event.target !== input)) {
      return;
    }

    const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
    const deltaY =
      Number(event.deltaY) ||
      -Number(event.wheelDeltaY) ||
      -Number(event.wheelDelta) ||
      Number(event.detail) * 16 ||
      0;
    if (!maxScrollTop || !deltaY) {
      return;
    }

    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, input.scrollTop + deltaY));
    if (nextScrollTop === input.scrollTop) {
      return;
    }

    input.scrollTop = nextScrollTop;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  globalThis[ACTION_METHOD_NAMES.edit] = async function fluxLocalEditRecordedEdit(executionContext, info) {
    const settings = normalizeGenerationSettings(info, "edit");
    const result = await runGenerate({ source: "action", mode: "edit", settings });
    return actionInfoFromSettings(settings, result && result.seed || settings.seed, "edit");
  };

  globalThis[ACTION_METHOD_NAMES.fill] = async function fluxLocalEditRecordedFill(executionContext, info) {
    const settings = normalizeGenerationSettings(info, "fill");
    const result = await runGenerate({ source: "action", mode: "fill", settings });
    return actionInfoFromSettings(settings, result && result.seed || settings.seed, "fill");
  };

  function attachEvents() {
    bindSurfaceHover($("generateBtn"), $("generateBtn").parentElement);
    bindSurfaceHover($("referenceToggle"), $("referenceToggle").parentElement);
    bindSurfaceHover($("clearReferenceBtn"), $("clearReferenceWrap"));
    bindSurfaceHover($("targetReadout"), document.querySelector(".mp-dropdown"));
    bindSurfaceHover($("modeMenuButton"), $("modeTriggerWrap"));

    $("modeMenuButton").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleModeMenu();
    });
    document.querySelectorAll(".mode-option").forEach((option) => {
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        chooseMode(option.dataset.mode);
      });
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          chooseMode(option.dataset.mode);
        }
      });
    });

    $("generateBtn").addEventListener("click", handleGenerate);
    $("generateBtn").addEventListener("mouseenter", updateBusyButtonLabel);
    $("generateBtn").addEventListener("mouseleave", updateBusyButtonLabel);
    $("referenceToggle").addEventListener("click", (event) => {
      event.preventDefault();
      if (!$("referenceButton").disabled) {
        handleChooseReference();
      }
    });
    $("referenceToggle").addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!$("referenceButton").disabled) {
          handleChooseReference();
        }
      }
    });
    $("clearReferenceBtn").addEventListener("click", clearReferenceFile);

    $("targetReadout").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMegapixelsMenu();
    });
    document.querySelectorAll(".mp-option").forEach((option) => {
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        chooseMegapixels(option.dataset.value);
      });
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          chooseMegapixels(option.dataset.value);
        }
      });
    });
    document.addEventListener("click", () => {
      closeMegapixelsMenu();
      closeModeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMegapixelsMenu();
        closeModeMenu();
      }
    });
    window.addEventListener("resize", () => {
      if (!$("mpMenu").hidden) {
        positionMegapixelsMenu();
      }
      if (!$("modeMenu").hidden) {
        positionModeMenu();
      }
    });

    $("promptInput").addEventListener("beforeinput", (event) => {
      if (event.inputType !== "insertFromPaste") {
        return;
      }
      const text = getTransferText(event.dataTransfer);
      if (text && insertPromptTextFromPaste(text)) {
        event.preventDefault();
      }
    });

    $("promptInput").addEventListener("paste", (event) => {
      if (Date.now() - lastProgrammaticPasteAt < 100) {
        event.preventDefault();
        return;
      }

      const text = getTransferText(event.clipboardData || window.clipboardData);
      if (text && insertPromptTextFromPaste(text)) {
        event.preventDefault();
        return;
      }

      setTimeout(saveCurrentSettings, 0);
    });

    $("promptInput").addEventListener("change", saveCurrentSettings);
    $("promptInput").addEventListener("input", saveCurrentSettings);
    const promptInput = $("promptInput");
    const promptPanel = document.querySelector(".prompt-panel");
    ["wheel", "mousewheel", "DOMMouseScroll"].forEach((eventName) => {
      promptInput.addEventListener(eventName, scrollPromptWithWheel);
      promptPanel.addEventListener(eventName, scrollPromptWithWheel, true);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    logger = globalThis.Flux2Logger.createLogger(null);
    applySettings(globalThis.FluxLocalEditSettings.loadSettings());
    updateReferencePreview();
    attachEvents();
    refreshSelectionHint();
    logger.info("Ready. Choose Edit or Fill, make a Photoshop selection, then click Generate.");
  });
})();
