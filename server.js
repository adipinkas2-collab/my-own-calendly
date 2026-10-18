'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  process.loadEnvFile(path.join(__dirname, '.env'));
}

const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = 'Asia/Jerusalem';
const OWNER_NAME = process.env.OWNER_NAME || 'Adi';
const OWNER_TITLE = process.env.OWNER_TITLE || 'Content creator & strategist';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_PATH = path.resolve(__dirname, process.env.DATABASE_FILE || 'data/bookings.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = [
  { id: 'intro', title: 'שיחת היכרות', description: 'נכיר, נבין את הצרכים שלך ונבדוק התאמה', minutes: 30 },
  { id: 'session', title: 'פגישת עבודה', description: 'פגישה ממוקדת לעבודה משותפת', minutes: 60 }
];
const HOURS = { 0: ['09:00', '17:00'], 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'] }; // Sun–Thu
const SLOT_MINUTES = 30;
const MIN_NOTICE_HOURS = 2;
const MAX_DAYS_AHEAD = 45;
const MAX_BODY_BYTES = 16 * 1024;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec("CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, cancel_token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', type_id TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL);");
db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_window ON bookings(status, starts_at, ends_at);");

const publicConfig = () => ({
  ownerName: OWNER_NAME, ownerTitle: OWNER_TITLE, timeZone: TIMEZONE,
  types: TYPES, workdays: Object.keys(HOURS).map(Number), maxDaysAhead: MAX_DAYS_AHEAD,
  minNoticeHours: MIN_NOTICE_HOURS, today: zonedDate(new Date())
});

function partsInZone(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(formatter.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return p;
}
function zonedDate(date) {
  const p = partsInZone(date);
  return [p.year, String(p.month).padStart(2, '0'), String(p.day).padStart(2, '0')].join('-');
}
function dateIsValid(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const date = new Date(iso + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}
function dateDiffDays(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
function weekday(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function hmToMinutes(hm) {
  const a = hm.split(':').map(Number); return a[0] * 60 + a[1];
}
function minutesToHm(n) { return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }

// Convert an Israel-local date and hour to UTC, including daylight-saving changes.
function localToUtc(date, hm) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, h, min, 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsInZone(new Date(guess));
    const displayedAsUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= displayedAsUTC - target;
  }
  const p = partsInZone(new Date(guess));
  return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === min
    ? new Date(guess).toISOString() : null;
}
function upcomingSlots(date, type, now = new Date()) {
  if (!dateIsValid(date)) return [];
  const daysAhead = dateDiffDays(zonedDate(now), date);
  if (daysAhead < 0 || daysAhead > MAX_DAYS_AHEAD) return [];
  const hours = HOURS[weekday(date)];
  if (!hours || !type) return [];
  const reserved = db.prepare("SELECT starts_at, ends_at FROM bookings WHERE status='confirmed' AND starts_at < ? AND ends_at > ?").all(
    localToUtc(date, '23:59') || date + 'T23:59:59Z', localToUtc(date, '00:00') || date + 'T00:00:00Z'
  );
  const result = [];
  for (let n = hmToMinutes(hours[0]); n + type.minutes <= hmToMinutes(hours[1]); n += SLOT_MINUTES) {
    const hour = minutesToHm(n);
    const startIso = localToUtc(date, hour);
    if (!startIso) continue;
    const start = Date.parse(startIso);
    const end = start + type.minutes * 60000;
    if (start < now.getTime() + MIN_NOTICE_HOURS * 3600000) continue;
    if (reserved.some(b => Date.parse(b.starts_at) < end && Date.parse(b.ends_at) > start)) continue;
    result.push({ time: hour, startsAt: startIso });
  }
  return result;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
  }, headers));
  res.end(JSON.stringify(body));
}
function bad(res, status, msg) { send(res, status, { error: msg }); }
async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function isAdmin(req) {
  if (!ADMIN_KEY || ADMIN_KEY.length < 16) return false;
  const entered = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = Buffer.from(entered); const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function clean(value, max) { return typeof value === 'string' ? value.trim().slice(0, max + 1) : ''; }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }

