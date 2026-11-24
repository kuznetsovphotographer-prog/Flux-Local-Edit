(function () {
  const { shell, storage } = require("uxp");
  const LOCAL_URL = "http://127.0.0.1:8188";
  const LOG_FOLDER = "%LOCALAPPDATA%\\LocalEdit";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function bounded(task, ms, message) {
    let timer;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getResponse(url, options) {
    return bounded(fetch(url, options), 2500, "Local ComfyUI did not respond in time.");
  }

  async function probe(baseUrl) {
    let response;
    try { response = await getResponse(`${baseUrl}/system_stats`); }
    catch (_) { return false; }
    const data = response.ok
      ? await bounded(response.json(), 2500, "ComfyUI returned an incomplete response.").catch(() => null)
      : null;
    if (!data || !data.system || !data.system.comfyui_version) {
      throw new Error(`The service at ${baseUrl} did not identify itself as ComfyUI.`);
    }
    return true;
  }

  async function openLauncher(check) {
    if (!shell || typeof shell.openPath !== "function") {
      throw new Error("Automatic launch is unavailable in this Photoshop. Start ComfyUI manually.");
    }
    const folder = await storage.localFileSystem.getPluginFolder();
    const scripts = await folder.getEntry("scripts");
    let packagePath;
    try {
      const config = await scripts.getEntry("comfyui-path.txt");
      packagePath = String(await config.read()).trim();
    } catch (_) {
      throw new Error("Start ComfyUI manually, or configure Windows autostart in plugin/scripts/comfyui-path.txt.");
    }
    if (!/^[a-z]:[\\/][^"\r\n]+$/i.test(packagePath)) {
      throw new Error("comfyui-path.txt must contain one absolute Windows path to a ComfyUI folder with a venv.");
    }
    const launcher = await scripts.getEntry("start-comfy.cmd");
    if (!launcher.nativePath) throw new Error("Local Edit’s Windows launcher does not have a local path.");
    check();
    const error = await shell.openPath(launcher.nativePath,
      "Start Local Edit’s local ComfyUI without opening Stability Matrix.");
    if (error) throw new Error(`Could not open the Local Edit launcher: ${error}`);
  }

  async function ensureReady(baseUrl, { check = () => {}, onStarting = () => {} } = {}) {
    check();
    const running = await probe(baseUrl);
    check();
    if (running) return;
    if (baseUrl !== LOCAL_URL) {
      throw new Error("Automatic launch is configured only for local ComfyUI on port 8188.");
    }
    onStarting();
    await openLauncher(check);
    const deadline = Date.now() + 155000;
    while (Date.now() < deadline) {
      check();
      const ready = await probe(baseUrl);
      check();
      if (ready) return;
      await wait(900);
    }
    throw new Error(`ComfyUI did not start in time. Check ${LOG_FOLDER}\\comfy-launch.log and comfy-server.log.`);
  }

  async function requireIdle(baseUrl) {
    const response = await getResponse(`${baseUrl}/queue`);
    if (!response.ok) throw new Error(`Could not check the ComfyUI queue (HTTP ${response.status}).`);
    const data = await bounded(response.json(), 2500, "ComfyUI returned an incomplete queue response.");
    if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) {
      throw new Error("Could not verify that the ComfyUI queue is empty.");
    }
    if (data.queue_running.length || data.queue_pending.length) {
      throw new Error("ComfyUI is busy. Wait for its queue to finish and try again.");
    }
  }

  async function freeVRAM(baseUrl) {
    if (baseUrl !== LOCAL_URL) throw new Error("Free VRAM is available only for local ComfyUI.");
    if (!await probe(baseUrl)) return false;
    await requireIdle(baseUrl);
    const response = await getResponse(`${baseUrl}/free`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
    if (!response.ok) throw new Error(`ComfyUI refused to free VRAM (HTTP ${response.status}).`);
    return true;
  }

  async function buildWarmup(mode) {
    const mappers = {
      edit: globalThis.Flux2WorkflowMapper,
      fill: globalThis.FluxLocalEditFillWorkflowMapper,
      qwen: globalThis.FluxLocalEditQwenWorkflowMapper
    };
    if (!mappers[mode]) throw new Error("Unknown model for ComfyUI preload.");
    const workflow = await mappers[mode].patchWorkflow({ imageName: "synthetic.png",
      maskName: "synthetic-mask.png", prompt: "A gray image", megapixels: 1, seed: 17, warmup: mode === "fill" });
    const size = 256;
    const graph = workflow.prompt;
    for (const node of Object.values(graph)) {
      switch (node.class_type) {
        case "LoadImage": node.class_type = "EmptyImage"; node.inputs = { width: size, height: size, batch_size: 1, color: 8421504 }; break;
        case "LoadImageMask": node.class_type = "SolidMask"; node.inputs = { width: size, height: size, value: 1 }; break;
        case "ImageScaleToTotalPixels": node.inputs.megapixels = size * size / 1000000; break;
        case "TextEncodeQwenImage21": node.inputs.resolution = size; break;
        case "KSampler": node.inputs.steps = Math.min(node.inputs.steps, 2); break;
      }
    }
    if (!graph[workflow.outputNodeId] || !graph[workflow.outputNodeId].inputs.images) {
      throw new Error("The model workflow has no previewable output for preload.");
    }
    const { images } = graph[workflow.outputNodeId].inputs;
    graph[workflow.outputNodeId] = { class_type: "PreviewImage", inputs: { images } };
    return graph;
  }

  async function preload(mode, client, onProgress = () => {}) {
    const graph = await buildWarmup(mode);
    await requireIdle(client.baseUrl);
    const clientId = `local-edit-preload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const early = [];
    let id, socket;
    let stage = "queued";
    const emit = (next, numbers = {}) => {
      if (stage !== next || next === "sampling") onProgress({ stage: next, ...numbers });
      stage = next;
    };
    const onEvent = (event) => {
      const data = event.data || {};
      if (!data.prompt_id) return;
      if (!id) {
        if (early.length < 64) early.push(event);
        return;
      }
      if (data.prompt_id !== id) return;
      const kind = graph[String(data.node)]?.class_type;
      if (event.type === "progress" && ["KSampler", "SamplerCustomAdvanced"].includes(kind)) {
        const value = Number(data.value), max = Number(data.max);
        if (stage !== "finishing" && Number.isFinite(value) && Number.isFinite(max) && value > 0 && max > 0) {
          emit("sampling", { value: Math.min(value, max), max });
        }
      } else if (event.type === "execution_success" || (event.type === "executing" && data.node === null) ||
        (event.type === "executing" && stage === "sampling" && ["VAEDecode", "ImageCompositeMasked", "PreviewImage"].includes(kind))) {
        emit("finishing");
      } else if (stage === "queued" && ["execution_start", "executing"].includes(event.type)) {
        emit("loading");
      }
    };
    try {
      // History remains authoritative. The socket is optional, and only drives the progress UI.
      try { socket = await client.openSocket(clientId, onEvent); } catch (_) {}
      id = await client.queuePrompt(graph, clientId);
      onProgress({ stage: "queued" });
      if (!socket) emit("loading");
      for (const event of early) onEvent(event);
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const result = (await bounded(client.getHistory(id), 6000, "ComfyUI history did not respond."))[id];
        if (result) {
          const status = result.status || {};
          if (status.completed && status.status_str === "success") return;
          const failed = (status.messages || []).find(([name]) => name === "execution_error");
          throw new Error(failed && failed[1].exception_message || `ComfyUI preload stopped (${status.status_str || "unknown"}).`);
        }
        await wait(1000);
      }
      throw new Error("Preload is taking longer than four minutes. Check ComfyUI; its queue was not interrupted.");
    } finally {
      if (socket) {
        try { socket.close(); } catch (_) {}
      }
    }
  }

  globalThis.LocalEditComfyEngine = { probe, ensureReady, freeVRAM, buildWarmup, preload };
})();
