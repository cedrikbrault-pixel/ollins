'use strict';
/**
 * Yo'llins Tacos – serveur de gestion.
 * Aucune dépendance : seulement Node.js (version 18 ou plus).
 * Comptes + mots de passe (scrypt), sessions signées, droits selon le grade,
 * données dans un fichier JSON (dossier data/), sauvegardes automatiques.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILE = path.join(DATA_DIR, 'data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const GRADES = ['Patron', 'Co-Patron', 'Vendeur', 'Stagiaire'];
const COLL = ['sales', 'runs', 'expenses', 'staff', 'notes', 'wallet', 'weeks', 'settings'];
const SESSION_MS = 7 * 24 * 3600 * 1000;
const UNDO_MS = 15 * 60 * 1000; // un employé peut annuler sa propre vente pendant 15 min
const MAX_BODY = 6 * 1024 * 1024;

/* ---------- secret de session ---------- */
function loadSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* première fois */ }
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(REMOTE_URL && REMOTE_TOKEN); // stockage distant gratuit (hébergeur sans disque)
const REMOTE_KEY = 'yollins:data';
let SECRET = REMOTE ? null : loadSecret();
const zlib = require('node:zlib');
async function remoteCmd(cmd) {
  const r = await fetch(REMOTE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j.result;
}
const packDB = (o) => zlib.gzipSync(JSON.stringify(o)).toString('base64');
const unpackDB = (t) => JSON.parse(zlib.gunzipSync(Buffer.from(t, 'base64')).toString('utf8'));

/* ---------- base de données (fichier JSON) ---------- */
let DB = { rev: 1, users: {}, c: {} };
if (!REMOTE) {
  try {
    DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error('data.json illisible :', e.message); process.exit(1); }
  }
}
DB.users = DB.users || {};
DB.c = DB.c || {};
for (const k of COLL) DB.c[k] = DB.c[k] || {};

let saving = false, dirty = false;
function flush() {
  if (REMOTE) {
    saving = true; dirty = false;
    remoteCmd(['SET', REMOTE_KEY, packDB(DB)]).catch((e) => { dirty = true; console.error('Écriture distante impossible :', e.message); })
      .finally(() => { saving = false; if (dirty) setTimeout(flush, 1500); });
    return;
  }
  saving = true; dirty = false;
  const tmp = FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(DB), (err) => {
    if (err) { console.error('Écriture impossible :', err.message); saving = false; return; }
    fs.rename(tmp, FILE, (e2) => {
      saving = false;
      if (e2) console.error('Renommage impossible :', e2.message);
      if (dirty) flush();
    });
  });
}
function persist() { DB.rev++; dirty = true; if (!saving) flush(); }
function flushSync() { try { fs.writeFileSync(FILE, JSON.stringify(DB)); } catch (e) { console.error(e.message); } }
async function shutdown() {
  if (REMOTE) { try { await Promise.race([remoteCmd(['SET', REMOTE_KEY, packDB(DB)]), new Promise((r) => setTimeout(r, 4000))]); } catch (e) { /* tant pis */ } } else flushSync();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function backup() {
  try {
    if (!fs.existsSync(FILE)) return;
    const d = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, 'data-' + d + '.json');
    if (!fs.existsSync(dest)) fs.copyFileSync(FILE, dest);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (old.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
  } catch (e) { console.error('Sauvegarde :', e.message); }
}
if (!REMOTE) { backup(); setInterval(backup, 6 * 3600 * 1000).unref(); }

/* ---------- mots de passe ---------- */
const SC = { N: 16384, r: 8, p: 1 };
function hashPw(pw) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, SC, (e, k) => e ? rej(e) : res('scrypt$' + salt.toString('base64') + '$' + k.toString('base64')));
  });
}
function checkPw(pw, stored) {
  return new Promise((res) => {
    const p = String(stored || '').split('$');
    if (p[0] !== 'scrypt' || p.length !== 3) return res(false);
    crypto.scrypt(pw, Buffer.from(p[1], 'base64'), 64, SC, (e, k) => {
      if (e) return res(false);
      const b = Buffer.from(p[2], 'base64');
      res(b.length === k.length && crypto.timingSafeEqual(b, k));
    });
  });
}
let DUMMY = '';
hashPw('mot-de-passe-factice').then((h) => { DUMMY = h; });

