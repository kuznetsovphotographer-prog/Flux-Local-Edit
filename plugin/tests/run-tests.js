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
  settings.saveSettings({ ...loaded, activeMode: "qwen", qwenPrompt: "use <image2>" });
  assert.strictEqual(settings.loadSettings().activeMode, "qwen");
  assert.strictEqual(settings.loadSettings().qwenPrompt, "use <image2>");
  assert.strictEqual(settings.loadSettings().editPrompt, "edit");
  assert.strictEqual(settings.loadSettings().fillPrompt, "");
}

function makeObjectInfo(map) {
  const info = {};
  [...map.requiredNodes, ...map.inpaintNodes, ...map.fallbackNodes].forEach((name) => {
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
  const profile = { contextWidth: 897, contextHeight: 987, targetWidth: 944, targetHeight: 1056,
    growWork: 51, blurWork: 21, colorMatch: true };
  const empty = mapper.buildPromptWithMap(map, {
    imageName: "context.png",
    maskName: "mask.png",
    prompt: " \n ", profile, advanced: true,
    seed: 123
  });
  const ids = map.apiNodes;
  assert.match(empty.prompt[ids.clipTextEncode].inputs.text, /surrounding background.*nothing added/);
  assert.strictEqual(empty.prompt[ids.loadImage].inputs.image, "context.png");
  assert.strictEqual(empty.prompt[ids.loadMask].inputs.image, "mask.png");
  assert.strictEqual(empty.prompt[ids.imageToMask].inputs.channel, "red");
  assert.strictEqual(empty.prompt[ids.ksampler].inputs.seed, 123);
  assert.strictEqual(empty.prompt[ids.ksampler].inputs.steps, 25);
  assert.strictEqual(empty.prompt[ids.fluxGuidance].inputs.guidance, 30);
  assert.strictEqual(empty.prompt[ids.maskGrow].inputs.grow, 51);
  assert.strictEqual(empty.prompt[ids.maskGrow].inputs.blur, 21);
  assert.strictEqual(empty.prompt[ids.prefill].inputs.fill, "navier-stokes");
  assert.strictEqual(empty.prompt[ids.inpaintConditioning].inputs.mask[0], ids.maskStable);
  assert.strictEqual(empty.prompt[ids.inpaintConditioning].inputs.pixels[0], ids.preblur);
  assert.strictEqual(empty.prompt[ids.colorMatch].inputs.reference[0], ids.imageScale);
  assert.strictEqual(empty.prompt[ids.saveImage].inputs.images[0], ids.outputScale);
  assert.strictEqual(empty.prompt[ids.outputScale].inputs.width, 897);
  assert(!Object.values(empty.prompt).some((node) => node.class_type === "ImageCompositeMasked"));

  const described = mapper.buildPromptWithMap(map, {
    imageName: "context.png",
    maskName: "mask.png",
    prompt: "remove the cable", profile,
    seed: 456
  });
  assert.strictEqual(described.prompt[ids.clipTextEncode].inputs.text, "remove the cable");
  assert.strictEqual(described.prompt[ids.negativePrompt].inputs.text, "");
  assert.strictEqual(described.prompt[ids.maskGrow].class_type, "GrowMask");
  assert.strictEqual(described.prompt[ids.inpaintConditioning].inputs.mask[0], ids.softMask);
  assert(!described.prompt[ids.prefill] && !described.prompt[ids.colorMatch]);
  const unbounded = mapper.buildPromptWithMap(map, { imageName: "x.png", maskName: "m.png", advanced: true,
    profile: { ...profile, contextWidth: 6000, contextHeight: 4000, colorMatch: false, nativeTransfer: false } });
  assert(!unbounded.prompt[ids.imageScale] && !unbounded.prompt[ids.maskScale]);
  assert(!unbounded.prompt[ids.outputScale] && !unbounded.prompt[ids.colorMatch]);
  assert.strictEqual(unbounded.prompt[ids.saveImage].inputs.images[0], ids.vaeDecode);
  assert.deepStrictEqual(
    [map.defaults.unetName, map.defaults.clipName1, map.defaults.clipName2, map.defaults.vaeName],
    [
      "flux1-fill-dev-fp8.safetensors",
      "t5xxl_fp8_e4m3fn.safetensors",
      "clip_l.safetensors",
      "ae.safetensors"
    ]
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(mapper.validateRequirementsWithMap(map, makeObjectInfo(map)))),
    { advanced: true, missingInpaintNodes: [] }
  );
  const vanilla = makeObjectInfo(map);
  for (const node of map.inpaintNodes) delete vanilla[node];
  assert.strictEqual(mapper.validateRequirementsWithMap(map, vanilla).advanced, false);
  delete vanilla.ImageBlur;
  assert.throws(() => mapper.validateRequirementsWithMap(map, vanilla), /ImageBlur/);
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
  assert.strictEqual(manifest.name, "Local Edit");
  assert.strictEqual(manifest.entrypoints[0].id, "fluxLocalEditPanel");
  assert.strictEqual(manifest.entrypoints[0].label.default, "Local Edit");
  const html = fs.readFileSync(path.join(pluginRoot, "index.html"), "utf8");
  assert.match(html, /<title>Local Edit<\/title>/);
  assert.doesNotMatch(html, /Auto Feather|autoFeather/);
  assert.strictEqual((html.match(/data-remove-reference="/g) || []).length, 2);
  assert.match(html, /id="pluginModeName"[^>]*>FLUX\.2 Klein<\/span>/);
  assert.match(html, /id="modeTriggerWrap" class="mode-trigger-wrap"/);
  assert.match(html, /id="modeMenuButton"[\s\S]*class="mode-menu-hitbox"/);
  assert.strictEqual((html.match(/class="mode-card(?: is-selected)?"/g) || []).length, 3);
  const cards = Array.from(html.matchAll(/class="mode-card-title">([^<]+)<\/span>\s*<span class="mode-card-model">([^<]+)<\/span>/g),
    ([, name, detail]) => [name, detail]);
  assert.deepStrictEqual(cards, [
    ["FLUX.2 Klein", "Image editing · 9B FP8"],
    ["FLUX.1 Fill", "Inpainting · Dev FP8"],
    ["Qwen Image 2.1 Turbo", "Image editing · INT8"]
  ]);
  assert.match(html, /data-mode="edit"/);
  assert.match(html, /data-mode="fill"/);
  const main = fs.readFileSync(path.join(pluginRoot, "src/main.js"), "utf8");
  const styles = fs.readFileSync(path.join(pluginRoot, "styles.css"), "utf8");
  assert.deepStrictEqual(Array.from(main.matchAll(/displayName: "([^"]+)",\s*displayDetail: "([^"]+)"/g),
    ([, name, detail]) => [name, detail]), cards);
  assert.match(main, /fluxLocalEditGenerateEditActionHandler/);
  assert.match(main, /fluxLocalEditGenerateFillActionHandler/);
  assert.match(main, /fluxLocalEditGenerateQwenActionHandler/);
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
  assert.match(html, /class="action-button-wrap reference-action-wrap"/);
  assert.match(styles, /\.reference-action-wrap\s*\{[^}]*width: 130px/);
  assert.match(styles, /\.reference-action-wrap \.button-visual-label\s*\{[^}]*white-space: nowrap/);
  assert.match(styles, /\.reference-action-wrap \.button-visual-label\s*\{[^}]*margin-left: 6px/);
  assert.match(styles, /\.reference-action-wrap \.button-visual\s*\{[^}]*gap: 0/);
}

function testQwenWorkflow() {
  const sandbox = loadScript("src/imageSizing.js");
  vm.runInContext(fs.readFileSync(path.join(pluginRoot, "src/qwenWorkflowMapper.js"), "utf8"), sandbox);
  sandbox.Flux2WorkflowMapper = { normalizeSeed: (seed) => seed };
  const mapper = sandbox.FluxLocalEditQwenWorkflowMapper;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(plain(mapper.targetSize(893, 347, 1)), { resolution: 1024, width: 1632, height: 640 });
  assert.deepStrictEqual(plain(mapper.targetSize(896, 1152, 4)), { resolution: 2016, width: 1792, height: 2272 });
  assert.strictEqual(mapper.targetSize(896, 1152, 900).resolution, 2016);
  assert.strictEqual(mapper.targetSize(896, 1152, -20).resolution, 1024);
  const { prompt, seed, outputNodeId } = mapper.patchWorkflow({
    imageName: "crop.png", referenceImageName: "ref.png", megapixels: 4, seed: 42, prompt: "Use <image2>."
  });
  assert.strictEqual(seed, 42);
  assert.equal(prompt["5"].inputs.prompt, "Use <image2>.");
  assert.equal(prompt["7"].inputs.sigmas.split(",").length - 1, 8);
  assert.deepStrictEqual(plain(prompt["11"].inputs.latent_image), ["5", 2]);
  assert.equal(prompt["4"].inputs.image, "crop.png");
  assert.equal(prompt["14"].inputs.image, "ref.png");
  assert.equal(prompt[outputNodeId].inputs["format.channels"], "RGB (3 channels)");
  assert(!Object.values(prompt).some((node) => /enhance/i.test(node.class_type)));
  const without = mapper.patchWorkflow({ imageName: "crop.png", seed: 42, prompt: "" });
  assert.strictEqual(without.prompt["5"].inputs.prompt, "");
  assert(!without.prompt["14"] && !without.prompt["5"].inputs["images.image_2"]);
  const pair = mapper.patchWorkflow({ imageName: "crop.png", referenceImageNames: ["a.png", "b.png", "extra.png"], seed: 42 });
  assert.deepStrictEqual(plain(pair.prompt["5"].inputs["images.image_3"]), ["15", 0]);
  assert.equal(pair.prompt["14"].inputs.image, "a.png");
  assert.equal(pair.prompt["15"].inputs.image, "b.png");
  assert(!pair.prompt["16"] && !pair.prompt["5"].inputs["images.image_4"]);
  assert.throws(() => mapper.validateRequirements({}), /TextEncodeQwenImage21/);
}

const tests = [
  ["image sizing and context bounds", testImageSizing],
  ["independent settings and prompts", testSettings],
  ["Fill prompt graph and model validation", testFillWorkflow],
  ["Qwen resolution, eight steps and optional reference", testQwenWorkflow],
  ["unique uploads, identity, modes, actions", testUploadNamesAndIdentity]
];

for (const [name, run] of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(`PASS ${tests.length} test groups`);
