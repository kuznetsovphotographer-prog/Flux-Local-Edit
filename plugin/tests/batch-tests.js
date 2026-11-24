const assert = require("assert");
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.resolve(__dirname, "..");
const plain = (v) => JSON.parse(JSON.stringify(v));
const logger = { info() {}, warn() {}, error() {} };
function load(ctx, name) { vm.runInContext(fs.readFileSync(path.join(root, "src", name), "utf8"), ctx, { filename: name }); }
function base(overrides = {}) { const ctx = { console, URL, Uint8Array, setTimeout, ...overrides }; ctx.globalThis = ctx; vm.createContext(ctx); return ctx; }

function brute(data, w, h) {
  const seen = new Set(), out = [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || seen.has(i)) continue;
    const q = [i], pixels = []; seen.add(i);
    for (let head = 0; head < q.length; head++) {
      const p = q[head], x = p % w, y = Math.floor(p / w); pixels.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, n = yy * w + xx;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && data[n] && !seen.has(n)) { seen.add(n); q.push(n); }
      }
    }
    const xs = pixels.map((p) => p % w), ys = pixels.map((p) => Math.floor(p / w));
    const bounds = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs) + 1, bottom: Math.max(...ys) + 1 };
    out.push({ bounds, solid: pixels.every((p) => data[p] === 255) && pixels.length === (bounds.right - bounds.left) * (bounds.bottom - bounds.top) });
  }
  return out.sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}
async function components() {
  const ctx = base(); load(ctx, "selectionRegions.js"); const r = ctx.FluxLocalEditRegions;
  let rand = 1234; const next = () => (rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let trial = 0; trial < 250; trial++) {
    const w = 4 + trial % 11, h = 3 + trial % 13;
    const data = Uint8Array.from({ length: w * h }, () => next() < 0.3 ? (next() < 0.2 ? 64 : 255) : 0);
    if (!data.some(Boolean)) data[0] = 255;
    const jobs = r.split(data, w, h);
    assert.deepStrictEqual(plain(jobs.map(({ bounds, solid }) => ({ bounds, solid }))), brute(data, w, h));
    const reconstructed = new Uint8Array(data.length);
    for (const job of jobs) {
      const pixels = r.regionMask(data, w, job);
      for (let y = 0; y < job.height; y++) for (let x = 0; x < job.width; x++) reconstructed[(y + job.bounds.top) * w + x + job.bounds.left] += pixels[y * job.width + x];
    }
    assert.deepStrictEqual(reconstructed, data);
    const offset = r.split(data, w, h, { left: 111, top: 222 });
    assert.equal(offset[0].bounds.left, jobs[0].bounds.left + 111);
    assert.equal(offset[0].bounds.top, jobs[0].bounds.top + 222);
  }
  assert.throws(() => r.split(new Uint8Array(10), 5, 3), /dimensions/);
  assert.throws(() => r.split(new Uint8Array(9), 3, 3), /No selected/);
}

