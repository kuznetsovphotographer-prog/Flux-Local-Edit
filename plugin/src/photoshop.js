(function () {
  const photoshop = require("photoshop");
  const { app, constants, core, action } = photoshop;
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;

  function toNumber(value) {
    if (typeof value === "number") {
      return value;
    }
    if (value && typeof value._value === "number") {
      return value._value;
    }
    if (value && typeof value.value === "number") {
      return value.value;
    }
    return Number(value);
  }

  function plainBounds(bounds) {
    if (Array.isArray(bounds)) {
      return {
        left: Math.round(toNumber(bounds[0])),
        top: Math.round(toNumber(bounds[1])),
        right: Math.round(toNumber(bounds[2])),
        bottom: Math.round(toNumber(bounds[3]))
      };
    }

    return {
      left: Math.round(toNumber(bounds.left)),
      top: Math.round(toNumber(bounds.top)),
      right: Math.round(toNumber(bounds.right)),
      bottom: Math.round(toNumber(bounds.bottom))
    };
  }

  function boundsSize(bounds) {
    return {
      width: Math.max(0, bounds.right - bounds.left),
      height: Math.max(0, bounds.bottom - bounds.top)
    };
  }

  async function getActiveDocument() {
    if (!app.documents || app.documents.length === 0) {
      throw new Error("No active Photoshop document.");
    }
    const doc = app.activeDocument;
    if (!doc) {
      throw new Error("No active Photoshop document.");
    }
    return doc;
  }

  async function getSolidSelection() {
    const doc = await getActiveDocument();
    const rawBounds = await Promise.resolve(doc.selection.bounds);
    if (!rawBounds) {
      throw new Error("No active selection. Select a rectangular area first.");
    }
    const solid = await Promise.resolve(doc.selection.solid);
    if (!solid) {
      throw new Error("The current selection is not a solid rectangle. Use Rectangular Marquee for MVP.");
    }

    const bounds = plainBounds(rawBounds);
    const size = boundsSize(bounds);
    if (size.width < 1 || size.height < 1) {
      throw new Error("Selection bounds are empty.");
    }

    const docWidth = Math.round(toNumber(doc.width));
    const docHeight = Math.round(toNumber(doc.height));
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > docWidth || bounds.bottom > docHeight) {
      throw new Error("Selection must stay inside the canvas for this MVP.");
    }

    return {
      docId: doc.id,
      docTitle: doc.title || doc.name || "Untitled",
      bounds,
      width: size.width,
      height: size.height
    };
  }

  async function closeWithoutSaving(doc) {
    if (!doc) {
      return;
    }
    if (typeof doc.closeWithoutSaving === "function") {
      await doc.closeWithoutSaving();
      return;
    }
    await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
  }

  async function exportSelectionMerged(selection, logger) {
    return core.executeAsModal(async () => {
      const sourceDoc = await getActiveDocument();
      const tempFolder = await fs.getTemporaryFolder();
      const file = await tempFolder.createFile(`flux2-selection-${Date.now()}.png`, { overwrite: true });
      let tempDoc = null;

      try {
        logger && logger.info("Duplicating visible document state for export.");
        tempDoc = await sourceDoc.duplicate(`Flux2 selection export ${Date.now()}`, true);
        await tempDoc.crop(selection.bounds);
        await tempDoc.saveAs.png(file, {}, true);
        return file;
      } finally {
        if (tempDoc) {
          await closeWithoutSaving(tempDoc);
        }
      }
    }, { commandName: "Export Flux2 selection" });
  }

  async function activateDocumentById(docId) {
    await action.batchPlay([
      {
        _obj: "select",
        _target: [{ _ref: "document", _id: docId }],
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  }

  async function setRectangleSelection(bounds) {
    await action.batchPlay([
      {
        _obj: "set",
        _target: [
          {
            _ref: "channel",
            _property: "selection"
          }
        ],
        to: {
          _obj: "rectangle",
          top: { _unit: "pixelsUnit", _value: bounds.top },
          left: { _unit: "pixelsUnit", _value: bounds.left },
          bottom: { _unit: "pixelsUnit", _value: bounds.bottom },
          right: { _unit: "pixelsUnit", _value: bounds.right }
        },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  }

  function activeLayer(doc) {
    if (doc.activeLayers && doc.activeLayers.length) {
      return doc.activeLayers[0];
    }
    if (doc.layers && doc.layers.length) {
      return doc.layers[0];
    }
    return null;
  }

  async function safeRenameLayer(layer, layerName, logger) {
    if (!layer) {
      return;
    }
    try {
      layer.name = layerName;
    } catch (error) {
      logger && logger.warn(`Could not rename placed layer: ${error.message}`);
    }
  }

  async function placeEmbeddedFile(fileEntry) {
    const token = await fs.createSessionToken(fileEntry);
    await action.batchPlay([
      {
        _obj: "placeEvent",
        null: {
          _path: token,
          _kind: "local"
        },
        linked: false,
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage"
        },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: 0 },
          vertical: { _unit: "pixelsUnit", _value: 0 }
        },
        _isCommand: false,
        _options: { dialogOptions: "dontDisplay" }
      }
    ], { synchronousExecution: true });
  }

  async function transformActiveLayer(scaleXPercent, scaleYPercent, dx, dy) {
    await action.batchPlay([
      {
        _obj: "transform",
        _target: [
          {
            _ref: "layer",
            _enum: "ordinal",
            _value: "targetEnum"
          }
        ],
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage"
        },
        width: { _unit: "percentUnit", _value: scaleXPercent },
        height: { _unit: "percentUnit", _value: scaleYPercent },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: dx },
          vertical: { _unit: "pixelsUnit", _value: dy }
        },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], { synchronousExecution: true });
  }

  function centerOf(bounds) {
    return {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2
    };
  }

  async function fitLayerToBounds(layer, targetBounds, logger) {
    try {
      const startBounds = plainBounds(layer.boundsNoEffects || layer.bounds);
      const startSize = boundsSize(startBounds);
      const targetSize = boundsSize(targetBounds);
      if (startSize.width < 1 || startSize.height < 1) {
        throw new Error("Placed layer has empty bounds.");
      }

      const startCenter = centerOf(startBounds);
      const targetCenter = centerOf(targetBounds);
      const scaleX = (targetSize.width / startSize.width) * 100;
      const scaleY = (targetSize.height / startSize.height) * 100;
      const dx = targetCenter.x - startCenter.x;
      const dy = targetCenter.y - startCenter.y;

      logger && logger.info(`Placed layer before fit: left ${startBounds.left}, top ${startBounds.top}, right ${startBounds.right}, bottom ${startBounds.bottom}.`);
      logger && logger.info(`Transforming placed layer to ${targetSize.width} x ${targetSize.height}px at original selection.`);
      await transformActiveLayer(scaleX, scaleY, dx, dy);

      const finalBounds = plainBounds(layer.boundsNoEffects || layer.bounds);
      const finalDx = targetBounds.left - finalBounds.left;
      const finalDy = targetBounds.top - finalBounds.top;
      if (finalDx !== 0 || finalDy !== 0) {
        await layer.translate(finalDx, finalDy);
        logger && logger.info(`Final pixel alignment shift: ${finalDx}px, ${finalDy}px.`);
      }

      const alignedBounds = plainBounds(layer.boundsNoEffects || layer.bounds);
      logger && logger.info(`Placed layer bounds: left ${alignedBounds.left}, top ${alignedBounds.top}, right ${alignedBounds.right}, bottom ${alignedBounds.bottom}.`);
    } catch (error) {
      logger && logger.warn(`Could not fit placed layer to selection bounds: ${error.message}`);
      throw error;
    }
  }

  async function placeResultFileIntoSelection(resultFile, targetDoc, layerName, targetBounds, logger) {
    await setRectangleSelection(targetBounds);
    await placeEmbeddedFile(resultFile);
    const placedDoc = await getActiveDocument();
    const layer = activeLayer(placedDoc);
    if (!layer) {
      throw new Error("Photoshop did not create an active placed layer.");
    }
    await safeRenameLayer(layer, layerName, logger);
    await fitLayerToBounds(layer, targetBounds, logger);
    await setRectangleSelection(targetBounds);
    return layer;
  }

  async function placeResultLayer(resultFile, selection, logger) {
    return core.executeAsModal(async () => {
      await activateDocumentById(selection.docId);
      const targetDoc = await getActiveDocument();
      const layerName = `ComfyUI Edit - ${new Date().toISOString().replace("T", " ").replace(/:/g, "-").slice(0, 19)}`;

      logger && logger.info("Placing generated result into the original document without opening a new image window.");
      const layer = await placeResultFileIntoSelection(resultFile, targetDoc, layerName, selection.bounds, logger);
      await activateDocumentById(selection.docId);
      return layer;
    }, { commandName: "Place Flux2 result" });
  }

  globalThis.Flux2Photoshop = {
    exportSelectionMerged,
    getSolidSelection,
    placeResultLayer
  };
})();
