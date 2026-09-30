(function () {
  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  function roundToMultiple(value, multiple) {
    const m = Math.max(1, Math.round(Number(multiple) || 1));
    return Math.max(m, Math.round(value / m) * m);
  }

  function floorToMultiple(value, multiple) {
    const m = Math.max(1, Math.round(Number(multiple) || 1));
    return Math.max(m, Math.floor(value / m) * m);
  }

  function computeTargetSize(width, height, megapixels, multiple) {
    const sourceWidth = Math.max(1, Math.round(Number(width)));
    const sourceHeight = Math.max(1, Math.round(Number(height)));
    const mp = clampNumber(megapixels, 1, 4, 1);
    const step = Math.max(1, Math.round(Number(multiple) || 16));
    const sourceArea = sourceWidth * sourceHeight;
    const targetArea = mp * 1000000;
    const scale = Math.sqrt(targetArea / sourceArea);
    const targetWidth = roundToMultiple(sourceWidth * scale, step);
    const targetHeight = roundToMultiple(sourceHeight * scale, step);

    return {
      sourceWidth,
      sourceHeight,
      megapixels: mp,
      multiple: step,
      scale,
      targetWidth,
      targetHeight,
      targetMegapixels: (targetWidth * targetHeight) / 1000000
    };
  }

  function computeCappedTargetSize(width, height, megapixels, multiple) {
    const sourceWidth = Math.max(1, Math.round(Number(width)));
    const sourceHeight = Math.max(1, Math.round(Number(height)));
    const mp = clampNumber(megapixels, 1, 4, 1);
    const step = Math.max(1, Math.round(Number(multiple) || 16));
    const sourceArea = sourceWidth * sourceHeight;
    const targetArea = mp * 1000000;
    const scale = Math.sqrt(targetArea / sourceArea);
    let targetWidth = roundToMultiple(sourceWidth * scale, step);
    let targetHeight = roundToMultiple(sourceHeight * scale, step);

    while (targetWidth * targetHeight > targetArea) {
      const widthScale = targetWidth / sourceWidth;
      const heightScale = targetHeight / sourceHeight;
      if (widthScale >= heightScale && targetWidth > step) {
        targetWidth -= step;
      } else if (targetHeight > step) {
        targetHeight -= step;
      } else {
        break;
      }
    }

    targetWidth = floorToMultiple(targetWidth, step);
    targetHeight = floorToMultiple(targetHeight, step);

    return {
      sourceWidth,
      sourceHeight,
      megapixels: mp,
      multiple: step,
      scale,
      targetWidth,
      targetHeight,
      targetMegapixels: (targetWidth * targetHeight) / 1000000
    };
  }

  function computeContextRect(bounds, documentWidth, documentHeight, options) {
    const width = Math.max(1, Math.round(Number(documentWidth)));
    const height = Math.max(1, Math.round(Number(documentHeight)));
    const source = bounds || {};
    const raw = [source.left, source.top, source.right, source.bottom].map(Number);
    if (!raw.every(Number.isFinite)) {
      throw new Error("Selection bounds are invalid.");
    }

    const left = Math.max(0, Math.min(width, Math.floor(raw[0])));
    const top = Math.max(0, Math.min(height, Math.floor(raw[1])));
    const right = Math.max(0, Math.min(width, Math.ceil(raw[2])));
    const bottom = Math.max(0, Math.min(height, Math.ceil(raw[3])));
    if (right <= left || bottom <= top) {
      throw new Error("Selection becomes empty after clamping to the canvas.");
    }

    const config = options || {};
    const ratio = clampNumber(config.paddingRatio, 0, 2, 0.2);
    const minimum = Math.max(0, Math.round(Number(config.minimumPadding) || 64));
    const maximum = Math.max(minimum, Math.round(Number(config.maximumPadding) || 512));
    const unionWidth = right - left;
    const unionHeight = bottom - top;
    const padding = Math.min(maximum, Math.max(minimum, Math.round(Math.max(unionWidth, unionHeight) * ratio)));
    const context = {
      left: Math.max(0, left - padding),
      top: Math.max(0, top - padding),
      right: Math.min(width, right + padding),
      bottom: Math.min(height, bottom + padding)
    };

    return {
      selectionBounds: { left, top, right, bottom },
      contextBounds: context,
      padding,
      width: context.right - context.left,
      height: context.bottom - context.top
    };
  }

  globalThis.Flux2ImageSizing = {
    clampNumber,
    computeCappedTargetSize,
    computeContextRect,
    computeTargetSize,
    floorToMultiple,
    roundToMultiple
  };
})();
