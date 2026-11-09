// Проверка статистики бота: D1 на node:sqlite, время подменено. Запуск: node tools/stattest.mjs (Node 22+)
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:'); let writes = 0;
const mk = sql => { const st = { a: [], bind(...a) { return { ...st, a }; },
  runS() { const r = db.prepare(sql).run(...this.a); writes += Number(r.changes); return { meta: { changes: r.changes } }; },
  async run() { return this.runS(); }, async first() { return db.prepare(sql).get(...this.a) ?? null; }, async all() { return { results: db.prepare(sql).all(...this.a) }; } }; return st; };
const DB = { prepare: mk, batch: async l => { db.exec('BEGIN'); try { const o = l.map(s => s.runS()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
mk.prototype; const P = DB.prepare; DB.prepare = sql => { const s = P(sql); s.sql = sql; const b = s.bind; s.bind = (...a) => { const r = b.call(s, ...a); r.sql = sql; return r; }; return s; };
let sent = []; globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); };
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const src = new URL('../worker/worker.js', import.meta.url), tmp = path.join(os.tmpdir(), 'fp-worker-test-' + process.pid + '.mjs');
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8') + '\nexport const _t = { mark, rollup, statsText };\n');
const W = await import(tmp); fs.unlinkSync(tmp);
const env = { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', STATS_SALT: 'salt123', OWNER_ID: '42', DAILY_LIMIT: '30' };
let NOW = Date.parse('2026-10-01T10:00:00Z'); const RD = Date; globalThis.Date = class extends RD { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } };
const ctx = { ps: [], waitUntil(p) { this.ps.push(p); } }; const flush = async () => { await Promise.all(ctx.ps); ctx.ps = []; };
const botMsg = async (uid, text, voice) => { await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: NOW / 1000 | 0, from: { id: uid }, chat: { id: uid, type: 'private' }, ...(voice ? { voice: { file_id: 'f', duration: 3 } } : { text }) } }) }), env, ctx); await flush(); };
const day = async n => { NOW += 864e5 * n; await W.default.scheduled({}, env, ctx); await flush(); };
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
// день 1: 3 пользователя, uid 1 пишет 3 раза, 2 — 1 раз; 3 — только приложение (mark напрямую)
writes = 0; for (let i = 0; i < 3; i++) await botMsg(1, 'кофе 300'); await botMsg(2, 'такси 100'); await botMsg(2, '/start');
await W._t.mark(env, 3, 'app'); await W._t.mark(env, 3, 'app'); await W._t.mark(env, 1, 'app');
const actW = db.prepare('SELECT COUNT(*) c FROM act').get().c; assert(actW === 3, 'act rows 3');
const raw = db.prepare("SELECT * FROM act").all(); assert(raw.every(r => r.h.length === 16 && !/^\d+$/.test(r.h)), 'only hashes');
assert(JSON.stringify(db.prepare("SELECT * FROM act WHERE bot=1 AND app=1").all().length) === '1', 'uid1 bot+app');
// повтор в "другом экземпляре": очищаем память — запись не должна добавиться
let w0 = writes; await W._t.mark(env, 1, 'bot'); assert(writes === w0, 'dup mark no write (cache)');
await day(1);   // rollup за день 1
const a1 = db.prepare('SELECT * FROM agg').all();
assert(a1.length >= 1 && a1.find(r => r.day === '2026-10-01').msgs === 4 && a1.find(r => r.day === '2026-10-01').users === 3 && a1.find(r => r.day === '2026-10-01').new === 3, 'agg day1');
// голос (транскрипция не настроена — fetch мок, groq вернёт ok без text → «не смог разобрать», но счётчик уже учтён)
await botMsg(2, null, true); await botMsg(4, 'новый 50');
// 7 дней спустя: uid1 возвращается
await day(7); await botMsg(1, 'хлеб 20');
await day(1); await day(30); await botMsg(2, 'ещё 1');

// владелец/чужой
sent = []; await botMsg(5, '/stats'); assert(sent.length === 0, 'non-owner silent');
await botMsg(42, '/stats'); assert(sent.some(m => /Статистика/.test(m.text)), 'owner gets stats');
// уборка 90 дней
await day(95); assert(db.prepare("SELECT COUNT(*) c FROM act WHERE day < '2026-10-05'").get().c === 0, 'act >90 deleted');
assert(db.prepare('SELECT COUNT(*) c FROM agg').get().c > 3, 'agg kept');
assert(db.prepare("SELECT COUNT(*) c FROM cnt WHERE day < ?").get(new Date(NOW - 2*864e5).toISOString().slice(0,10)).c === 0, 'cnt >2d deleted');
console.log('usr left', db.prepare('SELECT COUNT(*) c FROM usr').get().c);

// --- сценарий 2: возврат и суммы за 7/30 дней (новая база) ---
for (const t of ['act','usr','agg','cnt','msgs','rcpt']) db.exec('DELETE FROM ' + t);
NOW = Date.parse('2026-10-01T10:00:00Z');
// день 0: 1,2,3 новые; 1 — голос; дни 1..9 каждый день пишет 2 (1 сообщение)
await botMsg(1, 'a 1'); await botMsg(1, null, true); await botMsg(2, 'b 2'); await botMsg(3, 'c 3');
for (let i = 1; i <= 9; i++) { await day(1); await botMsg(2, 'x ' + i); }
await botMsg(1, 'вернулся 5');   // день 9: uid1 через 9 дней
const s = await W._t.statsText(env);
assert(/Всего людей +2 +2 +3/.test(s), 'users today 2 / 7d 2 / 30d 3');
assert(/Сообщений боту +2 +8 +14/.test(s) && / из них голосом +0 +0 +1/.test(s), 'msgs 2/8/14, voice 0/0/1'); 
assert(/7 дн +▓{7}░{3} +67% +2 из 3/.test(s), 'ret7 = 2 of 3'); assert(s.length < 4096, 'fits telegram ' + s.length); if (process.env.SHOW) console.log(s);