/* ---------- réinitialisation d'urgence du mot de passe ---------- */
(async () => {
  const name = process.env.RESET_PASSWORD_USER, pw = process.env.RESET_PASSWORD_NEW;
  if (!name || !pw) return;
  const u = Object.values(DB.users).find((x) => x.username === String(name).toLowerCase());
  if (!u) return console.error('RESET_PASSWORD_USER : compte introuvable.');
  if (pw.length < 8) return console.error('RESET_PASSWORD_NEW : 8 caractères minimum.');
  u.hash = await hashPw(pw); u.sv = (u.sv || 0) + 1; persist();
  console.log('Mot de passe réinitialisé pour "' + u.username + '". Retire maintenant les deux variables RESET_PASSWORD_*.');
})();

/* ---------- sessions ---------- */
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(u) {
  const p = Buffer.from(JSON.stringify({ u: u.id, v: u.sv || 0, e: Date.now() + SESSION_MS })).toString('base64url');
  return p + '.' + sign(p);
}
function userFromReq(req) {
  const m = /(?:^|;\s*)yt_sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [p, sg] = m[1].split('.');
  if (!p || !sg) return null;
  const exp = sign(p);
  if (sg.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(exp))) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { return null; }
  if (!o || o.e < Date.now()) return null;
  const u = DB.users[o.u];
  return u && (u.sv || 0) === o.v ? u : null;
}
const isAdmin = (u) => u.grade === 'Patron' || u.grade === 'Co-Patron';
const isPatron = (u) => u.grade === 'Patron';
const pub = (u) => ({ id: u.id, staff: u.staff, name: u.name, username: u.username, grade: u.grade, admin: isAdmin(u), patron: isPatron(u) });

/* ---------- limitation des tentatives de connexion ---------- */
const fails = new Map();
function throttled(key) {
  const f = fails.get(key);
  return !!f && f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000;
}
function failed(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.t > 15 * 60 * 1000) fails.set(key, { n: 1, t: Date.now() });
  else { f.n++; f.t = Date.now(); }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (now - v.t > 15 * 60 * 1000) fails.delete(k); }, 600000).unref();

/* ---------- droits par collection ---------- */
function canRead(u, coll, id, d) {
  const a = isAdmin(u);
  switch (coll) {
    case 'sales': return true;
    case 'runs': return a || (!!d && d._by === u.id); // un employé ne voit que ses propres courses
    case 'settings': return id === 'pay' ? a : true; // % de salaires : direction seulement
    default: return a; // expenses, staff, notes, wallet, weeks
  }
}
function canWrite(u, coll, op, id) {
  const a = isAdmin(u), p = isPatron(u);
  switch (coll) {
    case 'sales':
      if (op === 'add') return true;
      if (a) return true;
      if (op === 'delete') { const d = DB.c.sales[id]; return !!d && d._by === u.id && Date.now() - (d._t || 0) < UNDO_MS; }
      return false;
    case 'runs':
      if (op === 'add') return true;
      if (a) return true;
      if (op === 'delete') { const d = DB.c.runs[id]; return !!d && d._by === u.id && Date.now() - (d._t || 0) < UNDO_MS; }
      return false;
    case 'expenses': case 'notes': return a;
    case 'staff': return p && op !== 'add';
    default: return p; // wallet, weeks, settings : patron seulement
  }
}

