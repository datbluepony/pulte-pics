'use strict';
/*
 * Reads the agents' starred map PDF on the device, with no paid service.
 *
 * 1. pdf.js lists what is on each page: the map screenshots (images), the stars
 *    (small filled shapes or small pasted images) and the legend names (text).
 * 2. OpenCV template matching finds where each screenshot sits on the master map.
 * 3. Each star is carried onto the master map and matched to the nearest lot label.
 */
(function (root) {
  const STAR_MAX = 40;    // pt, largest star
  const STAR_MIN = 5;     // pt
  const IMAGE_MIN = 100;  // pt, smallest map screenshot
  const RENDER = 2;       // canvas pixels per pt
  const GOOD_SCORE = 0.6; // template match score that needs no warning
  const MIN_SCORE = 0.45; // below this the screenshot was not found on the master map
  const CLOSE_RATIO = 1.25; // second-nearest lot this close means "check it"

  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  /** Stars, map images and text on one page, in points from the top-left corner. */
  async function pageItems(pdfjsLib, page) {
    const OPS = pdfjsLib.OPS;
    const viewport = page.getViewport({ scale: 1 });
    const list = await page.getOperatorList();
    const fillOps = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke];
    const stack = [];
    let ctm = viewport.transform.slice();
    let fill = [0, 0, 0];
    let fillStack = [];
    let box = null; // bounding box of the path under construction
    const grow = (x, y) => {
      const p = apply(ctm, x, y);
      box = box ? [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])] : [p[0], p[1], p[0], p[1]];
    };
    const stars = [], images = [];
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i], args = list.argsArray[i];
      if (fn === OPS.save) { stack.push(ctm); fillStack.push(fill); }
      else if (fn === OPS.restore) { if (stack.length) { ctm = stack.pop(); fill = fillStack.pop(); } }
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); fillStack.push(fill); if (args[0]) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) { ctm = stack.pop(); fill = fillStack.pop(); } }
      else if (fn === OPS.setFillRGBColor) fill = [args[0], args[1], args[2]];
      else if (fn === OPS.constructPath) {
        const ops = args[0], xy = args[1];
        let j = 0;
        for (const op of ops) {
          if (op === OPS.moveTo || op === OPS.lineTo) { grow(xy[j], xy[j + 1]); j += 2; }
          else if (op === OPS.curveTo) { grow(xy[j], xy[j + 1]); grow(xy[j + 2], xy[j + 3]); grow(xy[j + 4], xy[j + 5]); j += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { grow(xy[j], xy[j + 1]); grow(xy[j + 2], xy[j + 3]); j += 4; }
          else if (op === OPS.rectangle) { grow(xy[j], xy[j + 1]); grow(xy[j] + xy[j + 2], xy[j + 1] + xy[j + 3]); j += 4; }
        }
      } else if (fillOps.indexOf(fn) >= 0) {
        if (box) {
          const w = box[2] - box[0], h = box[3] - box[1];
          const grey = Math.max(...fill) - Math.min(...fill) < 12;
          if (w >= STAR_MIN && h >= STAR_MIN && w <= STAR_MAX && h <= STAR_MAX && !grey) {
            stars.push({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, color: fill.slice() });
          }
        }
        box = null;
      } else if (fn === OPS.stroke || fn === OPS.closeStroke || fn === OPS.endPath) box = null;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const c = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
        const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
        const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const w = r[2] - r[0], h = r[3] - r[1];
        if (w >= IMAGE_MIN && h >= IMAGE_MIN) images.push(r);
        else if (w >= STAR_MIN && h >= STAR_MIN && w <= STAR_MAX && h <= STAR_MAX) {
          stars.push({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, color: null }); // pasted star: colour is sampled from the render
        }
      }
    }
    // one star can be painted twice (fill, then outline)
    const unique = [];
    stars.forEach(s => { if (!unique.some(u => Math.hypot(u.x - s.x, u.y - s.y) < 2)) unique.push(s); });
    const text = (await page.getTextContent()).items.filter(t => t.str && t.str.trim()).map(t => {
      const m = mul(viewport.transform, t.transform);
      return { str: t.str.trim(), x: m[4], y: m[5] };
    });
    return { width: viewport.width, height: viewport.height, stars: unique, images: images, text: text };
  }

  /** Pair each legend name with the star printed just left of it. */
  function legend(items) {
    const entries = [];
    items.text.forEach(t => {
      let best = null;
      items.stars.forEach(s => {
        const dx = t.x - s.x, dy = Math.abs((t.y - 5) - s.y);
        if (dx > 0 && dx < 45 && dy < 14 && (!best || dx < t.x - best.x)) best = s;
      });
      if (best) { best.legend = true; entries.push({ name: t.str, color: best.color }); }
    });
    return entries;
  }

  const colorGap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const unhex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

  function colorName(c) {
    const [r, g, b] = c;
    if (r > 200 && g > 200 && b < 120) return 'Yellow';
    if (g > r + 40 && g > b + 40) return 'Green';
    if (b > r + 40 && b >= g) return 'Blue';
    if (r > 200 && b > 180 && g < r) return 'Pink';
    if (r > g + 60 && r > b + 60) return g > 120 ? 'Orange' : 'Red';
    return 'Unlisted colour';
  }

  // ---------- OpenCV matching ----------

  function matcher(cv, masterRgba) {
    const rgb = new cv.Mat();
    cv.cvtColor(masterRgba, rgb, cv.COLOR_RGBA2RGB);
    const scaled = (src, f) => {
      const d = new cv.Mat();
      cv.resize(src, d, new cv.Size(Math.max(1, Math.round(src.cols * f)), Math.max(1, Math.round(src.rows * f))), 0, 0, cv.INTER_AREA);
      return d;
    };
    const pyr = { 4: scaled(rgb, 0.25), 2: scaled(rgb, 0.5), 1: rgb };

    // best position of the crop, scaled by k into master pixels, on pyramid level lv
    function match(crop, k, lv, near) {
      const m = pyr[lv];
      const t = scaled(crop, k / lv);
      let roi = m, ox = 0, oy = 0, out = null;
      if (near) {
        const pad = near.pad / lv;
        const x0 = Math.max(0, Math.floor(near.x / lv - pad)), y0 = Math.max(0, Math.floor(near.y / lv - pad));
        const x1 = Math.min(m.cols, Math.ceil(near.x / lv + t.cols + pad)), y1 = Math.min(m.rows, Math.ceil(near.y / lv + t.rows + pad));
        if (x1 - x0 < t.cols || y1 - y0 < t.rows) { t.delete(); return null; }
        roi = m.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)); ox = x0; oy = y0;
      }
      if (t.cols <= roi.cols && t.rows <= roi.rows && t.cols >= 24 && t.rows >= 24) {
        const res = new cv.Mat();
        cv.matchTemplate(roi, t, res, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(res);
        res.delete();
        out = { k: k, score: mm.maxVal, x: (mm.maxLoc.x + ox) * lv, y: (mm.maxLoc.y + oy) * lv };
      }
      t.delete();
      if (near) roi.delete();
      return out;
    }

    /** Where a screenshot sits on the master map: master = (x, y) + k * crop pixel. */
    function locate(cropRgba) {
      const crop = new cv.Mat();
      cv.cvtColor(cropRgba, crop, cv.COLOR_RGBA2RGB);
      let best = null;
      for (let k = 0.08; k < 2.5; k *= 1.04) {
        const r = match(crop, k, 4);
        if (r && (!best || r.score > best.score)) best = r;
      }
      if (best) {
        [[2, 0.05, 0.01, 12], [1, 0.012, 0.003, 6]].forEach(([lv, span, step, pad]) => {
          const base = best;
          let fine = null;
          for (let k = base.k * (1 - span); k <= base.k * (1 + span); k += base.k * step) {
            const r = match(crop, k, lv, { x: base.x, y: base.y, pad: pad });
            if (r && (!fine || r.score > fine.score)) fine = r;
          }
          if (fine) best = fine;
        });
      }
      crop.delete();
      return best;
    }
    return { locate: locate, free: () => { pyr[4].delete(); pyr[2].delete(); rgb.delete(); } };
  }

  /** The two lots whose labels are nearest a point on the master map. */
  function nearestLots(master, x, y) {
    let a = null, b = null;
    for (const n in master.lots) {
      const d = Math.hypot(master.lots[n][0] - x, master.lots[n][1] - y);
      if (!a || d < a.d) { b = a; a = { lot: Number(n), d: d }; }
      else if (!b || d < b.d) b = { lot: Number(n), d: d };
    }
    return [a, b];
  }

  // ---------- browser pipeline ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  let libs = null;
  function loadLibs() {
    if (!libs) libs = (async () => {
      await loadScript('vendor/pdf.min.js');
      root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      await loadScript('vendor/opencv.js');
      let cv = root.cv;
      if (cv && typeof cv.then === 'function') cv = await cv;
      if (!cv.Mat) await new Promise(r => { cv.onRuntimeInitialized = r; });
      return { pdfjsLib: root.pdfjsLib, cv: cv };
    })();
    return libs;
  }

  function sampleColor(ctx, x, y) {
    const d = ctx.getImageData(Math.round(x * RENDER) - 3, Math.round(y * RENDER) - 3, 7, 7).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
    return sum.map(v => v / (d.length / 4));
  }

  function thumb(canvas, x, y) {
    const size = 150, half = 55 * RENDER; // 110 pt window around the star
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(canvas, x * RENDER - half, y * RENDER - half, half * 2, half * 2, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.55);
  }

  /**
   * file: the agents' PDF. master: lots.json. agents: [{name, color}].
   * Returns { lots: [{lot, agent, color, flag, thumb}], legend: [{name, color}], warnings: [] }.
   */
  async function readMap(file, master, agents, progress) {
    progress('Loading the map reader (first time takes a moment)...');
    const { pdfjsLib, cv } = await loadLibs();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;

    const img = new Image();
    img.src = 'map.jpg';
    await img.decode();
    const mc = document.createElement('canvas');
    mc.width = img.naturalWidth; mc.height = img.naturalHeight;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
    mctx.drawImage(img, 0, 0);
    const masterMat = cv.matFromImageData(mctx.getImageData(0, 0, mc.width, mc.height));
    const m = matcher(cv, masterMat);
    masterMat.delete();

    const pages = [];
    let known = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const items = await pageItems(pdfjsLib, page);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(items.width * RENDER); canvas.height = Math.round(items.height * RENDER);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: RENDER }) }).promise;
      items.stars.forEach(s => { if (!s.color) s.color = sampleColor(ctx, s.x, s.y); });
      known = known.concat(legend(items));
      pages.push({ n: n, items: items, canvas: canvas, ctx: ctx });
    }

    // legend colours first, then the colours saved for each agent
    const palette = [];
    known.forEach(e => {
      const a = agents.find(g => g.name.toLowerCase() === e.name.toLowerCase());
      palette.push({ name: a ? a.name : e.name, color: e.color, onFile: !!a });
    });
    agents.forEach(a => { if (!palette.some(p => p.name === a.name)) palette.push({ name: a.name, color: unhex(a.color), onFile: true }); });
    const whose = color => {
      const best = palette.map(p => ({ p: p, gap: colorGap(p.color, color) })).sort((x, y) => x.gap - y.gap)[0];
      return best && best.gap < 40 ? best.p : null;
    };

    const lots = [], warnings = [];
    for (const pg of pages) {
      const free = pg.items.stars.filter(s => !s.legend);
      for (let i = 0; i < pg.items.images.length; i++) {
        const r = pg.items.images[i];
        const inside = free.filter(s => s.x >= r[0] && s.x <= r[2] && s.y >= r[1] && s.y <= r[3]);
        inside.forEach(s => { s.used = true; });
        if (!inside.length) continue;
        progress('Matching page ' + pg.n + ' of ' + pages.length + ' to the master map...');
        await new Promise(res => setTimeout(res, 30)); // let the progress text paint
        const x0 = Math.round(r[0] * RENDER), y0 = Math.round(r[1] * RENDER);
        const w = Math.min(pg.canvas.width - x0, Math.round((r[2] - r[0]) * RENDER)), h = Math.min(pg.canvas.height - y0, Math.round((r[3] - r[1]) * RENDER));
        const cropMat = cv.matFromImageData(pg.ctx.getImageData(x0, y0, w, h));
        const pos = m.locate(cropMat);
        cropMat.delete();
        if (!pos || pos.score < MIN_SCORE) {
          warnings.push('Page ' + pg.n + ': one map picture could not be found on the master map, so its ' + inside.length + ' stars are missing. Add those lots by hand.');
          continue;
        }
        inside.forEach(s => {
          const X = pos.x + (s.x * RENDER - x0) * pos.k, Y = pos.y + (s.y * RENDER - y0) * pos.k;
          const [a, b] = nearestLots(master, X, Y);
          const owner = whose(s.color);
          const why = [];
          if (!owner) why.push(colorName(s.color) + ' star is not in the legend');
          else if (!owner.onFile) why.push(owner.name + ' is not in your agent list');
          if (b.d / a.d < CLOSE_RATIO) why.push('Star sits close to lot ' + b.lot + ' too');
          if (pos.score < GOOD_SCORE) why.push('This map picture was a weak match to the master map');
          if (a.d > 30) why.push('Star is not on a lot');
          lots.push({ lot: a.lot, agent: owner && owner.onFile ? owner.name : '', color: hex(s.color), flag: why.join('. '), thumb: thumb(pg.canvas, s.x, s.y) });
        });
      }
      free.filter(s => !s.used).forEach(s => {
        const owner = whose(s.color);
        warnings.push('Page ' + pg.n + ': one star' + (owner ? ' for ' + owner.name : '') + ' sits outside the map picture, so it has no lot. Ask the agent which lot it is.');
      });
    }
    m.free();
    return { lots: lots, legend: known.map(e => ({ name: e.name, color: hex(e.color) })), warnings: warnings };
  }

  const api = { readMap: readMap, pageItems: pageItems, legend: legend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapRead = api;
})(typeof window !== 'undefined' ? window : globalThis);
