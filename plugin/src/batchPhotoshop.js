(function () {
  const { app, core, action, constants, imaging } = require("photoshop");
  function number(v) {
    if (typeof v === "number") return v;
    if (v && typeof v._value === "number") return v._value;
    if (v && typeof v.value === "number") return v.value;
    return Number(v);
  }
  function docById(id) { return Array.from(app.documents || []).find((d) => d.id === id); }
  function channel(doc, name) { return Array.from(doc.channels || []).find((c) => c.name === name); }
  async function activate(id) {
    await action.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: id }], _options: { dialogOptions: "dontDisplay" } }], {});
  }
  async function close(doc) { await doc.closeWithoutSaving(); }
  async function selectionHint() {
    if (!app.documents.length || !app.activeDocument) throw new Error("No active Photoshop document.");
    if (!app.activeDocument.selection.bounds) throw new Error("Select separate regions with Shift + Marquee. Generate processes each region in order.");
    return "Generate processes each separate region in order. MP applies to each region; results go into one group.";
  }
  function validSource(session) {
    const doc = docById(session.docId);
    if (!doc) throw new Error("The source document was closed. Remaining regions were cancelled.");
    if (number(doc.width) !== session.documentWidth || number(doc.height) !== session.documentHeight) {
      throw new Error("The source canvas size changed. Remaining regions were cancelled.");
    }
    if (!channel(doc, session.originalChannel)) throw new Error("The saved selection was removed. Remaining regions were cancelled.");
    if (session.group && !findLayer(doc.layers, session.group.id)) throw new Error("The result group was removed. Remaining regions were cancelled.");
    return doc;
  }
  function findLayer(layers, id) {
    for (const layer of Array.from(layers || [])) {
      if (layer.id === id) return layer;
      const nested = layer.layers && findLayer(layer.layers, id); if (nested) return nested;
    }
    return null;
  }
  async function putRegion(docId, session, region) {
    const pixels = globalThis.FluxLocalEditRegions.regionMask(session.mask, session.maskWidth, region);
    const image = await imaging.createImageDataFromBuffer(pixels, {
      width: region.width, height: region.height, components: 1, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2"
    });
    try { await imaging.putSelection({ documentID: docId, imageData: image, replace: true,
      targetBounds: { left: region.bounds.left, top: region.bounds.top } }); }
    finally { image.dispose(); }
  }
  async function capture(mode, check) {
    return core.executeAsModal(async () => {
      check();
      if (!app.documents.length || !app.activeDocument) throw new Error("No active Photoshop document.");
      if (!imaging || !imaging.getSelection) throw new Error("Photoshop Imaging API is required for separate-region processing.");
      const doc = app.activeDocument, bounds = doc.selection.bounds;
      if (!bounds) throw new Error("Select one or more separate regions first.");
      const w = number(doc.width), h = number(doc.height);
      const crop = { left: Math.max(0, Math.floor(number(bounds.left))), top: Math.max(0, Math.floor(number(bounds.top))),
        right: Math.min(w, Math.ceil(number(bounds.right))), bottom: Math.min(h, Math.ceil(number(bounds.bottom))) };
      if (crop.right <= crop.left || crop.bottom <= crop.top) throw new Error("Selection is outside the canvas.");
      if ((crop.right - crop.left) * (crop.bottom - crop.top) > 100000000) throw new Error("Selection spans over 100 million pixels. Process a smaller set of regions.");
      const session = { docId: doc.id, documentWidth: w, documentHeight: h, mode, completed: 0,
        originalChannel: `Flux batch original ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        jobChannels: [], activeLayerIds: Array.from(doc.activeLayers || []).map((l) => l.id), group: null, snapshotId: null };
      let image = null;
      try {
        await doc.selection.save(session.originalChannel);
        image = await imaging.getSelection({ documentID: doc.id, sourceBounds: crop });
        if (image.imageData.components !== 1) throw new Error("Expected a grayscale Photoshop selection mask.");
        const raw = await image.imageData.getData();
        const bits = image.imageData.componentSize;
        if (![8, 16, 32].includes(bits)) throw new Error("Unsupported Photoshop selection mask depth.");
        const scale = bits === 8 ? 1 : bits === 16 ? 255 / 32768 : 255;
        session.mask = Uint8Array.from(raw, (value) => Math.max(0, Math.min(255, Math.round(value * scale))));
        session.maskWidth = image.imageData.width;
        session.jobs = globalThis.FluxLocalEditRegions.split(session.mask, image.imageData.width, image.imageData.height, image.sourceBounds);
        check();
        if (mode === "edit" && session.jobs.some((job) => !job.solid)) {
          throw new Error("Klein Edit needs separate solid rectangles. Use Shift + Rectangular Marquee with Feather 0; use Fill for Lasso or feathered regions.");
        }
        const snapshot = await doc.duplicate(`Flux batch source ${Date.now()}`, true);
        session.snapshotId = snapshot.id;
        await activate(doc.id);
        return session;
      } catch (error) {
        const saved = channel(doc, session.originalChannel);
        if (saved) { await Promise.resolve().then(() => doc.selection.load(saved, constants.SelectionType.REPLACE, false)).catch(() => null); await Promise.resolve().then(() => saved.remove()).catch(() => null); }
        const snap = docById(session.snapshotId); if (snap) await close(snap).catch(() => null);
        await activate(doc.id).catch(() => null);
        throw error;
      } finally { if (image) image.imageData.dispose(); }
    }, { commandName: "Capture Flux regions and source snapshot" });
  }
  async function prepareJob(session, job, index, settings, logger, check) {
    const channelName = `${session.originalChannel} area ${index + 1}`;
    await core.executeAsModal(async () => {
      check(); const doc = validSource(session); await activate(doc.id);
      await putRegion(doc.id, session, job);
      await doc.selection.save(channelName); session.jobChannels.push(channelName);
      await doc.selection.load(channel(doc, session.originalChannel), constants.SelectionType.REPLACE, false);
      const snapshot = docById(session.snapshotId);
      if (!snapshot) throw new Error("The frozen source snapshot was closed.");
      await activate(snapshot.id); await putRegion(snapshot.id, session, job);
    }, { commandName: `Prepare Flux region ${index + 1}` });
    check();
    try {
      if (session.mode === "edit") {
        const selection = { docId: session.snapshotId, bounds: job.bounds, width: job.width, height: job.height };
        const file = await globalThis.Flux2Photoshop.exportSelectionMerged(selection, logger);
        return { file, selection: { ...selection, docId: session.docId, batch: { session, index } } };
      }
      const ps = globalThis.FluxLocalEditFillPhotoshop;
      const fill = await ps.exportFillAssets(settings, logger, { docId: session.snapshotId });
      try {
        await ps.restoreFillSession(fill, { restoreLayers: true, removeChannel: true }, logger);
        return { session: { ...fill, docId: session.docId, selectionChannelName: channelName,
          batch: { session, index } } };
      } catch (error) { await cleanupAssets({ session: fill }); throw error; }
    } finally {
      // Never leave the frozen snapshot active while the model is generating.
      await core.executeAsModal(async () => {
        if (docById(session.docId)) await activate(session.docId);
      }, { commandName: "Return to Flux source document" }).catch((error) => logger.warn(error.message));
    }
  }
  // Called within the placement's existing executeAsModal, never starts a nested modal.
  async function attachResult(layer, batch) {
    const { session, index } = batch, doc = validSource(session);
    layer.name = `Flux ${session.mode === "edit" ? "Edit" : "Fill"} - ${index + 1}`;
    // Move our new layer out of any user group/clipping stack before changing its flags.
    const currentTop = doc.layers[0];
    if (currentTop && currentTop.id !== layer.id) await layer.move(currentTop, constants.ElementPlacement.PLACEBEFORE);
    // UXP executes the menu command even for false -> false; that command is
    // unavailable for an ordinary placed layer. Only release a real clipping mask.
    if (layer.isClippingMask === true) layer.isClippingMask = false;
    if (!session.group) {
      session.group = await doc.createLayerGroup({ name: `Flux ${session.mode === "edit" ? "Edit" : "Fill"} - ${session.jobs.length} regions`, fromLayers: [layer] });
      const top = doc.layers[0];
      if (top && top.id !== session.group.id) await session.group.move(top, constants.ElementPlacement.PLACEBEFORE);
    } else await layer.move(session.group, constants.ElementPlacement.PLACEINSIDE);
  }
  async function cleanupAssets(prepared) {
    if (!prepared) return;
    const files = prepared.session ? [prepared.session.contextFile, prepared.session.maskFile] : [prepared.file];
    for (const file of files) if (file && typeof file.delete === "function") await file.delete();
  }
  async function finish(session, logger) {
    return core.executeAsModal(async () => {
      const snapshot = docById(session.snapshotId);
      if (snapshot) await close(snapshot).catch((error) => logger.warn(error.message));
      const doc = docById(session.docId);
      if (!doc) return;
      await activate(doc.id);
      const saved = channel(doc, session.originalChannel);
      if (saved) await Promise.resolve().then(() => doc.selection.load(saved, constants.SelectionType.REPLACE, false)).catch((error) => logger.warn(error.message));
      for (const name of [...session.jobChannels, session.originalChannel]) {
        const temporary = channel(doc, name); if (temporary) await Promise.resolve().then(() => temporary.remove()).catch((error) => logger.warn(error.message));
      }
      if (session.group && session.completed === 0 && !session.group.layers.length) {
        await Promise.resolve().then(() => session.group.delete()).catch((error) => logger.warn(error.message));
      }
      const group = session.group && findLayer(doc.layers, session.group.id);
      if (group && session.completed > 0) doc.activeLayers = [group];
      else {
        const layers = session.activeLayerIds.map((id) => findLayer(doc.layers, id)).filter(Boolean);
        if (layers.length) doc.activeLayers = layers;
      }
      session.mask = null;
    }, { commandName: "Finish Flux region queue" });
  }
  globalThis.FluxLocalEditBatchPhotoshop = { capture, prepareJob, attachResult, cleanupAssets, finish, validSource, selectionHint };
})();
