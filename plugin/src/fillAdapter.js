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

    try {
      session = await globalThis.FluxLocalEditFillPhotoshop.exportFillAssets(settings, logger);
      context.throwIfCancelled(token);
      context.updateSelectionHint({
        width: session.contextWidth,
        height: session.contextHeight,
        bounds: session.contextBounds
      }, settings, "fill", session);

      const client = new globalThis.Flux2ComfyClient.ComfyClient(settings.comfyUrl, logger);
      context.setClient(client);
      const stats = await client.testConnection();
      context.throwIfCancelled(token);
      const version = stats && stats.system && stats.system.comfyui_version || "unknown";
      logger.info(`Connected to ComfyUI ${version}.`);
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

      const result = await client.runPrompt(patched.prompt, patched.outputNodeId, context.onProgress, {
        cancelToken: token,
        onPromptQueued: context.setPromptId
      });
      context.throwIfCancelled(token);
      logger.info(`Fill generation finished. Output: ${result.image.filename}.`);

      const downloaded = await client.downloadImage(result.image);
      context.throwIfCancelled(token);
      logger.info(`Downloaded Fill result: ${downloaded.file.name}.`);
      await globalThis.FluxLocalEditFillPhotoshop.placeFillResult(downloaded.file, session, logger);
      placed = true;
      context.throwIfCancelled(token);
      context.setPreview(downloaded);
      logger.info("Placed one Fill layer with the original Photoshop selection as its layer mask.");
      return { mode: "fill", seed: patched.seed, session, downloaded };
    } finally {
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
