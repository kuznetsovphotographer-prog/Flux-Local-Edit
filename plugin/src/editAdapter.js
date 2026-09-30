(function () {
  async function run(context) {
    const settings = context.settings;
    const logger = context.logger;
    const token = context.cancelToken;
    const selectedReferenceFile = context.referenceFile || null;
    const prompt = globalThis.Flux2WorkflowMapper.combinePrompt(settings.prompt, settings.negativePrompt);

    const selection = await globalThis.Flux2Photoshop.getSolidSelection();
    context.throwIfCancelled(token);
    context.updateSelectionHint(selection, settings, "edit");
    logger.info(`Selection bounds: left ${selection.bounds.left}, top ${selection.bounds.top}, right ${selection.bounds.right}, bottom ${selection.bounds.bottom}.`);

    const client = new globalThis.Flux2ComfyClient.ComfyClient(settings.comfyUrl, logger);
    context.setClient(client);
    const stats = await client.testConnection();
    context.throwIfCancelled(token);
    const version = stats && stats.system && stats.system.comfyui_version || "unknown";
    logger.info(`Connected to ComfyUI ${version}.`);

    logger.info("Validating FLUX.2 Klein Edit workflow mapping.");
    const workflowPatch = await globalThis.Flux2WorkflowMapper.patchWorkflow({
      imageName: "__placeholder__.png",
      referenceImageName: selectedReferenceFile ? "__reference_placeholder__.png" : "",
      prompt,
      megapixels: settings.megapixels,
      resolutionSteps: 16,
      seed: settings.seed
    });
    context.throwIfCancelled(token);
    logger.info(`Using seed ${workflowPatch.seed}.`);
    logger.info(selectedReferenceFile ? "Using two-image reference workflow." : "Using single-image workflow.");

    if (context.shouldRecordAction) {
      await context.recordAction(settings, workflowPatch.seed, "edit");
      if (selectedReferenceFile) {
        logger.warn("Reference image is session-only and is not stored in recorded Photoshop Actions.");
      }
    }

    const exported = await globalThis.Flux2Photoshop.exportSelectionMerged(selection, logger);
    context.throwIfCancelled(token);
    logger.info(`Exported Photoshop selection: ${exported.name}.`);

    const upload = await client.uploadImage(exported, "edit-selection");
    context.throwIfCancelled(token);
    logger.info(`Uploaded to ComfyUI input: ${upload.imageName}.`);

    let referenceUpload = null;
    if (selectedReferenceFile) {
      referenceUpload = await client.uploadImage(selectedReferenceFile, "edit-reference");
      context.throwIfCancelled(token);
      logger.info(`Uploaded reference image to ComfyUI input: ${referenceUpload.imageName}.`);
    }

    const patched = await globalThis.Flux2WorkflowMapper.patchWorkflow({
      imageName: upload.imageName,
      referenceImageName: referenceUpload ? referenceUpload.imageName : "",
      prompt,
      megapixels: settings.megapixels,
      resolutionSteps: 16,
      seed: workflowPatch.seed
    });
    context.throwIfCancelled(token);

    const result = await client.runPrompt(patched.prompt, patched.outputNodeId, context.onProgress, {
      cancelToken: token,
      onPromptQueued: context.setPromptId
    });
    context.throwIfCancelled(token);
    logger.info(`Generation finished. Output: ${result.image.filename}.`);

    const downloaded = await client.downloadImage(result.image);
    context.throwIfCancelled(token);
    logger.info(`Downloaded result: ${downloaded.file.name}.`);
    context.setPreview(downloaded);
    context.throwIfCancelled(token);

    await globalThis.Flux2Photoshop.placeResultLayer(downloaded.file, selection, logger);
    logger.info("Placed Edit result as a new aligned Photoshop layer.");
    return { mode: "edit", seed: patched.seed, selection, downloaded };
  }

  globalThis.FluxLocalEditEditAdapter = { run };
})();
