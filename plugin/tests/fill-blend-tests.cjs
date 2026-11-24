const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const ctx = vm.createContext({ Uint8Array, require: () => ({ storage: { localFileSystem: {} } }) });
for (const file of ["fillBlend.js", "fillWorkflowMapper.js"]) vm.runInContext(fs.readFileSync(path.join(root, "src", file), "utf8"), ctx);
const blend = ctx.FluxLocalEditFillBlend;
const mapper = ctx.FluxLocalEditFillWorkflowMapper;
const map = JSON.parse(fs.readFileSync(path.join(root, "workflows", "fill-workflow-map.json"), "utf8"));
const bounds = (left, top, right, bottom) => ({ left, top, right, bottom });
const examples = blend.plan(bounds(1520, 2140, 1759, 2469), 3650, 5478, { megapixels: 1, prompt: " " });

function unit() {
  const f = examples;
  assert.deepEqual(JSON.parse(JSON.stringify(f.contextBounds)), bounds(1191, 1811, 2088, 2798));
  assert.deepEqual([f.contextWidth, f.contextHeight, f.targetWidth, f.targetHeight, f.growWork, f.blurWork, f.layerGrow, f.featherImage],
    [897, 987, 944, 1056, 51, 21, 48, 20]);
  const edge = blend.plan(bounds(0, 20, 239, 349), 3650, 5478, { megapixels: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(edge.contextBounds)), bounds(0, 0, 897, 987));
  const prompt = blend.plan(bounds(0, 20, 239, 349), 3650, 5478, { megapixels: 1, prompt: "red earring" });
  assert.deepEqual([prompt.contextWidth, prompt.contextHeight, prompt.layerGrow], [567, 657, 20]);
  const full = blend.plan(bounds(0, 0, 100, 99), 100, 99, { megapixels: 1 });
  assert.deepEqual([full.contextWidth, full.contextHeight, full.colorMatch], [100, 99, false]);
  for (const mp of [1, 2, 3, 4]) for (const b of [bounds(0, 50, 30, 150), bounds(930, 0, 980, 500), bounds(0, 0, 30000, 10)]) {
    const p = blend.plan(b, 30000, 500, { megapixels: mp });
    assert.equal(p.targetWidth % 16 + p.targetHeight % 16, 0);
    assert(p.targetWidth * p.targetHeight <= mp * 1_000_000);
    assert(Math.max(p.targetWidth, p.targetHeight) <= 4096);
    assert(p.contextBounds.left <= b.left && p.contextBounds.right >= b.right);
    if (b.right === 30000) assert.equal(p.nativeTransfer, false);
  }

  const strip = { bounds: bounds(160, 100, 491, 218), data: new Uint8Array(331 * 118) };
  for (let x = 0; x < 331; x++) {
    const start = Math.floor(x * 0.24);
    for (let y = start; y < start + 32; y++) strip.data[y * 331 + x] = 255;
  }
  const compact = { bounds: bounds(160, 100, 491, 218), data: new Uint8Array(331 * 118).fill(255) };
  const placement = blend.plan(strip.bounds, 1200, 1000, {});
  assert.equal(blend.generationMaskProfile(placement, compact), placement, "The filled bounding box is not a narrow strip");
  const limited = blend.generationMaskProfile(placement, strip);
  assert(limited.maskThickness > 20 && limited.maskThickness < 32);
  assert(limited.growWork < placement.growWork / 3 && limited.blurWork <= limited.growWork / 2);
  assert.deepEqual(Object.keys(limited).filter((key) => limited[key] !== placement[key]).sort(),
    ["blurWork", "growWork", "maskThickness"], "Only the generation mask can change");
  const morePixels = blend.generationMaskProfile(blend.plan(strip.bounds, 1200, 1000, { megapixels: 4 }), strip);
  assert(morePixels.growWork > limited.growWork, "Growth follows the rendering resolution");
  assert.equal(morePixels.maskThickness, limited.maskThickness, "Thickness is measured in document pixels");
  for (const advanced of [true, false]) {
    const { prompt } = mapper.buildPromptWithMap(map, { imageName: "source.png", maskName: "mask.png", profile: limited, advanced, seed: 42 });
    const node = prompt[map.apiNodes.maskGrow];
    assert.equal(node.inputs[advanced ? "grow" : "expand"], limited.growWork);
    if (advanced) assert.equal(node.inputs.blur, limited.blurWork);
  }

  const p = blend.plan(bounds(95, 95, 209, 209), 512, 512, {});
  const mask = { bounds: p.selectionBounds, data: new Uint8Array(114 * 114).fill(255) };
  for (let y = 18; y < 96; y++) mask.data.fill(0, y * 114 + 18, y * 114 + 96);
  const expanded = blend.layerMask(mask, p);
  function alpha(x, y) {
    const b = expanded.bounds;
    if (x < b.left || x >= b.right || y < b.top || y >= b.bottom) return 0;
    return expanded.data[(y - b.top) * (b.right - b.left) + x - b.left];
  }
  assert.equal(alpha(152, 152), 0, "A large interior gap is not repainted");
  assert(alpha(105, 150) > 245, "Target opaque inside");
  assert(alpha(93, 150) > 220, "Soft ramp covers the outline");
  assert(alpha(74, 150) < alpha(85, 150) && alpha(74, 150) > 0);
  assert.equal(alpha(52, 150), 0, "Pixels beyond the ramp stay unchanged");

  const inner = blend.innerLayerMask(mask, p);
  assert.deepEqual(inner.bounds, mask.bounds, "Do not expand the bounding box");
  for (let i = 0; i < mask.data.length; i++) assert(inner.data[i] <= mask.data[i], "Never add opacity to the original mask");
  assert.equal(inner.data[57 * 114 + 57], 0, "The hole stays protected");
  assert(inner.data[57 * 114 + 17] < 255, "The inner edge of a hole also fades");
  assert(inner.data[57 * 114] < inner.data[57 * 114 + 3] && inner.data[57 * 114 + 3] < 255);
  assert.equal(inner.data[57 * 114 + 8], 255, "The core stays opaque");
  const narrow = { bounds: bounds(20, 20, 22, 80), data: new Uint8Array(120).fill(255) };
  assert.equal(blend.innerLayerMask(narrow, p), narrow, "A two-pixel selection does not disappear");
  const branch = { bounds: bounds(0, 0, 12, 12), data: new Uint8Array(144) };
  for (let y = 0; y < 9; y++) branch.data.fill(255, y * 12, y * 12 + 9);
  for (let x = 9; x < 12; x++) branch.data[4 * 12 + x] = 255;
  branch.data[4 * 12 + 8] = 23;
  const branchBlend = blend.innerLayerMask(branch, { ...p, featherImage: 3 });
  assert.equal(branchBlend.data[0], 255, "No fade along the outside canvas edge");
  assert.equal(branchBlend.data[4 * 12 + 11], 255, "Keep a one-pixel arm attached to a large selection");
  assert.equal(branchBlend.data[4 * 12 + 8], 23, "Do not multiply an already softer original alpha");

  const w = 120, h = 120;
  const local = blend.plan(bounds(40, 40, 80, 80), w, h, {});
  const raw = { bounds: local.selectionBounds, data: new Uint8Array(1600).fill(255) };
  const frame = (value) => ({ width: w, height: h, components: 4, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? 255 : value) });
  const base = frame(100), generated = frame(117);
  for (let y = 40; y < 80; y++) for (let x = 40; x < 80; x++) base.data.fill(220, (y * w + x) * 4, (y * w + x) * 4 + 3);
  const field = blend.seamField(base, generated, raw, local);
  assert.equal(field.largest, 17, "Removed object in original must not change the color correction");
  blend.applySeam(generated.data, w, h, 4, 0, 0, field);
  assert.deepEqual([...generated.data.slice((60 * w + 60) * 4, (60 * w + 60) * 4 + 4)], [100, 100, 100, 255]);
  assert.deepEqual([...generated.data.slice(0, 4)], [117, 117, 117, 255]);
  assert.equal(blend.seamField(base, frame(160), raw, local), null, "A true content difference must not be treated as a tint");
  console.log("PASS OpenFill geometry, 1–4 MP, adaptive generation growth, inward/outward masks, canvas edges, holes and local RGB correction");
}

