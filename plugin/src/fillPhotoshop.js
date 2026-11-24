(function () {
  const photoshop = require("photoshop");
  const { app, constants, core, action, imaging } = photoshop;
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;

  const RGB = "sRGB IEC61966-2.1";

  function toNumber(value) {
    if (typeof value === "number") return value;
    if (value && typeof value._value === "number") return value._value;
    if (value && typeof value.value === "number") return value.value;
    return Number(value);
  }

  function plainBounds(bounds) {
    if (Array.isArray(bounds)) {
      return {
        left: Math.floor(toNumber(bounds[0])),
        top: Math.floor(toNumber(bounds[1])),
        right: Math.ceil(toNumber(bounds[2])),
        bottom: Math.ceil(toNumber(bounds[3]))
      };
    }
    return {
      left: Math.floor(toNumber(bounds.left)),
      top: Math.floor(toNumber(bounds.top)),
      right: Math.ceil(toNumber(bounds.right)),
      bottom: Math.ceil(toNumber(bounds.bottom))
    };
  }

  function makeNonce() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function getDocumentById(docId) {
    return Array.from(app.documents || []).find((doc) => Number(doc.id) === Number(docId)) || null;
  }

  async function getActiveDocument() {
    if (!app.documents || !app.documents.length || !app.activeDocument) {
      throw new Error("No active Photoshop document.");
    }
    return app.activeDocument;
  }

  async function activateDocumentById(docId) {
    await action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "document", _id: docId }],
      _options: { dialogOptions: "dontDisplay" }
    }], {});
  }

  async function closeWithoutSaving(doc) {
    if (!doc) return;
    if (typeof doc.closeWithoutSaving === "function") {
      await doc.closeWithoutSaving();
      return;
    }
    await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
  }

  function findChannelByName(doc, name) {
    if (!doc || !name) return null;
    try {
      if (doc.channels && typeof doc.channels.getByName === "function") {
        const found = doc.channels.getByName(name);
        if (found) return found;
      }
    } catch (error) {
      // Some hosts throw instead of returning null when a channel is missing.
    }
    return Array.from(doc.channels || []).find((channel) => {
      try {
        return channel.name === name;
      } catch (error) {
        return false;
      }
    }) || null;
  }

  async function prepareExportDocument(doc) {
    if (constants.DocumentMode && constants.ChangeMode && doc.mode !== constants.DocumentMode.RGB) {
      await doc.changeMode(constants.ChangeMode.RGB);
    }
    if (constants.BitsPerChannelType && doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) {
      doc.bitsPerChannel = constants.BitsPerChannelType.EIGHT;
    }
  }

  async function fillCurrentSelection(fillValue) {
    await action.batchPlay([{
      _obj: "fill",
      using: { _enum: "fillContents", _value: fillValue },
      opacity: { _unit: "percentUnit", _value: 100 },
      mode: { _enum: "blendMode", _value: "normal" },
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
  }

  async function readSelectionMask(doc, bounds) {
    const { imageData, sourceBounds } = await imaging.getSelection({ documentID: doc.id, sourceBounds: bounds });
    try {
      const box = plainBounds(sourceBounds);
      if (imageData.components !== 1 || box.right - box.left !== imageData.width || box.bottom - box.top !== imageData.height) {
        throw new Error("Photoshop did not return a matching grayscale Fill selection.");
      }
      const raw = await imageData.getData();
      const depth = imageData.componentSize;
      if (![8, 16, 32].includes(depth)) throw new Error("Unsupported Fill selection mask depth.");
      const multiplier = depth === 8 ? 1 : depth === 16 ? 255 / 32768 : 255;
      return { bounds: box, data: depth === 8 ? new Uint8Array(raw) :
        Uint8Array.from(raw, (value) => Math.max(0, Math.min(255, Math.round(value * multiplier)))) };
    } finally { imageData.dispose(); }
  }

  async function readRgb(doc, bounds, targetSize) {
    const { imageData, sourceBounds, level } = await imaging.getPixels({ documentID: doc.id, sourceBounds: bounds,
      ...(targetSize ? { targetSize } : {}), componentSize: 8, colorSpace: "RGB", colorProfile: RGB, applyAlpha: false });
    try {
      const box = plainBounds(sourceBounds), divisor = 2 ** (level || 0);
      const matches = box.left === Math.floor(bounds.left / divisor) && box.top === Math.floor(bounds.top / divisor) &&
        box.right >= Math.floor(bounds.right / divisor) && box.bottom >= Math.floor(bounds.bottom / divisor);
      if (!matches || (imageData.components !== 3 && imageData.components !== 4)) return null;
      const data = await imageData.getData({ chunky: true });
      return { width: imageData.width, height: imageData.height, components: imageData.components, data: new Uint8Array(data) };
    } finally { imageData.dispose(); }
  }

  function analysisSize(w, h) {
    const scale = Math.min(1, 256 / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  function pixelBounds(w, h) { return { left: 0, top: 0, right: w, bottom: h }; }

  async function fitLargeExport(doc, profile) {
    if (!profile.nativeTransfer) {
      await doc.resizeImage(profile.targetWidth, profile.targetHeight, undefined,
        constants.ResampleMethod && constants.ResampleMethod.BICUBIC);
    }
  }

  async function deleteTemp(file, logger) {
    if (file && typeof file.delete === "function") {
      await Promise.resolve().then(() => file.delete()).catch((error) => logger && logger.warn(`Fill temporary file cleanup: ${error.message}`));
    }
  }

  async function getSelectionContext(settings) {
    const sourceDoc = await getActiveDocument();
    const rawBounds = await Promise.resolve(sourceDoc.selection.bounds);
    if (!rawBounds) {
      throw new Error("No active selection. Select one or more areas first.");
    }
    const selectionBounds = plainBounds(rawBounds);
    const documentWidth = Math.max(1, Math.round(toNumber(sourceDoc.width)));
    const documentHeight = Math.max(1, Math.round(toNumber(sourceDoc.height)));
    return { docId: sourceDoc.id, ...globalThis.FluxLocalEditFillBlend.plan(selectionBounds, documentWidth, documentHeight, settings) };
  }

  function collectLayers(doc) {
    const result = [];
    const visit = (layers) => {
      Array.from(layers || []).forEach((layer) => {
        result.push(layer);
        if (layer.layers && layer.layers.length) visit(layer.layers);
      });
    };
    visit(doc && doc.layers);
    return result;
  }

  async function restoreActiveLayers(doc, layerIds) {
    const wanted = new Set((layerIds || []).map(Number));
    const layers = collectLayers(doc).filter((layer) => wanted.has(Number(layer.id)));
    if (!layers.length) return;

    try {
      doc.activeLayers = layers;
      return;
    } catch (error) {
      // Fallback for hosts where activeLayers assignment is rejected.
    }

    const descriptors = layers.map((layer, index) => {
      const descriptor = {
        _obj: "select",
        _target: [{ _ref: "layer", _id: layer.id }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" }
      };
      if (index > 0) {
        descriptor.selectionModifier = {
          _enum: "selectionModifierType",
          _value: "addToSelection"
        };
      }
      return descriptor;
    });
    await action.batchPlay(descriptors, {});
  }

  async function exportFillAssets(settings, logger, options = {}) {
    return core.executeAsModal(async () => {
      const sourceDoc = options.docId ? getDocumentById(options.docId) : await getActiveDocument();
      if (!sourceDoc) throw new Error("The export source document was closed.");
      await activateDocumentById(sourceDoc.id);
      const rawBounds = await Promise.resolve(sourceDoc.selection.bounds);
      if (!rawBounds) {
        throw new Error("No active selection. Select one or more areas first.");
      }

      const selectionBounds = plainBounds(rawBounds);
      const documentWidth = Math.max(1, Math.round(toNumber(sourceDoc.width)));
      const documentHeight = Math.max(1, Math.round(toNumber(sourceDoc.height)));
      const blend = globalThis.FluxLocalEditFillBlend;
      const baseProfile = blend.plan(selectionBounds, documentWidth, documentHeight, settings);
      const nonce = makeNonce();
      const channelName = `Flux Local Edit Selection ${nonce}`;
      const activeLayerIds = Array.from(sourceDoc.activeLayers || []).map((layer) => layer.id);
      const tempFolder = await fs.getTemporaryFolder();
      let contextFile = null, maskFile = null;
      let contextDoc = null;
      let maskDoc = null;
      let keepSourceChannel = false;

      try {
        contextFile = await tempFolder.createFile(`flux-local-edit-context-${nonce}.png`, { overwrite: true });
        maskFile = await tempFolder.createFile(`flux-local-edit-mask-${nonce}.png`, { overwrite: true });
        await sourceDoc.selection.save(channelName);
        const sourceChannel = findChannelByName(sourceDoc, channelName);
        if (!sourceChannel) {
          throw new Error("Photoshop did not create the temporary selection channel.");
        }

        const inputMask = await readSelectionMask(sourceDoc, baseProfile.selectionBounds);
        const profile = blend.generationMaskProfile(baseProfile, inputMask);
        const strictMask = Boolean(options.strictMask);
        logger && logger.info(`Fill context ${profile.contextWidth} x ${profile.contextHeight}px; ` +
          `render ${profile.targetWidth} x ${profile.targetHeight}px (${profile.targetMegapixels.toFixed(2)} MP); ` +
          `generation mask grow/blur ${profile.growWork}/${profile.blurWork}px` +
          (profile.maskThickness ? ` (limited for a ${profile.maskThickness.toFixed(1)}px-thick selection); ` : "; ") +
          `layer mask ${strictMask ? `inward feather up to ${profile.featherImage}px` : `grow/feather ${profile.layerGrow}/${profile.featherImage}px`}.`);

        contextDoc = await sourceDoc.duplicate(`Flux Local Edit context ${nonce}`, true);
        await prepareExportDocument(contextDoc);
        await contextDoc.crop(profile.contextBounds);
        const size = analysisSize(profile.contextWidth, profile.contextHeight);
        let original = null;
        try { original = await readRgb(contextDoc, pixelBounds(profile.contextWidth, profile.contextHeight), size); }
        catch (error) { logger && logger.warn(`Fill edge color reference unavailable: ${error.message}`); }
        await fitLargeExport(contextDoc, profile);
        await contextDoc.saveAs.png(contextFile, {}, true);
        await closeWithoutSaving(contextDoc);
        contextDoc = null;

        await activateDocumentById(sourceDoc.id);
        await sourceDoc.selection.load(sourceChannel, constants.SelectionType.REPLACE, false);
        maskDoc = await sourceDoc.duplicate(`Flux Local Edit mask ${nonce}`, false);
        await prepareExportDocument(maskDoc);
        const maskChannel = findChannelByName(maskDoc, channelName);
        if (!maskChannel) {
          throw new Error("The saved selection was not preserved in the mask document.");
        }

        await maskDoc.flatten(); // A temporary mask layer must not inherit source group masks/opacity.
        await maskDoc.createLayer(constants.LayerKind.NORMAL, { name: "Flux Local Edit mask pixels" });
        await maskDoc.selection.selectAll();
        await fillCurrentSelection("black");
        await maskDoc.selection.load(maskChannel, constants.SelectionType.REPLACE, false);
        await fillCurrentSelection("white");
        await maskDoc.crop(profile.contextBounds);
        await fitLargeExport(maskDoc, profile);
        await maskDoc.selection.deselect();
        await maskDoc.saveAs.png(maskFile, {}, true);
        await closeWithoutSaving(maskDoc);
        maskDoc = null;

        await activateDocumentById(sourceDoc.id);
        await sourceDoc.selection.load(sourceChannel, constants.SelectionType.REPLACE, false);
        keepSourceChannel = true;

        return {
          docId: sourceDoc.id,
          docTitle: sourceDoc.title || sourceDoc.name || "Untitled",
          activeLayerIds,
          selectionChannelName: channelName,
          ...profile,
          strictMask,
          inputMask,
          original,
          contextFile,
          maskFile,
          nonce
        };
      } finally {
        if (contextDoc) await closeWithoutSaving(contextDoc).catch(() => null);
        if (maskDoc) await closeWithoutSaving(maskDoc).catch(() => null);
        if (!keepSourceChannel) {
          await deleteTemp(contextFile, logger);
          await deleteTemp(maskFile, logger);
        }
        const liveSource = getDocumentById(sourceDoc.id);
        if (liveSource) {
          await activateDocumentById(sourceDoc.id).catch(() => null);
          const liveChannel = findChannelByName(liveSource, channelName);
          if (liveChannel) {
            await Promise.resolve().then(() => liveSource.selection.load(liveChannel, constants.SelectionType.REPLACE, false)).catch(() => null);
            if (!keepSourceChannel) {
              await Promise.resolve().then(() => liveChannel.remove()).catch(() => null);
              await restoreActiveLayers(liveSource, activeLayerIds).catch(() => null);
            }
          }
        }
      }
    }, { commandName: "Export Flux Local Edit Fill assets" });
  }

  async function placeEmbeddedFile(fileEntry) {
    const token = await fs.createSessionToken(fileEntry);
    await action.batchPlay([{
      _obj: "placeEvent",
      null: { _path: token, _kind: "local" },
      linked: false,
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: 0 },
        vertical: { _unit: "pixelsUnit", _value: 0 }
      },
      _isCommand: false,
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
  }

  async function transformActiveLayer(scaleXPercent, scaleYPercent, dx, dy) {
    await action.batchPlay([{
      _obj: "transform",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      width: { _unit: "percentUnit", _value: scaleXPercent },
      height: { _unit: "percentUnit", _value: scaleYPercent },
      offset: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: dx },
        vertical: { _unit: "pixelsUnit", _value: dy }
      },
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
  }

  function boundsSize(bounds) {
    return {
      width: Math.max(0, bounds.right - bounds.left),
      height: Math.max(0, bounds.bottom - bounds.top)
    };
  }

  function centerOf(bounds) {
    return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  }

  function activeLayer(doc) {
    if (doc.activeLayers && doc.activeLayers.length) return doc.activeLayers[0];
    return doc.layers && doc.layers.length ? doc.layers[0] : null;
  }

  async function fitLayerToBounds(layer, targetBounds, logger) {
    const startBounds = plainBounds(layer.boundsNoEffects || layer.bounds);
    const startSize = boundsSize(startBounds);
    const targetSize = boundsSize(targetBounds);
    if (startSize.width < 1 || startSize.height < 1 || targetSize.width < 1 || targetSize.height < 1) {
      throw new Error("Placed Fill layer has empty bounds.");
    }
    const startCenter = centerOf(startBounds);
    const targetCenter = centerOf(targetBounds);
    await transformActiveLayer(
      targetSize.width / startSize.width * 100,
      targetSize.height / startSize.height * 100,
      targetCenter.x - startCenter.x,
      targetCenter.y - startCenter.y
    );
    const finalBounds = plainBounds(layer.boundsNoEffects || layer.bounds);
    const finalDx = targetBounds.left - finalBounds.left;
    const finalDy = targetBounds.top - finalBounds.top;
    if (finalDx || finalDy) await layer.translate(finalDx, finalDy);
    logger && logger.info(`Aligned layer to ${targetSize.width} x ${targetSize.height}px context rect.`);
  }

  async function createLayerMaskFromSelection() {
    await action.batchPlay([{
      _obj: "make",
      new: { _class: "channel" },
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: "revealSelection" },
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
  }

  async function selectBlendMask(doc, mask) {
    const { left, top, right, bottom } = mask.bounds;
    const imageData = await imaging.createImageDataFromBuffer(mask.data, { width: right - left, height: bottom - top,
      components: 1, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
    try { await imaging.putSelection({ documentID: doc.id, imageData, replace: true, targetBounds: { left, top } }); }
    finally { imageData.dispose(); }
  }

  // Work on the downloaded PNG in a temporary Photoshop document, never on the user's layers.
  async function correctResultEdge(resultFile, session, logger, check) {
    if (!session.original) return null;
    const { contextWidth: w, contextHeight: h, contextBounds: crop, selectionBounds: box } = session;
    let resultDoc = null, corrected = null, saved = false;
    try {
      check();
      resultDoc = await app.open(resultFile);
      if (toNumber(resultDoc.width) !== w || toNumber(resultDoc.height) !== h) {
        if (toNumber(resultDoc.width) !== session.targetWidth || toNumber(resultDoc.height) !== session.targetHeight) {
          const error = new Error("The generated image does not match its Fill context.");
          error.kind = "fill_geometry";
          throw error;
        }
        await resultDoc.resizeImage(w, h, undefined, constants.ResampleMethod && constants.ResampleMethod.BICUBIC);
      }
      const blend = globalThis.FluxLocalEditFillBlend;
      const generated = await readRgb(resultDoc, pixelBounds(w, h), analysisSize(w, h));
      const field = blend.seamField(session.original, generated, session.inputMask, session);
      if (!field) return null;

      const reach = session.strictMask ? 0 : session.layerGrow + 3 * session.featherImage;
      const left = Math.max(0, box.left - crop.left - reach), top = Math.max(0, box.top - crop.top - reach);
      const right = Math.min(w, box.right - crop.left + reach), bottom = Math.min(h, box.bottom - crop.top + reach);
      const foreground = await resultDoc.createLayer(constants.LayerKind.NORMAL, { name: "Fill edge color correction" });
      const stripHeight = Math.max(1, Math.floor(750000 / (right - left)));
      for (let y = top; y < bottom; y += stripHeight) {
        check();
        const end = Math.min(bottom, y + stripHeight);
        const pixels = await readRgb(resultDoc, { left, top: y, right, bottom: end });
        if (!pixels || pixels.width !== right - left || pixels.height !== end - y) return null;
        if (pixels.components === 4) {
          for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] !== 255) return null;
        }
        blend.applySeam(pixels.data, pixels.width, pixels.height, pixels.components, left, y, field);
        const imageData = await imaging.createImageDataFromBuffer(pixels.data, { width: pixels.width,
          height: pixels.height, components: pixels.components, colorSpace: "RGB", colorProfile: RGB });
        try { await imaging.putPixels({ documentID: resultDoc.id, layerID: foreground.id, imageData,
          replace: false, targetBounds: { left, top: y } }); }
        finally { imageData.dispose(); }
      }
      check();
      const temp = await fs.getTemporaryFolder();
      corrected = await temp.createFile(`local-edit-fill-blended-${session.nonce}.png`, { overwrite: true });
      await resultDoc.flatten();
      await resultDoc.saveAs.png(corrected, {}, true);
      logger && logger.info(`Corrected the Fill seam (maximum RGB offset ${field.largest.toFixed(1)} levels).`);
      saved = true;
      return corrected;
    } finally {
      try { if (resultDoc) await closeWithoutSaving(resultDoc); }
      catch (error) { logger && logger.warn(`Could not close the Fill result work document: ${error.message}`); }
      if (!saved) await deleteTemp(corrected, logger);
    }
  }

  async function deleteLayer(layer) {
    if (!layer) return;
    if (typeof layer.delete === "function") {
      await layer.delete();
      return;
    }
    await action.batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: layer.id }],
      _options: { dialogOptions: "dontDisplay" }
    }], {});
  }

  async function restoreFillSession(session, options, logger) {
    if (!session || !session.docId) return false;
    return core.executeAsModal(async () => {
      const doc = getDocumentById(session.docId);
      if (!doc) {
        logger && logger.warn("The original Photoshop document was closed before Fill cleanup.");
        return false;
      }
      await activateDocumentById(session.docId);
      const channel = findChannelByName(doc, session.selectionChannelName);
      if (channel) {
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        if (!options || options.removeChannel !== false) await channel.remove();
      } else {
        logger && logger.warn("The temporary Fill selection channel was not found during cleanup.");
      }
      if (!options || options.restoreLayers !== false) {
        await restoreActiveLayers(doc, session.activeLayerIds);
      }
      return true;
    }, { commandName: "Restore Flux Local Edit Fill state" });
  }

  async function placeMaskedResult(resultFile, session, logger, check, label) {
    return core.executeAsModal(async () => {
      check();
      if (session.batch) globalThis.FluxLocalEditBatchPhotoshop.validSource(session.batch.session);
      const doc = getDocumentById(session.docId);
      if (!doc) throw new Error("The original Photoshop document was closed during generation.");
      if (session.inputMask && (toNumber(doc.width) !== session.docWidth || toNumber(doc.height) !== session.docHeight)) {
        throw new Error("The source canvas size changed during Fill generation.");
      }
      await activateDocumentById(session.docId);
      const channel = findChannelByName(doc, session.selectionChannelName);
      if (!channel) throw new Error(`The saved ${label} selection is no longer available.`);

      let placedLayer = null, corrected = null;
      try {
        if (session.inputMask) {
          try { corrected = await correctResultEdge(resultFile, session, logger, check); }
          catch (error) {
            check();
            if (error.kind === "fill_geometry") throw error;
            logger && logger.warn(`Fill seam color correction skipped: ${error.message}`);
          }
          await activateDocumentById(session.docId);
          check();
        }
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await placeEmbeddedFile(corrected || resultFile);
        placedLayer = activeLayer(doc);
        if (!placedLayer) throw new Error(`Photoshop did not create a ${label} result layer.`);
        placedLayer.name = `Flux Local Edit - ${label}`;
        await fitLayerToBounds(placedLayer, session.contextBounds, logger);
        check();
        const blend = globalThis.FluxLocalEditFillBlend;
        // Qwen has no Fill inputMask and always reloads its exact saved selection.
        const mask = session.inputMask && (session.strictMask ? blend.innerLayerMask(session.inputMask, session) :
          blend.layerMask(session.inputMask, session));
        const useBlendMask = mask && mask !== session.inputMask;
        check();
        if (useBlendMask) await selectBlendMask(doc, mask);
        else await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        check();
        await createLayerMaskFromSelection();
        if (session.batch) await globalThis.FluxLocalEditBatchPhotoshop.attachResult(placedLayer, session.batch);
        check();
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await channel.remove();
        const maskLabel = useBlendMask ? (session.strictMask ? "inward Fill blend" : "soft Fill blend") : "original selection";
        logger && logger.info(`Applied the ${maskLabel} as the ${label} layer mask.`);
        return placedLayer;
      } catch (error) {
        if (placedLayer) await deleteLayer(placedLayer).catch(() => null);
        const cleanupChannel = findChannelByName(doc, session.selectionChannelName);
        if (cleanupChannel) {
          await Promise.resolve().then(() => doc.selection.load(cleanupChannel, constants.SelectionType.REPLACE, false)).catch(() => null);
          await Promise.resolve().then(() => cleanupChannel.remove()).catch(() => null);
        }
        await restoreActiveLayers(doc, session.activeLayerIds).catch(() => null);
        throw error;
      } finally {
        await deleteTemp(corrected, logger);
      }
    }, { commandName: `Place Flux Local Edit ${label} result` });
  }

  function placeFillResult(resultFile, session, logger, check = () => {}) {
    return placeMaskedResult(resultFile, session, logger, check, "Fill");
  }

  function placeQwenResult(resultFile, session, logger, check = () => {}) {
    return placeMaskedResult(resultFile, session, logger, check, "Qwen");
  }

  async function diagnosticMaskRoundTrip(settings, logger) {
    const session = await exportFillAssets(settings, logger);
    try {
      return await core.executeAsModal(async () => {
        const doc = getDocumentById(session.docId);
        if (!doc) throw new Error("The original document was closed before the mask diagnostic.");
        await activateDocumentById(session.docId);
        const channel = findChannelByName(doc, session.selectionChannelName);
        if (!channel) throw new Error("The saved selection is unavailable for the mask diagnostic.");
        await placeEmbeddedFile(session.maskFile);
        const layer = activeLayer(doc);
        if (!layer) throw new Error("Photoshop did not create the mask diagnostic layer.");
        layer.name = "Flux Local Edit - Mask Diagnostic";
        await fitLayerToBounds(layer, session.contextBounds, logger);
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await channel.remove();
        logger && logger.info("Mask diagnostic placed: white must match the selection and black must stay protected.");
        return { layerId: layer.id, session };
      }, { commandName: "Flux Local Edit mask round-trip" });
    } catch (error) {
      await restoreFillSession(session, { restoreLayers: true, removeChannel: true }, logger).catch(() => null);
      throw error;
    }
  }

  async function removeLayerById(docId, layerId) {
    return core.executeAsModal(async () => {
      const doc = getDocumentById(docId);
      if (!doc) return false;
      await activateDocumentById(docId);
      const layer = collectLayers(doc).find((candidate) => Number(candidate.id) === Number(layerId));
      if (!layer) return false;
      await deleteLayer(layer);
      return true;
    }, { commandName: "Remove Flux Local Edit diagnostic layer" });
  }

  globalThis.FluxLocalEditFillPhotoshop = {
    createLayerMaskFromSelection,
    deleteTemp,
    diagnosticMaskRoundTrip,
    exportFillAssets,
    getSelectionContext,
    placeFillResult,
    placeQwenResult,
    removeLayerById,
    restoreFillSession
  };
})();
