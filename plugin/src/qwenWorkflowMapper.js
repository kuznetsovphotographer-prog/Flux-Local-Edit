(function () {
  const MODEL = "qwen_image_2.1_turbo_int8_convrot.safetensors";
  const ENCODER = "qwen3vl_8b_int8_convrot.safetensors";
  const VAE = "qwen_image_2.1_vae_bf16.safetensors";
  const SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";
  const OUTPUT = "13";
  const REQUIRED_NODES = [
    "UNETLoader", "CLIPLoader", "VAELoader", "LoadImage", "TextEncodeQwenImage21", "QwenImage21Cache",
    "ManualSigmas", "KSamplerSelect", "RandomNoise", "CFGGuider", "SamplerCustomAdvanced", "VAEDecode", "SaveImageAdvanced"
  ];

  function lookupOptions(info, node, field) {
    const spec = info[node] && info[node].input && info[node].input.required && info[node].input.required[field];
    return spec && (Array.isArray(spec[0]) ? spec[0] : spec[1] && spec[1].options);
  }

  function validateRequirements(info) {
    const missing = REQUIRED_NODES.filter((node) => !info || !info[node]);
    if (missing.length) throw new Error(`Qwen requires a newer ComfyUI. Missing nodes: ${missing.join(", ")}.`);
    const missingFiles = [
      ["UNETLoader", "unet_name", MODEL, "diffusion_models"],
      ["CLIPLoader", "clip_name", ENCODER, "text_encoders"],
      ["VAELoader", "vae_name", VAE, "vae"]
    ].filter(([node, field, file]) => !(lookupOptions(info, node, field) || []).includes(file));
    if (missingFiles.length) {
      throw new Error(`Qwen model files not found: ${missingFiles.map(([, , file, folder]) => `models/${folder}/${file}`).join(", ")}.`);
    }
  }

  function resolutionFor(megapixels) {
    const mp = globalThis.Flux2ImageSizing.clampNumber(megapixels, 1, 4, 1);
    // Keep the verified 1024 preset at 1 MP. Above that, approximate the requested pixel budget.
    return Math.max(1024, Math.round(Math.sqrt(mp * 1000000) / 32) * 32);
  }

  function roundSide(pixels) {
    // TextEncodeQwenImage21 uses Python round() (ties to even).
    const units = pixels / 32;
    const floor = Math.floor(units);
    return Math.max(1, units - floor === 0.5 && floor % 2 === 0 ? floor : Math.round(units)) * 32;
  }

  function targetSize(width, height, megapixels) {
    const resolution = resolutionFor(megapixels);
    const aspect = width / height;
    return {
      resolution,
      width: roundSide(Math.sqrt(resolution * resolution * aspect)),
      height: roundSide(Math.sqrt(resolution * resolution / aspect))
    };
  }

  function patchWorkflow({ imageName, referenceImageName, referenceImageNames, prompt, megapixels, seed }) {
    if (!imageName) throw new Error("No Photoshop region was uploaded for Qwen.");
    const noiseSeed = globalThis.Flux2WorkflowMapper.normalizeSeed(seed);
    const node = (class_type, inputs) => ({ class_type, inputs });
    const graph = {
      "1": node("UNETLoader", { unet_name: MODEL, weight_dtype: "default" }),
      "2": node("CLIPLoader", { clip_name: ENCODER, type: "qwen_image", device: "default" }),
      "3": node("VAELoader", { vae_name: VAE }),
      "4": node("LoadImage", { image: imageName }),
      "5": node("TextEncodeQwenImage21", {
        clip: ["2", 0], vae: ["3", 0], "images.image_1": ["4", 0],
        prompt: String(prompt == null ? "" : prompt), negative_prompt: "", resolution: resolutionFor(megapixels)
      }),
      "6": node("QwenImage21Cache", { model: ["1", 0], device: "auto", dtype: "default" }),
      "7": node("ManualSigmas", { sigmas: SIGMAS }),
      "8": node("KSamplerSelect", { sampler_name: "euler" }),
      "9": node("RandomNoise", { noise_seed: noiseSeed }),
      "10": node("CFGGuider", {
        model: ["6", 0], positive: ["5", 0], negative: ["5", 1], cfg: 1
      }),
      "11": node("SamplerCustomAdvanced", {
        noise: ["9", 0], guider: ["10", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["5", 2]
      }),
      "12": node("VAEDecode", { samples: ["11", 0], vae: ["3", 0] }),
      [OUTPUT]: node("SaveImageAdvanced", {
        images: ["12", 0], filename_prefix: "Flux_Local_Edit_Qwen", format: "png",
        "format.bit_depth": "8-bit", "format.input_color_space": "sRGB",
        // Place Embedded must see the full crop bounds, not just the extent of opaque pixels.
        "format.channels": "RGB (3 channels)"
      })
    };
    const names = (Array.isArray(referenceImageNames) ? referenceImageNames : [referenceImageName])
      .map((name) => String(name || "").trim()).filter(Boolean).slice(0, 2);
    names.forEach((name, index) => {
      const id = String(14 + index);
      graph[id] = node("LoadImage", { image: name });
      graph["5"].inputs[`images.image_${2 + index}`] = [id, 0];
    });
    return { prompt: graph, outputNodeId: OUTPUT, seed: noiseSeed };
  }

  globalThis.FluxLocalEditQwenWorkflowMapper = { patchWorkflow, targetSize, validateRequirements };
})();
