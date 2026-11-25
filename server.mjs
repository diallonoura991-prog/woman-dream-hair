import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const password = process.env.APP_PASSWORD || '';
const sessionSecret = process.env.SESSION_SECRET || '';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
let databaseReady = false;
const serviceDefaults = ['Brushing', 'Tresses', 'Pose de perruque', 'Manucure', 'Soin capillaire'];
const paymentDefaults = ['Orange Money', 'Wave', 'Espèce'];
const allowedYears = [2026, 2027, 2028];
const cookieName = 'wdh_session';

function salonTime() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Abidjan', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const clock = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Abidjan', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${clock.hour}:${clock.minute}` };
}
function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateString) {
  const d = new Date(`${dateString}T12:00:00Z`);
  return addDays(dateString, -((d.getUTCDay() + 6) % 7));
}
function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(value));
}
function sendText(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(value);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}
function signed(value) { return createHmac('sha256', sessionSecret).update(value).digest('base64url'); }
function sessionValid(req) {
  if (!sessionSecret) return false;
  const token = cookies(req)[cookieName];
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const value = token.slice(0, dot), signature = token.slice(dot + 1);
  const expected = signed(value);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expires = Number(value.slice(0, value.indexOf(':')));
  return Number.isFinite(expires) && expires > Date.now();
}
function cookie(value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error('Requête trop volumineuse.');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new Error('Données invalides.'); }
}
function requireAuth(req, res) {
  if (!sessionValid(req)) { sendJson(res, 401, { error: 'Reconnecte-toi pour continuer.' }); return false; }
  return true;
}
function buildArchiveWhere(url) {
  const clauses = [], values = [];
  const year = url.searchParams.get('year') || '';
  const month = url.searchParams.get('month') || '';
  const client = (url.searchParams.get('client') || '').trim().slice(0, 120);
  if (year) {
    const y = Number(year);
    if (!allowedYears.includes(y)) throw new Error('Année non prise en charge.');
    values.push(y); clauses.push(`entry_year = $${values.length}`);
  } else {
    values.push(allowedYears); clauses.push(`entry_year = ANY($${values.length}::smallint[])`);
  }
  if (month) {
    const m = Number(month);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('Mois invalide.');
    values.push(m); clauses.push(`entry_month = $${values.length}`);
  }
  if (client) {
    values.push(client.toLocaleLowerCase('fr'));
    clauses.push(`POSITION($${values.length} IN client_search) > 0`);
  }
  return { where: clauses.join(' AND '), values };
}
function escapeCsv(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
async function initializeDatabase() {
  const sql = await readFile(path.join(root, 'database', 'schema.sql'), 'utf8');
  await pool.query(sql);
  for (const [table, defaults] of [['services', serviceDefaults], ['payment_modes', paymentDefaults]]) {
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    if (count.rows[0].count === 0) {
      for (const name of defaults) await pool.query(`INSERT INTO ${table} (name) VALUES ($1)`, [name]);
    }
  }
}
async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, databaseReady ? 200 : 503, { ok: databaseReady });
  if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, { authenticated: sessionValid(req) });
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origine de requête refusée.' });
    const body = await readJson(req);
    const entered = Buffer.from(String(body.password || ''));
    const expected = Buffer.from(password);
    if (!password || entered.length !== expected.length || !timingSafeEqual(entered, expected)) {
      return sendJson(res, 401, { error: 'Mot de passe incorrect.' });
    }
    const value = `${Date.now() + 7 * 24 * 60 * 60 * 1000}:${randomBytes(24).toString('hex')}`;
    return sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(`${value}.${signed(value)}`, 7 * 24 * 60 * 60) });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (!pathname.startsWith('/api/')) return false;
  if (!requireAuth(req, res)) return true;

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const { date } = salonTime();
    const weekStart = mondayOf(date);
    const weekEnd = addDays(weekStart, 6);
    const [services, payments, today, week, summary] = await Promise.all([
      pool.query('SELECT id, name FROM services WHERE active = TRUE ORDER BY name'),
      pool.query('SELECT id, name FROM payment_modes WHERE active = TRUE ORDER BY name'),
      pool.query('SELECT id, entry_date, entry_time, client_name, service_name, payment_name, amount FROM entries WHERE entry_date = $1 ORDER BY entry_time DESC', [date]),
      pool.query('SELECT entry_date, SUM(amount)::bigint AS total FROM entries WHERE entry_date BETWEEN $1 AND $2 GROUP BY entry_date', [weekStart, weekEnd]),
      pool.query('SELECT payment_name, SUM(amount)::bigint AS total FROM entries WHERE entry_date = $1 GROUP BY payment_name', [date]),
    ]);
    const rows = today.rows.map(row => ({ id: row.id, entryDate: String(row.entry_date), entryTime: String(row.entry_time).slice(0, 5), client: row.client_name, service: row.service_name, paymentMethod: row.payment_name, amount: Number(row.amount) }));
    const weekMap = new Map(week.rows.map(r => [String(r.entry_date), Number(r.total)]));
    const days = Array.from({ length: 7 }, (_, i) => { const d = addDays(weekStart, i); return { date: d, total: weekMap.get(d) || 0 }; });
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const summaryMap = new Map(summary.rows.map(r => [r.payment_name, Number(r.total)]));
    return sendJson(res, 200, {
      date, services: services.rows, payments: payments.rows, today: rows, week: days, total, count: rows.length,
      summary: payments.rows.map(p => ({ name: p.name, total: summaryMap.get(p.name) || 0 }))
    });
  }
  if (pathname === '/api/entries' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origine de requête refusée.' });
    const body = await readJson(req);
    const client = String(body.client || '').trim();
    const service = String(body.service || '').trim();
    const payment = String(body.payment || '').trim();
    const amount = Number(body.amount);
    if (!client || client.length > 120 || !service || service.length > 100 || !payment || payment.length > 80 || !Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000) {
      return sendJson(res, 400, { error: 'Vérifie le nom, la prestation, le paiement et le prix.' });
    }
    const { date, time } = salonTime();
    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
    if (!allowedYears.includes(year)) return sendJson(res, 400, { error: 'Les saisies sont prévues pour 2026, 2027 et 2028.' });
    const [serviceResult, paymentResult] = await Promise.all([
      pool.query('SELECT name FROM services WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1', [service]),
      pool.query('SELECT name FROM payment_modes WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1', [payment]),
    ]);
    if (!serviceResult.rowCount || !paymentResult.rowCount) return sendJson(res, 400, { error: 'Choisis une prestation et un mode de paiement actifs.' });
    const result = await pool.query(
      'INSERT INTO entries (entry_date, entry_time, entry_year, entry_month, client_name, client_search, service_name, payment_name, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [date, time, year, month, client, client.toLocaleLowerCase('fr'), serviceResult.rows[0].name, paymentResult.rows[0].name, amount]
    );
    return sendJson(res, 201, { id: result.rows[0].id });
  }
  if (pathname === '/api/archive' && req.method === 'GET') {
    const filter = buildArchiveWhere(url);
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM entries WHERE ${filter.where}`, filter.values),
      pool.query(`SELECT entry_date, entry_time, client_name, service_name, payment_name, amount FROM entries WHERE ${filter.where} ORDER BY entry_date DESC, entry_time DESC`, filter.values),
    ]);
    return sendJson(res, 200, {
      total: count.rows[0].count,
      entries: rows.rows.map(r => ({ entryDate: String(r.entry_date), entryTime: String(r.entry_time).slice(0, 5), client: r.client_name, service: r.service_name, paymentMethod: r.payment_name, amount: Number(r.amount) }))
    });
  }
  if (pathname === '/api/archive-export' && req.method === 'GET') {
    const filter = buildArchiveWhere(url);
    const rows = await pool.query(`SELECT entry_date, entry_time, client_name, service_name, payment_name, amount FROM entries WHERE ${filter.where} ORDER BY entry_date DESC, entry_time DESC`, filter.values);
    const csvRows = [['Date', 'Heure', 'Cliente', 'Prestation', 'Mode de paiement', 'Montant FCFA'], ...rows.rows.map(r => [r.entry_date, String(r.entry_time).slice(0, 5), r.client_name, r.service_name, r.payment_name, r.amount])];
    const csv = '\ufeff' + csvRows.map(row => row.map(escapeCsv).join(';')).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="archives-woman-dream-hair.csv"', 'Cache-Control': 'no-store' });
    return res.end(csv);
  }
  if (pathname === '/api/services' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origine de requête refusée.' });
    const body = await readJson(req), name = String(body.name || '').trim();
    if (!name || name.length > 100) return sendJson(res, 400, { error: 'Le nom de la prestation est invalide.' });
    let found = await pool.query('SELECT id, name FROM services WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1', [name]);
    if (!found.rowCount) found = await pool.query('INSERT INTO services (name) VALUES ($1) RETURNING id, name', [name]);
    return sendJson(res, 201, { service: found.rows[0] });
  }
  const removeService = pathname.match(/^\/api\/services\/(\d+)$/);
  if (removeService && req.method === 'DELETE') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origine de requête refusée.' });
    await pool.query('UPDATE services SET active = FALSE WHERE id = $1', [removeService[1]]);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/payment-modes' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origine de requête refusée.' });
    const body = await readJson(req), name = String(body.name || '').trim();
    if (!name || name.length > 80) return sendJson(res, 400, { error: 'Le mode de paiement est invalide.' });
    let found = await pool.query('SELECT id, name FROM payment_modes WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1', [name]);
    if (!found.rowCount) found = await pool.query('INSERT INTO payment_modes (name) VALUES ($1) RETURNING id, name', [name]);
    return sendJson(res, 201, { payment: found.rows[0] });
  }
  sendJson(res, 404, { error: 'Adresse introuvable.' });
  return true;
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Méthode refusée.');
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(publicDir, requested);
    if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, 'index.html')) return sendText(res, 403, 'Accès refusé.');
    const info = await stat(file);
    if (!info.isFile()) return sendText(res, 404, 'Page introuvable.');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (res.headersSent) return res.end();
    const status = /trop volumineuse|Données invalides/.test(error.message) ? 400 : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: status === 500 ? 'Une erreur est survenue. Réessaie dans un instant.' : error.message });
  }
});

const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', async () => {
  try {
    if (!process.env.DATABASE_URL || password.length < 12 || sessionSecret.length < 32) {
      throw new Error('Configuration requise: DATABASE_URL, APP_PASSWORD (12 caractères minimum), SESSION_SECRET (32 caractères minimum).');
    }
    await initializeDatabase();
    databaseReady = true;
    console.log(`WOMAN DREAM HAIR prêt sur le port ${port}.`);
  } catch (error) {
    databaseReady = false;
    console.error('Initialisation WOMAN DREAM HAIR impossible:', error.message);
  }
});

process.on('SIGTERM', async () => { await pool.end(); server.close(() => process.exit(0)); });
