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

function host(mode, failure = "", soft = false) {
  let docId = 1, layerId = 1, modal = false, jobsRun = 0, maxInFlight = 0, inFlight = 0;
  const events = [], documents = [], files = new Map();
  const token = { cancelled: false }; const app = { documents, activeDocument: null };
  const check = () => { if (token.cancelled) { const e = new Error("Stopped"); e.kind = "cancelled"; throw e; } };
  const width = 40, height = 30;
  const selected = new Uint8Array(width * height);
  function rectangle(data, b, value = 255) { for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) data[y * width + x] = value; }
  const rectangles = [{ left: 0, top: 0, right: 3, bottom: 4 }, { left: 14, top: 10, right: 18, bottom: 14 }, { left: 33, top: 24, right: 40, bottom: 30 }];
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
  const constants = { SelectionType: { REPLACE: "replace" }, ElementPlacement: { PLACEBEFORE: "before", PLACEINSIDE: "inside" },
    DocumentMode: { RGB: "RGB" }, ChangeMode: {}, BitsPerChannelType: { EIGHT: 8 }, LayerKind: { NORMAL: "normal" }, ResampleMethod: { BICUBIC: "bicubic" } };
  const photoshop = { app, constants, core: { async executeAsModal(fn) { assert(!modal, "Nested executeAsModal"); modal = true; try { return await fn(); } finally { modal = false; } } },
    imaging: {
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
          if (failure === "cancel-placement" && jobsRun === 2) token.cancelled = true;
        }
      }
      return [];
    } }
  };
  const storage = { localFileSystem: { async getTemporaryFolder() { return { async createFile(name) {
    const f = { name, delete() { f.deleted = true; } }; files.set(name, f); return f;
  } }; }, async createSessionToken() { return "file"; } } };
  const ctx = base({ require(name) { if (name === "photoshop") return photoshop; if (name === "uxp") return { storage }; throw new Error(name); } });
  ["imageSizing.js", "selectionRegions.js", "photoshop.js", "fillPhotoshop.js", "batchPhotoshop.js", "batchRunner.js", "editAdapter.js", "fillAdapter.js"].forEach((f) => load(ctx, f));
  ctx.Flux2WorkflowMapper = { normalizeSeed: (s) => Number(s) || 123, combinePrompt: (p) => p, async patchWorkflow(opts) { return { seed: opts.seed, outputNodeId: "out", prompt: { mode, ...opts } }; } };
  ctx.FluxLocalEditFillWorkflowMapper = { async validateRequirements() {}, async patchWorkflow(opts) { return { seed: opts.seed, outputNodeId: "out", prompt: { mode, ...opts } }; } };
  ctx.Flux2ComfyClient = { ComfyClient: class {
    async testConnection() { return {}; } async getObjectInfo() { return {}; }
    async uploadImage(file, role) { assert(!file.deleted); events.push({ type: "upload", role }); return { imageName: file.name || `${role}.png` }; }
    async runPrompt(graph) {
      assert.strictEqual(app.activeDocument, source, "Original, not snapshot, must be visible during generation");
      jobsRun++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve();
      events.push({ type: "job", seed: graph.seed }); source.sourceVersion = "ALREADY_EDITED";
      if ((jobsRun === 2 && failure === "error") || (jobsRun === 1 && failure === "first-error")) { inFlight--; throw new Error("Comfy failure"); }
      if (jobsRun === 1 && failure === "first-cancel") token.cancelled = true;
      if (jobsRun === 2 && failure === "cancel") token.cancelled = true;
      if (jobsRun === 2 && failure === "canvas") source.width++;
      if (jobsRun === 2 && failure === "group") { const group = source.layers.find((l) => l.layers); if (group) await group.delete(); }
      inFlight--; return { image: { filename: "result.png" } };
    }
    async downloadImage() { return { file: {}, blob: {} }; }
  } };
  const progress = [], previews = []; let records = 0;
  const context = { settings: { prompt: "remove person", megapixels: 1, seed: 123 }, referenceFile: {}, logger, cancelToken: token,
    throwIfCancelled: check, setClient() {}, setPromptId() {}, updateSelectionHint() {}, shouldRecordAction: true,
    async recordAction() { records++; }, onProgress() {}, onBatchProgress: (s) => progress.push(s), setPreview: (p) => previews.push(p) };
  return { ctx, source, rectangles, selected, documents, files, events, progress, previews, context,
    stats: () => ({ jobsRun, maxInFlight, records }), adapter: mode === "edit" ? ctx.FluxLocalEditEditAdapter : ctx.FluxLocalEditFillAdapter };
}