function host(mode, failure = "", soft = false, single = false, nearby = false) {
  let docId = 1, layerId = 1, modal = false, jobsRun = 0, maxInFlight = 0, inFlight = 0;
  const events = [], documents = [], files = new Map();
  const token = { cancelled: false }; const app = { documents, activeDocument: null };
  const check = () => { if (token.cancelled) { const e = new Error("Stopped"); e.kind = "cancelled"; throw e; } };
  const width = mode === "qwen" ? 420 : 40, height = mode === "qwen" ? 300 : 30;
  const selected = new Uint8Array(width * height);
  function rectangle(data, b, value = 255) { for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) data[y * width + x] = value; }
  const rectangles = nearby ? [{ left: 4, top: 6, right: 16, bottom: 24 }, { left: 17, top: 6, right: 29, bottom: 24 }]
    : single ? [{ left: 12, top: 10, right: 24, bottom: 20 }] : mode === "qwen"
    ? [{ left: 0, top: 0, right: 110, bottom: 23 }, { left: 180, top: 100, right: 190, bottom: 161 }, { left: 330, top: 240, right: 420, bottom: 300 }]
    : [{ left: 0, top: 0, right: 3, bottom: 4 }, { left: 14, top: 10, right: 18, bottom: 14 }, { left: 33, top: 24, right: 40, bottom: 30 }];
  rectangles.forEach((r) => rectangle(selected, r)); if (soft) selected[0] = 64;
  function boundsOf(data, w) {
    let l = w, t = Infinity, r = 0, b = 0;
    for (let p = 0; p < data.length; p++) if (data[p]) { const x = p % w, y = Math.floor(p / w); l = Math.min(l, x); r = Math.max(r, x + 1); t = Math.min(t, y); b = Math.max(b, y + 1); }
    return t === Infinity ? null : { left: l, top: t, right: r, bottom: b };
  }
  function detach(layer) { const list = layer.parent ? layer.parent.layers : layer.doc.layers; const i = list.indexOf(layer); if (i >= 0) list.splice(i, 1); }
  function layer(doc, b = { left: 0, top: 0, right: 32, bottom: 32 }) {
    const l = { id: layerId++, doc, parent: null, bounds: { ...b }, name: "Layer", _isClippingMask: false,
      get isClippingMask() { return this._isClippingMask; },
      set isClippingMask(value) {
        if (value === false && !this._isClippingMask) throw new Error('Command "Release Clipping Mask" is not currently available.');
        this._isClippingMask = value; events.push("change-clipping-mask");
      },
      get boundsNoEffects() { return this.bounds; },
      async translate(dx, dy) { this.bounds.left += dx; this.bounds.right += dx; this.bounds.top += dy; this.bounds.bottom += dy; },
      move(target, location) {
        detach(this);
        if (location === "inside") { target.layers.push(this); this.parent = target; }
        else { this.parent = target.parent; const list = this.parent ? this.parent.layers : doc.layers; list.splice(list.indexOf(target), 0, this); }
      },
      delete() { detach(this); this.deleted = true; events.push("delete-layer"); }
    }; doc.layers.unshift(l); return l;
  }
  function channel(doc, name, pixels) { return { name, pixels: pixels.slice(), remove() { doc.channels.splice(doc.channels.indexOf(this), 1); } }; }
  function makeDoc(w, h, pixels, sourceVersion = "ORIGINAL", channels = []) {
    const doc = { id: docId++, width: w, height: h, title: "Fixture", sourceVersion, mode: "RGB", bitsPerChannel: 8, layers: [], activeLayers: [], channels: [], selectionData: pixels.slice(),
      get selection() { return this._selection; },
      async duplicate() { const copy = makeDoc(this.width, this.height, this.selectionData, this.sourceVersion, this.channels); app.activeDocument = copy; return copy; },
      async crop(b) { events.push({ type: "crop", sourceVersion: doc.sourceVersion, bounds: plain(b) }); doc.width = b.right - b.left; doc.height = b.bottom - b.top; },
      async resizeImage(w, h) { doc.width = w; doc.height = h; }, async flatten() {},
      async createLayer() { return layer(doc); },
      async createLayerGroup(options) {
        const group = layer(doc); group.layers = []; group.name = options.name;
        for (const l of options.fromLayers) l.move(group, "inside"); return group;
      },
      closeWithoutSaving() { documents.splice(documents.indexOf(doc), 1); if (app.activeDocument === doc) app.activeDocument = documents[0]; },
      saveAs: { async png(file) { file.width = doc.width; file.height = doc.height; file.sourceVersion = doc.sourceVersion; events.push({ type: "png", file: file.name, sourceVersion: doc.sourceVersion }); } }
    };
    doc._selection = { get bounds() { return boundsOf(doc.selectionData, doc.width); }, get solid() { return true; },
      async save(name) { doc.channels.push(channel(doc, name, doc.selectionData)); },
      async load(c) { if (!c) throw new Error("Missing channel"); doc.selectionData = c.pixels.slice(); },
      async selectAll() {}, async deselect() {} };
    doc.channels = channels.map((c) => channel(doc, c.name, c.pixels));
    const original = layer(doc); doc.activeLayers = [original]; documents.push(doc); return doc;
  }
  const source = makeDoc(width, height, selected); app.activeDocument = source;
  app.open = async (file) => {
    const doc = makeDoc(file.width, file.height, new Uint8Array(file.width * file.height), "GENERATED");
    app.activeDocument = doc; return doc;
  };
  const constants = { SelectionType: { REPLACE: "replace" }, ElementPlacement: { PLACEBEFORE: "before", PLACEINSIDE: "inside" },
    DocumentMode: { RGB: "RGB" }, ChangeMode: {}, BitsPerChannelType: { EIGHT: 8 }, LayerKind: { NORMAL: "normal" }, ResampleMethod: { BICUBIC: "bicubic" } };
  const photoshop = { app, constants, core: { async executeAsModal(fn) { assert(!modal, "Nested executeAsModal"); modal = true; try { return await fn(); } finally { modal = false; } } },
    imaging: {
      async getPixels({ documentID, sourceBounds, targetSize }) {
        const doc = documents.find((d) => d.id === documentID), b = sourceBounds;
        const w = targetSize ? targetSize.width : b.right - b.left, h = targetSize ? targetSize.height : b.bottom - b.top;
        return { sourceBounds: b, level: 0, imageData: { width: w, height: h, components: 3,
          async getData() { return new Uint8Array(w * h * 3).fill(doc.sourceVersion === "GENERATED" ? 115 : 100); }, dispose() {} } };
      },
      async putPixels({ documentID, imageData, targetBounds }) {
        if (failure === "seam-write") throw new Error("Synthetic color write failure");
        assert.notStrictEqual(documentID, source.id, "Never rewrite the original pixels");
        events.push({ type: "seam-write", first: imageData.data[0], targetBounds });
        if (failure === "cancel-seam") token.cancelled = true;
      },
      async getSelection({ documentID, sourceBounds }) {
        if (failure === "capture") throw new Error("Synthetic selection capture failure");
        const doc = documents.find((d) => d.id === documentID), b = sourceBounds, w = b.right - b.left, h = b.bottom - b.top;
        const pixels = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) pixels.set(doc.selectionData.subarray((y + b.top) * doc.width + b.left, (y + b.top) * doc.width + b.right), y * w);
        return { sourceBounds: b, imageData: { width: w, height: h, components: 1, componentSize: 8, async getData() { return pixels; }, dispose() { pixels.fill(0); } } };
      },
      async createImageDataFromBuffer(data, options) { return { data, ...options, dispose() {} }; },
      async putSelection({ documentID, imageData: image, targetBounds: b }) {
        const doc = documents.find((d) => d.id === documentID); doc.selectionData = new Uint8Array(doc.width * doc.height);
        for (let y = 0; y < image.height; y++) doc.selectionData.set(image.data.subarray(y * image.width, (y + 1) * image.width), (y + b.top) * doc.width + b.left);
      }
    },
    action: { async batchPlay(descriptors) {
      for (const d of descriptors) {
        if (d._obj === "select" && d._target[0]._ref === "document") app.activeDocument = documents.find((doc) => doc.id === d._target[0]._id);
        if (d._obj === "set") {
          const b = Object.fromEntries(["left", "top", "right", "bottom"].map((k) => [k, d.to[k]._value]));
          app.activeDocument.selectionData.fill(0); rectangle(app.activeDocument.selectionData, b);
        }
        if (d._obj === "placeEvent") {
          events.push({ type: "place", file: d.null._path });
          const l = layer(app.activeDocument); app.activeDocument.activeLayers = [l];
          if (failure === "clipped") l._isClippingMask = true;
        }
        if (d._obj === "transform") {
          if (failure === "transform") throw new Error("Synthetic alignment failure");
          if (failure === "frozen-transform") throw Object.freeze(new Error("Frozen native alignment failure"));
          const l = app.activeDocument.activeLayers[0], b = l.bounds;
          const w = (b.right - b.left) * d.width._value / 100, h = (b.bottom - b.top) * d.height._value / 100;
          const cx = (b.left + b.right) / 2 + d.offset.horizontal._value, cy = (b.top + b.bottom) / 2 + d.offset.vertical._value;
          l.bounds = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
        }
        if (d._obj === "make") {
          app.activeDocument.activeLayers[0].mask = app.activeDocument.selectionData.slice();
          events.push({ type: "mask" });
          if (failure === "cancel-placement" && jobsRun === 2) token.cancelled = true;
        }
      }
      return [];
    } }
  };
  const storage = { localFileSystem: { async getTemporaryFolder() { return { async createFile(name) {
    const f = { name, delete() { f.deleted = true; } }; files.set(name, f); return f;
  } }; }, async createSessionToken(file) { return file.name || "file"; } } };
  const ctx = base({ require(name) { if (name === "photoshop") return photoshop; if (name === "uxp") return { storage }; throw new Error(name); } });
  ["imageSizing.js", "selectionRegions.js", "photoshop.js", "fillBlend.js", "fillPhotoshop.js", "batchPhotoshop.js", "batchRunner.js",
    "references.js", "editAdapter.js", "fillAdapter.js", "qwenWorkflowMapper.js", "qwenAdapter.js"].forEach((f) => load(ctx, f));
  ctx.Flux2WorkflowMapper = { normalizeSeed: (s) => Number(s) || 123, combinePrompt: (p) => p, async patchWorkflow(opts) { return { seed: opts.seed, outputNodeId: "out", prompt: { mode, ...opts } }; } };
  ctx.FluxLocalEditFillWorkflowMapper = { normalizeSeed: (s) => Number(s) || 123,
    async validateRequirements() { return { advanced: true, missingInpaintNodes: [] }; },
    async patchWorkflow(opts) { return { seed: opts.seed, outputNodeId: "out", prompt: { mode, ...opts } }; } };
  function qwenInfo() {
    const { prompt: graph } = ctx.FluxLocalEditQwenWorkflowMapper.patchWorkflow({ imageName: "fixture.png", seed: 1 });
    const info = Object.fromEntries(Object.values(graph).map(({ class_type }) => [class_type, { input: { required: {} } }]));
    for (const [id, key] of [["1", "unet_name"], ["2", "clip_name"], ["3", "vae_name"]]) {
      info[graph[id].class_type].input.required[key] = [[graph[id].inputs[key]]];
    }
    return info;
  }
  ctx.Flux2ComfyClient = { ComfyClient: class {
    async testConnection() { return {}; } async getObjectInfo() {
      if (mode === "qwen") { events.push({ type: "qwen-validate" }); return qwenInfo(); }
      return {};
    }
    async uploadImage(file, role) { assert(!file.deleted); events.push({ type: "upload", role }); return { imageName: file.name || `${role}.png` }; }
    async runPrompt(graph) {
      assert.strictEqual(app.activeDocument, source, "Original, not snapshot, must be visible during generation");
      jobsRun++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve();
      events.push({ type: "job", seed: mode === "qwen" ? graph["9"].inputs.noise_seed : graph.seed, graph }); source.sourceVersion = "ALREADY_EDITED";
      if ((jobsRun === 2 && failure === "error") || (jobsRun === 1 && failure === "first-error")) { inFlight--; throw new Error("Comfy failure"); }
      if (jobsRun === 1 && failure === "first-cancel") token.cancelled = true;
      if (jobsRun === 2 && failure === "cancel") token.cancelled = true;
      if (jobsRun === 2 && failure === "canvas") source.width++;
      if (jobsRun === 2 && failure === "group") { const group = source.layers.find((l) => l.layers); if (group) await group.delete(); }
      inFlight--; return { image: { filename: "result.png" } };
    }
    async downloadImage() { return { file: { name: "result.png", width, height }, blob: {} }; }
  } };
  const progress = [], previews = []; let records = 0;
  const context = { settings: { prompt: "remove person", megapixels: 1, seed: 123 }, referenceFiles: [{ name: "ref1.png" }, { name: "ref2.png" }], logger, cancelToken: token,
    throwIfCancelled: check, setClient() {}, setPromptId() {}, updateSelectionHint() {}, shouldRecordAction: true,
    async recordAction() { records++; }, onProgress() {}, onBatchProgress: (s) => progress.push(s), setPreview: (p) => previews.push(p) };
  return { ctx, source, rectangles, selected, documents, files, events, progress, previews, context,
    stats: () => ({ jobsRun, maxInFlight, records }),
    adapter: { edit: ctx.FluxLocalEditEditAdapter, fill: ctx.FluxLocalEditFillAdapter, qwen: ctx.FluxLocalEditQwenAdapter }[mode] };
}