function png(width, height, colorAt) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(colorAt(x, y), y * (width * 3 + 1) + x * 3 + 1);
  }
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

async function live() {
  const base = "http://127.0.0.1:8188";
  const get = async (route, options) => {
    const response = await fetch(base + route, options);
    if (!response.ok) throw Error(`${route}: ${response.status} ${await response.text()}`);
    return response;
  };
  const queue = async () => (await get("/queue")).json();
  const assertIdle = async () => {
    const q = await queue();
    assert(!q.queue_running.length && !q.queue_pending.length, "Do not enqueue the smoke test on a busy server");
  };
  await assertIdle();
  const requirements = mapper.validateRequirementsWithMap(map, await (await get("/object_info")).json());
  assert(requirements.advanced, `OpenFill nodes missing: ${requirements.missingInpaintNodes}`);
  const folder = `local-edit-smoke-${Date.now()}`;
  async function upload(name, data) {
    const body = new FormData();
    body.append("image", new Blob([data], { type: "image/png" }), name);
    body.append("subfolder", folder);
    const saved = await (await get("/upload/image", { method: "POST", body })).json();
    return `${saved.subfolder}/${saved.name}`;
  }
  const f = examples;
  const inLasso = (x, y) => ((x - 448) / 119) ** 2 + ((y - 493) / 164) ** 2 <= 1;
  const imageName = await upload("source.png", png(f.contextWidth, f.contextHeight, (x, y) => {
    const ring = ((x - 448) / 77) ** 2 + ((y - 493) / 116) ** 2;
    return ring >= 0.75 && ring < 1 ? [215, 165, 48] : [122 + Math.floor(x / 19), 128 + Math.floor(y / 20), 155];
  }));
  const maskName = await upload("selection.png", png(f.contextWidth, f.contextHeight, (x, y) => Array(3).fill(inLasso(x, y) ? 255 : 0)));
  const graph = mapper.buildPromptWithMap(map, { imageName, maskName, profile: f, advanced: true, seed: 3718167939, prompt: "" });
  const output = graph.prompt[graph.outputNodeId];
  graph.prompt[graph.outputNodeId] = { class_type: "PreviewImage", inputs: { images: output.inputs.images } };
  await assertIdle();
  const { prompt_id: id } = await (await get("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph.prompt }) })).json();
  console.log(`Queued 25-step Fill smoke test: ${id}`);
  for (let i = 0; i < 240; i++) {
    const record = (await (await get(`/history/${id}`)).json())[id];
    if (record) {
      assert.equal(record.status.status_str, "success", JSON.stringify(record.status.messages.filter(([kind]) => kind.startsWith("execution_error"))));
      const image = record.outputs[graph.outputNodeId].images[0];
      const bytes = Buffer.from(await (await get("/view?" + new URLSearchParams(image))).arrayBuffer());
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [897, 987]);
      console.log("PASS live advanced FLUX.1 Fill: 25 steps at 944×1056, PNG returns at native 897×987");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw Error(`Timed out waiting for synthetic Fill prompt ${id}`);
}

unit();
if (process.argv.includes("--live")) live().catch((error) => { console.error(error); process.exitCode = 1; });
