'use strict';
/*
 * Route planning over the community's real road layout.
 *
 * roads.png is a coarse grid of the master map: roads are cheap to cross, lots and
 * grass are slow, lakes are blocked. Travel cost between every pair of lots is the
 * cheapest path over that grid, so the route follows streets and goes around water.
 * The visiting order is then tightened with 2-opt and or-opt passes.
 */
(function (root) {
  const ROAD = 2, OFFROAD = 14, RING = 32;
  let grid = null;

  async function loadGrid(cell) {
    if (grid) return grid;
    const img = new Image();
    img.src = 'roads.png';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const cost = new Uint8Array(c.width * c.height);
    for (let i = 0; i < cost.length; i++) cost[i] = px[i * 4] > 200 ? ROAD : px[i * 4] < 50 ? 0 : OFFROAD;
    grid = { w: c.width, h: c.height, cost: cost, cell: cell };
    return grid;
  }

  /** Grid cell for a point in map pixels, nudged off water if needed. */
  function cellOf(g, pt) {
    const x = Math.min(g.w - 1, Math.max(0, Math.floor(pt[0] / g.cell)));
    const y = Math.min(g.h - 1, Math.max(0, Math.floor(pt[1] / g.cell)));
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && g.cost[ny * g.w + nx]) return ny * g.w + nx;
      }
    }
    return y * g.w + x;
  }

  /** Cheapest travel cost from one cell to each target cell (Dial's bucket queue). */
  function travelFrom(g, src, targets) {
    const { w, h, cost } = g;
    const dist = new Int32Array(w * h).fill(1e9);
    const ring = Array.from({ length: RING }, () => []);
    const waiting = new Set(targets);
    dist[src] = 0;
    ring[0].push(src);
    let pending = 1;
    for (let d = 0; pending > 0 && waiting.size; d++) {
      const bucket = ring[d % RING];
      while (bucket.length) {
        const c = bucket.pop();
        pending--;
        if (dist[c] !== d) continue;
        waiting.delete(c);
        const x = c % w, y = (c - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx, step = cost[n];
          if (!step) continue;
          const nd = d + (dx && dy ? step + (step >> 1) : step);
          if (nd < dist[n]) { dist[n] = nd; ring[nd % RING].push(n); pending++; }
        }
      }
    }
    return targets.map(t => dist[t]);
  }

  /** Cheapest path between two cells as map-pixel points, smoothed so it reads like a drawn road. */
  function trace(g, src, dst) {
    const { w, h, cost } = g;
    const dist = new Int32Array(w * h).fill(1e9);
    const prev = new Int32Array(w * h).fill(-1);
    const ring = Array.from({ length: RING }, () => []);
    dist[src] = 0;
    ring[0].push(src);
    let pending = 1, found = src === dst;
    for (let d = 0; pending > 0 && !found; d++) {
      const bucket = ring[d % RING];
      while (bucket.length) {
        const c = bucket.pop();
        pending--;
        if (dist[c] !== d) continue;
        if (c === dst) { found = true; break; }
        const x = c % w, y = (c - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx, step = cost[n];
          if (!step) continue;
          const nd = d + (dx && dy ? step + (step >> 1) : step);
          if (nd < dist[n]) { dist[n] = nd; prev[n] = c; ring[nd % RING].push(n); pending++; }
        }
      }
    }
    if (!found) return null;
    let pts = [];
    for (let c = dst; c !== -1; c = prev[c]) pts.push([(c % w + 0.5) * g.cell, (Math.floor(c / w) + 0.5) * g.cell]);
    pts.reverse();
    // grid paths are staircases: average neighbours to round them off, keeping the ends fixed
    for (let pass = 0; pass < 3; pass++) {
      pts = pts.map((p, i) => {
        if (i === 0 || i === pts.length - 1) return p;
        const a = pts[Math.max(0, i - 2)], b = pts[i - 1], c = pts[i + 1], e = pts[Math.min(pts.length - 1, i + 2)];
        return [(a[0] + b[0] + p[0] + c[0] + e[0]) / 5, (a[1] + b[1] + p[1] + c[1] + e[1]) / 5];
      });
    }
    return pts.filter((p, i) => i % 2 === 0 || i === pts.length - 1);
  }

  /** Road path between two map-pixel points, ending exactly on them. Flat [x, y, x, y, ...], rounded. */
  async function path(from, to, cell) {
    const g = await loadGrid(cell);
    const mid = trace(g, cellOf(g, from), cellOf(g, to)) || [];
    return [from].concat(mid.slice(1, -1), [to]).reduce((flat, p) => { flat.push(Math.round(p[0]), Math.round(p[1])); return flat; }, []);
  }

  /** Visiting order for points[1..], starting at points[0]; D is the cost matrix. */
  function order(D) {
    const n = D.length;
    const path = [0];
    const left = new Set();
    for (let i = 1; i < n; i++) left.add(i);
    while (left.size) {
      const here = path[path.length - 1];
      let best = -1;
      left.forEach(i => { if (best < 0 || D[here][i] < D[here][best]) best = i; });
      path.push(best);
      left.delete(best);
    }
    const len = p => { let s = 0; for (let i = 1; i < p.length; i++) s += D[p[i - 1]][p[i]]; return s; };
    let improved = true;
    while (improved) {
      improved = false;
      // 2-opt: reverse a stretch when that removes doubling back
      for (let i = 1; i < path.length - 1; i++) for (let j = i + 1; j < path.length; j++) {
        const a = path[i - 1], b = path[i], c = path[j], d = path[j + 1];
        const delta = D[a][c] + (d == null ? 0 : D[b][d]) - D[a][b] - (d == null ? 0 : D[c][d]);
        if (delta < -0.5) { path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse()); improved = true; }
      }
      // or-opt: move a run of 1 to 3 lots to a better place in the route
      for (let size = 1; size <= 3; size++) for (let i = 1; i + size <= path.length; i++) {
        const before = len(path);
        const run = path.slice(i, i + size);
        const rest = path.slice(0, i).concat(path.slice(i + size));
        let bestLen = before, bestAt = -1, bestRun = run;
        for (let at = 1; at <= rest.length; at++) for (const cand of [run, run.slice().reverse()]) {
          const l = len(rest.slice(0, at).concat(cand, rest.slice(at)));
          if (l < bestLen - 0.5) { bestLen = l; bestAt = at; bestRun = cand; }
        }
        if (bestAt >= 0) { path.splice(0, path.length, ...rest.slice(0, bestAt).concat(bestRun, rest.slice(bestAt))); improved = true; }
      }
    }
    return path.slice(1).map(i => i - 1);
  }

  /** points: map-pixel [x, y] of each lot. start: map-pixel start point. Returns { order: indexes into points in visiting order, paths: road path leading to each stop }. */
  async function plan(points, start, cell) {
    const g = await loadGrid(cell);
    const cells = [start].concat(points).map(p => cellOf(g, p));
    const all = [start].concat(points);
    const D = cells.map((c, i) => travelFrom(g, c, cells).map((d, j) => d < 1e9 ? d : Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1]) / cell * OFFROAD * 3));
    for (let i = 0; i < D.length; i++) for (let j = i + 1; j < D.length; j++) D[i][j] = D[j][i] = (D[i][j] + D[j][i]) / 2;
    const seq = order(D);
    // the drive from each stop to the next, along the roads
    const paths = [];
    let here = start;
    for (const i of seq) { paths.push(await path(here, points[i], cell)); here = points[i]; }
    return { order: seq, paths: paths };
  }

  const api = { plan: plan, path: path, trace: trace, order: order, travelFrom: travelFrom, cellOf: cellOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Route = api;
})(typeof window !== 'undefined' ? window : globalThis);