async function queues() {
  for (const mode of ["edit", "fill", "qwen"]) for (const failure of ["", "error", "cancel", "canvas", "group", "cancel-placement"]) {
    const h = host(mode, failure);
    let result, error;
    try { result = await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode); } catch (e) { error = e; }
    const expected = failure ? 1 : 3;
    if (failure) { assert(error, `${mode}/${failure}: expected error`); assert.equal(error.batch.completed, 1); }
    else { if (error) throw error; assert.equal(result.completed, 3); }
    assert.equal(h.stats().jobsRun, failure ? 2 : 3);
    assert.equal(h.stats().maxInFlight, 1); assert.equal(h.stats().records, 1);
    assert.equal(h.events.filter((e) => e.type === "upload" && e.role === "edit-reference").length, mode === "edit" ? 2 : 0);
    if (mode === "edit") assert(h.events.filter((e) => e.type === "job").every(({ graph }) =>
      graph.referenceImageNames.join(",") === "ref1.png,ref2.png"));
    if (mode === "qwen") {
      assert.equal(h.events.filter((e) => e.type === "upload" && e.role === "qwen-reference").length, 2);
      assert.equal(h.events.filter((e) => e.type === "qwen-validate").length, 1);
      const jobs = h.events.filter((e) => e.type === "job");
      for (const { graph } of jobs) {
        assert.equal(graph["5"].inputs.prompt, "remove person");
        assert.deepStrictEqual(plain(graph["5"].inputs["images.image_1"]), ["4", 0]);
        assert.deepStrictEqual(plain(graph["5"].inputs["images.image_2"]), ["14", 0]);
        assert.deepStrictEqual(plain(graph["5"].inputs["images.image_3"]), ["15", 0]);
        assert.equal(graph["14"].inputs.image, "ref1.png");
        assert.equal(graph["15"].inputs.image, "ref2.png");
      }
    }
    assert.equal(h.previews.length, expected);
    assert.equal(h.documents.length, 1, "Frozen snapshot and export duplicates must be closed");
    assert.equal(h.source.channels.length, 0, "Temporary channels must be removed");
    assert.deepStrictEqual(h.source.selectionData, h.selected, "Original multi-selection must be restored");
    assert([...h.files.values()].every((f) => f.deleted), "Export PNGs must be deleted");
    assert(h.events.filter((e) => e.type === "png" && !e.file.includes("fill-blended")).every((e) => e.sourceVersion === "ORIGINAL"), "Later exports must not include previous results");
    if (failure !== "group") {
      const group = h.source.layers.find((l) => l.layers); assert(group); assert.equal(group.layers.length, expected);
      assert.equal(group.name, `${{ edit: "Flux Edit", fill: "Flux Fill", qwen: "Qwen" }[mode]} - 3 regions`);
      group.layers.forEach((l, i) => {
        const mask = new Uint8Array(h.selected.length), b = h.rectangles[i];
        const w = mode === "qwen" ? 420 : 40, ht = mode === "qwen" ? 300 : 30;
        for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) mask[y * w + x] = 255;
        if (mode === "fill") {
          for (let j = 0; j < mask.length; j++) assert(l.mask[j] <= mask[j], "Fill alpha must stay within its own region");
          assert.equal(l.mask[Math.floor((b.top + b.bottom) / 2) * w + Math.floor((b.left + b.right) / 2)], 255);
        } else assert.deepStrictEqual(l.mask, mask, `${mode} layer mask must match the exact selection`);
        const target = mode === "qwen" ? [
          { left: 0, top: 0, right: 174, bottom: 87 },
          { left: 116, top: 36, right: 254, bottom: 225 },
          { left: 266, top: 176, right: 420, bottom: 300 }
        ][i] : mode === "edit" ? b : { left: 0, top: 0, right: w, bottom: ht };
        assert.deepStrictEqual(plain(l.bounds), target, "Context placement must match original coordinates");
      });
    }
    const seeds = h.events.filter((e) => e.type === "job").map((e) => e.seed);
    assert.deepStrictEqual(seeds, failure ? [123, 124] : [123, 124, 125]);
  }
}