/* ---------- utilitaires HTTP ---------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
const fail = (res, code, msg) => send(res, code, { error: msg });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('Requête trop volumineuse')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch (e) { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}
const clientIp = (req) => {
  const x = req.headers['x-forwarded-for'];
  return (x ? String(x).split(',')[0].trim() : req.socket.remoteAddress) || '?';
};
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
function cookie(req, token, maxAge) {
  return 'yt_sid=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '');
}
const newId = () => crypto.randomBytes(9).toString('base64url');
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
const validUser = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{3,30}$/.test(s);
const validPw = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 200;

function cleanDoc(body) {
  const d = {};
  for (const k of Object.keys(body)) { if (k === 'id' || k[0] === '_') continue; d[k] = body[k]; }
  return d;
}
function checkSale(d) {
  return typeof d.product === 'string' && d.product.length <= 120 &&
    Number.isFinite(d.qty) && d.qty >= 1 && d.qty <= 999 &&
    Number.isFinite(d.total) && d.total >= 0 && d.total <= 1e7 &&
    (d.cost === undefined || (Number.isFinite(d.cost) && d.cost >= 0));
}
const countPatrons = () => Object.values(DB.users).filter(isPatron).length;
const staffDoc = (id) => DB.c.staff[id];
const userByStaff = (sid) => Object.values(DB.users).find((u) => u.staff === sid);

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method !== 'GET') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '') && method !== 'DELETE') return fail(res, 415, 'Type de contenu invalide');
    const o = req.headers.origin;
    if (o) { try { if (new URL(o).host !== req.headers.host) return fail(res, 403, 'Origine refusée'); } catch (e) { return fail(res, 403, 'Origine refusée'); } }
  }

  /* --- public --- */
  if (p === '/api/public/prices' && method === 'GET') {
    return send(res, 200, DB.c.settings.prices || {}, { 'Cache-Control': 'public, max-age=30' });
  }

  if (p === '/api/me' && method === 'GET') {
    const u = userFromReq(req);
    if (u) return send(res, 200, { user: pub(u) });
    return send(res, 200, { setup: Object.keys(DB.users).length === 0 });
  }

  if (p === '/api/setup' && method === 'POST') {
    if (Object.keys(DB.users).length) return fail(res, 403, 'Le site est déjà configuré');
    const b = await readBody(req);
    const name = cleanName(b.name), un = String(b.username || '').toLowerCase();
    if (!name) return fail(res, 400, 'Nom manquant');
    if (!validUser(un)) return fail(res, 400, 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -)');
    if (!validPw(b.password)) return fail(res, 400, 'Mot de passe : 8 caractères minimum');
    const sid = newId(), uid = newId();
    DB.c.staff[sid] = { name, grade: 'Patron', quota: 50, at: Date.now() };
    DB.users[uid] = { id: uid, username: un, name, grade: 'Patron', hash: await hashPw(b.password), sv: 0, staff: sid, created: Date.now() };
    persist();
    return send(res, 200, { user: pub(DB.users[uid]) }, { 'Set-Cookie': cookie(req, makeToken(DB.users[uid]), SESSION_MS / 1000) });
  }

  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const un = String(b.username || '').toLowerCase().slice(0, 40);
    const k1 = 'u:' + un, k2 = 'i:' + clientIp(req);
    if (throttled(k1) || throttled(k2)) return fail(res, 429, 'Trop de tentatives. Réessaie dans 15 minutes.');
    const u = Object.values(DB.users).find((x) => x.username === un);
    const ok = await checkPw(String(b.password || '').slice(0, 200), u ? u.hash : DUMMY);
    if (!u || !ok) { failed(k1); failed(k2); return fail(res, 401, 'Identifiant ou mot de passe incorrect'); }
    fails.delete(k1);
    return send(res, 200, { user: pub(u) }, { 'Set-Cookie': cookie(req, makeToken(u), SESSION_MS / 1000) });
  }

  if (p === '/api/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }

  /* --- connecté --- */
  const me = userFromReq(req);
  if (!me) return fail(res, 401, 'Non connecté');

  if (p === '/api/sync' && method === 'GET') {
    const rev = +url.searchParams.get('rev') || 0;
    if (rev === DB.rev) return send(res, 200, { rev: DB.rev, same: true });
    const data = {};
    for (const c of COLL) {
      data[c] = [];
      for (const [id, d] of Object.entries(DB.c[c])) {
        if (!canRead(me, c, id, d)) continue;
        const o = { id };
        for (const k of Object.keys(d)) if (k[0] !== '_') o[k] = d[k];
        data[c].push(o);
      }
    }
    return send(res, 200, { rev: DB.rev, data });
  }

  if (p === '/api/export' && method === 'GET') {
    if (!isPatron(me)) return fail(res, 403, 'Réservé au patron');
    const name = 'sauvegarde-yollins-' + new Date().toISOString().slice(0, 10) + '.json';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    return res.end(JSON.stringify({ ...DB, secret: undefined }));
  }

  if (p === '/api/me/password' && method === 'POST') {
    const b = await readBody(req);
    if (!validPw(b.new)) return fail(res, 400, 'Nouveau mot de passe : 8 caractères minimum');
    if (!(await checkPw(String(b.old || ''), me.hash))) return fail(res, 403, 'Ancien mot de passe incorrect');
    me.hash = await hashPw(b.new); me.sv = (me.sv || 0) + 1; persist();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(me), SESSION_MS / 1000) });
  }

  if (p === '/api/users' && method === 'POST') {
    if (!isPatron(me)) return fail(res, 403, 'Réservé au patron');
    const b = await readBody(req);
    const name = cleanName(b.name), un = String(b.username || '').toLowerCase();
    if (!name) return fail(res, 400, 'Nom manquant');
    if (!validUser(un)) return fail(res, 400, 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -)');
    if (!validPw(b.password)) return fail(res, 400, 'Mot de passe : 8 caractères minimum');
    if (!GRADES.includes(b.grade)) return fail(res, 400, 'Grade invalide');
    if (Object.values(DB.users).some((x) => x.username === un)) return fail(res, 409, 'Cet identifiant existe déjà');
    if (Object.values(DB.c.staff).some((s) => s.name === name)) return fail(res, 409, 'Un employé porte déjà ce nom');
    const sid = newId(), uid = newId();
    DB.c.staff[sid] = { name, grade: b.grade, quota: Math.max(1, Math.round(+b.quota || 50)), at: Date.now() };
    DB.users[uid] = { id: uid, username: un, name, grade: b.grade, hash: await hashPw(b.password), sv: 0, staff: sid, created: Date.now() };
    persist();
    return send(res, 200, { id: sid });
  }

  let m = /^\/api\/users\/([A-Za-z0-9_-]{1,40})\/password$/.exec(p);
  if (m && method === 'POST') {
    if (!isPatron(me)) return fail(res, 403, 'Réservé au patron');
    const u = userByStaff(m[1]);
    if (!u) return fail(res, 404, 'Compte introuvable');
    const b = await readBody(req);
    if (!validPw(b.password)) return fail(res, 400, 'Mot de passe : 8 caractères minimum');
    u.hash = await hashPw(b.password); u.sv = (u.sv || 0) + 1; persist();
    const extra = u.id === me.id ? { 'Set-Cookie': cookie(req, makeToken(u), SESSION_MS / 1000) } : {};
    return send(res, 200, { ok: true }, extra);
  }

  m = /^\/api\/c\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(p);
  if (!m || !COLL.includes(m[1])) return fail(res, 404, 'Introuvable');
  const coll = m[1], id = m[2];
  const store = DB.c[coll];

  if (method === 'POST' && !id) { // ajout
    if (!canWrite(me, coll, 'add')) return fail(res, 403, 'Action non autorisée pour ton grade');
    const d = cleanDoc(await readBody(req));
    if (coll === 'sales') {
      if (!checkSale(d)) return fail(res, 400, 'Vente invalide');
      if (!isAdmin(me)) { d.emp = me.name; d.at = Date.now(); }
    }
    if (coll === 'runs') {
      if (!(typeof d.product === 'string' && d.product.trim() && d.product.length <= 120 && Number.isFinite(d.revenue) && d.revenue >= 0 && d.revenue <= 1e7)) return fail(res, 400, 'Course invalide');
      if (!isAdmin(me)) { d.emp = me.name; d.at = Date.now(); }
    }
    const nid = newId();
    store[nid] = Object.assign(d, { _by: me.id, _t: Date.now() });
    persist();
    return send(res, 200, { id: nid });
  }

  if (!id) return fail(res, 404, 'Introuvable');

  if (method === 'PUT' || method === 'PATCH') {
    if (!canWrite(me, coll, method === 'PUT' ? 'set' : 'update', id)) return fail(res, 403, 'Action non autorisée pour ton grade');
    const d = cleanDoc(await readBody(req));
    if (coll === 'staff') {
      const cur = staffDoc(id);
      if (!cur) return fail(res, 404, 'Employé introuvable');
      const next = Object.assign({}, cur, d);
      if (!GRADES.includes(next.grade)) return fail(res, 400, 'Grade invalide');
      next.quota = Math.max(1, Math.round(+next.quota || 1));
      const u = userByStaff(id);
      if (u && u.grade === 'Patron' && next.grade !== 'Patron' && countPatrons() <= 1) return fail(res, 400, 'Il doit rester au moins un patron');
      if (u) { u.grade = next.grade; if (typeof next.name === 'string' && cleanName(next.name)) u.name = cleanName(next.name); }
      store[id] = Object.assign(next, { _by: cur._by, _t: cur._t });
    } else if (coll === 'sales') {
      const next = method === 'PUT' ? d : Object.assign({}, store[id] || {}, d);
      if (!checkSale(next)) return fail(res, 400, 'Vente invalide');
      store[id] = Object.assign(next, { _by: me.id, _t: Date.now() });
    } else {
      const base = method === 'PUT' ? {} : Object.fromEntries(Object.entries(store[id] || {}).filter(([k]) => k[0] !== '_'));
      store[id] = Object.assign(base, d, { _by: me.id, _t: Date.now() });
    }
    persist();
    return send(res, 200, { ok: true });
  }

  if (method === 'DELETE') {
    if (!canWrite(me, coll, 'delete', id)) return fail(res, 403, 'Action non autorisée pour ton grade');
    if (!store[id]) return send(res, 200, { ok: true });
    if (coll === 'staff') {
      const u = userByStaff(id);
      if (u) {
        if (u.id === me.id) return fail(res, 400, 'Tu ne peux pas supprimer ton propre compte');
        if (isPatron(u) && countPatrons() <= 1) return fail(res, 400, 'Il doit rester au moins un patron');
        delete DB.users[u.id];
      }
      for (const [nid, n] of Object.entries(DB.c.notes)) if (n.emp === id) delete DB.c.notes[nid];
    }
    delete store[id];
    persist();
    return send(res, 200, { ok: true });
  }

  return fail(res, 405, 'Méthode non autorisée');
}

