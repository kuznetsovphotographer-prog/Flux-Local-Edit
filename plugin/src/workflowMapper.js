(function () {
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;
  const AUTO_FILL_PROMPT = "Seamlessly regenerate the selected area to match the surrounding image. Preserve identity, lighting, camera perspective, texture, color, and natural continuity. Fill missing or damaged content realistically.";
  const REFERENCE_AUTO_PROMPT = "Replace the clothing or object in image 1 using image 2 only as the visual reference.";
  const REFERENCE_IMAGE_GUIDANCE = "Use image 1 as the target photo crop and the strongest composition anchor. Use image 2 only as a secondary visual reference. Transfer the relevant outfit, garment shape, color, fabric, texture, pattern, and design from image 2 onto the subject in image 1. Fit it naturally to the existing body, pose, perspective, lighting, shadows, and camera angle. Preserve the person, identity, face, skin, hair, hands, body shape, background, composition, and surrounding scene from image 1. If image 1 and image 2 conflict, prioritize image 1. Do not paste image 2 directly. Do not copy the product photo background, white background, studio background, borders, or empty margins from image 2. Do not create a flat rectangular patch, poster, sticker, or floating overlay. The result must look like a natural photo edit of image 1.";

  async function readPluginJson(pathParts) {
    let entry = await fs.getPluginFolder();
    for (const part of pathParts) {
      entry = await entry.getEntry(part);
    }
    const text = await entry.read();
    return JSON.parse(text);
  }

  async function loadWorkflow() {
    const map = await readPluginJson(["workflows", "workflow-map.json"]);
    const workflow = await readPluginJson(["workflows", map.workflowFile]);
    validateWorkflow(workflow, map);
    return { workflow, map };
  }

  function byId(items, id) {
    return (items || []).find((item) => String(item.id) === String(id));
  }

  function requireTopNode(workflow, id, type) {
    const node = byId(workflow.nodes, id);
    if (!node) {
      throw new Error(`Workflow node ${id} was not found.`);
    }
    if (type && node.type !== type) {
      throw new Error(`Workflow node ${id} must be ${type}, but is ${node.type}.`);
    }
    return node;
  }

  function requireSubgraph(workflow, id) {
    const subgraph = (workflow.definitions && workflow.definitions.subgraphs || [])
      .find((item) => item.id === id);
    if (!subgraph) {
      throw new Error(`Workflow subgraph ${id} was not found.`);
    }
    return subgraph;
  }

  function validateSubgraphNode(subgraph, id, type) {
    const node = byId(subgraph.nodes, id);
    if (!node) {
      throw new Error(`Subgraph "${subgraph.name}" is missing node ${id}.`);
    }
    if (type && node.type !== type) {
      throw new Error(`Subgraph node ${id} must be ${type}, but is ${node.type}.`);
    }
    return node;
  }

  function validateWorkflow(workflow, map) {
    const active = map.activePath;
    requireTopNode(workflow, active.loadImageNode, "LoadImage");
    requireTopNode(workflow, active.saveImageNode, "SaveImage");
    requireTopNode(workflow, active.mainSubgraphNode, active.mainSubgraphId);

    const main = requireSubgraph(workflow, active.mainSubgraphId);
    const ref = requireSubgraph(workflow, active.referenceConditioningSubgraphId);
    const ids = map.apiNodes;

    validateSubgraphNode(main, ids.unetLoader, "UNETLoader");
    validateSubgraphNode(main, ids.clipLoader, "CLIPLoader");
    validateSubgraphNode(main, ids.vaeLoader, "VAELoader");
    validateSubgraphNode(main, ids.randomNoise, "RandomNoise");
    validateSubgraphNode(main, ids.clipTextEncode, "CLIPTextEncode");
    validateSubgraphNode(main, ids.imageScaleToTotalPixels, "ImageScaleToTotalPixels");
    validateSubgraphNode(main, ids.getImageSize, "GetImageSize");
    validateSubgraphNode(main, ids.flux2Scheduler, "Flux2Scheduler");
    validateSubgraphNode(main, ids.emptyFlux2LatentImage, "EmptyFlux2LatentImage");
    validateSubgraphNode(main, ids.conditioningZeroOut, "ConditioningZeroOut");
    validateSubgraphNode(main, ids.cfgGuider, "CFGGuider");
    validateSubgraphNode(main, ids.ksamplerSelect, "KSamplerSelect");
    validateSubgraphNode(main, ids.samplerCustomAdvanced, "SamplerCustomAdvanced");
    validateSubgraphNode(main, ids.vaeDecode, "VAEDecode");

    validateSubgraphNode(ref, ids.positiveReferenceLatent, "ReferenceLatent");
    validateSubgraphNode(ref, ids.vaeEncode, "VAEEncode");
    validateSubgraphNode(ref, ids.negativeReferenceLatent, "ReferenceLatent");

    if (!map.referencePath || !map.referenceApiNodes) {
      return;
    }

    const reference = map.referencePath;
    const refIds = map.referenceApiNodes;
    requireTopNode(workflow, reference.loadImageNode, "LoadImage");
    requireTopNode(workflow, reference.loadReferenceImageNode, "LoadImage");
    requireTopNode(workflow, reference.saveImageNode, "SaveImage");
    requireTopNode(workflow, reference.mainSubgraphNode, reference.mainSubgraphId);

    const referenceMain = requireSubgraph(workflow, reference.mainSubgraphId);
    const firstRef = requireSubgraph(workflow, reference.firstReferenceConditioningSubgraphId);
    const secondRef = requireSubgraph(workflow, reference.secondReferenceConditioningSubgraphId);

    validateSubgraphNode(referenceMain, refIds.unetLoader, "UNETLoader");
    validateSubgraphNode(referenceMain, refIds.clipLoader, "CLIPLoader");
    validateSubgraphNode(referenceMain, refIds.vaeLoader, "VAELoader");
    validateSubgraphNode(referenceMain, refIds.randomNoise, "RandomNoise");
    validateSubgraphNode(referenceMain, refIds.clipTextEncode, "CLIPTextEncode");
    validateSubgraphNode(referenceMain, refIds.imageScaleToTotalPixels, "ImageScaleToTotalPixels");
    validateSubgraphNode(referenceMain, refIds.referenceImageScaleToTotalPixels, "ImageScaleToTotalPixels");
    validateSubgraphNode(referenceMain, refIds.getImageSize, "GetImageSize");
    validateSubgraphNode(referenceMain, refIds.flux2Scheduler, "Flux2Scheduler");
    validateSubgraphNode(referenceMain, refIds.emptyFlux2LatentImage, "EmptyFlux2LatentImage");
    validateSubgraphNode(referenceMain, refIds.conditioningZeroOut, "ConditioningZeroOut");
    validateSubgraphNode(referenceMain, refIds.cfgGuider, "CFGGuider");
    validateSubgraphNode(referenceMain, refIds.ksamplerSelect, "KSamplerSelect");
    validateSubgraphNode(referenceMain, refIds.samplerCustomAdvanced, "SamplerCustomAdvanced");
    validateSubgraphNode(referenceMain, refIds.vaeDecode, "VAEDecode");

    validateSubgraphNode(firstRef, refIds.firstPositiveReferenceLatent, "ReferenceLatent");
    validateSubgraphNode(firstRef, refIds.firstVaeEncode, "VAEEncode");
    validateSubgraphNode(firstRef, refIds.firstNegativeReferenceLatent, "ReferenceLatent");
    validateSubgraphNode(secondRef, refIds.secondPositiveReferenceLatent, "ReferenceLatent");
    validateSubgraphNode(secondRef, refIds.secondVaeEncode, "VAEEncode");
    validateSubgraphNode(secondRef, refIds.secondNegativeReferenceLatent, "ReferenceLatent");
  }

  function node(classType, inputs, title) {
    const out = { class_type: classType, inputs };
    if (title) {
      out._meta = { title };
    }
    return out;
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

  function combinePrompt(prompt, negativePrompt) {
    const main = String(prompt || "").trim() || AUTO_FILL_PROMPT;
    const negative = String(negativePrompt || "").trim();
    if (!negative) {
      return main;
    }
    return `${main}\n\nNegative prompt:\n${negative}`;
  }

  function buildReferencePrompt(prompt) {
    const trimmed = String(prompt || "").trim();
    const userPrompt = !trimmed || trimmed === AUTO_FILL_PROMPT
      ? REFERENCE_AUTO_PROMPT
      : trimmed;
    return `${userPrompt}\n\nReference image instructions:\n${REFERENCE_IMAGE_GUIDANCE}`;
  }

  function getPatchBasics(options, defaults) {
    const seed = normalizeSeed(options.seed);
    const rawMegapixels = Number(options.megapixels || defaults.megapixels);
    const megapixels = Number.isFinite(rawMegapixels) ? Math.min(4, Math.max(1, rawMegapixels)) : 1;
    const resolutionSteps = 16;
    const prompt = String(options.prompt || "").trim() || AUTO_FILL_PROMPT;
    const imageName = String(options.imageName || "").trim();

    if (!imageName) {
      throw new Error("ComfyUI upload did not return an input image name.");
    }

    return { seed, megapixels, resolutionSteps, prompt, imageName };
  }

  function buildSingleImagePrompt(ids, defaults, basics) {
    const { seed, megapixels, resolutionSteps, prompt, imageName } = basics;
    const promptJson = {};

    promptJson[ids.loadImage] = node("LoadImage", {
      image: imageName
    }, "Photoshop selection input");

    promptJson[ids.unetLoader] = node("UNETLoader", {
      unet_name: defaults.unetName,
      weight_dtype: defaults.unetWeightDtype
    }, "Flux2 Klein UNET");

    promptJson[ids.clipLoader] = node("CLIPLoader", {
      clip_name: defaults.clipName,
      type: defaults.clipType,
      device: defaults.clipDevice
    }, "Flux2 text encoder");

    promptJson[ids.vaeLoader] = node("VAELoader", {
      vae_name: defaults.vaeName
    }, "Flux2 VAE");

    promptJson[ids.randomNoise] = node("RandomNoise", {
      noise_seed: seed
    }, "Seed");

    promptJson[ids.clipTextEncode] = node("CLIPTextEncode", {
      clip: ref(ids.clipLoader, 0),
      text: prompt
    }, "Prompt");

    promptJson[ids.imageScaleToTotalPixels] = node("ImageScaleToTotalPixels", {
      image: ref(ids.loadImage, 0),
      upscale_method: defaults.upscaleMethod,
      megapixels,
      resolution_steps: resolutionSteps
    }, "Target megapixels");

    promptJson[ids.getImageSize] = node("GetImageSize", {
      image: ref(ids.imageScaleToTotalPixels, 0)
    }, "Scaled image size");

    promptJson[ids.flux2Scheduler] = node("Flux2Scheduler", {
      steps: defaults.steps,
      width: ref(ids.getImageSize, 0),
      height: ref(ids.getImageSize, 1)
    }, "Flux2 scheduler");

    promptJson[ids.emptyFlux2LatentImage] = node("EmptyFlux2LatentImage", {
      width: ref(ids.getImageSize, 0),
      height: ref(ids.getImageSize, 1),
      batch_size: 1
    }, "Latent canvas");

    promptJson[ids.vaeEncode] = node("VAEEncode", {
      pixels: ref(ids.imageScaleToTotalPixels, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Reference latent encode");

    promptJson[ids.positiveReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.clipTextEncode, 0),
      latent: ref(ids.vaeEncode, 0)
    }, "Positive reference conditioning");

    promptJson[ids.conditioningZeroOut] = node("ConditioningZeroOut", {
      conditioning: ref(ids.clipTextEncode, 0)
    }, "Zeroed negative conditioning");

    promptJson[ids.negativeReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.conditioningZeroOut, 0),
      latent: ref(ids.vaeEncode, 0)
    }, "Negative reference conditioning");

    promptJson[ids.cfgGuider] = node("CFGGuider", {
      model: ref(ids.unetLoader, 0),
      positive: ref(ids.positiveReferenceLatent, 0),
      negative: ref(ids.negativeReferenceLatent, 0),
      cfg: defaults.cfg
    }, "CFG guider");

    promptJson[ids.ksamplerSelect] = node("KSamplerSelect", {
      sampler_name: defaults.samplerName
    }, "Sampler");

    promptJson[ids.samplerCustomAdvanced] = node("SamplerCustomAdvanced", {
      noise: ref(ids.randomNoise, 0),
      guider: ref(ids.cfgGuider, 0),
      sampler: ref(ids.ksamplerSelect, 0),
      sigmas: ref(ids.flux2Scheduler, 0),
      latent_image: ref(ids.emptyFlux2LatentImage, 0)
    }, "Sampler custom advanced");

    promptJson[ids.vaeDecode] = node("VAEDecode", {
      samples: ref(ids.samplerCustomAdvanced, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Decode");

    promptJson[ids.saveImage] = node("SaveImage", {
      images: ref(ids.vaeDecode, 0),
      filename_prefix: defaults.outputPrefix
    }, "Photoshop output");

    return {
      prompt: promptJson,
      seed,
      outputNodeId: ids.saveImage,
      defaults
    };
  }

  function buildReferenceImagePrompt(ids, defaults, basics, referenceImageName) {
    const { seed, megapixels, resolutionSteps, imageName } = basics;
    const prompt = buildReferencePrompt(basics.prompt);
    const secondImageName = String(referenceImageName || "").trim();

    if (!secondImageName) {
      throw new Error("Reference image upload did not return an input image name.");
    }

    const promptJson = {};

    promptJson[ids.loadImage] = node("LoadImage", {
      image: imageName
    }, "Photoshop selection input");

    promptJson[ids.loadReferenceImage] = node("LoadImage", {
      image: secondImageName
    }, "Reference image input");

    promptJson[ids.unetLoader] = node("UNETLoader", {
      unet_name: defaults.unetName,
      weight_dtype: defaults.unetWeightDtype
    }, "Flux2 Klein UNET");

    promptJson[ids.clipLoader] = node("CLIPLoader", {
      clip_name: defaults.clipName,
      type: defaults.clipType,
      device: defaults.clipDevice
    }, "Flux2 text encoder");

    promptJson[ids.vaeLoader] = node("VAELoader", {
      vae_name: defaults.vaeName
    }, "Flux2 VAE");

    promptJson[ids.randomNoise] = node("RandomNoise", {
      noise_seed: seed
    }, "Seed");

    promptJson[ids.clipTextEncode] = node("CLIPTextEncode", {
      clip: ref(ids.clipLoader, 0),
      text: prompt
    }, "Prompt");

    promptJson[ids.imageScaleToTotalPixels] = node("ImageScaleToTotalPixels", {
      image: ref(ids.loadImage, 0),
      upscale_method: defaults.upscaleMethod,
      megapixels,
      resolution_steps: resolutionSteps
    }, "Target megapixels");

    promptJson[ids.referenceImageScaleToTotalPixels] = node("ImageScaleToTotalPixels", {
      image: ref(ids.loadReferenceImage, 0),
      upscale_method: defaults.upscaleMethod,
      megapixels,
      resolution_steps: resolutionSteps
    }, "Reference megapixels");

    promptJson[ids.getImageSize] = node("GetImageSize", {
      image: ref(ids.imageScaleToTotalPixels, 0)
    }, "Scaled image size");

    promptJson[ids.flux2Scheduler] = node("Flux2Scheduler", {
      steps: defaults.steps,
      width: ref(ids.getImageSize, 0),
      height: ref(ids.getImageSize, 1)
    }, "Flux2 scheduler");

    promptJson[ids.secondVaeEncode] = node("VAEEncode", {
      pixels: ref(ids.imageScaleToTotalPixels, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Target selection latent encode");

    promptJson[ids.solidMask] = node("SolidMask", {
      value: 1,
      width: ref(ids.getImageSize, 0),
      height: ref(ids.getImageSize, 1)
    }, "Full selection mask");

    promptJson[ids.targetLatentNoiseMask] = node("SetLatentNoiseMask", {
      samples: ref(ids.secondVaeEncode, 0),
      mask: ref(ids.solidMask, 0)
    }, "Masked target latent base");

    promptJson[ids.firstPositiveReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.clipTextEncode, 0),
      latent: ref(ids.secondVaeEncode, 0)
    }, "Target positive reference conditioning");

    promptJson[ids.conditioningZeroOut] = node("ConditioningZeroOut", {
      conditioning: ref(ids.clipTextEncode, 0)
    }, "Zeroed negative conditioning");

    promptJson[ids.firstNegativeReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.conditioningZeroOut, 0),
      latent: ref(ids.secondVaeEncode, 0)
    }, "Target negative reference conditioning");

    promptJson[ids.firstVaeEncode] = node("VAEEncode", {
      pixels: ref(ids.referenceImageScaleToTotalPixels, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Garment reference latent encode");

    promptJson[ids.secondPositiveReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.firstPositiveReferenceLatent, 0),
      latent: ref(ids.firstVaeEncode, 0)
    }, "Garment positive reference conditioning");

    promptJson[ids.secondNegativeReferenceLatent] = node("ReferenceLatent", {
      conditioning: ref(ids.firstNegativeReferenceLatent, 0),
      latent: ref(ids.firstVaeEncode, 0)
    }, "Garment negative reference conditioning");

    promptJson[ids.cfgGuider] = node("CFGGuider", {
      model: ref(ids.unetLoader, 0),
      positive: ref(ids.secondPositiveReferenceLatent, 0),
      negative: ref(ids.secondNegativeReferenceLatent, 0),
      cfg: defaults.cfg
    }, "CFG guider");

    promptJson[ids.ksamplerSelect] = node("KSamplerSelect", {
      sampler_name: defaults.samplerName
    }, "Sampler");

    promptJson[ids.samplerCustomAdvanced] = node("SamplerCustomAdvanced", {
      noise: ref(ids.randomNoise, 0),
      guider: ref(ids.cfgGuider, 0),
      sampler: ref(ids.ksamplerSelect, 0),
      sigmas: ref(ids.flux2Scheduler, 0),
      latent_image: ref(ids.targetLatentNoiseMask, 0)
    }, "Sampler custom advanced masked target");

    promptJson[ids.vaeDecode] = node("VAEDecode", {
      samples: ref(ids.samplerCustomAdvanced, 0),
      vae: ref(ids.vaeLoader, 0)
    }, "Decode");

    promptJson[ids.saveImage] = node("SaveImage", {
      images: ref(ids.vaeDecode, 0),
      filename_prefix: defaults.outputPrefix
    }, "Photoshop output");

    return {
      prompt: promptJson,
      seed,
      outputNodeId: ids.saveImage,
      defaults
    };
  }

  async function patchWorkflow(options) {
    const { map } = await loadWorkflow();
    const defaults = map.defaults;
    const basics = getPatchBasics(options, defaults);
    const referenceImageName = String(options.referenceImageName || "").trim();

    if (referenceImageName) {
      return buildReferenceImagePrompt(map.referenceApiNodes, defaults, basics, referenceImageName);
    }

    return buildSingleImagePrompt(map.apiNodes, defaults, basics);
  }

  globalThis.Flux2WorkflowMapper = {
    AUTO_FILL_PROMPT,
    REFERENCE_AUTO_PROMPT,
    REFERENCE_IMAGE_GUIDANCE,
    combinePrompt,
    loadWorkflow,
    normalizeSeed,
    patchWorkflow,
    validateWorkflow
  };
})();