async function shapeValidation() {
  const rejected = host("edit", "", true);
  await assert.rejects(() => rejected.ctx.FluxLocalEditBatchRunner.run(rejected.context, rejected.adapter, "edit"), /solid rectangles/);
  assert.equal(rejected.stats().jobsRun, 0); assert.equal(rejected.source.channels.length, 0);
  const accepted = host("fill", "", true);
  const result = await accepted.ctx.FluxLocalEditBatchRunner.run(accepted.context, accepted.adapter, "fill");
  assert.equal(result.completed, 3);
  assert.equal(accepted.source.layers.find((l) => l.layers).layers[0].mask[0], 64, "Original feather value must survive");
  const qwen = host("qwen", "", true);
  qwen.context.referenceFiles = [];
  const qwenResult = await qwen.ctx.FluxLocalEditBatchRunner.run(qwen.context, qwen.adapter, "qwen");
  assert.equal(qwenResult.completed, 3);
  assert.equal(qwen.source.layers.find((l) => l.layers).layers[0].mask[0], 64);
  assert(qwen.events.filter((e) => e.type === "job").every(({ graph }) => !graph["14"]));
  const single = host("edit"); single.source.selectionData.fill(0);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 6; x++) single.source.selectionData[y * 40 + x] = 255;
  const one = await single.ctx.FluxLocalEditBatchRunner.run(single.context, single.adapter, "edit");
  assert.equal(one.completed, 1); assert.equal(single.stats().jobsRun, 1);
  assert.deepStrictEqual(plain(single.source.layers.find((l) => l.layers).layers[0].bounds), { left: 3, top: 2, right: 6, bottom: 5 });
}

