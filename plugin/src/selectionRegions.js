(function () {
  // Scan-line connected components: no full-size label image or pixel flood-fill queue.
  // Eight-connected nonzero pixels include feathered edges; touching regions are one job.
  function split(data, width, height, origin = { left: 0, top: 0 }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) {
      throw new Error("Invalid selection mask dimensions.");
    }
    const parent = [], rows = []; let previous = [];
    function root(id) { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; }
    function unite(a, b) { a = root(a); b = root(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    let runsCount = 0;
    for (let y = 0; y < height; y++) {
      const current = []; let cursor = 0;
      for (let x = 0; x < width;) {
        if (!data[y * width + x]) { x++; continue; }
        const start = x; while (x < width && data[y * width + x]) x++;
        const run = { left: start, right: x, y, label: parent.length };
        parent.push(run.label);
        while (cursor < previous.length && previous[cursor].right < start) cursor++;
        for (let i = cursor; i < previous.length && previous[i].left <= x; i++) unite(run.label, previous[i].label);
        current.push(run); rows.push(run);
        if (++runsCount > 500000) throw new Error("Selection is too fragmented. Use a few separate regions rather than a textured pixel selection.");
      }
      previous = current;
    }
    const components = new Map();
    for (const run of rows) {
      const label = root(run.label);
      if (!components.has(label)) components.set(label, { left: width, top: height, right: 0, bottom: 0, runs: [], solid: true, pixels: 0 });
      const c = components.get(label);
      c.left = Math.min(c.left, run.left); c.top = Math.min(c.top, run.y);
      c.right = Math.max(c.right, run.right); c.bottom = Math.max(c.bottom, run.y + 1);
      c.pixels += run.right - run.left; c.runs.push(run);
      for (let x = run.left; x < run.right && c.solid; x++) if (data[run.y * width + x] !== 255) c.solid = false;
    }
    const result = Array.from(components.values()).map((c) => ({
      bounds: { left: c.left + origin.left, top: c.top + origin.top, right: c.right + origin.left, bottom: c.bottom + origin.top },
      width: c.right - c.left, height: c.bottom - c.top, runs: c.runs,
      solid: c.solid && c.pixels === (c.right - c.left) * (c.bottom - c.top)
    })).sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
    if (!result.length) throw new Error("No selected pixels inside the canvas.");
    if (result.length > 100) throw new Error("Select at most 100 separate regions per generation.");
    return result;
  }
  function regionMask(data, sourceWidth, region) {
    const out = new Uint8Array(region.width * region.height);
    let left = Infinity, top = Infinity;
    for (const run of region.runs) { left = Math.min(left, run.left); top = Math.min(top, run.y); }
    for (const run of region.runs) out.set(data.subarray(run.y * sourceWidth + run.left, run.y * sourceWidth + run.right),
      (run.y - top) * region.width + run.left - left);
    return out;
  }
  globalThis.FluxLocalEditRegions = { split, regionMask };
})();
