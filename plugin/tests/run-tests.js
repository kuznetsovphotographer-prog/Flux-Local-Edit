const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const pluginRoot = path.resolve(__dirname, "..");

function loadScript(relativePath, overrides = {}) {
  const sandbox = {
    console,
    Blob,
    URL,
    FormData,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: global.fetch,
    localStorage: overrides.localStorage || {
      data: new Map(),
      getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
      setItem(key, value) { this.data.set(key, String(value)); }
    },
    require(name) {
      if (name === "uxp") {
        return {
          storage: {
            formats: { binary: "binary" },
            localFileSystem: {}
          }
        };
      }
      throw new Error(`Unexpected require in test: ${name}`);
    },
    ...overrides
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(pluginRoot, relativePath), "utf8"), sandbox, {
    filename: relativePath
  });
  return sandbox;
}

function testImageSizing() {
  const sandbox = loadScript("src/imageSizing.js");
  const sizing = sandbox.Flux2ImageSizing;
  [1, 1.5, 2, 3, 4].forEach((mp) => {
    const result = sizing.computeCappedTargetSize(1813, 927, mp, 16);
    assert.strictEqual(result.targetWidth % 16, 0);
    assert.strictEqual(result.targetHeight % 16, 0);
    assert(result.targetWidth * result.targetHeight <= mp * 1_000_000);
  });
  const edge = sizing.computeContextRect(
    { left: -25, top: 10, right: 90, bottom: 80 },
    1000,
    800,
    { paddingRatio: 0.2, minimumPadding: 64, maximumPadding: 512 }
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(edge.selectionBounds)), { left: 0, top: 10, right: 90, bottom: 80 });
  assert.strictEqual(edge.contextBounds.left, 0);
  assert.strictEqual(edge.contextBounds.top, 0);
  assert.strictEqual(edge.padding, 64);
}

function testSettings() {
  const storage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
    setItem(key, value) { this.data.set(key, String(value)); }
  };
  const sandbox = loadScript("src/settings.js", { localStorage: storage });
  const settings = sandbox.FluxLocalEditSettings;
  assert.strictEqual(settings.STORAGE_KEY, "fluxLocalEditSettings.v1");
  assert.strictEqual(settings.loadSettings().fillPrompt, "");
  settings.saveSettings({ activeMode: "fill", megapixels: 2.5, editPrompt: "edit", fillPrompt: "" });
  const loaded = settings.loadSettings();
  assert.strictEqual(loaded.activeMode, "fill");
  assert.strictEqual(loaded.editPrompt, "edit");
  assert.strictEqual(loaded.fillPrompt, "");
}

function makeObjectInfo(map) {
  const info = {};
  map.requiredNodes.forEach((name) => {
    info[name] = { input: { required: {}, optional: {} } };
  });
  info.UNETLoader.input.required.unet_name = [[map.defaults.unetName]];
  info.DualCLIPLoader.input.required.clip_name1 = [[map.defaults.clipName1, map.defaults.clipName2]];
  info.DualCLIPLoader.input.required.clip_name2 = [[map.defaults.clipName1, map.defaults.clipName2]];
  info.VAELoader.input.required.vae_name = [[map.defaults.vaeName]];
  return info;
}

function testFillWorkflow() {
  const sandbox = loadScript("src/fillWorkflowMapper.js");
  const mapper = sandbox.FluxLocalEditFillWorkflowMapper;
  const map = JSON.parse(fs.readFileSync(path.join(pluginRoot, "workflows/fill-workflow-map.json"), "utf8"));
  const empty = mapper.buildPromptWithMap(map, {
    imageName: "context.png",
    maskName: "mask.png",
    prompt: "",
    seed: 123
  });
  const ids = map.apiNodes;
  assert.strictEqual(empty.prompt[ids.clipTextEncode].inputs.text, "");
  assert.strictEqual(empty.prompt[ids.loadImage].inputs.image, "context.png");
  assert.strictEqual(empty.prompt[ids.loadMask].inputs.image, "mask.png");
  assert.strictEqual(empty.prompt[ids.loadMask].inputs.channel, "red");
  assert.strictEqual(empty.prompt[ids.ksampler].inputs.seed, 123);
  assert.strictEqual(empty.prompt[ids.ksampler].inputs.steps, 20);
  assert.strictEqual(empty.prompt[ids.fluxGuidance].inputs.guidance, 30);
  assert.strictEqual(empty.prompt[ids.imageCompositeMasked].inputs.mask[0], ids.loadMask);
  assert.strictEqual(empty.prompt[ids.saveImage].inputs.images[0], ids.imageCompositeMasked);

  const described = mapper.buildPromptWithMap(map, {
    imageName: "context.png",
    maskName: "mask.png",
    prompt: "remove the cable",
    seed: 456
  });
  assert.strictEqual(described.prompt[ids.clipTextEncode].inputs.text, "remove the cable");
  assert.deepStrictEqual(
    [map.defaults.unetName, map.defaults.clipName1, map.defaults.clipName2, map.defaults.vaeName],
    [
      "flux1-fill-dev-fp8.safetensors",
      "clip_l.safetensors",
      "t5xxl_fp8_e4m3fn.safetensors",
      "ae.safetensors"
    ]
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(mapper.validateRequirementsWithMap(map, makeObjectInfo(map)))),
    { missingNodes: [], missingModels: [] }
  );
  const broken = makeObjectInfo(map);
  broken.UNETLoader.input.required.unet_name = [[]];
  assert.throws(() => mapper.validateRequirementsWithMap(map, broken), /flux1-fill-dev-fp8\.safetensors/);
}