async function firstFailureAndEmpty() {
  for (const mode of ["edit", "fill", "qwen"]) for (const failure of ["first-error", "first-cancel"]) {
    const h = host(mode, failure);
    await assert.rejects(() => h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode));
    assert.equal(h.stats().jobsRun, 1); assert.equal(h.previews.length, 0);
    assert.equal(h.documents.length, 1); assert.equal(h.source.channels.length, 0);
    assert.deepStrictEqual(h.source.selectionData, h.selected);
    assert(!h.source.layers.some((l) => l.layers));
    assert([...h.files.values()].every((f) => f.deleted));
  }
  const h = host("fill"); h.source.selectionData.fill(0);
  await assert.rejects(() => h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, "fill"), /Select one/);
  assert.equal(h.stats().jobsRun, 0); assert.equal(h.documents.length, 1); assert.equal(h.source.channels.length, 0);
}

async function synchronousApiRegression() {
  // Photoshop Layer.delete is void. Some native cleanup APIs also expose sync results.
  // Cleanup must work with both return styles and never overwrite the primary error.
  for (const mode of ["edit", "fill", "qwen"]) {
    const h = host(mode, "transform");
    let failed;
    try { await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode); } catch (error) { failed = error; }
    assert(failed); assert.match(failed.message, /Synthetic alignment failure/);
    assert.doesNotMatch(failed.message, /reading 'catch'/);
    assert.match(failed.phase, /Place and group|Blend and place/);
    assert.equal(failed.batch.completed, 0);
    assert(h.events.includes("delete-layer"));
    assert.equal(h.source.layers.length, 1); assert.equal(h.source.channels.length, 0);
    assert.equal(h.documents.length, 1);
    assert.deepStrictEqual(h.source.selectionData, h.selected);
    assert([...h.files.values()].every((file) => file.deleted));
  }
  const broken = host("edit", "capture");
  await assert.rejects(() => broken.ctx.FluxLocalEditBatchRunner.run(broken.context, broken.adapter, "edit"), /Synthetic selection capture failure/);
  assert.equal(broken.source.channels.length, 0); assert.equal(broken.documents.length, 1);
  const pluginSources = ["photoshop.js", "fillPhotoshop.js", "batchPhotoshop.js", "editAdapter.js", "fillAdapter.js", "qwenAdapter.js"];
  for (const file of pluginSources) {
    const source = fs.readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /\.(?:delete|remove)\(\)\.catch\(/, `${file}: native void API must not be chained to catch`);
  }
}

