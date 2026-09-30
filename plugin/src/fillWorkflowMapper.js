(function () {
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;

  async function readPluginJson(pathParts) {
    let entry = await fs.getPluginFolder();
    for (const part of pathParts) {
      entry = await entry.getEntry(part);
    }
    return JSON.parse(await entry.read());
  }

  async function loadMap() {
    return readPluginJson(["workflows", "fill-workflow-map.json"]);
  }

  function node(classType, inputs, title) {
    const descriptor = { class_type: classType, inputs };
    if (title) descriptor._meta = { title };
    return descriptor;
  }

  function ref(nodeId, outputIndex) {
    return [String(nodeId), outputIndex];
  }

  function normalizeSeed(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (!raw || raw === "random") {
      return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Seed must be a positive number or the word random.");
    }
    return Math.floor(Math.min(parsed, Number.MAX_SAFE_INTEGER));
  }

  function buildPromptWithMap(map, options) {
    if (!map || !map.defaults || !map.apiNodes) {
      throw new Error("Fill workflow map is invalid.");
    }
    const defaults = map.defaults;
    const ids = map.apiNodes;
    const imageName = String(options && options.imageName || "").trim();
    const maskName = String(options && options.maskName || "").trim();
    const promptText = String(options && options.prompt != null ? options.prompt : "");
    const seed = normalizeSeed(options && options.seed);

    if (!imageName) throw new Error("ComfyUI upload did not return the Fill context image name.");
    if (!maskName) throw new Error("ComfyUI upload did not return the Fill mask image name.");

    const prompt = {};
    prompt[ids.loadImage] = node("LoadImage", { image: imageName }, "Photoshop Fill context");
    prompt[ids.loadMask] = node("LoadImageMask", {
      image: maskName,
      channel: defaults.maskChannel
    }, "Photoshop selection mask");
    prompt[ids.dualClipLoader] = node("DualCLIPLoader", {
      clip_name1: defaults.clipName1,
      clip_name2: defaults.clipName2,
      type: defaults.clipType,
      device: defaults.clipDevice
    }, "FLUX.1 Fill text encoders");
    prompt[ids.unetLoader] = node("UNETLoader", {
      unet_name: defaults.unetName,
      weight_dtype: defaults.unetWeightDtype
    }, "FLUX.1 Fill Dev FP8");
    prompt[ids.vaeLoader] = node("VAELoader", {
      vae_name: defaults.vaeName
    }, "FLUX autoencoder");
    prompt[ids.clipTextEncode] = node("CLIPTextEncode", {
      text: promptText,
      clip: ref(ids.dualClipLoader, 0)
    }, "Fill prompt (empty is allowed)");
    prompt[ids.fluxGuidance] = node("FluxGuidance", {
      conditioning: ref(ids.clipTextEncode, 0),
      guidance: defaults.guidance
    }, "FLUX guidance");
    prompt[ids.conditioningZeroOut] = node("ConditioningZeroOut", {
      conditioning: ref(ids.fluxGuidance, 0)
    }, "Zero negative conditioning");
    prompt[ids.differentialDiffusion] = node("DifferentialDiffusion", {
      model: ref(ids.unetLoader, 0),
      strength: defaults.differentialDiffusionStrength
    }, "Differential diffusion");
    prompt[ids.inpaintConditioning] = node("InpaintModelConditioning", {
      positive: ref(ids.fluxGuidance, 0),
      negative: ref(ids.conditioningZeroOut, 0),
      vae: ref(ids.vaeLoader, 0),
      pixels: ref(ids.loadImage, 0),
      mask: ref(ids.loadMask, 0),
      noise_mask: true
    }, "FLUX Fill conditioning");
    prompt[ids.ksampler] = node("KSampler", {
      model: ref(ids.differentialDiffusion, 0),
      seed,
      steps: defaults.steps,
      cfg: defaults.cfg,
      sampler_name: defaults.samplerName,
      scheduler: defaults.scheduler,
      positive: ref(ids.inpaintConditioning, 0),
      negative: ref(ids.inpaintConditioning, 1),
      latent_image: ref(ids.inpaintConditioning, 2),
      denoise: defaults.denoise
    }, "FLUX.1 Fill sampler");
    prompt[ids.vaeDecode] = node("VAEDecode", {
      samples: ref(ids.ksampler, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Decode Fill result");
    prompt[ids.imageCompositeMasked] = node("ImageCompositeMasked", {
      destination: ref(ids.loadImage, 0),
      source: ref(ids.vaeDecode, 0),
      x: 0,
      y: 0,
      resize_source: false,
      mask: ref(ids.loadMask, 0)
    }, "Protect pixels outside the selection");
    prompt[ids.saveImage] = node("SaveImage", {
      images: ref(ids.imageCompositeMasked, 0),
      filename_prefix: defaults.outputPrefix
    }, "Photoshop Fill output");

    return { prompt, seed, outputNodeId: ids.saveImage, defaults };
  }

  async function patchWorkflow(options) {
    return buildPromptWithMap(await loadMap(), options || {});
  }

  function optionValues(nodeInfo, group, inputName) {
    const descriptor = nodeInfo && nodeInfo.input && nodeInfo.input[group] && nodeInfo.input[group][inputName];
    return descriptor && Array.isArray(descriptor[0]) ? descriptor[0] : [];
  }

  function validateRequirementsWithMap(map, objectInfo) {
    const missingNodes = (map.requiredNodes || []).filter((name) => !objectInfo || !objectInfo[name]);
    const defaults = map.defaults;
    const missingModels = [];
    const unets = optionValues(objectInfo && objectInfo.UNETLoader, "required", "unet_name");
    const clip1 = optionValues(objectInfo && objectInfo.DualCLIPLoader, "required", "clip_name1");
    const clip2 = optionValues(objectInfo && objectInfo.DualCLIPLoader, "required", "clip_name2");
    const vaes = optionValues(objectInfo && objectInfo.VAELoader, "required", "vae_name");

    if (!unets.includes(defaults.unetName)) missingModels.push(defaults.unetName);
    if (!clip1.includes(defaults.clipName1) && !clip2.includes(defaults.clipName1)) missingModels.push(defaults.clipName1);
    if (!clip1.includes(defaults.clipName2) && !clip2.includes(defaults.clipName2)) missingModels.push(defaults.clipName2);
    if (!vaes.includes(defaults.vaeName)) missingModels.push(defaults.vaeName);

    if (missingNodes.length || missingModels.length) {
      const details = [];
      if (missingNodes.length) details.push(`Missing ComfyUI nodes: ${missingNodes.join(", ")}.`);
      if (missingModels.length) details.push(`Missing Fill models: ${missingModels.join(", ")}.`);
      throw new Error(details.join(" "));
    }
    return { missingNodes, missingModels };
  }

  async function validateRequirements(objectInfo) {
    return validateRequirementsWithMap(await loadMap(), objectInfo);
  }

  globalThis.FluxLocalEditFillWorkflowMapper = {
    buildPromptWithMap,
    loadMap,
    normalizeSeed,
    patchWorkflow,
    validateRequirements,
    validateRequirementsWithMap
  };
})();
