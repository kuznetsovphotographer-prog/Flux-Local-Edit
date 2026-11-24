(function () {
  const { storage } = require("uxp");
  const fs = storage.localFileSystem;
  const BACKGROUND = "seamless continuation of the surrounding background, same material, texture, lighting and color as the area around it, nothing added";
  const BACKGROUND_NEGATIVE = "object, button, logo, text, watermark, person, blurry, smudge, artifacts, seam";

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
    const warmup = Boolean(options && options.warmup);
    const profile = options && options.profile;
    const advanced = Boolean(options && options.advanced);
    const removal = !promptText.trim();

    if (!warmup && !imageName) throw new Error("ComfyUI upload did not return the Fill context image name.");
    if (!warmup && !maskName) throw new Error("ComfyUI upload did not return the Fill mask image name.");
    if (!warmup && (!profile || ![profile.contextWidth, profile.contextHeight, profile.targetWidth, profile.targetHeight]
      .every((n) => Number.isInteger(n) && n > 0))) throw new Error("Fill context geometry is missing or invalid.");

    const prompt = {};
    const put = (key, type, inputs, title) => {
      prompt[ids[key]] = node(type, inputs, title);
      return ref(ids[key], 0);
    };
    const scaleImage = (key, image, width, height) => put(key, "ImageScale", {
      image, width, height, upscale_method: "lanczos", crop: "disabled"
    });
    let image, mask, original;
    if (warmup) {
      image = put("loadImage", "EmptyImage", { width: 256, height: 256, batch_size: 1, color: 8421504 });
      mask = put("loadMask", "SolidMask", { width: 256, height: 256, value: 1 });
    } else {
      image = put("loadImage", "LoadImage", { image: imageName }, "Photoshop Fill context");
      let gray = put("loadMask", "LoadImage", { image: maskName }, "Photoshop selection mask");
      if (profile.nativeTransfer !== false && (profile.targetWidth !== profile.contextWidth || profile.targetHeight !== profile.contextHeight)) {
        image = scaleImage("imageScale", image, profile.targetWidth, profile.targetHeight);
        gray = scaleImage("maskScale", gray, profile.targetWidth, profile.targetHeight);
      }
      original = image;
      mask = put("imageToMask", "ImageToMask", { image: gray, channel: defaults.maskChannel });
      const grow = profile.growWork, blur = profile.blurWork;
      if (advanced) {
        mask = put("maskGrow", "INPAINT_ExpandMask", { mask, grow, blur, blur_type: "gaussian" });
        mask = put("maskStable", "INPAINT_StabilizeMask", { mask, epsilon: 0.01 });
        image = put("prefill", "INPAINT_MaskedFill", { image, mask, fill: "navier-stokes", falloff: 0 });
        image = put("preblur", "INPAINT_MaskedBlur", { image, mask, blur: 65, falloff: 0 });
      } else {
        mask = put("maskGrow", "GrowMask", { mask, expand: grow, tapered_corners: true });
        if (blur > 0) {
          const maskImage = put("maskToImage", "MaskToImage", { mask });
          const blurred = put("maskBlur", "ImageBlur", { image: maskImage,
            blur_radius: Math.max(1, Math.min(31, Math.floor(blur / 2))), sigma: Math.max(1, blur / 3) });
          mask = put("softMask", "ImageToMask", { image: blurred, channel: defaults.maskChannel });
        }
      }
    }
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
      text: removal ? BACKGROUND : promptText,
      clip: ref(ids.dualClipLoader, 0)
    }, removal ? "Continue surrounding background" : "Fill prompt");
    prompt[ids.fluxGuidance] = node("FluxGuidance", {
      conditioning: ref(ids.clipTextEncode, 0),
      guidance: defaults.guidance
    }, "FLUX guidance");
    prompt[ids.negativePrompt] = node("CLIPTextEncode", { text: removal ? BACKGROUND_NEGATIVE : "",
      clip: ref(ids.dualClipLoader, 0) }, "Negative Fill prompt");
    prompt[ids.differentialDiffusion] = node("DifferentialDiffusion", {
      model: ref(ids.unetLoader, 0),
      strength: defaults.differentialDiffusionStrength
    }, "Differential diffusion");
    prompt[ids.inpaintConditioning] = node("InpaintModelConditioning", {
      positive: ref(ids.fluxGuidance, 0),
      negative: ref(ids.negativePrompt, 0),
      vae: ref(ids.vaeLoader, 0),
      pixels: image,
      mask,
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
    let output = ref(ids.vaeDecode, 0);
    if (!warmup) {
      if (advanced && profile.colorMatch) {
        output = put("colorMatch", "INPAINT_ColorMatch", { target: output, reference: original,
          exclude_mask: mask, strength: 1 });
      }
      // Large contexts are fitted in Photoshop instead of allocating a large GPU upscaling tensor.
      if (profile.nativeTransfer !== false && (profile.targetWidth !== profile.contextWidth || profile.targetHeight !== profile.contextHeight)) {
        output = scaleImage("outputScale", output, profile.contextWidth, profile.contextHeight);
      }
    }
    prompt[ids.saveImage] = node("SaveImage", {
      images: output,
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
    const missingInpaintNodes = (map.inpaintNodes || []).filter((name) => !objectInfo || !objectInfo[name]);
    if (missingInpaintNodes.length) for (const name of map.fallbackNodes || []) {
      if (!objectInfo || !objectInfo[name]) missingNodes.push(name);
    }
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
    return { advanced: missingInpaintNodes.length === 0, missingInpaintNodes };
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
