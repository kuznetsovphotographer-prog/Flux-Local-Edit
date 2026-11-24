(function () {
  async function validateFillInstallation(client, cache, logger) {
    if (cache && cache.fillRequirements) return cache.fillRequirements;
    logger.info("Validating FLUX.1 Fill nodes and exact model filenames.");
    const objectInfo = await client.getObjectInfo();
    const requirements = await globalThis.FluxLocalEditFillWorkflowMapper.validateRequirements(objectInfo);
    if (cache) cache.fillRequirements = requirements;
    if (requirements.advanced) logger.info("FLUX.1 Fill: masked prefill and ComfyUI color match are available.");
    else logger.warn(`FLUX.1 Fill: using core nodes, without masked prefill or ComfyUI color match. Missing: ${requirements.missingInpaintNodes.join(", ")}.`);
    return requirements;
  }

  async function run(context) {
    const settings = context.settings;
    const logger = context.logger;
    const token = context.cancelToken;
    const ps = globalThis.FluxLocalEditFillPhotoshop;
    const mapper = globalThis.FluxLocalEditFillWorkflowMapper;
    let session = null;
    let placed = false;
    let downloaded = null;

    try {
      session = context.prepared ? context.prepared.session : await ps.exportFillAssets(settings, logger);
      context.throwIfCancelled(token);
      context.updateSelectionHint({
        width: session.contextWidth,
        height: session.contextHeight,
        bounds: session.contextBounds
      }, settings, "fill", session);

      const client = new globalThis.Flux2ComfyClient.ComfyClient(settings.comfyUrl, logger);
      context.setClient(client);
      if (context.setStage) context.setStage("Connect to ComfyUI");
      const stats = await client.testConnection();
      context.throwIfCancelled(token);
      const version = stats && stats.system && stats.system.comfyui_version || "unknown";
      logger.info(`Connected to ComfyUI ${version}.`);
      if (context.setStage) context.setStage("Validate Fill workflow");
      const requirements = await validateFillInstallation(client, context.referenceCache, logger);
      context.throwIfCancelled(token);

      const seed = mapper.normalizeSeed(settings.seed);
      logger.info(`Using seed ${seed}.`);
      if (context.shouldRecordAction) {
        await context.recordAction(settings, seed, "fill");
      }

      if (context.setStage) context.setStage("Upload Fill region and mask");
      const contextUpload = await client.uploadImage(session.contextFile, "fill-context");
      context.throwIfCancelled(token);
      logger.info(`Uploaded Fill context: ${contextUpload.imageName}.`);
      const maskUpload = await client.uploadImage(session.maskFile, "fill-mask");
      context.throwIfCancelled(token);
      logger.info(`Uploaded Fill mask: ${maskUpload.imageName}.`);

      const patched = await mapper.patchWorkflow({
        imageName: contextUpload.imageName,
        maskName: maskUpload.imageName,
        prompt: settings.prompt,
        seed,
        profile: session,
        advanced: requirements.advanced
      });
      context.throwIfCancelled(token);

      if (context.setStage) context.setStage("Generate Fill result");
      const result = await client.runPrompt(patched.prompt, patched.outputNodeId, context.onProgress, {
        cancelToken: token,
        onPromptQueued: context.setPromptId
      });
      context.throwIfCancelled(token);
      logger.info(`Fill generation finished. Output: ${result.image.filename}.`);

      if (context.setStage) context.setStage("Download Fill result");
      downloaded = await client.downloadImage(result.image);
      context.throwIfCancelled(token);
      logger.info(`Downloaded Fill result: ${downloaded.file.name}.`);
      if (context.setStage) context.setStage("Blend and place Fill result");
      await ps.placeFillResult(downloaded.file, session, logger, () => context.throwIfCancelled(token));
      placed = true;
      try { context.setPreview(downloaded); } catch (error) { logger.warn(`Layer placed; preview unavailable: ${error.message}`); }
      logger.info("Placed one Fill layer with an editable mask.");
      return { mode: "fill", seed: patched.seed, session, downloaded };
    } finally {
      if (downloaded) {
        if (!placed && downloaded.objectUrl) URL.revokeObjectURL(downloaded.objectUrl);
        if (downloaded.file && typeof downloaded.file.delete === "function") await Promise.resolve().then(() => downloaded.file.delete()).catch((error) => logger.warn(error.message));
      }
      if (session && !placed) {
        await ps.restoreFillSession(
          session,
          { restoreLayers: true, removeChannel: true },
          logger
        ).catch((error) => logger.warn(`Could not fully restore Fill state: ${error.message || String(error)}`));
      }
      if (session && !context.prepared) {
        await ps.deleteTemp(session.contextFile, logger);
        await ps.deleteTemp(session.maskFile, logger);
      }
    }
  }

  globalThis.FluxLocalEditFillAdapter = { run };
})();
