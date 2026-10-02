/**
 * Pulte Pic System - Google Apps Script backend.
 *
 * Runs in the photographer's Google account. Stores full-resolution photos in
 * Drive (Pulte Pics / community / date / agent / Lot N), emails agents, and
 * deletes old runs. Uses only free Google services.
 *
 * One-time setup: paste this file into script.google.com, run setup(), then
 * Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 */

const ROOT_NAME = 'Pulte Pics';
const DEFAULT_EXPIRE_DAYS = 13;
const PROPS = PropertiesService.getScriptProperties();

/** Run once from the editor. Authorizes the script, prints the owner token, installs cleanup. */
function setup() {
  if (!PROPS.getProperty('OWNER_TOKEN')) {
    PROPS.setProperty('OWNER_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  if (!PROPS.getProperty('EXPIRE_DAYS')) PROPS.setProperty('EXPIRE_DAYS', String(DEFAULT_EXPIRE_DAYS));
  rootFolder_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanup')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
  MailApp.getRemainingDailyQuota(); // forces the email permission prompt now
  Logger.log('Owner token (paste into the app Settings): ' + PROPS.getProperty('OWNER_TOKEN'));
}

function doGet() {
  return ContentService.createTextOutput('Pulte Pic System backend is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = route_(req);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  if (req.action === 'agentView') return agentView_(req);
  // the team page: anyone holding the team link
  if (['teamView', 'markSent', 'zip'].indexOf(req.action) >= 0) {
    if (!req.key || req.key !== teamKey_()) throw new Error('This link is not valid. Ask your photographer for the current one.');
    if (req.action === 'teamView') return teamView_(req);
    if (req.action === 'markSent') return markSent_(req);
    return zip_(req);
  }
  if (!req.token || req.token !== PROPS.getProperty('OWNER_TOKEN')) throw new Error('Wrong owner token.');
  switch (req.action) {
    case 'ping': return config_();
    case 'saveAgents': return saveAgents_(req);
    case 'plan': return plan_(req);
    case 'wipe': return wipe_();
    case 'upload': return upload_(req);
    case 'note': return note_(req);
    case 'notify': return notify_(req);
    default: throw new Error('Unknown action: ' + req.action);
  }
}

// ---------- config ----------

function agents_() {
  return JSON.parse(PROPS.getProperty('AGENTS') || '[]');
}

/** Key in the one link the whole team shares. */
function teamKey_() {
  let key = PROPS.getProperty('TEAM_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    PROPS.setProperty('TEAM_KEY', key);
  }
  return key;
}

function config_() {
  return {
    version: 4,
    nextRun: PROPS.getProperty('NEXT_RUN') || '',
    teamKey: teamKey_(),
    agents: agents_(),
    expireDays: Number(PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS),
  };
}

function saveAgents_(req) {
  const old = agents_();
  const agents = (req.agents || []).filter(a => a.name).map(a => {
    const prev = old.filter(o => o.name === a.name)[0];
    return {
      name: String(a.name).trim(),
      color: a.color || '#888888',
      email: String(a.email || '').trim(),
      key: prev ? prev.key : Utilities.getUuid().replace(/-/g, ''),
    };
  });
  PROPS.setProperty('AGENTS', JSON.stringify(agents));
  if (req.expireDays) PROPS.setProperty('EXPIRE_DAYS', String(Math.max(1, Number(req.expireDays))));
  if ('nextRun' in req) PROPS.setProperty('NEXT_RUN', String(req.nextRun || ''));
  return config_();
}

// ---------- run plans ----------

/** The lot list of each recent run, from the map: { date: { community, lots: [[lot, agent]], done } }. */
function plans_() {
  try { return JSON.parse(PROPS.getProperty('PLANS') || '{}'); } catch (err) { return {}; }
}

function savePlans_(plans) {
  // keep the five newest runs so the property stays small
  const keep = {};
  Object.keys(plans).sort().slice(-5).forEach(d => { keep[d] = plans[d]; });
  PROPS.setProperty('PLANS', JSON.stringify(keep));
}

/** The photographer built a route: remember every lot in it, so the team page knows the full list before photos exist. */
function plan_(req) {
  const plans = plans_();
  plans[req.date] = {
    community: req.community,
    lots: (req.lots || []).map(l => [String(l.lot), String(l.agent)]),
    done: !!(plans[req.date] && plans[req.date].done),
  };
  savePlans_(plans);
  return {};
}

// ---------- Drive folders ----------

function rootFolder_() {
  const id = PROPS.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* fall through and recreate */ }
  }
  const f = DriveApp.createFolder(ROOT_NAME);
  PROPS.setProperty('ROOT_FOLDER_ID', f.getId());
  return f;
}

function child_(parent, name, create) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) return f;
  }
  return create ? parent.createFolder(name) : null;
}

