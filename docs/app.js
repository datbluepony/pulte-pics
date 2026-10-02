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
  { name: 'Justin', color: '#29a9e1', email: '' },
  { name: 'Gita', color: '#f3b6e6', email: '' },
  { name: 'Derek', color: '#f5e400', email: '' },
]);
let run = store.get('run', null);          // current photo run
let history = store.get('history', {});    // lot -> { date, stage } from the last visit
let master = { lots: {}, image: { w: 1, h: 1 } };
let currentLot = null;
let zoom = 1;

const saveRun = () => store.set('run', run);
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
const queuePut = item => tx('readwrite', s => s.put(item));
const queueDel = id => tx('readwrite', s => s.delete(id));
const queueAll = async () => (await tx('readonly', s => s.getAll())).sort((a, b) => a.t - b.t);

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
      if (!items.length) { setStatus(run ? 'Everything is sent.' : 'Connected.'); break; }
      if (!navigator.onLine) { setStatus('Offline. ' + photos + ' photos waiting.', 'err'); break; }
      keepAwake(true);
      const it = items[0];
      setStatus('Sending lot ' + it.lot + '. ' + photos + ' photos left. Keep this screen open.', 'busy');
      try {
        if (it.type === 'photo') {
          await api('upload', { community: it.community, date: it.date, agent: it.agent, lot: it.lot, name: it.name, mime: it.mime, data: await toBase64(it.blob) });
          const lot = run && run.date === it.date && lotOf(it.lot);
          if (lot) { lot.sent++; saveRun(); renderRoute(); renderLot(); }
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

function newRun(lots) {
  run = { community: COMMUNITY, date: $('#run-date').value || today(), phase: 'review', lots: lots, order: [] };
  saveRun();
  renderRun();
}

const blankLot = (lot, agent) => ({ lot: lot, agent: agent || '', flag: '', stage: '', extra: '', count: 0, sent: 0, done: false });

$('#btn-manual').addEventListener('click', () => newRun([]));

$('#btn-read').addEventListener('click', async () => {
  const files = Array.from($('#map-file').files);
  const msg = $('#read-msg');
  if (!files.length) { msg.textContent = 'Choose the map file first.'; return; }
  $('#btn-read').disabled = true;
  msg.textContent = 'Reading the stars. This takes about a minute.';
  try {
    const payload = [];
    for (const f of files) payload.push({ mime: f.type || 'application/pdf', data: await toBase64(f) });
    const out = await api('parseMap', { files: payload, agents: agents.map(a => a.name), maxLot: Object.keys(master.lots).length });
    const seen = {};
    const lots = [];
    out.lots.forEach(r => {
      if (seen[r.lot]) return;
      seen[r.lot] = true;
      const l = blankLot(r.lot, agents.some(a => a.name === r.agent) ? r.agent : '');
      const why = [];
      if (!l.agent) why.push((r.starColor || 'Unknown') + ' star has no agent');
      if (!r.confident) why.push((r.note || 'Not certain') + (r.alternates.length ? ' (could be ' + r.alternates.join(' or ') + ')' : ''));
      l.flag = why.join('. ');
      lots.push(l);
    });
    msg.textContent = '';
    newRun(lots);
  } catch (e) {
    msg.textContent = e.message;
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
  $('#review-sum').textContent = run.lots.length + ' lots. ' + (bad ? bad + ' need a look, shown first.' : 'All clear.');
  const rows = run.lots.map((l, i) => ({ l, i, p: problems(l, i) }));
  rows.sort((a, b) => ((b.p.length || b.l.flag ? 1 : 0) - (a.p.length || a.l.flag ? 1 : 0)) || (a.l.lot - b.l.lot));
  $('#review-list').innerHTML = rows.map(({ l, i, p }) => `
    <div class="card">
      <div class="row">
        <span class="dot" style="background:${esc(agentColor(l.agent))}"></span>
        <input type="number" inputmode="numeric" style="width:96px" data-i="${i}" data-f="lot" value="${l.lot || ''}">
        <select class="grow" data-i="${i}" data-f="agent">
          <option value="">Agent?</option>
          ${agents.map(a => `<option ${a.name === l.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
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

// ---------- route ----------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Nearest-neighbour path from the main entry, then 2-opt to remove doubling back. */
function computeRoute(nums) {
  const at = n => n == null ? START : master.lots[n];
  const left = nums.slice();
  const path = [null];
  while (left.length) {
    const here = at(path[path.length - 1]);
    let best = 0;
    left.forEach((n, i) => { if (dist(here, at(n)) < dist(here, at(left[best]))) best = i; });
    path.push(left.splice(best, 1)[0]);
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const a = at(path[i - 1]), b = at(path[i]), c = at(path[j]), d = path[j + 1] == null ? null : at(path[j + 1]);
        const delta = dist(a, c) + (d ? dist(b, d) : 0) - dist(a, b) - (d ? dist(c, d) : 0);
        if (delta < -0.01) {
          path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path.slice(1);
}

$('#btn-route').addEventListener('click', () => {
  if (!run.lots.length) { alert('Add at least one lot.'); return; }
  if (run.lots.some((l, i) => problems(l, i).length)) { alert('Fix the lots marked in red first.'); return; }
  const done = run.lots.filter(l => l.done).map(l => l.lot);
  run.order = done.concat(computeRoute(run.lots.filter(l => !l.done).map(l => l.lot)));
  run.phase = 'route';
  saveRun();
  renderRun();
});
$('#btn-edit').addEventListener('click', () => { run.phase = 'review'; saveRun(); renderRun(); });

const nextLot = () => run.order.find(n => !lotOf(n).done);

function renderRoute() {
  if (!run || run.phase !== 'route') return;
  const done = run.lots.filter(l => l.done).length;
  const next = nextLot();
  $('#route-title').textContent = done + ' of ' + run.lots.length + ' lots done';
  $('#route-sum').textContent = agents.map(a => a.name + ' ' + run.lots.filter(l => l.agent === a.name).length).join(' · ');
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

$('#btn-notify').addEventListener('click', async () => {
  const waiting = (await queueAll()).length;
  if (waiting && !confirm(waiting + ' items are still sending. Email the agents anyway?')) return;
  if (!waiting && !confirm('Email each agent the link to their photos now?')) return;
  try {
    const out = await api('notify', { community: run.community, date: run.date, portal: new URL('agent.html', location.href).href, backend: settings.url });
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

// ---------- one lot ----------

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

function openLot(n) {
  currentLot = n;
  const l = lotOf(n);
  if (!l.stage && history[n]) l.stage = history[n].stage; // start from the last visit's stage
  $('#lot-extra').value = l.extra;
  renderLot();
  show('lot');
}

function renderLot() {
  if (currentLot == null || !run) return;
  const l = lotOf(currentLot);
  if (!l) return;
  $('#lot-band').style.background = agentColor(l.agent);
  $('#lot-agent').textContent = l.agent;
  $('#lot-num').textContent = l.lot;
  $('#lot-count').innerHTML = `<b>${l.count}</b> photos<br>${l.sent} sent`;
  $('#stage-chips').innerHTML = STAGES.map(s => `<button data-stage="${s.id}" class="${s.id === l.stage ? 'on' : ''}">${esc(s.label)}</button>`).join('');
  $('#lot-preview').textContent = stageNote(l) || 'Pick a stage and the customer note is written for you.';
}

async function addPhotos(input) {
  const l = lotOf(currentLot);
  for (const file of Array.from(input.files)) {
    l.count++;
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const name = 'Lot ' + l.lot + ' - ' + run.date + ' - ' + String(l.count).padStart(2, '0') + '.' + ext;
    // the original file goes up untouched, so the agent gets full resolution
    await queuePut({ id: run.date + '/' + l.lot + '/' + l.count, type: 'photo', t: Date.now() + l.count / 1000, community: run.community, date: run.date, agent: l.agent, lot: l.lot, name: name, mime: file.type || 'image/jpeg', blob: file });
  }
  input.value = '';
  saveRun();
  renderLot();
  pump();
}
$('#cam').addEventListener('change', e => addPhotos(e.target));
$('#lib').addEventListener('change', e => addPhotos(e.target));

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
  if (!l.count && !confirm('No photos on this lot yet. Mark it done anyway?')) return;
  l.done = true;
  await queuePut({ id: run.date + '/' + l.lot + '/note', type: 'note', t: Date.now(), community: run.community, date: run.date, agent: l.agent, lot: l.lot, stage: (STAGES.find(s => s.id === l.stage) || {}).label || '', note: stageNote(l) });
  if (l.stage) { history[l.lot] = { date: run.date, stage: l.stage }; store.set('history', history); }
  saveRun();
  pump();
  const next = nextLot();
  if (next) openLot(next);
  else { renderRoute(); show('run'); }
});

// ---------- map ----------

function renderMap(center) {
  const inner = $('#mapinner');
  const wrap = $('#mapwrap');
  inner.style.width = Math.round(wrap.clientWidth * zoom) + 'px';
  const next = run && run.phase === 'route' ? nextLot() : null;
  const pins = !run ? '' : run.lots.filter(l => master.lots[l.lot]).map(l => {
    const [x, y] = master.lots[l.lot];
    const order = run.order.indexOf(l.lot) + 1;
    return `<div class="pin ${l.done ? 'done' : ''} ${l.lot === next ? 'next' : ''}" data-lot="${l.lot}"
      style="left:${(x / master.image.w * 100).toFixed(2)}%;top:${(y / master.image.h * 100).toFixed(2)}%;background:${esc(agentColor(l.agent))}">${order || ''}</div>`;
  }).join('');
  inner.innerHTML = '<img src="map.jpg" alt="Verdana Village site map">' + pins;
  const focus = next || (run && run.lots[0] && run.lots[0].lot);
  if (center && master.lots[focus]) {
    const [x, y] = master.lots[focus];
    const w = inner.clientWidth, h = w * master.image.h / master.image.w;
    wrap.scrollLeft = x / master.image.w * w - wrap.clientWidth / 2;
    wrap.scrollTop = y / master.image.h * h - wrap.clientHeight / 2;
  }
}
$('#zoom-in').addEventListener('click', () => { zoom = Math.min(12, zoom * 1.6); renderMap(true); });
$('#zoom-out').addEventListener('click', () => { zoom = Math.max(1, zoom / 1.6); renderMap(true); });
$('#zoom-next').addEventListener('click', () => { zoom = Math.max(zoom, 6); renderMap(true); });
$('#mapinner').addEventListener('click', e => {
  if (e.target.dataset.lot && run.phase === 'route') openLot(Number(e.target.dataset.lot));
});

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
$('#btn-add-agent').addEventListener('click', () => { agents.push({ name: '', color: '#3cb371', email: '' }); renderSettings(); });
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
    msg.textContent = 'Connected. ' + (out.mapReader ? 'Map reading is on.' : 'Map reading is off until the Claude API key is added to the Google script.');
    setStatus('Connected.');
    renderSettings();
    pump();
  } catch (e) {
    msg.textContent = 'Could not connect: ' + e.message;
  }
});

// ---------- start ----------

fetch('lots.json').then(r => r.json()).then(m => {
  master = m;
  renderRun();
  if (settings.url) { setStatus('Connected.'); pump(); }
  else show('settings');
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
