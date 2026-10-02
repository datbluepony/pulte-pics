'use strict';

// ---------- small helpers ----------

const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

const COMMUNITY = 'Verdana Village';
const START = [1323, 204]; // main entry guard house, in map image pixels
const ARRIVED_M = 25;      // closer than this counts as being at the lot
const STAGES = [
  { id: 'prep', label: 'Lot prep', text: 'The homesite has been cleared and is being prepared for the foundation.' },
  { id: 'slab', label: 'Foundation', text: 'The foundation has been poured.' },
  { id: 'walls', label: 'Walls going up', text: 'The walls are going up, with block and framing work underway.' },
  { id: 'roof', label: 'Roof on', text: 'The roof is on and the windows are going in.' },
  { id: 'exterior', label: 'Exterior finish', text: 'The exterior is being finished, with stucco and paint work underway.' },
  { id: 'drywall', label: 'Drywall', text: 'Inside, the drywall is up and the rooms are taking shape.' },
  { id: 'interior', label: 'Interior finishes', text: 'Interior finishes are going in, including cabinets, tile and trim.' },
  { id: 'final', label: 'Final touches', text: 'The home is in its final touches, with the driveway, landscaping and last details being completed.' },
  { id: 'complete', label: 'Complete', text: 'The home looks complete from the outside.' },
];

let settings = store.get('settings', { url: '', token: '', expireDays: 11 });
let agents = store.get('agents', [
  { name: 'Justin', color: '#46b1e1', email: '' },
  { name: 'Gita', color: '#f2cfee', email: '' },
  { name: 'Derek', color: '#ffff00', email: '' },
]);
let run = store.get('run', null);          // current photo run
let history = store.get('history', {});    // lot -> { date, stage } from the last visit
let master = { lots: {}, image: { w: 1, h: 1 } };
let currentLot = null;
let lotStep = 'find';
let zoom = 4;

function saveRun() {
  try { store.set('run', run); } catch (e) {
    // storage is full: the star snapshots are the only big thing in a run
    run.lots.forEach(l => { delete l.thumb; });
    try { store.set('run', run); } catch (e2) {
      run.lots.forEach(l => (l.photos || []).forEach(ph => { delete ph.thumb; }));
      store.set('run', run);
    }
  }
}
const agentColor = name => (agents.find(a => a.name === name) || {}).color || '#cccccc';
const lotOf = n => run.lots.find(l => l.lot === n);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

async function api(action, body) {
  if (!settings.url) throw new Error('Add the Google web app URL in Settings first.');
  // text/plain body keeps this a "simple" request, which Apps Script web apps need
  const res = await fetch(settings.url, { method: 'POST', body: JSON.stringify(Object.assign({ action, token: settings.token }, body)) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'Request failed');
  return out;
}

const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// ---------- upload queue (IndexedDB so photos survive a reload) ----------

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('pulte-pics', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const tx = async (mode, fn) => {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction('queue', mode);
    const r = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
};
// If the phone refuses to store an item, it waits in memory instead, so nothing taken is dropped
// while the app stays open.
const memQueue = [];
const queuePut = async item => {
  try { await tx('readwrite', s => s.put(item)); } catch (e) { memQueue.push(item); }
};
const queueDel = async id => {
  const i = memQueue.findIndex(m => m.id === id);
  if (i >= 0) { memQueue.splice(i, 1); return; }
  await tx('readwrite', s => s.delete(id));
};
const queueAll = async () => {
  let stored = [];
  try { stored = await tx('readonly', s => s.getAll()); } catch (e) { /* storage unavailable: memory only */ }
  return stored.concat(memQueue).sort((a, b) => a.t - b.t);
};

/** Drop photos that were counted but never made it into the queue, so the numbers are honest. */
async function reconcile() {
  if (!run) return;
  const items = await queueAll();
  run.lots.forEach(l => {
    const waiting = items.filter(i => i.type === 'photo' && i.date === run.date && i.lot === l.lot).map(i => i.name);
    l.seq = Math.max(l.seq || 0, l.count || 0);
    l.photos = (l.photos || []).filter(ph => ph.id || waiting.indexOf(ph.name) >= 0);
    l.count = l.sent + waiting.length;
  });
  saveRun();
}

let pumping = false;
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch (e) { /* wake lock is a nice-to-have */ }
}

function setStatus(text, cls) {
  const el = $('#status');
  el.textContent = text;
  el.className = cls || '';
}

async function pump() {
  if (pumping || !settings.url) return;
  pumping = true;
  let fails = 0;
  try {
    for (;;) {
      const items = await queueAll();
      const photos = items.filter(i => i.type === 'photo').length;
      if (!items.length) {
        setStatus(run ? 'Everything is sent.' : 'Connected.');
        // last lot is in: tell the agents without being asked
        if (run && run.phase === 'route' && !run.notified && run.lots.length && run.lots.every(l => l.done)) {
          run.notified = true;
          saveRun();
          try {
            const out = await notifyAgents();
            setStatus('Everything is sent. Emailed: ' + (out.sent.join(', ') || 'nobody') + '.');
          } catch (e) {
            run.notified = false;
            saveRun();
            setStatus('Everything is sent, but the agent email failed: ' + e.message, 'err');
          }
        }
        break;
      }
      if (!navigator.onLine) { setStatus('Offline. ' + photos + ' photos waiting.', 'err'); break; }
      keepAwake(true);
      const it = items[0];
      setStatus('Sending lot ' + it.lot + '. ' + photos + ' photos left. Keep this screen open.', 'busy');
      try {
        if (it.type === 'photo') {
          const up = await api('upload', { community: it.community, date: it.date, agent: it.agent, lot: it.lot, name: it.name, mime: it.mime, data: await toBase64(it.buf ? new Blob([it.buf]) : it.blob) });
          const lot = run && run.date === it.date && lotOf(it.lot);
          if (lot) {
            lot.sent++;
            // the Drive file id is the proof this photo arrived
            const photo = (lot.photos || []).find(ph => ph.name === it.name);
            if (photo) photo.id = up.id;
            saveRun(); renderRoute(); renderLot();
          }
        } else {
          await api('note', { community: it.community, date: it.date, agent: it.agent, lot: it.lot, stage: it.stage, note: it.note });
        }
        await queueDel(it.id);
        fails = 0;
      } catch (e) {
        fails++;
        setStatus('Send failed, retrying: ' + e.message, 'err');
        await sleep(Math.min(60000, 4000 * fails));
      }
    }
  } finally {
    pumping = false;
    keepAwake(false);
  }
}
window.addEventListener('online', pump);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });

// ---------- tabs ----------

function show(tab) {
  ['run', 'lot', 'map', 'settings'].forEach(v => $('#view-' + v).classList.toggle('hide', v !== tab));
  document.querySelectorAll('nav .tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === (tab === 'lot' ? 'run' : tab)));
  if (tab === 'map') renderMap(true);
  if (tab === 'settings') renderSettings();
  if (tab !== 'lot') currentLot = null;
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav .tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

// ---------- run: start ----------

function renderRun() {
  const phase = run ? run.phase : 'start';
  $('#run-start').classList.toggle('hide', phase !== 'start');
  $('#run-review').classList.toggle('hide', phase !== 'review');
  $('#run-route').classList.toggle('hide', phase !== 'route');
  $('#headsub').textContent = COMMUNITY + (run ? ' · ' + run.date : '');
  if (phase === 'start') $('#run-date').value = $('#run-date').value || today();
  if (phase === 'review') renderReview();
  if (phase === 'route') renderRoute();
}

function newRun(lots, warnings) {
  run = { community: COMMUNITY, date: $('#run-date').value || today(), phase: 'review', lots: lots, order: [], warnings: warnings || [] };
  saveRun();
  renderRun();
}

const blankLot = (lot, agent) => ({ lot: lot, agent: agent || '', flag: '', stage: '', extra: '', count: 0, sent: 0, done: false });

$('#btn-manual').addEventListener('click', () => newRun([]));

$('#btn-read').addEventListener('click', async () => {
  const file = $('#map-file').files[0];
  const msg = $('#read-msg');
  if (!file) { msg.textContent = 'Choose the map PDF first.'; return; }
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { msg.textContent = 'The map has to be the PDF the agents send. For a screenshot, add the lots by hand.'; return; }
  $('#btn-read').disabled = true;
  try {
    const out = await MapRead.readMap(file, master, agents, text => { msg.textContent = text; });
    // the legend on the map is the authority on each agent's star colour
    out.legend.forEach(e => {
      const a = agents.find(g => g.name.toLowerCase() === e.name.toLowerCase());
      if (a) a.color = e.color;
    });
    store.set('agents', agents);
    const lots = out.lots.map(r => Object.assign(blankLot(r.lot, r.agent), { flag: r.flag, thumb: r.thumb, star: r.color }));
    msg.textContent = '';
    if (!lots.length) out.warnings.push('No stars were found on this map.');
    newRun(lots, out.warnings);
  } catch (e) {
    msg.textContent = 'Could not read the map: ' + e.message;
  }
  $('#btn-read').disabled = false;
});

// ---------- run: review ----------

function problems(l, i) {
  const out = [];
  if (!master.lots[l.lot]) out.push('Not a lot on the master map');
  if (run.lots.findIndex(o => o.lot === l.lot) !== i) out.push('Listed twice');
  if (!l.agent) out.push('Pick an agent');
  return out;
}

function renderReview() {
  const bad = run.lots.filter((l, i) => problems(l, i).length || l.flag).length;
  $('#review-sum').textContent = run.lots.length + ' lots: ' + agents.map(a => a.name + ' ' + run.lots.filter(l => l.agent === a.name).length).join(', ') + '. ' +
    (bad ? bad + ' need a look, shown first.' : 'Every lot number is on the master map.');
  $('#review-warn').innerHTML = (run.warnings || []).map(w => `<div class="card flag">${esc(w)}</div>`).join('');
  const rows = run.lots.map((l, i) => ({ l, i, p: problems(l, i) }));
  rows.sort((a, b) => ((b.p.length || b.l.flag ? 1 : 0) - (a.p.length || a.l.flag ? 1 : 0)) || (a.l.lot - b.l.lot));
  $('#review-list').innerHTML = rows.map(({ l, i, p }) => `
    <div class="card">
      <div class="row">
        ${l.thumb ? `<img class="thumb" src="${l.thumb}" alt="Star on the agents' map">` : ''}
        <div class="grow">
          <div class="row">
            <span class="dot" style="background:${esc(l.star || agentColor(l.agent))}"></span>
            <input type="number" inputmode="numeric" style="width:96px" data-i="${i}" data-f="lot" value="${l.lot || ''}">
          </div>
          <select data-i="${i}" data-f="agent" style="margin-top:6px">
            <option value="">Agent?</option>
            ${agents.map(a => `<option ${a.name === l.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <button class="small" data-i="${i}" data-f="del">Remove</button>
      </div>
      ${p.concat(l.flag ? [l.flag] : []).map(t => `<div class="flag">${esc(t)}</div>`).join('')}
      ${l.flag ? `<button class="small" data-i="${i}" data-f="ok" style="margin-top:6px">Looks right</button>` : ''}
    </div>`).join('');
}

$('#review-list').addEventListener('change', e => {
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (i == null) return;
  if (f === 'lot') run.lots[i].lot = Number(e.target.value);
  if (f === 'agent') run.lots[i].agent = e.target.value;
  saveRun();
  renderReview();
});
$('#review-list').addEventListener('click', e => {
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (f === 'del') run.lots.splice(i, 1);
  else if (f === 'ok') run.lots[i].flag = '';
  else return;
  saveRun();
  renderReview();
});
$('#btn-add').addEventListener('click', () => {
  run.lots.unshift(blankLot(0, ''));
  saveRun();
  renderReview();
});
$('#btn-discard').addEventListener('click', () => {
  if (!confirm('Throw away this lot list?')) return;
  run = null;
  saveRun();
  renderRun();
});

// ---------- where am I ----------

let pos = null;          // latest GPS fix
let heading = null;      // degrees clockwise from north the top of the phone points
let watchId = null;

/** GPS fix as a point in map pixels, or null when unknown or far outside the community. */
function myMapPoint() {
  if (!pos || !master.geo) return null;
  const g = master.geo;
  const p = [(pos.longitude - g.lon0) / g.dLon, (pos.latitude - g.lat0) / g.dLat];
  const pad = 600;
  return p[0] > -pad && p[1] > -pad && p[0] < master.image.w + pad && p[1] < master.image.h + pad ? p : null;
}

function startGps() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    p => { pos = p.coords; renderFind(); },
    () => { if (!pos) $('#find-dist').textContent = 'Location is off'; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;   // iPhone
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;                    // Android
  if (h == null) return;
  heading = h;
  renderFind();
}

$('#btn-compass').addEventListener('click', async () => {
  try {
    // iPhone only hands out compass readings after a tap on a button
    if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') { alert('Compass access was not allowed.'); return; }
    }
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    $('#btn-compass').classList.add('hide');
  } catch (e) {
    alert('This phone would not share its compass: ' + e.message);
  }
});

// ---------- route ----------

async function planRoute(fromHere) {
  const todo = run.lots.filter(l => !l.done).map(l => l.lot);
  const done = run.order.filter(n => lotOf(n) && lotOf(n).done);
  run.lots.filter(l => l.done && done.indexOf(l.lot) < 0).forEach(l => done.push(l.lot));
  const start = (fromHere && myMapPoint()) || START;
  const plan = await Route.plan(todo.map(n => master.lots[n]), start, master.grid.cell);
  run.order = done.concat(plan.order.map(i => todo[i]));
  run.paths = run.paths || {};   // lot -> road path that leads to it
  plan.order.forEach((i, k) => { run.paths[todo[i]] = plan.paths[k]; });
  run.phase = 'route';
  saveRun();
  renderRun();
}

$('#btn-route').addEventListener('click', async () => {
  if (!run.lots.length) { alert('Add at least one lot.'); return; }
  if (run.lots.some((l, i) => problems(l, i).length)) { alert('Fix the lots marked in red first.'); return; }
  $('#btn-route').disabled = true;
  $('#btn-route').textContent = 'Planning the route...';
  await sleep(30);
  try { await planRoute(false); } catch (e) { alert('Could not plan the route: ' + e.message); }
  $('#btn-route').disabled = false;
  $('#btn-route').textContent = 'Build my route';
  startGps();
});
$('#btn-reroute').addEventListener('click', async () => {
  if (!myMapPoint()) { alert('I need your location inside Verdana Village to re-plan from where you are.'); startGps(); return; }
  await planRoute(true);
});
$('#btn-edit').addEventListener('click', () => { run.phase = 'review'; saveRun(); renderRun(); });
$('#btn-go').addEventListener('click', () => { const n = nextLot(); if (n) openLot(n); });

const nextLot = () => run.order.find(n => !lotOf(n).done);

function renderRoute() {
  if (!run || run.phase !== 'route') return;
  const done = run.lots.filter(l => l.done).length;
  const next = nextLot();
  $('#route-title').textContent = done + ' of ' + run.lots.length + ' lots done';
  $('#route-sum').textContent = agents.map(a => a.name + ' ' + run.lots.filter(l => l.agent === a.name).length).join(' · ');
  $('#btn-go').classList.toggle('hide', !next);
  if (next) $('#btn-go').textContent = 'Go to next lot: ' + next;
  $('#route-list').innerHTML = run.order.map((n, i) => {
    const l = lotOf(n);
    return `<div class="card lot-row ${l.done ? 'done' : ''} ${n === next ? 'next' : ''}" data-lot="${n}">
      <span class="order">${i + 1}</span>
      <span class="dot" style="background:${esc(agentColor(l.agent))}"></span>
      <span class="num">${n}</span>
      <span class="grow muted">${esc(l.agent)}${l.count ? ' · ' + l.sent + '/' + l.count + ' sent' : ''}</span>
      <span>${l.done ? '✓' : n === next ? 'Next' : ''}</span>
    </div>`;
  }).join('');
}
$('#route-list').addEventListener('click', e => {
  const row = e.target.closest('[data-lot]');
  if (row) openLot(Number(row.dataset.lot));
});

const notifyAgents = () => api('notify', { community: run.community, date: run.date, portal: new URL('agent.html', location.href).href, backend: settings.url });

$('#btn-notify').addEventListener('click', async () => {
  const waiting = (await queueAll()).length;
  if (waiting && !confirm(waiting + ' items are still sending. Email the agents anyway?')) return;
  if (!waiting && !confirm('Email each agent the link to their photos now?')) return;
  try {
    const out = await notifyAgents();
    run.notified = true;
    saveRun();
    alert('Emailed: ' + (out.sent.join(', ') || 'nobody') + (out.skipped.length ? '\nSkipped: ' + out.skipped.join(', ') : ''));
  } catch (e) {
    alert(e.message);
  }
});
$('#btn-new').addEventListener('click', async () => {
  const waiting = (await queueAll()).length;
  if (!confirm(waiting ? waiting + ' items are still sending and will keep going. Start a new run?' : 'Close this run and start a new one?')) return;
  run = null;
  saveRun();
  renderRun();
});

// ---------- one lot: find it ----------

const MINI_ZOOM = 1.5;  // closest view, screen pixels per map pixel
const MINI_WIDE = 0.25; // widest view
const HERE_M = 30;      // a lot label this close to you counts as the lot you are on

/** Lot whose label is nearest a map point, if it is close enough to be "this lot". */
function lotAt(pt) {
  let best = null, bd = HERE_M / master.geo.mPerPx;
  for (const n in master.lots) {
    const d = Math.hypot(master.lots[n][0] - pt[0], master.lots[n][1] - pt[1]);
    if (d < bd) { bd = d; best = Number(n); }
  }
  return best;
}

let drive = { lot: null, from: null, pts: null }; // road path from where you are to the lot

/** Keep the driving line fresh: recompute when the lot changes or you have moved about 25 m. */
function refreshDrive(me) {
  const moved = !drive.from || Math.hypot(me[0] - drive.from[0], me[1] - drive.from[1]) * master.geo.mPerPx > 25;
  if (drive.lot === currentLot && !moved) return;
  const lot = currentLot;
  drive = { lot: lot, from: me, pts: drive.lot === lot ? drive.pts : null };
  Route.path(me, master.lots[lot], master.grid.cell).then(pts => {
    if (drive.lot !== lot) return;
    drive.pts = pts;
    renderFind();
  });
}

function renderFind() {
  if (currentLot == null || lotStep !== 'find' || !master.lots[currentLot]) return;
  const [x, y] = master.lots[currentLot];
  const mini = $('#mini');
  const w = mini.clientWidth, h = mini.clientHeight;
  const me = myMapPoint();
  const dx = me ? x - me[0] : 0, dy = me ? y - me[1] : 0;

  // live map: zoomed so you and the lot are both in view, closing in as you get nearer
  const z = me ? Math.max(MINI_WIDE, Math.min(MINI_ZOOM, (Math.min(w, h) - 90) / Math.max(Math.abs(dx), Math.abs(dy), 1))) : MINI_ZOOM;
  const cx = me ? (x + me[0]) / 2 : x, cy = me ? (y + me[1]) / 2 : y;
  const place = (el, pt) => { el.style.left = (w / 2 + (pt[0] - cx) * z) + 'px'; el.style.top = (h / 2 + (pt[1] - cy) * z) + 'px'; };
  mini.style.backgroundSize = (master.image.w * z) + 'px ' + (master.image.h * z) + 'px';
  mini.style.backgroundPosition = (w / 2 - cx * z) + 'px ' + (h / 2 - cy * z) + 'px';
  place($('#mini-target'), [x, y]);

  const dot = $('#mini-me'), here = $('#mini-here');
  const near = [currentLot - 1, currentLot + 1].filter(n => master.lots[n]);
  let hint = near.length ? 'Lot ' + currentLot + ' is next to ' + near.join(' and ') + '.' : '';
  $('#arrow').style.transform = 'rotate(' + (me ? Math.atan2(dx, -dy) * 180 / Math.PI - (heading || 0) : 0) + 'deg)';
  $('#arrow').style.opacity = me ? 1 : 0.25;
  dot.classList.toggle('hide', !me);
  // driving line in screen pixels
  let line = '';
  if (me) {
    refreshDrive(me);
    if (drive.lot === currentLot && drive.pts) {
      const scr = [];
      for (let i = 0; i < drive.pts.length; i += 2) scr.push((w / 2 + (drive.pts[i] - cx) * z).toFixed(1), (h / 2 + (drive.pts[i + 1] - cy) * z).toFixed(1));
      line = polyline(scr, '#fff', 7) + polyline(scr, '#1a73e8', 4);
    }
  }
  $('#mini-path').innerHTML = line;
  if (!me) {
    here.classList.add('hide');
    $('#find-dist').textContent = pos ? 'You are not at Verdana Village' : 'Finding you...';
    $('#find-hint').textContent = hint + (pos ? ' The live map and compass start once you are in the community.' : '');
    return;
  }
  place(dot, me);
  dot.classList.toggle('facing', heading != null);
  dot.style.transform = 'rotate(' + (heading || 0) + 'deg)';
  const standing = lotAt(me);
  here.classList.toggle('hide', standing == null || standing === currentLot);
  if (standing != null) place(here, master.lots[standing]);
  const metres = Math.hypot(dx, dy) * master.geo.mPerPx;
  $('#find-dist').textContent = standing === currentLot || metres < ARRIVED_M ? 'You are at lot ' + currentLot : Math.round(metres * 3.281 / 10) * 10 + ' ft away';
  if (standing != null && standing !== currentLot) hint = 'You are at lot ' + standing + '. ' + hint;
  if (heading == null) hint += ' Turn on the compass to see which way you are facing.';
  $('#find-hint').textContent = hint;
}

// ---------- one lot: shoot it ----------

function stageNote(l) {
  const stage = STAGES.find(s => s.id === l.stage);
  const prev = history[l.lot] && history[l.lot].date !== run.date ? history[l.lot] : null;
  const parts = [];
  if (stage) {
    parts.push(stage.text);
    if (prev && prev.stage === stage.id) parts.push('This is the same stage as the last update, with work continuing.');
  }
  if (l.extra.trim()) parts.push(l.extra.trim());
  return parts.join(' ');
}

function openLot(n, step) {
  currentLot = n;
  const l = lotOf(n);
  lotStep = step || (l.count || l.done ? 'shoot' : 'find');
  if (!l.stage && history[n]) l.stage = history[n].stage; // start from the last visit's stage
  $('#lot-extra').value = l.extra;
  show('lot');
  currentLot = n; // show() clears it for other tabs
  renderLot();
  startGps();
}

function renderLot() {
  if (currentLot == null || !run) return;
  const l = lotOf(currentLot);
  if (!l) return;
  $('#lot-band').style.background = agentColor(l.agent);
  $('#lot-agent').textContent = l.agent;
  $('#lot-num').textContent = l.lot;
  $('#lot-count').innerHTML = `<b>${l.count}</b> photos<br>${l.sent} sent`;
  $('#lot-find').classList.toggle('hide', lotStep !== 'find');
  $('#lot-shoot').classList.toggle('hide', lotStep !== 'shoot');
  if (lotStep === 'find') { renderFind(); return; }
  // a submitted lot keeps its note in sync if you change it, but the button says it is already in
  $('#btn-done').textContent = (l.done ? 'Already submitted ✓ ' : 'Submit ') + (run.order.some(n => n !== l.lot && !lotOf(n).done) ? '→ next lot' : '→ back to route');
  $('#btn-done').className = l.done ? '' : 'good';
  const photos = l.photos || [];
  $('#lot-photos-sum').textContent = !l.count ? 'No photos yet.'
    : l.sent === l.count ? 'All ' + l.count + ' photos are in Google Drive.'
    : l.count + ' photos saved in the app. ' + l.sent + ' of ' + l.count + ' delivered to Google Drive so far.';
  $('#lot-photos-sum').className = l.count && l.sent === l.count ? 'ok' : 'muted';
  $('#lot-photos').innerHTML = photos.map(ph => `
    <${ph.id ? `a href="https://drive.google.com/file/d/${esc(ph.id)}/view" target="_blank" rel="noopener"` : 'span'} class="shot ${ph.id ? 'sent' : ''}">
      ${ph.thumb ? `<img src="${ph.thumb}" alt="${esc(ph.name)}">` : ''}<b>${ph.id ? '✓' : '…'}</b>
    </${ph.id ? 'a' : 'span'}>`).join('');
  $('#stage-chips').innerHTML = STAGES.map(s => `<button data-stage="${s.id}" class="${s.id === l.stage ? 'on' : ''}">${esc(s.label)}</button>`).join('');
  $('#lot-preview').textContent = stageNote(l) || 'Pick a stage and the customer note is written for you.';
}

/** Small preview of a photo, from a canvas or an image file. */
async function makeThumb(source) {
  try {
    const img = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
    const size = 96, side = Math.min(img.width, img.height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.5);
  } catch (e) {
    return '';
  }
}

/** Queue one photo for upload. The file goes up untouched. */
async function queuePhoto(blob, ext, thumbSource) {
  const l = lotOf(currentLot);
  l.seq = Math.max(l.seq || 0, l.count) + 1; // never reuse a file name, even after a lost photo
  const name = 'Lot ' + l.lot + ' - ' + run.date + ' - ' + String(l.seq).padStart(2, '0') + '.' + ext;
  // stored as raw bytes: iPhone can refuse to store photo objects themselves
  const buf = await new Response(blob).arrayBuffer();
  await queuePut({ id: run.date + '/' + l.lot + '/' + l.seq, type: 'photo', t: Date.now() + l.seq / 1000, community: run.community, date: run.date, agent: l.agent, lot: l.lot, name: name, mime: blob.type || 'image/jpeg', buf: buf });
  l.count++;
  (l.photos = l.photos || []).push({ name: name, thumb: await makeThumb(thumbSource || blob), id: '' });
  saveRun();
}

$('#lib').addEventListener('change', async e => {
  for (const file of Array.from(e.target.files)) await queuePhoto(file, (file.name.split('.').pop() || 'jpg').toLowerCase());
  e.target.value = '';
  renderLot();
  pump();
});

$('#btn-here').addEventListener('click', () => { lotStep = 'shoot'; renderLot(); openCamera(); });
$('#btn-skip-find').addEventListener('click', () => { lotStep = 'shoot'; renderLot(); });
$('#btn-refind').addEventListener('click', () => { lotStep = 'find'; renderLot(); });
$('#btn-cam').addEventListener('click', openCamera);

$('#stage-chips').addEventListener('click', e => {
  if (!e.target.dataset.stage) return;
  const l = lotOf(currentLot);
  l.stage = l.stage === e.target.dataset.stage ? '' : e.target.dataset.stage;
  saveRun();
  renderLot();
});
$('#lot-extra').addEventListener('input', e => {
  lotOf(currentLot).extra = e.target.value;
  saveRun();
  $('#lot-preview').textContent = stageNote(lotOf(currentLot)) || 'Pick a stage and the customer note is written for you.';
});
$('#btn-back').addEventListener('click', () => { renderRoute(); show('run'); });

$('#btn-done').addEventListener('click', async () => {
  const l = lotOf(currentLot);
  if (!l.done && !l.count && !confirm('No photos on this lot yet. Mark it done anyway?')) return;
  l.done = true;
  await queuePut({ id: run.date + '/' + l.lot + '/note', type: 'note', t: Date.now(), community: run.community, date: run.date, agent: l.agent, lot: l.lot, stage: (STAGES.find(s => s.id === l.stage) || {}).label || '', note: stageNote(l) });
  if (l.stage) { history[l.lot] = { date: run.date, stage: l.stage }; store.set('history', history); }
  saveRun();
  pump();
  const next = nextLot();
  if (next) openLot(next, 'find');
  else { renderRoute(); show('run'); }
});

// ---------- rapid camera ----------

let stream = null;
const video = $('#cam-video');

async function openCamera() {
  $('#camera').classList.remove('hide');
  $('#cam-count').textContent = lotOf(currentLot).count + ' saved';
  $('#cam-top').textContent = 'Lot ' + currentLot + ' · starting camera...';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } } });
    video.srcObject = stream;
    video.play().catch(() => {});
    if (!video.videoWidth) await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
    await sharpen(stream.getVideoTracks()[0]);
    showCamSize();
  } catch (e) {
    closeCamera();
    alert('The camera would not start (' + e.message + '). Use "Add from library" instead.');
  }
}

/** Push the camera to the largest picture size it offers. */
async function sharpen(track) {
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.width || !caps.height) return;
    const before = video.videoWidth * video.videoHeight;
    await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } });
    // give the new size a moment to reach the preview
    for (let i = 0; i < 10 && video.videoWidth * video.videoHeight === before; i++) await sleep(100);
  } catch (e) { /* the camera keeps the size it started with */ }
}

function showCamSize() {
  const mp = (video.videoWidth * video.videoHeight / 1e6).toFixed(1);
  $('#cam-top').textContent = 'Lot ' + currentLot + ' · ' + video.videoWidth + ' × ' + video.videoHeight + ' (' + mp + ' MP)';
}
video.addEventListener('resize', () => { if (stream) showCamSize(); });

function closeCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $('#camera').classList.add('hide');
  renderLot();
  pump();
}

$('#cam-shutter').addEventListener('click', async () => {
  if (!video.videoWidth) return;
  // grab the frame first so the photo is the moment of the tap
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const flash = $('#cam-flash');
  flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  let blob = null;
  // phones that offer a true still-photo capture (not iPhone, today) use it for full sensor quality
  if (window.ImageCapture && stream) {
    try { blob = await new ImageCapture(stream.getVideoTracks()[0]).takePhoto(); } catch (err) { blob = null; }
  }
  if (!blob) blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.97));
  await queuePhoto(blob, 'jpg', c);
  $('#cam-count').textContent = lotOf(currentLot).count + ' saved';
});
$('#cam-close').addEventListener('click', closeCamera);

// ---------- map ----------

const ZOOM_MAX = 24;
const polyline = (flat, color, width) => `<polyline points="${flat.join(' ')}" stroke="${color}" stroke-width="${width}"/>`;

/** Resize the map keeping the given screen point (relative to the map box) still. Pins keep their size. */
function setZoom(z, fx, fy) {
  const inner = $('#mapinner'), wrap = $('#mapwrap');
  z = Math.max(1, Math.min(ZOOM_MAX, z));
  const k = z / zoom;
  if (fx == null) { fx = wrap.clientWidth / 2; fy = wrap.clientHeight / 2; }
  const sx = (wrap.scrollLeft + fx) * k - fx, sy = (wrap.scrollTop + fy) * k - fy;
  zoom = z;
  inner.style.width = Math.round(wrap.clientWidth * zoom) + 'px';
  // zoomed out, stops are plain dots; zoomed in, small numbered pins that stay the same size as the map grows
  inner.classList.toggle('far', zoom < 2.5);
  inner.style.setProperty('--pin', zoom < 2.5 ? '6px' : '11px');
  wrap.scrollLeft = sx;
  wrap.scrollTop = sy;
}

function centerOn(lot) {
  if (!master.lots[lot]) return;
  const inner = $('#mapinner'), wrap = $('#mapwrap');
  const [x, y] = master.lots[lot];
  const w = inner.clientWidth, h = w * master.image.h / master.image.w;
  wrap.scrollLeft = x / master.image.w * w - wrap.clientWidth / 2;
  wrap.scrollTop = y / master.image.h * h - wrap.clientHeight / 2;
}

function renderMap(center) {
  const inner = $('#mapinner');
  const next = run && run.phase === 'route' ? nextLot() : null;
  const pins = !run ? '' : run.lots.filter(l => master.lots[l.lot]).map(l => {
    const [x, y] = master.lots[l.lot];
    const order = run.order.indexOf(l.lot) + 1;
    return `<div class="pin ${l.done ? 'done' : ''} ${l.lot === next ? 'next' : ''}" data-lot="${l.lot}"
      style="left:${(x / master.image.w * 100).toFixed(2)}%;top:${(y / master.image.h * 100).toFixed(2)}%;background:${esc(agentColor(l.agent))}">${order || ''}</div>`;
  }).join('');
  const me = myMapPoint();
  const meDot = me ? `<div class="me" style="left:${(me[0] / master.image.w * 100).toFixed(2)}%;top:${(me[1] / master.image.h * 100).toFixed(2)}%"></div>` : '';
  // the drive along the roads: grey where you have been, blue for what is left
  let line = '';
  if (run && run.phase === 'route' && run.paths) {
    const legs = run.order.filter(n => run.paths[n]);
    const draw = (done, color) => legs.filter(n => lotOf(n).done === done).map(n => polyline(run.paths[n], '#fff', 5) + polyline(run.paths[n], color, 3)).join('');
    line = `<svg class="routeline" viewBox="0 0 ${master.image.w} ${master.image.h}" preserveAspectRatio="none">${draw(true, '#7b8794')}${draw(false, '#1a73e8')}</svg>`;
  }
  inner.innerHTML = '<img src="map.jpg" alt="Verdana Village site map">' + line + pins + meDot;
  setZoom(zoom);
  if (center) centerOn(next || (run && run.lots[0] && run.lots[0].lot));
}
$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.6));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.6));
$('#zoom-next').addEventListener('click', () => { setZoom(Math.max(zoom, 6)); centerOn(nextLot()); });
$('#mapinner').addEventListener('click', e => {
  if (e.target.dataset.lot && run.phase === 'route') openLot(Number(e.target.dataset.lot));
});

// pinch to zoom the map itself (not the page), so pins and the route line stay thin
(function () {
  const wrap = $('#mapwrap');
  let startDist = 0, startZoom = 1;
  const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  wrap.addEventListener('touchstart', e => { if (e.touches.length === 2) { startDist = spread(e.touches); startZoom = zoom; } }, { passive: true });
  wrap.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();
    const box = wrap.getBoundingClientRect();
    setZoom(startZoom * spread(e.touches) / startDist, (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left, (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top);
  }, { passive: false });
  wrap.addEventListener('touchend', e => { if (e.touches.length < 2) startDist = 0; });
  // iPhone would otherwise zoom the whole page
  ['gesturestart', 'gesturechange'].forEach(ev => wrap.addEventListener(ev, e => e.preventDefault()));
})();

// ---------- settings ----------

function renderSettings() {
  $('#set-url').value = settings.url;
  $('#set-token').value = settings.token;
  $('#set-expire').value = settings.expireDays;
  $('#agent-list').innerHTML = agents.map((a, i) => `
    <div class="card">
      <div class="row">
        <input type="color" data-i="${i}" data-f="color" value="${esc(a.color)}" style="width:48px;height:44px;padding:2px">
        <input type="text" class="grow" data-i="${i}" data-f="name" value="${esc(a.name)}" placeholder="Name as it appears on the map legend">
        <button class="small" data-i="${i}" data-f="del">Remove</button>
      </div>
      <input type="email" data-i="${i}" data-f="email" value="${esc(a.email)}" placeholder="Email address" style="margin-top:8px">
    </div>`).join('');
  $('#portal-links').innerHTML = agents.filter(a => a.key).length ? '<h2>Agent links</h2><p class="muted">Each link shows only that agent\'s lots. It stays the same every run, so they can bookmark it.</p>' +
    agents.filter(a => a.key).map(a => `<div class="card row"><span class="grow"><b>${esc(a.name)}</b></span><button class="small" data-link="${esc(portalLink(a))}">Copy link</button></div>`).join('') : '';
}
const portalLink = a => new URL('agent.html', location.href).href + '?u=' + encodeURIComponent(settings.url) + '&k=' + a.key;

$('#agent-list').addEventListener('change', e => {
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (i != null && f !== 'del') agents[i][f] = e.target.value.trim();
});
$('#agent-list').addEventListener('click', e => {
  if (e.target.dataset.f !== 'del') return;
  agents.splice(e.target.dataset.i, 1);
  renderSettings();
});
$('#btn-add-agent').addEventListener('click', () => { agents.push({ name: '', color: '#47d45a', email: '' }); renderSettings(); });
$('#portal-links').addEventListener('click', async e => {
  if (!e.target.dataset.link) return;
  await navigator.clipboard.writeText(e.target.dataset.link);
  e.target.textContent = 'Copied';
});

$('#btn-save').addEventListener('click', async () => {
  settings = { url: $('#set-url').value.trim(), token: $('#set-token').value.trim(), expireDays: Number($('#set-expire').value) || 11 };
  store.set('settings', settings);
  store.set('agents', agents);
  const msg = $('#set-msg');
  msg.textContent = 'Connecting...';
  try {
    const out = await api('saveAgents', { agents: agents, expireDays: settings.expireDays });
    agents = out.agents;
    store.set('agents', agents);
    msg.textContent = 'Connected.';
    setStatus('Connected.');
    renderSettings();
    pump();
  } catch (e) {
    msg.textContent = 'Could not connect: ' + e.message;
  }
});

// ---------- start ----------

fetch('lots.json').then(r => r.json()).then(async m => {
  master = m;
  await reconcile();
  renderRun();
  if (settings.url) { setStatus('Connected.'); pump(); }
  else show('settings');
  if (run && run.phase === 'route') startGps();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
