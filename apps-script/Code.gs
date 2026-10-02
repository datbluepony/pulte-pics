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
const DEFAULT_EXPIRE_DAYS = 11; // about 1.5 weeks
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
  if (!req.token || req.token !== PROPS.getProperty('OWNER_TOKEN')) throw new Error('Wrong owner token.');
  switch (req.action) {
    case 'ping': return config_();
    case 'saveAgents': return saveAgents_(req);
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

function config_() {
  return {
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
  return config_();
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

function upload_(req) {
  const folder = lotFolder_(req.community, req.date, req.agent, req.lot);
  const existing = folder.getFilesByName(req.name);
  if (existing.hasNext()) return { id: existing.next().getId(), duplicate: true };
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'image/jpeg', req.name);
  return { id: folder.createFile(blob).getId() };
}

function note_(req) {
  const folder = lotFolder_(req.community, req.date, req.agent, req.lot);
  folder.setDescription(JSON.stringify({ stage: req.stage || '', note: req.note || '' }));
  return {};
}

function lotInfo_(folder) {
  let meta = {};
  try { meta = JSON.parse(folder.getDescription() || '{}'); } catch (err) { /* plain-text description */ }
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) files.push({ id: f.getId(), name: f.getName() });
  }
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  return {
    lot: folder.getName().replace(/^Lot\s+/, ''),
    stage: meta.stage || '',
    note: meta.note || '',
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

// ---------- email ----------

function notify_(req) {
  const sent = [], skipped = [];
  agents_().forEach(agent => {
    const run = agentRuns_(agent.name).filter(r => r.date === req.date && r.community === req.community)[0];
    const lots = run ? lots_(run.folder).filter(l => l.files.length) : [];
    if (!lots.length) return;
    if (!agent.email) { skipped.push(agent.name + ' (no email on file)'); return; }
    const link = req.portal + '?u=' + encodeURIComponent(req.backend) + '&k=' + agent.key;
    const rows = lots.map(l =>
      '<tr><td style="padding:6px 12px 6px 0;vertical-align:top"><b>Lot ' + esc_(l.lot) + '</b></td>' +
      '<td style="padding:6px 12px 6px 0;vertical-align:top">' + l.files.length + ' photos</td>' +
      '<td style="padding:6px 0;vertical-align:top">' + esc_(l.note) + '</td></tr>').join('');
    MailApp.sendEmail({
      to: agent.email,
      subject: req.community + ' update photos - ' + req.date + ' - ' + lots.length + ' lots',
      htmlBody:
        '<p>Hi ' + esc_(agent.name) + ',</p>' +
        '<p>Update photos for ' + lots.length + ' of your lots at ' + esc_(req.community) + ' are ready, full resolution, sorted by lot.</p>' +
        '<p><a href="' + link + '"><b>Open your photos</b></a></p>' +
        '<table style="border-collapse:collapse;font-size:14px">' + rows + '</table>' +
        '<p>Photos are removed after ' + (PROPS.getProperty('EXPIRE_DAYS') || DEFAULT_EXPIRE_DAYS) + ' days, so please download what you need.</p>',
    });
    sent.push(agent.name + ' (' + lots.length + ' lots)');
  });
  return { sent: sent, skipped: skipped };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
