const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const base = "http://127.0.0.1:8188";
const root = path.resolve(__dirname, "..");
const entry = (file) => ({ nativePath: file, getEntry: (name) => entry(path.join(file, name)), read: () => fs.readFileSync(file, "utf8") });
const fakeJson = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function setup(request, openPath, ws = globalThis.WebSocket, autostartPath = "C:\\Apps\\ComfyUI") {
  const context = vm.createContext({ console, setTimeout, clearTimeout, fetch: request, WebSocket: ws, require: (name) => {
    assert.equal(name, "uxp");
    // Load workflow JSONs from the real plugin, substituting only the launcher config.
    const fileSystem = { getPluginFolder: () => ({
      getEntry(name) {
        const directory = entry(path.join(root, name));
        if (name !== "scripts") return directory;
        return { getEntry(file) {
          if (file !== "comfyui-path.txt") return directory.getEntry(file);
          if (!autostartPath) throw Error("Missing local configuration");
          return { read: () => autostartPath };
        } };
      }
    }) };
    return { storage: { localFileSystem: fileSystem, formats: {} }, shell: { openPath } };
  } });
  for (const file of ["imageSizing.js", "workflowMapper.js", "fillWorkflowMapper.js", "qwenWorkflowMapper.js", "comfyClient.js", "comfyEngine.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "src", file), "utf8"), context, { filename: file });
  }
  return { engine: context.LocalEditComfyEngine, client: new context.Flux2ComfyClient.ComfyClient(base) };
}

async function unit() {
  let started = 0, connected = false, calls = [], queue = { queue_running: [], queue_pending: [] };
  let stats = fakeJson({ system: { comfyui_version: "test" } });
  const { engine } = setup(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/system_stats")) {
      if (!connected) throw new TypeError("connection refused");
      return stats;
    }
    if (url.endsWith("/queue")) return fakeJson(queue);
    if (url.endsWith("/free")) return fakeJson({});
    throw Error(url);
  }, async (launcher) => {
    assert.equal(launcher, path.join(root, "scripts", "start-comfy.cmd"));
    assert(fs.existsSync(launcher));
    started++;
    connected = true;
    return "";
  });
  await engine.ensureReady(base);
  await engine.ensureReady(base);
  assert.equal(started, 1, "reuse running server");
  stats = fakeJson({ invalid: true });
  await assert.rejects(() => engine.ensureReady(base), /did not identify/);
  assert.equal(started, 1, "do not launch another server over an invalid responder");
  stats = fakeJson({ system: { comfyui_version: "test" } });
  queue.queue_running.push(["other job"]);
  await assert.rejects(() => engine.freeVRAM(base), /busy/);
  queue = { queue_running: [], queue_pending: [["queued job"]] };
  await assert.rejects(() => engine.freeVRAM(base), /busy/);
  assert(!calls.some((call) => call.url.endsWith("/free")));
  queue = { queue_running: [], queue_pending: [] };
  assert.equal(await engine.freeVRAM(base), true);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { unload_models: true, free_memory: true });
  connected = false;
  const checkpoints = calls.length;
  assert.equal(await engine.freeVRAM(base), false);
  assert.equal(calls.length, checkpoints + 1, "offline unload only checks connection");
  await assert.rejects(() => engine.ensureReady(base, { check: () => { throw Error("cancelled"); } }), /cancelled/);
  assert.equal(started, 1);
  const denied = setup(async () => { throw new TypeError("connection refused"); }, async () => "denied").engine;
  await assert.rejects(() => denied.ensureReady(base), /denied/);
  for (const [config, expected] of [["", /Start ComfyUI manually/], ["relative\\path", /absolute Windows path/]]) {
    const offline = setup(async () => { throw new TypeError("connection refused"); },
      async () => { throw Error("Should not open the launcher"); }, undefined, config).engine;
    await assert.rejects(() => offline.ensureReady(base), expected);
  }
  for (const mode of ["edit", "fill", "qwen"]) {
    const graph = Object.values(await engine.buildWarmup(mode));
    assert(graph.some((node) => node.class_type === "UNETLoader"));
    assert(graph.some((node) => node.class_type === "PreviewImage"));
    assert(!graph.some((node) => /^LoadImage|^SaveImage/.test(node.class_type)));
  }
  console.log("PASS autostart, reusing server, denial, cancellation, idle-only unloading and three synthetic graphs");

  const phases = [];
  let message, closed = 0;
  const mock = setup(async () => fakeJson({ queue_running: [], queue_pending: [] })).engine;
  const client = {
    baseUrl: base,
    async openSocket(_, listener) { message = listener; return { close() { closed++; } }; },
    async queuePrompt(graph) {
      const sampler = Object.keys(graph).find((key) => graph[key].class_type === "KSampler");
      message({ type: "execution_start", data: { prompt_id: "ours" } });
      message({ type: "progress", data: { prompt_id: "unrelated", node: sampler, value: 9, max: 10 } });
      message({ type: "progress", data: { prompt_id: "ours", node: sampler, value: 0, max: 2 } });
      message({ type: "progress", data: { prompt_id: "ours", node: sampler, value: 1, max: 2 } });
      message({ type: "execution_success", data: { prompt_id: "ours" } });
      return "ours";
    },
    async getHistory() { return { ours: { status: { completed: true, status_str: "success" } } }; }
  };
  await mock.preload("fill", client, (entry) => phases.push(entry.stage === "sampling" ? `${entry.value}/${entry.max}` : entry.stage));
  assert.deepEqual(phases, ["queued", "loading", "1/2", "finishing"]);
  assert.equal(closed, 1);
  phases.length = 0;
  await mock.preload("fill", { ...client, async openSocket() { throw Error("offline"); }, async queuePrompt() { return "ours"; } },
    (entry) => phases.push(entry.stage));
  assert.deepEqual(phases, ["queued", "loading"]);
  console.log("PASS preload progress, model-event filtering and polling fallback");
}

async function live() {
  const { engine, client } = setup(fetch, async () => { throw Error("Live test does not start or replace the running server"); });
  await engine.ensureReady(base);
  const modes = process.argv.slice(3);
  for (const mode of modes.length ? modes : ["edit", "fill", "qwen"]) {
    const start = Date.now();
    await engine.preload(mode, client, (state) => console.log(mode, JSON.stringify(state)));
    console.log(`PASS live ${mode} preload (${((Date.now() - start) / 1000).toFixed(1)} s)`);
  }
}

(process.argv.includes("--live") ? live() : unit()).catch((error) => { console.error(error); process.exitCode = 1; });
