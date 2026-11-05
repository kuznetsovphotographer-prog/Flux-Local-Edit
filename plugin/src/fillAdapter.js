(function () {
  let validatedBaseUrl = "";

  async function validateFillInstallation(client, baseUrl, logger) {
    if (validatedBaseUrl === baseUrl) return;
    logger.info("Validating FLUX.1 Fill nodes and exact model filenames.");
    const objectInfo = await client.getObjectInfo();
    await globalThis.FluxLocalEditFillWorkflowMapper.validateRequirements(objectInfo);
    validatedBaseUrl = baseUrl;
    logger.info("FLUX.1 Fill nodes and models are available.");
  }

  async function run(context) {
    const settings = context.settings;
    const logger = context.logger;
    const token = context.cancelToken;
    let session = null;
    let placed = false;
    let downloaded = null;

    try {
      session = context.prepared ? context.prepared.session : await globalThis.FluxLocalEditFillPhotoshop.exportFillAssets(settings, logger);
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
      await validateFillInstallation(client, settings.comfyUrl, logger);
      context.throwIfCancelled(token);

      const placeholder = await globalThis.FluxLocalEditFillWorkflowMapper.patchWorkflow({
        imageName: "__fill_context__.png",
        maskName: "__fill_mask__.png",
        prompt: settings.prompt,
        seed: settings.seed
      });
      logger.info(`Using seed ${placeholder.seed}.`);
      if (context.shouldRecordAction) {
        await context.recordAction(settings, placeholder.seed, "fill");
      }

      if (context.setStage) context.setStage("Upload Fill region and mask");
      const contextUpload = await client.uploadImage(session.contextFile, "fill-context");
      context.throwIfCancelled(token);
      logger.info(`Uploaded Fill context: ${contextUpload.imageName}.`);
      const maskUpload = await client.uploadImage(session.maskFile, "fill-mask");
      context.throwIfCancelled(token);
      logger.info(`Uploaded Fill mask: ${maskUpload.imageName}.`);

      const patched = await globalThis.FluxLocalEditFillWorkflowMapper.patchWorkflow({
        imageName: contextUpload.imageName,
        maskName: maskUpload.imageName,
        prompt: settings.prompt,
        seed: placeholder.seed
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
      if (context.setStage) context.setStage("Place and group Fill result");
      await globalThis.FluxLocalEditFillPhotoshop.placeFillResult(downloaded.file, session, logger, () => context.throwIfCancelled(token));
      placed = true;
      try { context.setPreview(downloaded); } catch (error) { logger.warn(`Layer placed; preview unavailable: ${error.message}`); }
      logger.info("Placed one Fill layer with the original Photoshop selection as its layer mask.");
      return { mode: "fill", seed: patched.seed, session, downloaded };
    } finally {
      if (downloaded) {
        if (!placed && downloaded.objectUrl) URL.revokeObjectURL(downloaded.objectUrl);
        if (downloaded.file && typeof downloaded.file.delete === "function") await Promise.resolve().then(() => downloaded.file.delete()).catch((error) => logger.warn(error.message));
      }
      if (session && !placed) {
        await globalThis.FluxLocalEditFillPhotoshop.restoreFillSession(
          session,
          { restoreLayers: true, removeChannel: true },
          logger
        ).catch((error) => logger.warn(`Could not fully restore Fill state: ${error.message || String(error)}`));
      }
    }
  }

  globalThis.FluxLocalEditFillAdapter = {
    resetValidationCache() {
      validatedBaseUrl = "";
    },
    run
  };
})();
