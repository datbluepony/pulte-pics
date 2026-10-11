// Usage: node tools/test-backend.js
// Runs apps-script/Code.gs in Node against in-memory stand-ins for Drive, properties, cache, lock and mail.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

let nextId = 1;
class File {
  constructor(name, parent, blob) { this.id = 'file' + nextId++; this.name = name; this.parent = parent; this.trashed = false; this.blob = blob; }
  getId() { return this.id; } getName() { return this.name; } isTrashed() { return this.trashed || this.parent.isTrashed(); }
  setTrashed(t) { this.trashed = t; } getMimeType() { return this.blob.mime; } getBlob() { return this.blob; }
}
class Folder {
  constructor(name, parent) { this.id = 'folder' + nextId++; this.name = name; this.parent = parent; this.kids = []; this.files = []; this.desc = ''; this.trashed = false; this.sharing = null; }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return 'https://drive/' + this.id; }
  isTrashed() { return this.trashed || (this.parent ? this.parent.isTrashed() : false); }
  setTrashed(t) { this.trashed = t; }
  getDescription() { return this.desc; } setDescription(d) { this.desc = d; }
  setSharing(a, p) { this.sharing = [a, p]; }
  createFolder(n) { const f = new Folder(n, this); this.kids.push(f); folders[f.id] = f; return f; }
  createFile(blob) { const f = new File(blob.name, this, blob); this.files.push(f); files[f.id] = f; return f; }
  getFolders() { return iter(this.kids.filter(k => !k.trashed)); }
  getFoldersByName(n) { return iter(this.kids.filter(k => k.name === n && !k.trashed)); }
  getFiles() { return iter(this.files.filter(k => !k.trashed)); }
  getFilesByName(n) { return iter(this.files.filter(k => k.name === n && !k.trashed)); }
}
const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const folders = {}, files = {};
const props = {};
const cache = {};
const mail = [];
const ctx = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  DriveApp: {
    createFolder: n => { const f = new Folder(n, null); folders[f.id] = f; return f; },
    getFolderById: id => { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
    getFileById: id => { if (!files[id]) throw new Error('no file'); return files[id]; },
    Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
  },
  Utilities: {
    getUuid: () => 'u' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    base64Decode: d => Buffer.from(d, 'base64'),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    zip: (blobs, name) => ({ bytes: Buffer.concat(blobs.map(b => b.bytes)), mime: 'application/zip', name }),
  },
  MailApp: { sendEmail: m => mail.push(m), getRemainingDailyQuota: () => 100 },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }) }) }) },
  ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Logger: { log() {} },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);

const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
ctx.setup();
const token = props.OWNER_TOKEN;
const own = (action, b) => post(Object.assign({ action, token }, b));
const C = 'Verdana Village';
const jpg = Buffer.from('fake-jpeg').toString('base64');

// connect with three agents
let r = own('saveAgents', { agents: [{ name: 'Justin', color: '#46b1e1', email: 'j@x' }, { name: 'Gita', color: '#f2cfee', email: '' }, { name: 'Derek', color: '#ffff00', email: 'd@x' }], expireDays: 13, nextRun: '2026-10-25' });
assert(r.ok && r.version >= 6 && r.teamKey, 'saveAgents');
const key = r.teamKey;
const team = (action, b) => post(Object.assign({ action, key }, b));
assert.strictEqual(post({ action: 'ping', token: 'wrong' }).ok, false, 'wrong token rejected');
assert.strictEqual(team('teamView', {}).run, null, 'empty before any run');

