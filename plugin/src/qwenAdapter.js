(function () {
  async function run(context) {
    const { settings, prepared, logger, cancelToken: token } = context;
    if (!prepared || !prepared.file || !prepared.session) {
      throw new Error("Qwen requires a prepared Photoshop region.");
    }
    const check = () => context.throwIfCancelled(token);
    const stage = context.setStage || (() => {});
    const mapper = globalThis.FluxLocalEditQwenWorkflowMapper;
    const references = globalThis.LocalEditReferences;
    const referenceFiles = references.list(context.referenceFiles ?? context.referenceFile);
    const client = new globalThis.Flux2ComfyClient.ComfyClient(settings.comfyUrl, logger);
    const cache = context.referenceCache || {};
    context.setClient(client);
    check();
    context.updateSelectionHint(prepared.session, settings, "qwen");

    if (!cache.qwenValidated) {
      stage("Check Qwen nodes and models");
      await client.testConnection();
      check();
      mapper.validateRequirements(await client.getObjectInfo());
      check();
      cache.qwenValidated = true;
    }

    stage("Upload Qwen region");
    const { imageName } = await client.uploadImage(prepared.file, "qwen-context");
    check();
    if (referenceFiles.length) stage("Upload Qwen references");
    const referenceImageNames = await references.upload(context, client, referenceFiles, "qwen-reference");
    const patched = mapper.patchWorkflow({
      imageName, referenceImageNames,
      prompt: settings.prompt, megapixels: settings.megapixels, seed: settings.seed
    });
    if (context.shouldRecordAction) {
      await context.recordAction(settings, patched.seed, "qwen");
      if (referenceFiles.length) logger.warn("References are session-only and are not stored in Photoshop Actions.");
    }
    check();
    stage("Generate Qwen result");
    const result = await client.runPrompt(patched.prompt, patched.outputNodeId, context.onProgress, {
      cancelToken: token, onPromptQueued: context.setPromptId
    });
    check();
    stage("Download Qwen result");
    const downloaded = await client.downloadImage(result.image);
    let placed = false;
    try {
      check();
      stage("Place and group Qwen result");
      await globalThis.FluxLocalEditFillPhotoshop.placeQwenResult(downloaded.file, prepared.session, logger, check);
      placed = true;
      try { context.setPreview(downloaded); }
      catch (error) { logger.warn(`Layer placed; preview unavailable: ${error.message}`); }
      return { mode: "qwen", seed: patched.seed };
    } finally {
      if (!placed && downloaded.objectUrl) URL.revokeObjectURL(downloaded.objectUrl);
      const file = downloaded.file;
      if (file && typeof file.delete === "function") {
        await Promise.resolve().then(() => file.delete()).catch((error) => logger.warn(error.message));
      }
    }
  }

  globalThis.FluxLocalEditQwenAdapter = { run };
})();
