/* Sign PDF interface. */
(function () {
  "use strict";

  var E = window.TDSign;
  var LOCALES = window.TD_LOCALES || {};
  var MAX_BYTES = 80 * 1024 * 1024;
  var MAX_PAGES = 60;
  var LANG_KEY = "signpdf.lang";
  var PREFS_KEY = "signpdf.prefs";
  var SIG_KEY = "signpdf.signature";

  var state = {
    lang: "en",
    pdf: null,
    bytes: null,
    name: "",
    size: 0,
    pages: [],
    placements: [],
    selected: null,
    pending: null,
    signature: null,
    ink: "#101820",
    outName: "signed",
    history: [],
    busy: false,
    renderToken: 0
  };

  var el = {};
  var uid = 0;
  var strokes = [];
  var drawing = null;
  var drag = null;
  var toastTimer = 0;
  var resizeTimer = 0;

  /* ------------------------------------------------------------ language */

  function detectLang() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (error) { saved = null; }
    if (saved && LOCALES[saved]) return saved;
    var nav = (navigator.language || "en").toLowerCase();
    if (nav.indexOf("ro") === 0) return "ro";
    if (nav.indexOf("sr") === 0) return nav.indexOf("cyrl") >= 0 ? "sr-cyrl" : "sr-latn";
    return "en";
  }

  function t(key, vars) {
    var pack = LOCALES[state.lang] || LOCALES.en || {};
    var text = pack[key];
    if (text === undefined) text = (LOCALES.en || {})[key];
    if (text === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split("{" + name + "}").join(String(vars[name]));
      });
    }
    return text;
  }

  function applyLang() {
    document.documentElement.lang = state.lang;
    document.title = t("docTitle");
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) {
      node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
    });
    el.langSelect.value = state.lang;
    document.querySelectorAll(".page-no").forEach(function (node, index) {
      node.textContent = t("pageLabel", { n: index + 1 });
    });
    updatePending();
    renderDocMeta();
  }

  function savePrefs() {
    try {
      localStorage.setItem(LANG_KEY, state.lang);
      localStorage.setItem(PREFS_KEY, JSON.stringify({ outName: state.outName, ink: state.ink }));
    } catch (error) { /* private mode */ }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var prefs = JSON.parse(raw);
        if (prefs && typeof prefs.outName === "string" && prefs.outName.trim()) state.outName = prefs.outName;
        if (prefs && typeof prefs.ink === "string") state.ink = prefs.ink;
      }
      var saved = localStorage.getItem(SIG_KEY);
      if (saved) {
        var sig = JSON.parse(saved);
        if (sig && typeof sig.url === "string" && sig.url.indexOf("data:image/png") === 0 && sig.aspect > 0) {
          state.signature = { url: sig.url, aspect: sig.aspect };
        }
      }
    } catch (error) { /* ignore a broken preference */ }
  }

  function saveSignature() {
    if (!state.signature) return;
    try {
      localStorage.setItem(SIG_KEY, JSON.stringify({
        url: state.signature.url,
        aspect: state.signature.aspect
      }));
    } catch (error) { /* the quota can be full, the tool still works */ }
  }

  /* ------------------------------------------------------------ ui bits */

  function toast(message, isError) {
    clearTimeout(toastTimer);
    el.toast.textContent = message || "";
    el.toast.classList.toggle("err", !!isError);
    if (message) {
      toastTimer = setTimeout(function () { el.toast.textContent = ""; }, 5200);
    }
  }

  function setBusy(flag) {
    state.busy = flag;
    renderButtons();
  }

  function renderButtons() {
    var hasDoc = !!state.pdf;
    el.exportBtn.disabled = !hasDoc || !state.placements.length || state.busy;
    el.undoBtn.disabled = !state.history.length || state.busy;
    el.clearBtn.disabled = !state.placements.length || state.busy;
    el.deleteBtn.hidden = !state.selected;
    el.dateBtn.disabled = !hasDoc || state.busy;
    el.replaceBtn.disabled = state.busy;
    el.chooseBtn.disabled = state.busy;
  }

  function renderDocMeta() {
    if (!state.pdf) {
      el.docMeta.textContent = "";
      return;
    }
    var pages = state.pages.length || state.pdf.numPages;
    var parts = [pages === 1 ? t("docPage") : t("docPages", { n: pages }), E.formatSize(state.size)];
    el.docMeta.textContent = parts.join(" · ");
  }

  function updatePending() {
    el.pendingHint.textContent = state.pending
      ? t(state.pending.kind === "date" ? "pendingDate" : "pendingSignature")
      : "";
    document.querySelectorAll(".overlay").forEach(function (overlay) {
      overlay.classList.toggle("is-armed", !!state.pending);
    });
  }

  function showSignature() {
    if (state.signature) {
      el.sigPreview.src = state.signature.url;
      el.sigPreview.hidden = false;
      el.sigEmpty.hidden = true;
    } else {
      el.sigPreview.hidden = true;
      el.sigEmpty.hidden = false;
    }
  }

  /* ------------------------------------------------------------ history */

  function snapshot() {
    state.history.push(state.placements.map(function (item) {
      return { id: item.id, page: item.page, x: item.x, y: item.y, w: item.w, h: item.h, url: item.url, key: item.key, aspect: item.aspect };
    }));
    if (state.history.length > 40) state.history.shift();
    renderButtons();
  }

  function undo() {
    if (!state.history.length || state.busy) return;
    state.placements = state.history.pop();
    state.selected = null;
    renderAllPlacements();
    renderButtons();
  }

  /* ------------------------------------------------------------- pages */

  async function openPdf(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast(t("errBig", { size: E.formatSize(MAX_BYTES) }), true);
      return;
    }
    var buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      toast(t("errInvalid"), true);
      return;
    }
    var bytes = new Uint8Array(buffer);
    setBusy(true);
    var doc = null;
    try {
      doc = await window.pdfjsLib.getDocument({
        data: bytes.slice(0),
        useSystemFonts: true,
        isEvalSupported: false
      }).promise;
    } catch (error) {
      setBusy(false);
      var name = error && error.name ? error.name : "";
      if (name === "PasswordException") toast(t("errEncrypted"), true);
      else toast(t("errInvalid"), true);
      return;
    }

    if (state.pdf && typeof state.pdf.destroy === "function") {
      try { state.pdf.destroy(); } catch (error) { /* already gone */ }
    }

    state.pdf = doc;
    state.bytes = bytes;
    state.name = file.name || "document.pdf";
    state.size = file.size;
    state.placements = [];
    state.history = [];
    state.selected = null;
    state.pending = null;
    state.pages = [];
    state.outName = E.safeName(file.name, "signed");
    el.outName.value = state.outName;

    el.drop.hidden = true;
    el.docBar.hidden = false;
    document.querySelector(".workspace").classList.add("has-doc");
    el.docName.textContent = state.name;
    el.docName.title = state.name;

    await renderPages();
    setBusy(false);
    renderButtons();
    toast("");
    if (window.innerWidth < 980) {
      var first = el.pageList.querySelector(".page");
      if (first) first.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  async function renderPages() {
    if (!state.pdf) return;
    var token = ++state.renderToken;
    var shown = Math.min(state.pdf.numPages, MAX_PAGES);
    var width = Math.max(el.pageList.clientWidth || el.doc.clientWidth || 640, 260);

    el.pageList.innerHTML = "";
    el.pagesEmpty.hidden = true;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (var index = 0; index < shown; index += 1) {
      if (token !== state.renderToken) return;
      var page = await state.pdf.getPage(index + 1);
      var base = page.getViewport({ scale: 1 });
      var scale = width / base.width;

      var card = document.createElement("div");
      card.className = "page";
      card.dataset.page = String(index);

      var sheet = document.createElement("div");
      sheet.className = "sheet";

      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(base.width * scale * dpr));
      canvas.height = Math.max(1, Math.round(base.height * scale * dpr));
      sheet.appendChild(canvas);

      var overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.dataset.page = String(index);
      overlay.addEventListener("pointerdown", onPointerDown);
      overlay.addEventListener("pointermove", onPointerMove);
      overlay.addEventListener("pointerup", onPointerUp);
      overlay.addEventListener("pointercancel", onPointerUp);
      sheet.appendChild(overlay);

      var label = document.createElement("span");
      label.className = "page-no";
      label.textContent = t("pageLabel", { n: index + 1 });

      card.appendChild(sheet);
      card.appendChild(label);
      el.pageList.appendChild(card);

      state.pages[index] = { w: base.width, h: base.height };

      var context = canvas.getContext("2d");
      await page.render({
        canvasContext: context,
        viewport: page.getViewport({ scale: scale * dpr })
      }).promise;
    }

    if (token !== state.renderToken) return;
    if (shown < state.pdf.numPages) {
      el.pagesCap.textContent = t("pagesCap", { n: shown });
      el.pagesCap.hidden = false;
    } else {
      el.pagesCap.hidden = true;
    }
    updatePending();
    renderAllPlacements();
    renderDocMeta();
  }

  /* -------------------------------------------------------- placements */

  function cloneInto(element, rect, selected) {
    element.style.left = (rect.x * 100).toFixed(4) + "%";
    element.style.top = (rect.y * 100).toFixed(4) + "%";
    element.style.width = (rect.w * 100).toFixed(4) + "%";
    element.style.height = (rect.h * 100).toFixed(4) + "%";
    element.classList.toggle("is-selected", !!selected);
  }

  function renderPagePlacements(pageIndex) {
    var overlay = el.pageList.querySelector('.overlay[data-page="' + pageIndex + '"]');
    if (!overlay) return;
    overlay.innerHTML = "";
    state.placements.forEach(function (item) {
      if (item.page !== pageIndex) return;
      var box = document.createElement("div");
      box.className = "place";
      box.dataset.id = item.id;
      var image = document.createElement("img");
      image.src = item.url;
      image.alt = "";
      image.draggable = false;
      box.appendChild(image);
      if (item.id === state.selected) {
        ["nw", "ne", "sw", "se"].forEach(function (corner) {
          var handle = document.createElement("span");
          handle.className = "handle " + corner;
          box.appendChild(handle);
        });
      }
      cloneInto(box, item, item.id === state.selected);
      overlay.appendChild(box);
    });
    overlay.classList.toggle("has-selection", state.placements.some(function (item) {
      return item.page === pageIndex && item.id === state.selected;
    }));
  }

  function renderAllPlacements() {
    for (var index = 0; index < state.pages.length; index += 1) renderPagePlacements(index);
    renderButtons();
  }

  function pointFromEvent(event, overlay) {
    var box = overlay.getBoundingClientRect();
    return {
      x: box.width ? (event.clientX - box.left) / box.width : 0,
      y: box.height ? (event.clientY - box.top) / box.height : 0,
      w: box.width,
      h: box.height
    };
  }

  function findPlacement(id) {
    for (var i = 0; i < state.placements.length; i += 1) {
      if (state.placements[i].id === id) return state.placements[i];
    }
    return null;
  }

  function onPointerDown(event) {
    if (state.busy || event.button > 0) return;
    var overlay = event.currentTarget;
    var pageIndex = Number(overlay.dataset.page);
    var page = state.pages[pageIndex];
    if (!page) return;
    var point = pointFromEvent(event, overlay);

    if (state.pending) {
      event.preventDefault();
      addPlacement(pageIndex, point.x, point.y);
      return;
    }

    var selected = state.selected ? findPlacement(state.selected) : null;
    if (selected && selected.page === pageIndex) {
      var corner = E.handleAt(selected, point.x, point.y, 16 / point.w, 16 / point.h);
      if (corner) {
        event.preventDefault();
        snapshot();
        state.selected = selected.id;
        drag = { mode: "resize", corner: corner, pageIndex: pageIndex, id: selected.id, moved: false };
        overlay.setPointerCapture(event.pointerId);
        return;
      }
    }

    var hit = E.hitTest(state.placements.filter(function (item) {
      return item.page === pageIndex;
    }), point.x, point.y);

    state.selected = hit;
    renderAllPlacements();

    if (hit) {
      event.preventDefault();
      snapshot();
      drag = { mode: "move", pageIndex: pageIndex, id: hit, moved: false };
      overlay.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event) {
    if (!drag) return;
    var overlay = event.currentTarget;
    if (Number(overlay.dataset.page) !== drag.pageIndex) return;
    var page = state.pages[drag.pageIndex];
    var item = findPlacement(drag.id);
    if (!page || !item) return;
    var point = pointFromEvent(event, overlay);
    if (!drag.last) {
      drag.last = { x: point.x, y: point.y };
      if (drag.mode === "resize" && !(item.aspect > 0)) {
        item.aspect = item.w * page.w / Math.max(item.h * page.h, 0.0001);
      }
      return;
    }
    if (drag.mode === "move") {
      var moved = E.moveBy(item, point.x - drag.last.x, point.y - drag.last.y);
      item.x = moved.x;
      item.y = moved.y;
      item.w = moved.w;
      item.h = moved.h;
    } else {
      var resized = E.resize(item, drag.corner, point.x, point.y, item.aspect, page.w, page.h);
      item.x = resized.x;
      item.y = resized.y;
      item.w = resized.w;
      item.h = resized.h;
    }
    drag.last = { x: point.x, y: point.y };
    drag.moved = true;
    var box = overlay.querySelector('.place[data-id="' + drag.id + '"]');
    if (box) cloneInto(box, item, true);
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!drag) return;
    var overlay = event.currentTarget;
    try { overlay.releasePointerCapture(event.pointerId); } catch (error) { /* not captured */ }
    var id = drag.id;
    var item = findPlacement(id);
    drag = null;
    renderAllPlacements();
    if (item && item.id === state.selected) renderButtons();
  }

  function addPlacement(pageIndex, nx, ny) {
    var page = state.pages[pageIndex];
    if (!page || !state.pending) return;
    snapshot();
    var rect = E.placeAt(nx, ny, state.pending.aspect, page.w, page.h, state.pending.width);
    var item = {
      id: "p" + (++uid),
      page: pageIndex,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      url: state.pending.url,
      key: state.pending.key,
      aspect: state.pending.aspect
    };
    state.placements.push(item);
    state.selected = item.id;
    state.pending = null;
    updatePending();
    renderAllPlacements();
    toast("");
  }

  /* ------------------------------------------------------------ signature */

  function setSignature(dataUrl, aspect, kind) {
    state.signature = { url: dataUrl, aspect: aspect };
    state.pending = { url: dataUrl, aspect: aspect, key: "sig" + (++uid), kind: kind || "signature" };
    saveSignature();
    showSignature();
    updatePending();
  }

  function padContext() {
    var canvas = el.drawCanvas;
    var width = canvas.clientWidth || 320;
    var height = canvas.clientHeight || 170;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    var context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { context: context, width: width, height: height, dpr: dpr };
  }

  function redrawPad() {
    var pad = padContext();
    pad.context.clearRect(0, 0, pad.width, pad.height);
    pad.context.lineCap = "round";
    pad.context.lineJoin = "round";
    strokes.forEach(function (stroke) {
      var points = stroke.points;
      pad.context.strokeStyle = stroke.color;
      pad.context.lineWidth = 2.6;
      pad.context.beginPath();
      if (points.length === 1) {
        pad.context.arc(points[0].x, points[0].y, 1.3, 0, Math.PI * 2);
        pad.context.fillStyle = stroke.color;
        pad.context.fill();
        return;
      }
      pad.context.moveTo(points[0].x, points[0].y);
      for (var i = 1; i < points.length - 1; i += 1) {
        var midX = (points[i].x + points[i + 1].x) / 2;
        var midY = (points[i].y + points[i + 1].y) / 2;
        pad.context.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
      }
      var last = points[points.length - 1];
      pad.context.lineTo(last.x, last.y);
      pad.context.stroke();
    });
  }

  function padPoint(event) {
    var box = el.drawCanvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function startStroke(event) {
    if (event.button > 0) return;
    event.preventDefault();
    el.drawCanvas.setPointerCapture(event.pointerId);
    drawing = { color: state.ink, points: [padPoint(event)] };
    strokes.push(drawing);
    redrawPad();
  }

  function moveStroke(event) {
    if (!drawing) return;
    event.preventDefault();
    var point = padPoint(event);
    var last = drawing.points[drawing.points.length - 1];
    if (last && Math.abs(point.x - last.x) < 0.7 && Math.abs(point.y - last.y) < 0.7) return;
    drawing.points.push(point);
    redrawPad();
  }

  function endStroke(event) {
    if (!drawing) return;
    drawing = null;
    try { el.drawCanvas.releasePointerCapture(event.pointerId); } catch (error) { /* fine */ }
  }

  function trimmedDataUrl(source, pad) {
    var context = source.getContext("2d");
    var data = context.getImageData(0, 0, source.width, source.height);
    var bounds = E.inkBounds(data.data, source.width, source.height, 10);
    if (!bounds) return null;
    var padding = Math.round(12 * (pad && pad.dpr ? pad.dpr : 1));
    var x = Math.max(0, bounds.x - padding);
    var y = Math.max(0, bounds.y - padding);
    var w = Math.min(source.width - x, bounds.w + padding * 2);
    var h = Math.min(source.height - y, bounds.h + padding * 2);
    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
    return { url: out.toDataURL("image/png"), aspect: w / h };
  }

  function useDrawn() {
    if (!strokes.length) {
      toast(t("errDrawEmpty"), true);
      return;
    }
    redrawPad();
    var pad = padContext();
    var result = trimmedDataUrl(el.drawCanvas, pad);
    if (!result) {
      toast(t("errDrawEmpty"), true);
      return;
    }
    setSignature(result.url, result.aspect, "signature");
  }

  function useTyped() {
    var text = el.typeInput.value.trim();
    if (!text) {
      toast(t("errTypeEmpty"), true);
      return;
    }
    var font = el.typeFont.value === "serif"
      ? 'italic 1px Georgia, "Times New Roman", serif'
      : '1px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Bradley Hand", cursive';
    var size = 220;
    var measure = document.createElement("canvas").getContext("2d");
    measure.font = font.replace("1px", size + "px");
    var width = Math.ceil(measure.measureText(text).width) + 80;
    var height = Math.round(size * 1.7);
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(width, 40);
    canvas.height = height;
    var context = canvas.getContext("2d");
    context.font = font.replace("1px", size + "px");
    context.fillStyle = state.ink;
    context.textBaseline = "middle";
    context.fillText(text, 40, Math.round(height / 2));
    var result = trimmedDataUrl(canvas, null);
    if (!result) {
      toast(t("errTypeEmpty"), true);
      return;
    }
    setSignature(result.url, result.aspect, "signature");
  }

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var image = new Image();
        image.onload = function () { resolve(image); };
        image.onerror = reject;
        image.src = String(reader.result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function useUploaded(file) {
    if (!file) return;
    var image;
    try {
      image = await readImage(file);
    } catch (error) {
      toast(t("errImage"), true);
      return;
    }
    var limit = 1600;
    var scale = Math.min(1, limit / Math.max(image.width, image.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    var context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    if (el.whiteToggle.checked) {
      var data = context.getImageData(0, 0, canvas.width, canvas.height);
      var pixels = data.data;
      for (var i = 0; i < pixels.length; i += 4) {
        var luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        if (luminance >= 232) {
          pixels[i + 3] = 0;
        } else if (luminance > 212) {
          pixels[i + 3] = Math.round(pixels[i + 3] * (232 - luminance) / 20);
        }
      }
      context.putImageData(data, 0, 0);
    }

    var result = trimmedDataUrl(canvas, null);
    if (!result) {
      toast(t("errImage"), true);
      return;
    }
    setSignature(result.url, result.aspect, "signature");
  }

  function addDate() {
    if (!state.pdf) {
      toast(t("errNoDoc"), true);
      return;
    }
    var now = new Date();
    var text = now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
    var size = 130;
    var measure = document.createElement("canvas").getContext("2d");
    measure.font = "600 " + size + "px ui-sans-serif, system-ui, sans-serif";
    var width = Math.ceil(measure.measureText(text).width) + 60;
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(size * 1.5);
    var context = canvas.getContext("2d");
    context.font = "600 " + size + "px ui-sans-serif, system-ui, sans-serif";
    context.fillStyle = state.ink;
    context.textBaseline = "middle";
    context.fillText(text, 30, Math.round(canvas.height / 2));
    var result = trimmedDataUrl(canvas, null);
    if (!result) return;
    state.pending = { url: result.url, aspect: result.aspect, key: "date" + (++uid), kind: "date", width: 0.16 };
    updatePending();
  }

  /* --------------------------------------------------------------- export */

  async function exportPdf() {
    if (!state.pdf || !state.bytes) {
      toast(t("errNoDoc"), true);
      return;
    }
    if (!state.placements.length) {
      toast(t("errNoPlacements"), true);
      return;
    }
    var name = E.safeName(el.outName.value, "");
    if (!name) {
      toast(t("errName"), true);
      return;
    }
    state.outName = name;
    savePrefs();
    setBusy(true);
    toast(t("working"));
    try {
      var images = {};
      state.placements.forEach(function (item) {
        if (!images[item.key]) images[item.key] = E.dataUrlBytes(item.url);
      });
      var output = await E.stampPdf(window.PDFLib, state.bytes, state.placements, images, { title: name });
      var blob = new Blob([output], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = name + ".pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
      toast(t("done"));
    } catch (error) {
      toast(t("errExport"), true);
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- wiring */

  function cacheElements() {
    [
      "langSelect", "drop", "chooseBtn", "fileInput", "docBar", "docName", "docMeta", "replaceBtn",
      "pagesEmpty", "pageList", "pagesCap", "tabDraw", "tabType", "tabUpload",
      "panelDraw", "panelType", "panelUpload", "drawCanvas", "inkSelect", "drawUndo", "drawClear",
      "drawUse", "typeInput", "typeFont", "typeUse", "uploadInput", "whiteToggle",
      "sigPreview", "sigEmpty", "pendingHint", "dateBtn", "deleteBtn", "outName", "exportBtn",
      "undoBtn", "clearBtn", "toast"
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function selectTab(which) {
    var tabs = { draw: el.tabDraw, type: el.tabType, upload: el.tabUpload };
    var panels = { draw: el.panelDraw, type: el.panelType, upload: el.panelUpload };
    Object.keys(tabs).forEach(function (key) {
      var on = key === which;
      tabs[key].classList.toggle("is-on", on);
      tabs[key].setAttribute("aria-selected", on ? "true" : "false");
      panels[key].hidden = !on;
    });
    if (which === "draw") {
      padContext();
      redrawPad();
    }
  }

  function bind() {
    el.langSelect.addEventListener("change", function () {
      state.lang = el.langSelect.value;
      savePrefs();
      applyLang();
    });

    el.chooseBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      el.fileInput.click();
    });
    el.drop.addEventListener("click", function () { el.fileInput.click(); });
    el.drop.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.fileInput.click();
      }
    });
    el.replaceBtn.addEventListener("click", function () { el.fileInput.click(); });
    el.fileInput.addEventListener("change", function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      el.fileInput.value = "";
      openPdf(file);
    });

    ["dragenter", "dragover"].forEach(function (type) {
      el.drop.addEventListener(type, function (event) {
        event.preventDefault();
        el.drop.classList.add("is-over");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      el.drop.addEventListener(type, function (event) {
        event.preventDefault();
        el.drop.classList.remove("is-over");
      });
    });
    el.drop.addEventListener("drop", function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      openPdf(file);
    });
    document.addEventListener("dragover", function (event) { event.preventDefault(); });
    document.addEventListener("drop", function (event) {
      if (event.target === el.drop || el.drop.contains(event.target)) return;
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file && /pdf$/i.test(file.name)) openPdf(file);
    });

    el.tabDraw.addEventListener("click", function () { selectTab("draw"); });
    el.tabType.addEventListener("click", function () { selectTab("type"); });
    el.tabUpload.addEventListener("click", function () { selectTab("upload"); });

    el.drawCanvas.addEventListener("pointerdown", startStroke);
    el.drawCanvas.addEventListener("pointermove", moveStroke);
    el.drawCanvas.addEventListener("pointerup", endStroke);
    el.drawCanvas.addEventListener("pointercancel", endStroke);
    el.drawUndo.addEventListener("click", function () {
      strokes.pop();
      redrawPad();
    });
    el.drawClear.addEventListener("click", function () {
      strokes = [];
      redrawPad();
    });
    el.drawUse.addEventListener("click", useDrawn);
    el.typeUse.addEventListener("click", useTyped);
    el.typeInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") useTyped();
    });
    el.uploadInput.addEventListener("change", function () {
      var file = el.uploadInput.files && el.uploadInput.files[0];
      el.uploadInput.value = "";
      useUploaded(file);
    });
    el.inkSelect.addEventListener("change", function () {
      state.ink = el.inkSelect.value;
      savePrefs();
    });

    el.dateBtn.addEventListener("click", addDate);
    el.deleteBtn.addEventListener("click", function () {
      if (!state.selected) return;
      snapshot();
      state.placements = state.placements.filter(function (item) { return item.id !== state.selected; });
      state.selected = null;
      renderAllPlacements();
    });

    el.exportBtn.addEventListener("click", exportPdf);
    el.undoBtn.addEventListener("click", undo);
    el.clearBtn.addEventListener("click", function () {
      if (!state.placements.length) return;
      snapshot();
      state.placements = [];
      state.selected = null;
      renderAllPlacements();
    });
    el.outName.addEventListener("input", function () {
      state.outName = el.outName.value;
      savePrefs();
    });

    document.addEventListener("keydown", function (event) {
      var tag = (event.target && event.target.tagName) || "";
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if ((event.key === "Delete" || event.key === "Backspace") && state.selected) {
        event.preventDefault();
        el.deleteBtn.click();
      } else if (event.key === "Escape") {
        state.selected = null;
        state.pending = null;
        updatePending();
        renderAllPlacements();
      }
    });

    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!state.pdf) return;
        renderPages();
        if (!el.panelDraw.hidden) {
          padContext();
          redrawPad();
        }
      }, 260);
    });
  }

  function workerSetup() {
    var node = document.getElementById("pdfWorkerSource");
    if (node && node.textContent && node.textContent.length > 1000 && window.pdfjsLib) {
      try {
        var blob = new Blob([node.textContent], { type: "text/javascript" });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      } catch (error) {
        /* the main thread still renders, only slower */
      }
    }
  }

  function init() {
    cacheElements();
    state.lang = detectLang();
    loadPrefs();
    workerSetup();

    el.inkSelect.value = state.ink;
    el.outName.value = state.outName;
    showSignature();
    bind();
    selectTab("draw");
    padContext();
    redrawPad();
    applyLang();
    renderButtons();
    renderDocMeta();

    if (state.signature) {
      state.pending = { url: state.signature.url, aspect: state.signature.aspect, key: "sig" + (++uid), kind: "signature" };
      updatePending();
    }

    window.__signpdf = {
      state: function () {
        return {
          lang: state.lang,
          pages: state.pages.length,
          placements: state.placements.map(function (item) {
            return { id: item.id, page: item.page, x: item.x, y: item.y, w: item.w, h: item.h };
          }),
          signature: !!state.signature,
          pending: !!state.pending,
          busy: state.busy
        };
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