async function clippingAndNativeErrorRegression() {
  for (const mode of ["edit", "fill", "qwen"]) {
    const normal = host(mode);
    const completed = await normal.ctx.FluxLocalEditBatchRunner.run(normal.context, normal.adapter, mode);
    assert.equal(completed.completed, 3);
    assert(!normal.events.includes("change-clipping-mask"), "Do not release a mask on ordinary result layers");
    const clipped = host(mode, "clipped");
    const released = await clipped.ctx.FluxLocalEditBatchRunner.run(clipped.context, clipped.adapter, mode);
    assert.equal(released.completed, 3);
    assert.equal(clipped.events.filter((e) => e === "change-clipping-mask").length, 3, "Release actual clipped result layers once");
    const frozen = host(mode, "frozen-transform");
    let error;
    try { await frozen.ctx.FluxLocalEditBatchRunner.run(frozen.context, frozen.adapter, mode); } catch (e) { error = e; }
    assert(error); assert.match(error.message, /Frozen native alignment failure/);
    assert.match(error.phase, /Place and group|Blend and place/);
    assert.equal(error.batch.total, 3); assert.equal(error.batch.completed, 0);
    assert(error.cause && Object.isFrozen(error.cause));
    assert.equal(frozen.documents.length, 1); assert.equal(frozen.source.channels.length, 0);
    assert.equal(frozen.source.layers.length, 1);
  }
}