/* ---------- fichiers statiques ---------- */
const PAGES = { '/': 'vitrine.html', '/index.html': 'vitrine.html', '/gestion': 'gestion.html', '/gestion/': 'gestion.html' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const page = PAGES[url.pathname];
    if (page && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = fs.readFileSync(path.join(PUBLIC_DIR, page));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page introuvable');
  } catch (e) {
    if (!res.headersSent) fail(res, e.message === 'Requête trop volumineuse' ? 413 : 500, e.message === 'JSON invalide' || e.message === 'Requête trop volumineuse' ? e.message : 'Erreur serveur');
    if (!['JSON invalide', 'Requête trop volumineuse'].includes(e.message)) console.error(e);
  }
});
async function start() {
  if (REMOTE) {
    try {
      const t = await remoteCmd(['GET', REMOTE_KEY]);
      if (t) DB = Object.assign(DB, unpackDB(t));
    } catch (e) { console.error('Lecture des données distantes impossible :', e.message); process.exit(1); }
    DB.users = DB.users || {}; DB.c = DB.c || {};
    for (const k of COLL) DB.c[k] = DB.c[k] || {};
    SECRET = (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) ? process.env.SESSION_SECRET : DB.secret;
    if (!SECRET) { SECRET = crypto.randomBytes(48).toString('base64url'); DB.secret = SECRET; persist(); }
  }
  server.listen(PORT, '0.0.0.0', () => console.log('Yo’llins Tacos en ligne sur le port ' + PORT + ' • données : ' + (REMOTE ? 'stockage distant' : DATA_DIR)));
}
start();
