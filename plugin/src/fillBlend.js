(function () {
  // Fill geometry and seam-field approach adapted from OpenFill (Beckett Harriman, Apache-2.0).
  // See OPENFILL-LICENSE.txt. This implementation uses Photoshop coordinates and JS buffers.
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const round = (value) => {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + Math.abs(floor % 2) : Math.round(value);
  };
  const width = (bounds) => bounds.right - bounds.left;
  const height = (bounds) => bounds.bottom - bounds.top;

  function plan(bounds, docWidth, docHeight, settings) {
    const selectionBounds = { left: clamp(bounds.left, 0, docWidth), top: clamp(bounds.top, 0, docHeight),
      right: clamp(bounds.right, 0, docWidth), bottom: clamp(bounds.bottom, 0, docHeight) };
    const sw = width(selectionBounds), sh = height(selectionBounds), side = Math.max(sw, sh);
    if (!(sw > 0 && sh > 0)) throw new Error("Fill selection is outside the canvas.");
    const removal = !String(settings && settings.prompt || "").trim();
    const padding = Math.max(32, round(side * (removal ? 1 : 0.5)));
    const contextWidth = Math.min(docWidth, Math.max(256, sw + 2 * padding));
    const contextHeight = Math.min(docHeight, Math.max(256, sh + 2 * padding));
    const left = clamp(round(selectionBounds.left + (sw - contextWidth) / 2), 0, docWidth - contextWidth);
    const top = clamp(round(selectionBounds.top + (sh - contextHeight) / 2), 0, docHeight - contextHeight);
    const contextBounds = { left, top, right: left + contextWidth, bottom: top + contextHeight };
    const budget = clamp(Math.round(Number(settings && settings.megapixels) || 1), 1, 4) * 1000000;
    const scale = Math.min(Math.sqrt(budget / (contextWidth * contextHeight)), 4096 / Math.max(contextWidth, contextHeight));
    const snap = (value) => Math.max(16, 16 * round(value / 16));
    let targetWidth = snap(contextWidth * scale), targetHeight = snap(contextHeight * scale);
    while (targetWidth * targetHeight > budget) {
      if (targetWidth > 16 && (targetHeight <= 16 || targetWidth / contextWidth >= targetHeight / contextHeight)) targetWidth -= 16;
      else targetHeight -= 16;
    }
    const growImage = clamp(round(side * 0.15), 6, 48);
    const featherImage = clamp(round(side * 0.06), 1, 24);
    const actualScale = targetWidth / contextWidth;
    const growWork = Math.max(1, round(growImage * actualScale));
    const blurWork = clamp(round(featherImage * actualScale), 0, growWork);
    const layerGrow = removal ? growImage : Math.min(growImage, featherImage);
    const edges = Number(selectionBounds.left === 0) + Number(selectionBounds.top === 0)
      + Number(selectionBounds.right === docWidth) + Number(selectionBounds.bottom === docHeight);
    return { selectionBounds, contextBounds, contextWidth, contextHeight, padding, docWidth, docHeight,
      targetWidth, targetHeight, targetMegapixels: targetWidth * targetHeight / 1000000,
      nativeTransfer: contextWidth * contextHeight <= 16000000 && Math.max(contextWidth, contextHeight) <= 8192,
      removal, growImage, featherImage, layerGrow, growWork, blurWork,
      colorMatch: edges < 3 && 1 - sw * sh / (contextWidth * contextHeight) >= 0.15 };
  }

  function generationMaskProfile(profile, mask) {
    const w = width(mask.bounds), h = height(mask.bounds), { data } = mask;
    // 2 * area / perimeter approximates the strip thickness even for curved or diagonal lassos.
    function measure(threshold) {
      let area = 0, perimeter = 0, left = w, right = 0, top = h, bottom = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (data[i] < threshold) continue;
        area++;
        if (!x || data[i - 1] < threshold) perimeter++;
        if (x + 1 === w || data[i + 1] < threshold) perimeter++;
        if (!y || data[i - w] < threshold) perimeter++;
        if (y + 1 === h || data[i + w] < threshold) perimeter++;
        if (x < left) left = x;
        if (x >= right) right = x + 1;
        if (y < top) top = y;
        bottom = y + 1;
      }
      return area ? { thickness: 2 * area / perimeter, side: Math.max(right - left, bottom - top) } : null;
    }
    const shape = measure(128) || measure(1);
    if (!shape) return profile;
    const ratio = shape.thickness / shape.side;
    if (ratio >= 0.2) return profile;
    const limit = Math.min(profile.growImage, Math.max(2, round(shape.thickness * 0.18)));
    const weight = clamp((0.2 - ratio) / 0.07, 0, 1);
    const growImage = profile.growImage + (limit - profile.growImage) * weight;
    const growWork = clamp(round(growImage * profile.targetWidth / profile.contextWidth), 1, profile.growWork);
    if (growWork >= profile.growWork) return profile;
    const blurWork = Math.min(profile.blurWork, Math.floor(growWork / 2));
    // Do not change the placement mask, its feather, the seam correction band or the context crop.
    return { ...profile, growWork, blurWork, maskThickness: shape.thickness };
  }

  function sample(mask, x, y) {
    const { bounds, data } = mask;
    return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
      ? data[(y - bounds.top) * width(bounds) + x - bounds.left] : 0;
  }

  // Separable line maximums form an octagon (the round-grow approximation used in OpenFill).
  function growPass(data, w, h, dx, dy, radius) {
    if (!radius) return data;
    const out = new Uint8Array(data.length), queue = new Int32Array(Math.max(w, h));
    function line(x, y, count) {
      let head = 0, tail = 0, next = 0;
      const start = y * w + x, stride = dy * w + dx;
      const at = (i) => start + i * stride;
      for (let i = 0; i < count; i++) {
        while (head < tail && queue[head] < i - radius) head++;
        while (next < count && next <= i + radius) {
          while (head < tail && data[at(queue[tail - 1])] <= data[at(next)]) tail--;
          queue[tail++] = next++;
        }
        out[at(i)] = data[at(queue[head])];
      }
    }
    if (!dy) for (let y = 0; y < h; y++) line(0, y, w);
    else if (!dx) for (let x = 0; x < w; x++) line(x, 0, h);
    else {
      for (let x = 0; x < w; x++) line(x, 0, Math.min(dx > 0 ? w - x : x + 1, h));
      for (let y = 1; y < h; y++) line(dx > 0 ? 0 : w - 1, y, Math.min(w, h - y));
    }
    return out;
  }

  function box(data, w, h, radius, vertical) {
    const out = new Uint8Array(data.length);
    const count = vertical ? h : w, lines = vertical ? w : h, stride = vertical ? w : 1;
    for (let j = 0; j < lines; j++) {
      const at = (i) => (vertical ? j : j * w) + clamp(i, 0, count - 1) * stride;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += data[at(i)];
      for (let i = 0; i < count; i++) {
        out[at(i)] = Math.round(sum / (2 * radius + 1));
        sum += data[at(i + radius + 1)] - data[at(i - radius)];
      }
    }
    return out;
  }

  function layerMask(mask, profile) {
    const r = profile.layerGrow, f = profile.featherImage, reach = r + 3 * f;
    const selection = mask.bounds, crop = profile.contextBounds;
    const bounds = { left: Math.max(crop.left, selection.left - reach), top: Math.max(crop.top, selection.top - reach),
      right: Math.min(crop.right, selection.right + reach), bottom: Math.min(crop.bottom, selection.bottom + reach) };
    const w = width(bounds), h = height(bounds);
    let data = new Uint8Array(w * h);
    for (let y = selection.top; y < selection.bottom; y++) {
      const start = (y - selection.top) * width(selection);
      data.set(mask.data.subarray(start, start + width(selection)), (y - bounds.top) * w + selection.left - bounds.left);
    }
    const d = Math.round(r * (1 - Math.SQRT1_2)), a = r - 2 * d;
    for (const [dx, dy, radius] of [[1, 0, a], [0, 1, a], [1, 1, d], [-1, 1, d]]) data = growPass(data, w, h, dx, dy, radius);
    // Three box passes approximate a Gaussian at sigma f, without a per-pixel kernel loop.
    const ideal = Math.sqrt(4 * f * f + 1), odd = Math.floor(ideal) - (1 - Math.floor(ideal) % 2);
    const small = Math.round((12 * f * f - 3 * odd * odd - 12 * odd - 9) / (-4 * odd - 4));
    for (let k = 0; k < 3; k++) {
      const radius = (odd - 1) / 2 + Number(k >= small);
      if (radius) data = box(box(data, w, h, radius, false), w, h, radius, true);
    }
    return { bounds, data };
  }

  // Measure the distance to unselected pixels without ever writing coverage outside the region.
  // A one- or two-pixel stroke has no safe interior to fade into, so leave its alpha alone.
  function innerLayerMask(mask, profile) {
    const { bounds, data } = mask, w = width(bounds), h = height(bounds);
    const radius = Math.max(0, Math.min(24, Math.round(profile.featherImage), Math.floor((Math.min(w, h) - 1) / 2)));
    if (!radius) return mask;
    const far = 3 * radius + 2, distance = new Uint8Array(data.length), out = new Uint8Array(data.length);
    const leftEdge = bounds.left > 0, topEdge = bounds.top > 0;
    const rightEdge = bounds.right < profile.docWidth, bottomEdge = bounds.bottom < profile.docHeight;

    // Two-pass 3–4 distance transform. Canvas edges are not seams; holes and gaps are.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      let d = x ? distance[i - 1] + 3 : leftEdge ? 3 : far;
      if (y) {
        d = Math.min(d, distance[i - w] + 3);
        if (x) d = Math.min(d, distance[i - w - 1] + 4);
        if (x + 1 < w) d = Math.min(d, distance[i - w + 1] + 4);
      } else if (topEdge) d = Math.min(d, 3);
      distance[i] = Math.min(d, far);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!data[i]) continue;
      let d = Math.min(distance[i], x + 1 < w ? distance[i + 1] + 3 : rightEdge ? 3 : far);
      if (y + 1 < h) {
        d = Math.min(d, distance[i + w] + 3);
        if (x) d = Math.min(d, distance[i + w - 1] + 4);
        if (x + 1 < w) d = Math.min(d, distance[i + w + 1] + 4);
      } else if (bottomEdge) d = Math.min(d, 3);
      distance[i] = d;
    }

    // Limit the fade by local mask thickness, including narrow arms of a larger lasso.
    const cap = (length) => Math.min(radius, (length - 1) >> 1);
    for (let y = 0; y < h; y++) {
      const row = y * w, end = row + w;
      for (let i = row; i < end;) {
        if (!data[i]) { i++; continue; }
        const start = i++;
        while (i < end && data[i]) i++;
        out.fill(cap(i - start), start, i);
      }
    }
    let changed = false;
    for (let x = 0; x < w; x++) for (let y = 0; y < h;) {
      if (!data[y * w + x]) { y++; continue; }
      const start = y++;
      while (y < h && data[y * w + x]) y++;
      const vertical = cap(y - start);
      for (let py = start; py < y; py++) {
        const i = py * w + x, f = Math.min(out[i], vertical);
        const t = f ? Math.min(1, (distance[i] - 1.5) / (3 * f)) : 1;
        // Take the smaller alpha rather than multiplying an already feathered selection twice.
        out[i] = Math.min(data[i], Math.round(255 * t * t * (3 - 2 * t)));
        if (out[i] !== data[i]) changed = true;
      }
    }
    return changed ? { bounds, data: out } : mask;
  }

  const median = (values) => {
    values.sort((a, b) => a - b);
    const i = values.length >> 1;
    return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
  };

  // OpenFill-style low-frequency RGB correction. Only compare the outside ring, never the removed object.
  function seamField(original, generated, mask, profile) {
    if (!original || !generated || original.width !== generated.width || original.height !== generated.height) return null;
    const w = original.width, h = original.height, crop = profile.contextBounds;
    const sx = profile.contextWidth / w, sy = profile.contextHeight / h;
    const band = Math.max(1, Math.round(profile.layerGrow / Math.max(sx, sy)));
    const selected = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      selected[y * w + x] = sample(mask, crop.left + Math.floor((x + 0.5) * sx), crop.top + Math.floor((y + 0.5) * sy)) >= 128 ? 1 : 0;
    }
    const near = growPass(growPass(selected, w, h, 1, 0, band), w, h, 0, 1, band);
    const cell = 8, gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const votes = Array(gw * gh), shown = new Uint8Array(gw * gh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, key = Math.floor(y / cell) * gw + Math.floor(x / cell);
      if (!near[i]) continue;
      shown[key] = 1;
      if (selected[i]) continue;
      const oi = i * original.components, gi = i * generated.components;
      if ((original.components === 4 && original.data[oi + 3] < 250) ||
          (generated.components === 4 && generated.data[gi + 3] < 250)) continue;
      const vote = votes[key] || (votes[key] = [[], [], []]);
      for (let c = 0; c < 3; c++) vote[c].push(original.data[oi + c] - generated.data[gi + c]);
    }
    const known = [];
    let largest = 0;
    votes.forEach((vote, key) => {
      if (vote[0].length < 4) return;
      const rgb = vote.map(median), magnitude = Math.max(...rgb.map(Math.abs));
      if (magnitude > 24 || vote.some((v, c) => median(v.map((a) => Math.abs(a - rgb[c]))) > 10)) return;
      largest = Math.max(largest, magnitude);
      known.push({ x: key % gw, y: Math.floor(key / gw), rgb });
    });
    if (largest < 1.5) return null;
    const offsets = new Float32Array(gw * gh * 3);
    for (let i = 0; i < shown.length; i++) {
      if (!shown[i]) continue;
      const x = i % gw, y = Math.floor(i / gw), sum = [0, 0, 0];
      let total = 0;
      for (const k of known) {
        const d2 = (x - k.x) ** 2 + (y - k.y) ** 2;
        if (!d2) { sum.splice(0, 3, ...k.rgb); total = 1; break; }
        for (let c = 0; c < 3; c++) sum[c] += k.rgb[c] / d2;
        total += 1 / d2;
      }
      for (let c = 0; c < 3; c++) offsets[i * 3 + c] = sum[c] / total;
    }
    return { offsets, width: gw, height: gh, cellX: cell * sx, cellY: cell * sy, largest };
  }

  function applySeam(data, w, h, components, left, top, field) {
    const gridW = field.width, values = field.offsets;
    const coords = (p, size, count) => clamp((p + 0.5) / size - 0.5, 0, count - 1);
    const xCoords = Float32Array.from({ length: w }, (_, x) => coords(left + x, field.cellX, gridW));
    for (let y = 0; y < h; y++) {
      const gy = coords(top + y, field.cellY, field.height), y0 = Math.floor(gy), y1 = Math.min(y0 + 1, field.height - 1), fy = gy - y0;
      const firstRow = y0 * gridW * 3, nextRow = y1 * gridW * 3;
      for (let x = 0; x < w; x++) {
        const gx = xCoords[x], x0 = Math.floor(gx), x1 = Math.min(x0 + 1, gridW - 1), fx = gx - x0;
        const i = (y * w + x) * components, a0 = x0 * 3, a1 = x1 * 3;
        for (let c = 0; c < 3; c++) {
          const a = values[firstRow + a0 + c] * (1 - fx) + values[firstRow + a1 + c] * fx;
          const b = values[nextRow + a0 + c] * (1 - fx) + values[nextRow + a1 + c] * fx;
          data[i + c] = clamp(Math.round(data[i + c] + a * (1 - fy) + b * fy), 0, 255);
        }
      }
    }
  }

  globalThis.FluxLocalEditFillBlend = { plan, generationMaskProfile, layerMask, innerLayerMask, seamField, applySeam };
})();