async function openFillSingle() {
  for (const failure of ["", "seam-write", "cancel-seam"]) {
    const h = host("fill", failure, false, true);
    h.context.settings.prompt = " \n ";
    let recorded;
    h.context.recordAction = async (settings, seed, mode) => { recorded = { prompt: settings.prompt, seed, mode }; };
    if (failure === "cancel-seam") {
      await assert.rejects(() => h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, "fill"), /Stopped/);
      assert.equal(h.source.layers.length, 1);
      assert(!h.events.some((event) => event.type === "place"));
      assert.equal(h.previews.length, 0);
    } else {
      assert.equal((await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, "fill")).completed, 1);
      const placed = h.source.layers.find((layer) => layer.layers).layers[0];
      assert.equal(placed.mask[14 * 40 + 16], 255);
      assert(placed.mask[14 * 40 + 8] > 0, "The blend extends outside the lasso");
      assert.equal(placed.mask[0], 0);
      assert.equal(h.previews.length, 1);
      assert.match(h.events.find((event) => event.type === "place").file, failure ? /^result\.png$/ : /fill-blended/);
      if (!failure) assert(h.events.some((event) => event.type === "seam-write" && event.first < 115));
    }
    assert.deepStrictEqual(recorded, { prompt: " \n ", seed: 123, mode: "fill" });
    assert.deepStrictEqual(h.source.selectionData, h.selected);
    assert.equal(h.source.channels.length, 0);
    assert.equal(h.documents.length, 1);
    assert([...h.files.values()].every((file) => file.deleted));
  }
}

