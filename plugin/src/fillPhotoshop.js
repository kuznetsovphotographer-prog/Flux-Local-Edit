(function () {
  const photoshop = require("photoshop");
  const { app, constants, core, action } = photoshop;
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;

  const CONTEXT_PADDING_RATIO = 0.2;
  const CONTEXT_PADDING_MINIMUM = 64;
  const CONTEXT_PADDING_MAXIMUM = 512;

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

  async function getSelectionContext(settings) {
    const sourceDoc = await getActiveDocument();
    const rawBounds = await Promise.resolve(sourceDoc.selection.bounds);
    if (!rawBounds) {
      throw new Error("No active selection. Select one or more areas first.");
    }
    const selectionBounds = plainBounds(rawBounds);
    const documentWidth = Math.max(1, Math.round(toNumber(sourceDoc.width)));
    const documentHeight = Math.max(1, Math.round(toNumber(sourceDoc.height)));
    const context = globalThis.Flux2ImageSizing.computeContextRect(
      selectionBounds,
      documentWidth,
      documentHeight,
      {
        paddingRatio: CONTEXT_PADDING_RATIO,
        minimumPadding: CONTEXT_PADDING_MINIMUM,
        maximumPadding: CONTEXT_PADDING_MAXIMUM
      }
    );
    const target = globalThis.Flux2ImageSizing.computeCappedTargetSize(
      context.width,
      context.height,
      settings && settings.megapixels,
      settings && settings.roundingMultiple || 16
    );
    return {
      docId: sourceDoc.id,
      selectionBounds: context.selectionBounds,
      contextBounds: context.contextBounds,
      contextWidth: context.width,
      contextHeight: context.height,
      padding: context.padding,
      targetWidth: target.targetWidth,
      targetHeight: target.targetHeight,
      targetMegapixels: target.targetMegapixels
    };
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

  async function exportFillAssets(settings, logger) {
    return core.executeAsModal(async () => {
      const sourceDoc = await getActiveDocument();
      const rawBounds = await Promise.resolve(sourceDoc.selection.bounds);
      if (!rawBounds) {
        throw new Error("No active selection. Select one or more areas first.");
      }

      const selectionBounds = plainBounds(rawBounds);
      const documentWidth = Math.max(1, Math.round(toNumber(sourceDoc.width)));
      const documentHeight = Math.max(1, Math.round(toNumber(sourceDoc.height)));
      const context = globalThis.Flux2ImageSizing.computeContextRect(
        selectionBounds,
        documentWidth,
        documentHeight,
        {
          paddingRatio: CONTEXT_PADDING_RATIO,
          minimumPadding: CONTEXT_PADDING_MINIMUM,
          maximumPadding: CONTEXT_PADDING_MAXIMUM
        }
      );
      const target = globalThis.Flux2ImageSizing.computeCappedTargetSize(
        context.width,
        context.height,
        settings && settings.megapixels,
        settings && settings.roundingMultiple || 16
      );
      const nonce = makeNonce();
      const channelName = `Flux Local Edit Selection ${nonce}`;
      const activeLayerIds = Array.from(sourceDoc.activeLayers || []).map((layer) => layer.id);
      const tempFolder = await fs.getTemporaryFolder();
      const contextFile = await tempFolder.createFile(`flux-local-edit-context-${nonce}.png`, { overwrite: true });
      const maskFile = await tempFolder.createFile(`flux-local-edit-mask-${nonce}.png`, { overwrite: true });
      let contextDoc = null;
      let maskDoc = null;
      let keepSourceChannel = false;

      try {
        await sourceDoc.selection.save(channelName);
        const sourceChannel = findChannelByName(sourceDoc, channelName);
        if (!sourceChannel) {
          throw new Error("Photoshop did not create the temporary selection channel.");
        }

        logger && logger.info(
          `Fill context ${context.width} x ${context.height}px; padding ${context.padding}px; upload ${target.targetWidth} x ${target.targetHeight}px (${target.targetMegapixels.toFixed(2)} MP).`
        );

        contextDoc = await sourceDoc.duplicate(`Flux Local Edit context ${nonce}`, true);
        await prepareExportDocument(contextDoc);
        await contextDoc.crop(context.contextBounds);
        await contextDoc.resizeImage(
          target.targetWidth,
          target.targetHeight,
          undefined,
          constants.ResampleMethod && constants.ResampleMethod.BICUBIC
        );
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

        await maskDoc.createLayer(constants.LayerKind.NORMAL, { name: "Flux Local Edit mask pixels" });
        await maskDoc.selection.selectAll();
        await fillCurrentSelection("black");
        await maskDoc.selection.load(maskChannel, constants.SelectionType.REPLACE, false);
        await fillCurrentSelection("white");
        await maskDoc.crop(context.contextBounds);
        await maskDoc.resizeImage(
          target.targetWidth,
          target.targetHeight,
          undefined,
          constants.ResampleMethod && constants.ResampleMethod.BICUBIC
        );
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
          selectionBounds: context.selectionBounds,
          contextBounds: context.contextBounds,
          contextWidth: context.width,
          contextHeight: context.height,
          padding: context.padding,
          targetWidth: target.targetWidth,
          targetHeight: target.targetHeight,
          targetMegapixels: target.targetMegapixels,
          contextFile,
          maskFile,
          nonce
        };
      } finally {
        if (contextDoc) await closeWithoutSaving(contextDoc).catch(() => null);
        if (maskDoc) await closeWithoutSaving(maskDoc).catch(() => null);
        const liveSource = getDocumentById(sourceDoc.id);
        if (liveSource) {
          await activateDocumentById(sourceDoc.id).catch(() => null);
          const liveChannel = findChannelByName(liveSource, channelName);
          if (liveChannel) {
            await liveSource.selection.load(liveChannel, constants.SelectionType.REPLACE, false).catch(() => null);
            if (!keepSourceChannel) {
              await liveChannel.remove().catch(() => null);
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

  async function placeFillResult(resultFile, session, logger) {
    return core.executeAsModal(async () => {
      const doc = getDocumentById(session.docId);
      if (!doc) throw new Error("The original Photoshop document was closed during generation.");
      await activateDocumentById(session.docId);
      const channel = findChannelByName(doc, session.selectionChannelName);
      if (!channel) throw new Error("The saved Fill selection is no longer available.");

      let placedLayer = null;
      try {
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await placeEmbeddedFile(resultFile);
        placedLayer = activeLayer(doc);
        if (!placedLayer) throw new Error("Photoshop did not create a Fill result layer.");
        placedLayer.name = "Flux Local Edit - Fill";
        await fitLayerToBounds(placedLayer, session.contextBounds, logger);
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await createLayerMaskFromSelection();
        await doc.selection.load(channel, constants.SelectionType.REPLACE, false);
        await channel.remove();
        logger && logger.info("Applied the original selection as the Fill layer mask.");
        return placedLayer;
      } catch (error) {
        if (placedLayer) await deleteLayer(placedLayer).catch(() => null);
        const cleanupChannel = findChannelByName(doc, session.selectionChannelName);
        if (cleanupChannel) {
          await doc.selection.load(cleanupChannel, constants.SelectionType.REPLACE, false).catch(() => null);
          await cleanupChannel.remove().catch(() => null);
        }
        await restoreActiveLayers(doc, session.activeLayerIds).catch(() => null);
        throw error;
      }
    }, { commandName: "Place Flux Local Edit Fill result" });
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
    CONTEXT_PADDING_MAXIMUM,
    CONTEXT_PADDING_MINIMUM,
    CONTEXT_PADDING_RATIO,
    diagnosticMaskRoundTrip,
    exportFillAssets,
    getSelectionContext,
    placeFillResult,
    removeLayerById,
    restoreFillSession
  };
})();