// run 1 (Sep 27): plan, photos, notes, finish
own('plan', { community: C, date: '2026-09-27', lots: [{ lot: 2096, agent: 'Gita' }, { lot: 30, agent: 'Derek' }] });
own('upload', { community: C, date: '2026-09-27', agent: 'Gita', lot: 2096, name: 'Lot 2096 - 01.jpg', mime: 'image/jpeg', data: jpg });
own('note', { community: C, date: '2026-09-27', agent: 'Gita', lot: 2096, stage: 'Foundation', note: 'The foundation has been poured.' });
own('upload', { community: C, date: '2026-09-27', agent: 'Derek', lot: 30, name: 'Lot 30 - 01.jpg', mime: 'image/jpeg', data: jpg });
own('note', { community: C, date: '2026-09-27', agent: 'Derek', lot: 30, stage: 'Roof on', note: 'Roof on.' });
r = team('teamView', {});
assert.strictEqual(r.run.date, '2026-09-27');
assert.strictEqual(r.run.inProgress, true, 'unfinished run is in progress');
r = own('notify', { community: C, date: '2026-09-27', portal: 'https://site/team.html', backend: 'https://script.google.com/x' });
assert.deepStrictEqual(r.sent.map(x => x.split(' ')[0]).sort(), ['Derek'], 'only agents with email and lots are emailed');
assert(r.skipped[0].startsWith('Gita'), 'Gita skipped for no email');
assert(mail[0].htmlBody.includes('k=' + key), 'email carries the team link');

// run 2 (Oct 11): Gita's 2096 moves up, 2109 is new; duplicate upload; delete a wrong photo
own('plan', { community: C, date: '2026-10-11', lots: [{ lot: 2096, agent: 'Gita' }, { lot: 2109, agent: 'Gita' }, { lot: 30, agent: 'Derek' }] });
let up1 = own('upload', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, name: 'Lot 2096 - 01.jpg', mime: 'image/jpeg', data: jpg });
const dup = own('upload', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, name: 'Lot 2096 - 01.jpg', mime: 'image/jpeg', data: jpg });
assert(dup.duplicate && dup.id === up1.id, 'same file name is not stored twice');
const wrong = own('upload', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, name: 'Lot 2096 - 02.jpg', mime: 'image/jpeg', data: jpg });
own('note', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, stage: 'Walls going up', note: 'Walls.' });

// while run 2 is in progress the page shows run 1, and offers run 2
r = team('teamView', {});
assert.strictEqual(r.run.date, '2026-09-27', 'last finished run shown while the new one is in progress');
assert(r.runs.some(x => x.date === '2026-10-11' && x.inProgress));
r = team('teamView', { date: '2026-10-11' });
let gita = r.run.agents.find(a => a.name === 'Gita');
assert.strictEqual(gita.lots.find(l => l.lot === '2096').files.length, 2);
assert.strictEqual(r.run.planned, 3); assert.strictEqual(r.run.shot, 1);

// cache: same answer twice, then a change makes it rebuild
const before = JSON.stringify(team('teamView', { date: '2026-10-11' }));
assert.strictEqual(before, JSON.stringify(r), 'cached copy matches');
own('deletePhoto', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, id: wrong.id });
assert(files[wrong.id].trashed, 'wrong photo trashed');
r = team('teamView', { date: '2026-10-11' });
gita = r.run.agents.find(a => a.name === 'Gita');
const l2096 = gita.lots.find(l => l.lot === '2096');
assert.strictEqual(l2096.files.length, 1, 'deleted photo gone from the page right away');
assert.strictEqual(l2096.prevStage, 'Foundation', 'previous stage known');
assert.strictEqual(l2096.stage, 'Walls going up');
const l2109 = gita.lots.find(l => l.lot === '2109');
assert(l2109.pending && l2109.isNew, '2109 is pending and new this run');
assert.strictEqual(r.run.agents.find(a => a.name === 'Derek').lots.find(l => l.lot === '30').isNew, false);