async function engineReadiness() {
  for (const mode of ["edit", "fill", "qwen"]) {
    const normal = host(mode);
    let calls = 0;
    normal.context.ensureEngine = async (check) => {
      check();
      calls++;
      assert.equal(normal.stats().jobsRun, 0);
      assert(!normal.events.some((event) => event.type === "upload"));
    };
    assert.equal((await normal.ctx.FluxLocalEditBatchRunner.run(normal.context, normal.adapter, mode)).completed, 3);
    assert.equal(calls, 1, "check readiness once per batch");

    const broken = host(mode);
    broken.context.ensureEngine = async () => { throw Error("Launcher permission denied"); };
    await assert.rejects(() => broken.ctx.FluxLocalEditBatchRunner.run(broken.context, broken.adapter, mode),
      (error) => error.phase === "Connect to local ComfyUI" && error.batch.completed === 0);
    assert.equal(broken.stats().jobsRun, 0);
    assert.equal(broken.documents.length, 1);
    assert.equal(broken.source.channels.length, 0);
    assert.deepStrictEqual(broken.source.selectionData, broken.selected);
  }
}

async function nearbyMasks() {
  for (const mode of ["edit", "fill", "qwen"]) {
    const h = host(mode, "", false, false, true);
    const w = h.source.width;
    const hole = 12 * w + 8;
    if (mode === "qwen") h.selected[hole] = h.source.selectionData[hole] = 0;
    const result = await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode);
    assert.equal(result.completed, 2);
    const order = h.events.filter((event) => ["job", "place", "mask"].includes(event.type)).map((event) => event.type);
    assert.deepStrictEqual(order, ["job", "place", "mask", "job", "place", "mask"]);
    const [first, second] = h.source.layers.find((layer) => layer.layers).layers;
    const at = (layer, x) => layer.mask[15 * w + x];
    assert.equal(at(first, 12), 255);
    if (mode === "fill") {
      assert(at(first, 15) > 0 && at(first, 15) < 255);
      assert(at(second, 17) > 0 && at(second, 17) < 255);
    } else {
      assert.equal(at(first, 15), 255);
      assert.equal(at(second, 17), 255);
    }
    assert.equal(at(second, 20), 255);
    assert.equal(at(first, 16) + at(second, 16), 0, "The one-pixel gap stays intact");
    if (mode === "qwen") {
      assert.equal(first.mask[hole], 0, "A hole stays protected");
      assert.equal(first.mask[hole + 1], 255, "Do not feather the pixels around a Qwen hole");
    }
    for (let i = 0; i < first.mask.length; i++) assert(!(first.mask[i] && second.mask[i]), "Adjacent softened masks must never overlap");
    assert.deepStrictEqual(h.source.selectionData, h.selected);
  }
}

async function singleEditMasks() {
  for (const mode of ["edit", "qwen"]) for (const tall of [false, true]) {
    const h = host(mode, "", false, true);
    const w = h.source.width;
    const box = { left: 36, top: 2, right: 38, bottom: 29 };
    if (tall) {
      h.selected.fill(0);
      for (let y = box.top; y < box.bottom; y++) h.selected.fill(255, y * w + box.left, y * w + box.right);
      h.source.selectionData.set(h.selected);
    }
    assert.equal((await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode)).completed, 1);
    const result = h.source.layers.find((layer) => layer.layers).layers[0];
    assert.deepStrictEqual(result.mask, h.selected);
    if (tall && mode === "edit") assert.deepStrictEqual(plain(result.bounds), box);
    if (tall && mode === "qwen") assert(result.bounds.right - result.bounds.left > box.right - box.left);
    assert.deepStrictEqual(h.source.selectionData, h.selected);
  }
  const standalone = host("edit", "", false, true);
  const ps = standalone.ctx.Flux2Photoshop;
  const selection = await ps.getSolidSelection();
  const layer = await ps.placeResultLayer({ name: "result.png" }, selection, logger);
  assert.deepStrictEqual(layer.mask, standalone.selected);
  assert.deepStrictEqual(standalone.source.selectionData, standalone.selected);
}

(async () => {
  for (const test of [components, queues, shapeValidation, firstFailureAndEmpty, synchronousApiRegression, clippingAndNativeErrorRegression, engineReadiness, openFillSingle, nearbyMasks, singleEditMasks]) { await test(); console.log(`PASS batch ${test.name}`); }
  console.log("PASS 250 component fuzz cases, Edit/Fill/Qwen queues, grouping, coordinates, masks, cancellation and cleanup. Host verification still required.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