function testUploadNamesAndIdentity() {
  const sandbox = loadScript("src/comfyClient.js");
  const makeName = sandbox.Flux2ComfyClient.makeUploadName;
  const a = makeName({ name: "context.png" }, "fill-context", "image/png");
  const b = makeName({ name: "context.png" }, "fill-context", "image/png");
  assert.notStrictEqual(a, b);
  assert.match(a, /^flux-local-edit-fill-context-/);

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.id, "com.local.photoshop.flux-local-edit");
  assert.strictEqual(manifest.name, "Flux Local Edit");
  assert.strictEqual(manifest.entrypoints[0].id, "fluxLocalEditPanel");
  const html = fs.readFileSync(path.join(pluginRoot, "index.html"), "utf8");
  assert.match(html, /Flux Local Edit · Edit/);
  assert.match(html, /Model: FLUX\.2 Klein 9B FP8/);
  assert.match(html, /id="modeTriggerWrap" class="mode-trigger-wrap"/);
  assert.match(html, /id="modeMenuButton"[\s\S]*class="mode-menu-hitbox"/);
  assert.strictEqual((html.match(/class="mode-card(?: is-selected)?"/g) || []).length, 2);
  assert.match(html, /Flux Local Edit · Edit[\s\S]*Model: FLUX\.2 Klein 9B FP8/);
  assert.match(html, /Flux Local Edit · Fill[\s\S]*Model: FLUX\.1 Fill Dev FP8/);
  assert.match(html, /data-mode="edit"/);
  assert.match(html, /data-mode="fill"/);
  const main = fs.readFileSync(path.join(pluginRoot, "src/main.js"), "utf8");
  const styles = fs.readFileSync(path.join(pluginRoot, "styles.css"), "utf8");
  assert.match(main, /fluxLocalEditGenerateEditActionHandler/);
  assert.match(main, /fluxLocalEditGenerateFillActionHandler/);
  assert.match(main, /function positionModeMenu\(\)/);
  assert.match(main, /bindSurfaceHover\(\$\("modeMenuButton"\), \$\("modeTriggerWrap"\)\)/);
  assert.match(main, /document\.querySelectorAll\("\.mode-card"\)/);
  assert.doesNotMatch(main, /flux2KleinGenerateActionHandler/);
  assert.match(styles, /\.mode-trigger-wrap:hover/);
  assert.match(styles, /\.mode-menu-hitbox[\s\S]*inset: 0/);
  assert.match(styles, /\.plugin-identity-visual[\s\S]*gap: 0/);
  assert.match(styles, /\.plugin-identity-copy[\s\S]*margin-left: 10px/);
  assert.match(styles, /\.model-indicator[\s\S]*margin-top: 0/);
  assert.match(styles, /\.mode-menu[\s\S]*overflow: hidden/);
  assert.match(styles, /\.mode-card\.is-selected[\s\S]*box-shadow: inset 0 0 0 1px var\(--ps-blue\)/);
  assert.match(styles, /\.mode-card-hitbox[\s\S]*opacity: 0/);
}

const tests = [
  ["image sizing and context bounds", testImageSizing],
  ["independent settings and prompts", testSettings],
  ["Fill prompt graph and model validation", testFillWorkflow],
  ["unique uploads, identity, modes, actions", testUploadNamesAndIdentity]
];

for (const [name, run] of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(`PASS ${tests.length} test groups`);