const hits = new Map();
function rateLimited(req, limit = 30, windowMs = 60000) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const data = hits.get(ip);
  if (!data || now - data.at > windowMs) { hits.set(ip, { at: now, n: 1 }); return false; }
  data.n += 1;
  return data.n > limit;
}
const FILES = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/admin': ['admin.html', 'text/html'], '/admin.html': ['admin.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'],
  '/admin.js': ['admin.js', 'text/javascript'] };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      if (rateLimited(req, req.method === 'POST' ? 10 : 100)) return bad(res, 429, 'יותר מדי בקשות. נסו שוב בעוד דקה.');
      if (req.method === 'GET' && pathname === '/api/config') return send(res, 200, publicConfig());
      if (req.method === 'GET' && pathname === '/api/availability') {
        const date = url.searchParams.get('date');
        const type = TYPES.find(t => t.id === url.searchParams.get('type'));
        if (!dateIsValid(date) || !type) return bad(res, 400, 'תאריך או סוג פגישה אינם תקינים');
        return send(res, 200, { date, slots: upcomingSlots(date, type) });
      }
      if (req.method === 'POST' && pathname === '/api/bookings') {
        const input = await jsonBody(req);
        const type = TYPES.find(t => t.id === input.type);
        const date = clean(input.date, 10);
        const time = clean(input.time, 5);
        const name = clean(input.name, 100);
        const email = clean(input.email, 254).toLowerCase();
        const note = clean(input.note || '', 1000);
        if (!type || !dateIsValid(date) || !/^\d{2}:\d{2}$/.test(time) ||
            name.length < 2 || name.length > 100 || !validEmail(email) || note.length > 1000) {
          return bad(res, 400, 'חסרים פרטים או שחלק מהשדות אינם תקינים');
        }
        let booking;
        db.exec('BEGIN IMMEDIATE');
        try {
          const slot = upcomingSlots(date, type).find(s => s.time === time);
          if (!slot) {
            db.exec('ROLLBACK');
            return bad(res, 409, 'השעה הזו כבר אינה זמינה. בחרו שעה אחרת.');
          }
          const endIso = new Date(Date.parse(slot.startsAt) + type.minutes * 60000).toISOString();
          const id = crypto.randomUUID();
          const token = crypto.randomBytes(24).toString('hex');
          db.prepare("INSERT INTO bookings(id, cancel_token, name, email, note, type_id, starts_at, ends_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)")
            .run(id, token, name, email, note, type.id, slot.startsAt, endIso, new Date().toISOString());
          db.exec('COMMIT');
          booking = { id, cancelToken: token, type: type.title, date, time, minutes: type.minutes };
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 201, { booking });
      }
      if (req.method === 'POST' && pathname.startsWith('/api/cancel/')) {
        const token = pathname.split('/').pop();
        if (!/^[a-f0-9]{48}$/.test(token)) return bad(res, 404, 'ההזמנה לא נמצאה');
        const result = db.prepare("UPDATE bookings SET status='cancelled' WHERE cancel_token=? AND status='confirmed'").run(token);
        return result.changes ? send(res, 200, { ok: true }) : bad(res, 404, 'ההזמנה לא נמצאה או כבר בוטלה');
      }
      if (pathname === '/api/admin/bookings' && req.method === 'GET') {
        if (!isAdmin(req)) return bad(res, 401, 'סיסמת ניהול שגויה');
        const bookings = db.prepare("SELECT id, name, email, note, type_id, starts_at, ends_at, status FROM bookings ORDER BY starts_at DESC LIMIT 200").all();
        return send(res, 200, { bookings });
      }
      if (pathname.startsWith('/api/admin/cancel/') && req.method === 'POST') {
        if (!isAdmin(req)) return bad(res, 401, 'סיסמת ניהול שגויה');
        const id = pathname.split('/').pop();
        const result = db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='confirmed'").run(id);
        return result.changes ? send(res, 200, { ok: true }) : bad(res, 404, 'ההזמנה לא נמצאה');
      }
      return bad(res, 404, 'הכתובת לא נמצאה');
    }
    const file = FILES[pathname];
    if (req.method !== 'GET' || !file) return bad(res, 404, 'הכתובת לא נמצאה');
    const data = fs.readFileSync(path.join(PUBLIC_DIR, file[0]));
    res.writeHead(200, {
      'Content-Type': file[1] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(data);
  } catch (e) {
    if (e.message === 'BODY_TOO_LARGE') return bad(res, 413, 'הבקשה גדולה מדי');
    if (e instanceof SyntaxError) return bad(res, 400, 'בקשה לא תקינה');
    console.error(e);
    return bad(res, 500, 'אירעה שגיאה זמנית. נסו שוב.');
  }
});
if (require.main === module) server.listen(PORT, () => console.log('My Calendly listening on http://localhost:' + PORT));
module.exports = { server, db, upcomingSlots, localToUtc, zonedDate, TYPES };
