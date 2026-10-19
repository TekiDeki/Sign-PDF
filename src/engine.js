/* Sign PDF engine.
 * Geometry, signature trimming and the actual PDF write. No DOM, no network,
 * so the same code runs in the browser and in the Node tests.
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TDSign = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Every placement is stored in page space, 0 to 1, with the origin in the
   * top left corner. Nothing depends on zoom, screen size or pixel ratio,
   * which is what makes the export identical on a phone and on a desktop. */

  var MIN_W = 0.05;
  var MAX_W = 1;

  function clamp(value, low, high) {
    if (!isFinite(value)) return low;
    return value < low ? low : value > high ? high : value;
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return "0 B";
    if (bytes < 1024) return Math.round(bytes) + " B";
    var kb = bytes / 1024;
    if (kb < 10) return kb.toFixed(1) + " KB";
    if (kb < 1024) return Math.round(kb) + " KB";
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
  }

  function safeName(text, fallback) {
    var base = String(text == null ? "" : text)
      .trim()
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    if (!base) base = fallback || "signed";
    return base.slice(0, 80);
  }

  /* Height that keeps the image looking like itself on this page. Page sizes
   * differ, so the ratio between the two dimensions has to be taken out. */
  /* The image keeps its own proportions on the page: the width and the height
   * are fractions of two different page dimensions, so the page ratio is
   * divided by the picture ratio, not multiplied by it. */
  function heightForWidth(w, aspect, pageWidth, pageHeight) {
    if (!(aspect > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return MIN_W;
    return (w * pageWidth) / (aspect * pageHeight);
  }

  function widthForHeight(h, aspect, pageWidth, pageHeight) {
    if (!(aspect > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return MIN_W;
    return (h * aspect * pageHeight) / pageWidth;
  }

  /* A new signature, centred on the point where the user clicked. */
  function placeAt(nx, ny, aspect, pageWidth, pageHeight, preferredWidth) {
    var w = preferredWidth > 0 ? preferredWidth : 0.30;
    var h = heightForWidth(w, aspect, pageWidth, pageHeight);
    if (h > 0.16) {
      w = widthForHeight(0.16, aspect, pageWidth, pageHeight);
      h = 0.16;
    }
    if (w > MAX_W) {
      w = MAX_W;
      h = heightForWidth(w, aspect, pageWidth, pageHeight);
    }
    w = Math.max(w, MIN_W);
    var rect = { x: nx - w / 2, y: ny - h / 2, w: w, h: h };
    return clampRect(rect);
  }

  function clampRect(rect) {
    var w = clamp(rect.w, MIN_W, MAX_W);
    var h = clamp(rect.h, MIN_W / 4, 1);
    return {
      x: clamp(rect.x, 0, 1 - w),
      y: clamp(rect.y, 0, 1 - h),
      w: w,
      h: h
    };
  }

  function moveBy(rect, dx, dy) {
    return clampRect({ x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h });
  }

  /* Corner handles keep the opposite corner still and the image undistorted. */
  function resize(rect, corner, nx, ny, aspect, pageWidth, pageHeight) {
    var anchorX = corner === "ne" || corner === "se" ? rect.x : rect.x + rect.w;
    var anchorY = corner === "sw" || corner === "se" ? rect.y : rect.y + rect.h;
    var w = Math.abs(nx - anchorX);
    w = clamp(w, MIN_W, MAX_W);
    var h = heightForWidth(w, aspect, pageWidth, pageHeight);
    if (h > 1) {
      h = 1;
      w = widthForHeight(h, aspect, pageWidth, pageHeight);
      w = clamp(w, MIN_W, MAX_W);
      h = heightForWidth(w, aspect, pageWidth, pageHeight);
    }
    var x = corner === "ne" || corner === "se" ? anchorX : anchorX - w;
    var y = corner === "sw" || corner === "se" ? anchorY : anchorY - h;
    return clampRect({ x: x, y: y, w: w, h: h });
  }

  function contains(rect, nx, ny) {
    return nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h;
  }

  /* Topmost first: the last drawn element is the one the finger finds. */
  function hitTest(items, nx, ny) {
    for (var i = items.length - 1; i >= 0; i -= 1) {
      if (contains(items[i], nx, ny)) return items[i].id;
    }
    return null;
  }

  function handleAt(rect, nx, ny, toleranceX, toleranceY) {
    var corners = [
      ["nw", rect.x, rect.y],
      ["ne", rect.x + rect.w, rect.y],
      ["sw", rect.x, rect.y + rect.h],
      ["se", rect.x + rect.w, rect.y + rect.h]
    ];
    var best = null;
    var bestDistance = 1e9;
    for (var i = 0; i < corners.length; i += 1) {
      var dx = (nx - corners[i][1]) / (toleranceX || 0.02);
      var dy = (ny - corners[i][2]) / (toleranceY || 0.02);
      var distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= 1 && distance < bestDistance) {
        best = corners[i][0];
        bestDistance = distance;
      }
    }
    return best;
  }

  /* Bounding box of the visible ink in an RGBA buffer. Used to cut the empty
   * space around a drawn or uploaded signature. */
  function inkBounds(rgba, width, height, threshold) {
    var limit = threshold == null ? 12 : threshold;
    var minX = width, minY = height, maxX = -1, maxY = -1;
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        var alpha = rgba[(y * width + x) * 4 + 3];
        if (alpha > limit) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function dataUrlBytes(dataUrl) {
    var comma = String(dataUrl).indexOf(",");
    if (comma < 0) return new Uint8Array(0);
    var body = String(dataUrl).slice(comma + 1);
    if (typeof atob === "function") {
      var text = atob(body);
      var out = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
      return out;
    }
    var buffer = Buffer.from(body, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  /* Write every placement into the pages and hand back the finished file.
   * The signature is drawn into the content stream, so it is part of the page,
   * not an annotation that can be moved or deleted afterwards. */
  async function stampPdf(PDFLib, sourceBytes, placements, images, options) {
    var settings = options || {};
    var doc = await PDFLib.PDFDocument.load(sourceBytes, { updateMetadata: false });
    var pages = doc.getPages();
    var embedded = {};
    for (var i = 0; i < placements.length; i += 1) {
      var item = placements[i];
      var page = pages[item.page];
      if (!page) continue;
      var key = item.key;
      if (!embedded[key]) {
        var bytes = images[key];
        if (!bytes) throw new Error("missing image " + key);
        embedded[key] = await doc.embedPng(bytes);
      }
      var size = page.getSize();
      var width = clamp(item.w, 0.001, 1) * size.width;
      var height = clamp(item.h, 0.001, 1) * size.height;
      var x = clamp(item.x, 0, 1) * size.width;
      var y = size.height - (clamp(item.y, 0, 1) + clamp(item.h, 0.001, 1)) * size.height;
      page.drawImage(embedded[key], { x: x, y: y, width: width, height: height });
    }
    if (settings.title) {
      doc.setTitle(String(settings.title));
    }
    return doc.save();
  }

  return {
    MIN_W: MIN_W,
    clamp: clamp,
    formatSize: formatSize,
    safeName: safeName,
    heightForWidth: heightForWidth,
    widthForHeight: widthForHeight,
    placeAt: placeAt,
    clampRect: clampRect,
    moveBy: moveBy,
    resize: resize,
    contains: contains,
    hitTest: hitTest,
    handleAt: handleAt,
    inkBounds: inkBounds,
    dataUrlBytes: dataUrlBytes,
    stampPdf: stampPdf
  };
});