/** Folder for a lot, created on demand. The agent's date folder is link-shared view-only. */
function lotFolder_(community, date, agent, lot) {
  const cache = CacheService.getScriptCache();
  const key = ['lot', community, date, agent, lot].join('|');
  const hit = cache.get(key);
  if (hit) {
    try {
      const f = DriveApp.getFolderById(hit);
      if (!f.isTrashed()) return f;
    } catch (err) { /* stale cache entry */ }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const dateFolder = child_(child_(rootFolder_(), community, true), date, true);
    let agentFolder = child_(dateFolder, agent, false);
    if (!agentFolder) {
      agentFolder = dateFolder.createFolder(agent);
      agentFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    const folder = child_(agentFolder, 'Lot ' + lot, true);
    cache.put(key, folder.getId(), 21600);
    return folder;
  } finally {
    lock.releaseLock();
  }
}

// ---------- photos ----------

/** Per-lot record kept in the folder description: { stage, note, sent, files: [{ id, name }] }. */
function readMeta_(folder) {
  try { return JSON.parse(folder.getDescription() || '{}') || {}; } catch (err) { return {}; }
}

function indexFile_(folder, id, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const meta = readMeta_(folder);
    meta.files = meta.files || [];
    if (!meta.files.some(f => f.id === id)) meta.files.push({ id: id, name: name });
    folder.setDescription(JSON.stringify(meta));
  } finally {
    lock.releaseLock();
  }
}

/** An existing lot folder, or null. Never creates anything. */
function findLot_(community, date, agent, lot) {
  let f = child_(rootFolder_(), community, false);
  ['' + date, '' + agent, 'Lot ' + lot].forEach(name => { f = f && child_(f, name, false); });
  return f;
}

function upload_(req) {
  const folder = lotFolder_(req.community, req.date, req.agent, req.lot);
  const existing = folder.getFilesByName(req.name);
  if (existing.hasNext()) {
    const id = existing.next().getId();
    indexFile_(folder, id, req.name);
    return { id: id, duplicate: true };
  }
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'image/jpeg', req.name);
  const id = folder.createFile(blob).getId();
  indexFile_(folder, id, req.name);
  return { id: id };
}

function note_(req) {
  const folder = lotFolder_(req.community, req.date, req.agent, req.lot);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const meta = readMeta_(folder);
    meta.stage = req.stage || '';
    meta.note = req.note || '';
    folder.setDescription(JSON.stringify(meta));
  } finally {
    lock.releaseLock();
  }
  return {};
}

function lotInfo_(folder) {
  const meta = readMeta_(folder);
  let files = meta.files;
  if (!files) {
    // lots uploaded before the file index existed: list the folder itself
    files = [];
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (!f.isTrashed() && String(f.getMimeType()).indexOf('image/') === 0) files.push({ id: f.getId(), name: f.getName() });
    }
  }
  files = files.slice().sort((x, y) => x.name < y.name ? -1 : 1);
  return {
    lot: folder.getName().replace(/^Lot\s+/, ''),
    stage: meta.stage || '',
    note: meta.note || '',
    sent: !!meta.sent,
    folderUrl: folder.getUrl(),
    files: files,
  };
}

