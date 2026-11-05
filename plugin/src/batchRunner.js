(function () {
  async function run(context, adapter, mode) {
    const ps = globalThis.FluxLocalEditBatchPhotoshop;
    const check = () => context.throwIfCancelled(context.cancelToken);
    const baseSeed = globalThis.Flux2WorkflowMapper.normalizeSeed(context.settings.seed);
    let session = null;
    const results = [];
    const referenceCache = {};
    let phase = "Capture selection", currentRegion = 0;
    try {
      session = await ps.capture(mode, check);
      context.logger.info(`Found ${session.jobs.length} separate region(s). Processing sequentially from one frozen source.`);
      for (let index = 0; index < session.jobs.length; index++) {
        check();
        phase = "Export region"; currentRegion = index + 1;
        const state = { current: index + 1, total: session.jobs.length, completed: session.completed };
        context.onBatchProgress(state);
        let prepared = null;
        try {
          prepared = await ps.prepareJob(session, session.jobs[index], index, context.settings, context.logger, check);
          check();
          const result = await adapter.run({ ...context, prepared, referenceCache,
            setStage(value) { phase = value; },
            shouldRecordAction: context.shouldRecordAction && index === 0,
            settings: { ...context.settings, seed: (baseSeed + index) % Number.MAX_SAFE_INTEGER },
            setPromptId: context.setPromptId,
            updateSelectionHint: (...args) => {
              context.updateSelectionHint(...args); context.onBatchProgress(state);
            },
            onProgress: (progress) => {
              if (progress && progress.max) context.onProgress({ value: index + Number(progress.value) / Number(progress.max), max: session.jobs.length });
            }
          });
          session.completed++;
          // Do not retain every preview blob/temporary File in memory for a long queue.
          results.push({ mode, seed: result.seed, index: index + 1 });
          context.setPromptId("");
          context.onBatchProgress({ ...state, completed: session.completed });
        } finally {
          await ps.cleanupAssets(prepared).catch((error) => context.logger.warn(`Temporary export cleanup: ${error.message}`));
        }
      }
      return { mode, results, completed: session.completed, total: session.jobs.length };
    } catch (error) {
      // Host errors may be frozen/proxies and silently reject additional properties.
      const failure = new Error(error && error.message || String(error));
      failure.cause = error;
      failure.kind = error && error.kind;
      failure.batch = { completed: session ? session.completed : 0, total: session ? session.jobs.length : 0 };
      failure.phase = `${phase}${currentRegion ? `, region ${currentRegion}` : ""}`;
      if (error && error.stack) failure.stack += `\nCaused by: ${error.stack}`;
      throw failure;
    } finally {
      if (session) await ps.finish(session, context.logger).catch((error) => context.logger.warn(`Queue cleanup: ${error.message}`));
    }
  }
  globalThis.FluxLocalEditBatchRunner = { run };
})();