// Derek's lot 1732: three photos sent two at a time. Drive can hand the second upload a stale copy of the
// lot's photo list, so the list ends up one short; and two uploads at once could make two "Lot 1732" folders.
const shots = [1, 2, 3].map(n => own('upload', { community: C, date: '2026-10-11', agent: 'Derek', lot: 1732, name: 'Lot 1732 - 0' + n + '.jpg', mime: 'image/jpeg', data: jpg }));
assert(shots.every(x => x.ok && x.id), 'three photos stored');
const derekDate = Object.values(folders).find(f => f.name === '2026-10-11' && !f.trashed);
const derekFolder = derekDate.kids.find(k => k.name === 'Derek');
const lot1732 = derekFolder.kids.find(k => k.name === 'Lot 1732');
const meta = JSON.parse(lot1732.desc); meta.files = meta.files.slice(0, 2); lot1732.desc = JSON.stringify(meta); // the lost entry
ctx.changed_();
let d1732 = team('teamView', { date: '2026-10-11' }).run.agents.find(a => a.name === 'Derek').lots.filter(l => l.lot === '1732');
assert.strictEqual(d1732.length, 1, 'one card for lot 1732');
assert.strictEqual(d1732[0].files.length, 3, 'all three photos show even when the photo list lost one');
const twin = derekFolder.createFolder('Lot 1732');
twin.createFile({ name: 'Lot 1732 - 04.jpg', mime: 'image/jpeg', bytes: Buffer.from('x') });
ctx.changed_();
d1732 = team('teamView', { date: '2026-10-11' }).run.agents.find(a => a.name === 'Derek').lots.filter(l => l.lot === '1732');
assert.strictEqual(d1732.length, 1, 'a duplicate lot folder is merged into one card');
assert.strictEqual(d1732[0].files.length, 4, 'photos from both copies show');
r = team('markSent', { community: C, date: '2026-10-11', agent: 'Derek', lot: 1732, sent: true });
assert(JSON.parse(twin.desc).sent && JSON.parse(lot1732.desc).sent, 'sent tick reaches both copies');
const z = team('zip', { community: C, date: '2026-10-11', agent: 'Derek', lot: 1732 });
assert(files[z.id].name.includes('4 photos'), 'zip has every photo');
// a second upload to a lot that was just made reuses the same folder
const before1801 = derekFolder.kids.length;
own('upload', { community: C, date: '2026-10-11', agent: 'Derek', lot: 1801, name: 'a.jpg', mime: 'image/jpeg', data: jpg });
own('upload', { community: C, date: '2026-10-11', agent: 'Derek', lot: 1801, name: 'b.jpg', mime: 'image/jpeg', data: jpg });
assert.strictEqual(derekFolder.kids.length, before1801 + 1, 'one folder for a new lot');

// sent tick and zip
r = team('markSent', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096, sent: true });
assert(r.ok && r.sent);
assert(team('teamView', { date: '2026-10-11' }).run.agents.find(a => a.name === 'Gita').lots.find(l => l.lot === '2096').sent, 'sent shows at once');
r = team('zip', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096 });
assert(r.ok && files[r.id].name.endsWith('.zip'));
assert.strictEqual(team('zip', { community: C, date: '2026-10-11', agent: 'Gita', lot: 2096 }).id, r.id, 'zip reused');
assert(team('teamView', { date: '2026-10-11' }).run.agents.find(a => a.name === 'Gita').lots.find(l => l.lot === '2096').files.every(f => !f.name.endsWith('.zip')), 'zip is not listed as a photo');
assert.strictEqual(post({ action: 'teamView', key: 'nope' }).ok, false, 'bad team key rejected');

// finishing run 2 makes it the default; property sizes stay small
own('notify', { community: C, date: '2026-10-11', portal: 'https://site/team.html', backend: 'https://script.google.com/x' });
assert.strictEqual(team('teamView', {}).run.date, '2026-10-11', 'finished run becomes the default');
Object.keys(props).forEach(k => assert(props[k].length < 9000, 'property ' + k + ' under the size limit'));

// older single-property plan store still reads
props.PLANS = JSON.stringify({ '2026-09-13': { community: C, lots: [['1', 'Justin']], done: true } });
assert(ctx.plans_()['2026-09-13'], 'legacy plans readable');
own('plan', { community: C, date: '2026-10-25', lots: [] });
assert(!('PLANS' in props) && props['PLAN_2026-09-13'], 'legacy plans moved to per-run keys');

// expiry and wipe
ctx.cleanup();
r = own('wipe', {});
assert(r.runs >= 1, 'wipe removed the runs cleanup left');
assert(!Object.keys(props).some(k => k.indexOf('PLAN') === 0), 'wipe cleared plans');
assert.strictEqual(team('teamView', {}).run, null, 'empty after wipe');

console.log('all backend checks passed');