/** Every run an agent has photos in, newest first. */
function agentRuns_(agentName) {
  const runs = [];
  const communities = rootFolder_().getFolders();
  while (communities.hasNext()) {
    const c = communities.next();
    if (c.isTrashed()) continue;
    const dates = c.getFolders();
    while (dates.hasNext()) {
      const d = dates.next();
      if (d.isTrashed()) continue;
      const a = child_(d, agentName, false);
      if (a) runs.push({ community: c.getName(), date: d.getName(), folder: a });
    }
  }
  runs.sort((x, y) => x.date < y.date ? 1 : -1);
  return runs;
}

function lots_(agentFolder) {
  const lots = [];
  const it = agentFolder.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) lots.push(lotInfo_(f));
  }
  lots.sort((a, b) => Number(a.lot) - Number(b.lot));
  return lots;
}

// ---------- agent side ----------

function agentView_(req) {
  const agent = agents_().filter(a => a.key && a.key === req.key)[0];
  if (!agent) throw new Error('This link is not valid. Ask your photographer for a new one.');
  const runs = agentRuns_(agent.name);
  const run = runs.filter(r => r.date === req.date)[0] || runs[0];
  return {
    agent: agent.name,
    expireDays: Number(PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS),
    runs: runs.map(r => ({ community: r.community, date: r.date })),
    run: run ? { community: run.community, date: run.date, folderUrl: run.folder.getUrl(), lots: lots_(run.folder) } : null,
  };
}

// ---------- team page ----------

function teamView_(req) {
  const runs = [];
  const communities = rootFolder_().getFolders();
  while (communities.hasNext()) {
    const c = communities.next();
    if (c.isTrashed()) continue;
    const dates = c.getFolders();
    while (dates.hasNext()) {
      const d = dates.next();
      if (!d.isTrashed() && /^\d{4}-\d{2}-\d{2}$/.test(d.getName())) runs.push({ community: c.getName(), date: d.getName(), folder: d });
    }
  }
  runs.sort((x, y) => x.date < y.date ? 1 : -1);
  const plans = plans_();
  // a run with a lot list is in progress until the agents have been told it is complete
  runs.forEach(r => { r.inProgress = !!(plans[r.date] && !plans[r.date].done); });
  // by default show the last finished run; an unfinished one only when asked for or when it is all there is
  const run = runs.filter(r => r.date === req.date)[0] || runs.filter(r => !r.inProgress)[0] || runs[0];
  const planned = run && plans[run.date] ? plans[run.date].lots : [];
  let shot = 0;
  const agents = !run ? [] : agents_().map(a => {
    const f = child_(run.folder, a.name, false);
    const lots = f ? lots_(f) : [];
    shot += lots.filter(l => l.files.length).length;
    // lots on the map that have no photos yet
    planned.filter(p => p[1] === a.name && !lots.some(l => l.lot === p[0])).forEach(p => {
      lots.push({ lot: p[0], stage: '', note: '', sent: false, folderUrl: '', files: [], pending: true });
    });
    lots.sort((x, y) => Number(x.lot) - Number(y.lot));
    return { name: a.name, color: a.color, folderUrl: f ? f.getUrl() : '', lots: lots };
  });
  return {
    expireDays: Number(PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS),
    nextRun: PROPS.getProperty('NEXT_RUN') || '',
    runs: runs.map(r => ({ community: r.community, date: r.date, inProgress: r.inProgress })),
    run: run ? {
      community: run.community,
      date: run.date,
      inProgress: run.inProgress,
      planned: planned.length,
      shot: shot,
      agents: agents,
    } : null,
  };
}