async function queues() {
  for (const mode of ["edit", "fill"]) for (const failure of ["", "error", "cancel", "canvas", "group", ...(mode === "fill" ? ["cancel-placement"] : [])]) {
    const h = host(mode, failure);
    let result, error;
    try { result = await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode); } catch (e) { error = e; }
    const expected = failure ? 1 : 3;
    if (failure) { assert(error, `${mode}/${failure}: expected error`); assert.equal(error.batch.completed, 1); }
    else { if (error) throw error; assert.equal(result.completed, 3); }
    assert.equal(h.stats().jobsRun, failure ? 2 : 3);
    assert.equal(h.stats().maxInFlight, 1); assert.equal(h.stats().records, 1);
    assert.equal(h.events.filter((e) => e.type === "upload" && e.role === "edit-reference").length, mode === "edit" ? 1 : 0);
    assert.equal(h.previews.length, expected);
    assert.equal(h.documents.length, 1, "Frozen snapshot and export duplicates must be closed");
    assert.equal(h.source.channels.length, 0, "Temporary channels must be removed");
    assert.deepStrictEqual(h.source.selectionData, h.selected, "Original multi-selection must be restored");
    assert([...h.files.values()].every((f) => f.deleted), "Export PNGs must be deleted");
    assert(h.events.filter((e) => e.type === "png").every((e) => e.sourceVersion === "ORIGINAL"), "Later exports must not include previous results");
    if (failure !== "group") {
      const group = h.source.layers.find((l) => l.layers); assert(group); assert.equal(group.layers.length, expected);
      assert.equal(group.name, `Flux ${mode === "edit" ? "Edit" : "Fill"} - 3 regions`);
      group.layers.forEach((l, i) => {
        if (mode === "edit") assert.deepStrictEqual(plain(l.bounds), h.rectangles[i], "Edit placement must match original pixels");
        else { const mask = new Uint8Array(h.selected.length); const b = h.rectangles[i];
          for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) mask[y * 40 + x] = 255;
          assert.deepStrictEqual(l.mask, mask, "Fill layer mask must contain only this region");
          assert.deepStrictEqual(plain(l.bounds), { left: 0, top: 0, right: 40, bottom: 30 }, "Fill context alignment");
        }
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
  const single = host("edit"); single.source.selectionData.fill(0);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 6; x++) single.source.selectionData[y * 40 + x] = 255;
  const one = await single.ctx.FluxLocalEditBatchRunner.run(single.context, single.adapter, "edit");
  assert.equal(one.completed, 1); assert.equal(single.stats().jobsRun, 1);
  assert.deepStrictEqual(plain(single.source.layers.find((l) => l.layers).layers[0].bounds), { left: 3, top: 2, right: 6, bottom: 5 });
}

async function firstFailureAndEmpty() {
  for (const mode of ["edit", "fill"]) for (const failure of ["first-error", "first-cancel"]) {
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
  for (const mode of ["edit", "fill"]) {
    const h = host(mode, "transform");
    let failed;
    try { await h.ctx.FluxLocalEditBatchRunner.run(h.context, h.adapter, mode); } catch (error) { failed = error; }
    assert(failed); assert.match(failed.message, /Synthetic alignment failure/);
    assert.doesNotMatch(failed.message, /reading 'catch'/);
    assert.match(failed.phase, /Place and group/);
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
  const pluginSources = ["photoshop.js", "fillPhotoshop.js", "batchPhotoshop.js", "editAdapter.js", "fillAdapter.js"];
  for (const file of pluginSources) {
    const source = fs.readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /\.(?:delete|remove)\(\)\.catch\(/, `${file}: native void API must not be chained to catch`);
  }
}

async function clippingAndNativeErrorRegression() {
  for (const mode of ["edit", "fill"]) {
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
    assert.match(error.phase, /Place and group/);
    assert.equal(error.batch.total, 3); assert.equal(error.batch.completed, 0);
    assert(error.cause && Object.isFrozen(error.cause));
    assert.equal(frozen.documents.length, 1); assert.equal(frozen.source.channels.length, 0);
    assert.equal(frozen.source.layers.length, 1);
  }
}

(async () => {
  for (const test of [components, queues, shapeValidation, firstFailureAndEmpty, synchronousApiRegression, clippingAndNativeErrorRegression]) { await test(); console.log(`PASS batch ${test.name}`); }
  console.log("PASS 250 component fuzz cases, Edit/Fill queue scenarios, grouping, coordinates, masks, cancellation and cleanup. Host verification still required.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