/** An agent ticks a lot once its update has gone to the customer. */
function markSent_(req) {
  const folder = findLot_(req.community, req.date, req.agent, req.lot);
  if (!folder) throw new Error('That lot is no longer here.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const meta = readMeta_(folder);
    meta.sent = !!req.sent;
    folder.setDescription(JSON.stringify(meta));
  } finally {
    lock.releaseLock();
  }
  return { sent: !!req.sent };
}

/** One zip of a lot's photos, built the first time someone asks for it. */
function zip_(req) {
  const folder = findLot_(req.community, req.date, req.agent, req.lot);
  if (!folder) throw new Error('That lot is no longer here.');
  const info = lotInfo_(folder);
  const name = 'Lot ' + info.lot + ' - ' + req.date + ' - ' + info.files.length + ' photos.zip';
  const made = folder.getFilesByName(name);
  if (made.hasNext()) return { id: made.next().getId() };
  try {
    const blobs = info.files.map(f => DriveApp.getFileById(f.id).getBlob());
    return { id: folder.createFile(Utilities.zip(blobs, name)).getId() };
  } catch (err) {
    throw new Error('These photos are too large to zip here. Use "Open in Drive" and download from there.');
  }
}

// ---------- email ----------

/** Tell each agent with lots in this run that the photos are done, with the team link. */
function notify_(req) {
  const sent = [], skipped = [];
  const plans = plans_();
  if (plans[req.date]) { plans[req.date].done = true; savePlans_(plans); }
  const link = req.portal + '?u=' + encodeURIComponent(req.backend) + '&k=' + teamKey_();
  const days = PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS;
  agents_().forEach(agent => {
    const run = agentRuns_(agent.name).filter(r => r.date === req.date && r.community === req.community)[0];
    const lots = run ? lots_(run.folder).filter(l => l.files.length) : [];
    if (!lots.length) return;
    if (!agent.email) { skipped.push(agent.name + ' (no email on file)'); return; }
    MailApp.sendEmail({
      to: agent.email,
      subject: req.community + ' update photos are ready - ' + req.date,
      htmlBody:
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#14202b;max-width:520px">' +
        '<p>Hi ' + esc_(agent.name) + ',</p>' +
        '<p>The photo run at ' + esc_(req.community) + ' is complete. Update photos for <b>' + lots.length + ' of your lots</b> are ready.</p>' +
        '<p style="margin:22px 0"><a href="' + link + '" style="background:#0b3c5d;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:bold;display:inline-block">Open the updated photos</a></p>' +
        '<p>On the page, click your name to see your lots.</p>' +
        '<p style="color:#5d6b78;font-size:13px">Your lots this run: ' + lots.map(l => esc_(l.lot)).join(', ') + '.<br>' +
        'Photos are removed after ' + days + ' days, so please download what you need.</p></div>',
    });
    sent.push(agent.name + ' (' + lots.length + ' lots)');
  });
  return { sent: sent, skipped: skipped };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Start fresh: trash every photo run and forget the lot lists. Agents, links and settings stay. */
function wipe_() {
  let runs = 0;
  const communities = rootFolder_().getFolders();
  while (communities.hasNext()) {
    const c = communities.next();
    if (c.isTrashed()) continue;
    const dates = c.getFolders();
    while (dates.hasNext()) { dates.next().setTrashed(true); runs++; }
  }
  PROPS.deleteProperty('PLANS');
  return { runs: runs };
}

// ---------- expiry ----------

/** Daily trigger: trash run folders older than EXPIRE_DAYS. */
function cleanup() {
  const days = Number(PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS);
  const cutoff = new Date(Date.now() - days * 86400000);
  const communities = rootFolder_().getFolders();
  while (communities.hasNext()) {
    const dates = communities.next().getFolders();
    while (dates.hasNext()) {
      const d = dates.next();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.getName());
      if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) < cutoff) d.setTrashed(true);
    }
  }
}
