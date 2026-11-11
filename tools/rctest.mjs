// Проверка квитанций-карточек бота (виджеты Bot API 10.4, v265): Telegram подменён, D1 на node:sqlite. Запуск: node tools/rctest.mjs
import { DatabaseSync } from 'node:sqlite'; import zlib from 'node:zlib';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const db = new DatabaseSync(':memory:');
const mk = sql => { const st = { a: [], bind(...a) { return { ...st, a }; }, runS() { db.prepare(sql).run(...this.a); return {}; },
  async run() { return this.runS(); }, async first() { return db.prepare(sql).get(...this.a) ?? null; }, async all() { return { results: db.prepare(sql).all(...this.a) }; } }; return st; };
const DB = { prepare: mk, batch: async l => l.map(s => s.runS()) };
let sent = [], failWidget = false, mid = 100;
globalThis.fetch = async (u, o) => { const m = String(u).split('/').pop(), b = JSON.parse(o.body); sent.push({ m, ...b });
  if (failWidget && /Widget/.test(m)) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: method not found' }));
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++mid } })); };
const src = new URL('../worker/worker.js', import.meta.url), tmp = path.join(os.tmpdir(), 'fp-rc-test-' + process.pid + '.mjs');
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8') + '\nexport const _t = { finishReceipts, rcData, RC_HTML, store, cmdFinish };\n');
const W = await import(tmp); fs.unlinkSync(tmp);
const env = { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', APP_URL: 'https://a.example/' };
const ctx = { ps: [], waitUntil(p) { this.ps.push(p.catch(() => {})); } };
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
const msg = async (uid, text) => W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: 1, from: { id: uid }, chat: { id: uid, type: 'private' }, text } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
const z = zlib.deflateSync(Buffer.from(W._t.RC_HTML), { level: 9 }).length;
assert(Buffer.byteLength(W._t.RC_HTML) <= 32768 && z <= 4096, `html ${Buffer.byteLength(W._t.RC_HTML)} B, zlib ${z} B`);
assert(W._t.RC_HTML.includes('\\n• «кофе'), 'перенос строки в скрипте виджета остался \\n');
// 1) фраза → виджет «в очереди»
await msg(7, 'кофе 300 кафе');
const sw = sent.find(x => x.m === 'sendWidget');
assert(sw && JSON.parse(sw.chat_data).s === 'q' && sw.caption.includes('кофе 300') && sw.reply_markup, 'sendWidget: статус q, подпись, кнопка');
assert(!sent.some(x => x.m === 'sendMessage'), 'текстом не дублируется');
const box = W._t.store(env, 7), id = db.prepare('SELECT id FROM rcpt').get().id;
// 2) на проверке → карточка с черновиком
sent = []; const card = { o: [[0, '−300 MDL', '🍽️', '#e0703c', 'Кафе и рестораны', 'сегодня', 0, '']] };
await W._t.finishReceipts(env, box, [id], [], { [id]: 'текст' }, [id], [], { [id]: card });
let e = sent.find(x => x.m === 'editMessageWidgetData'), d = e && JSON.parse(e.chat_data);
assert(d && d.s === 'h' && d.o[0][1] === '−300 MDL' && !d.n, 'hold: карточка без текста notes');
assert(sent.some(x => x.m === 'editMessageCaption' && x.caption.startsWith('📝')), 'hold: подпись');
// 3) записано → карточка с бюджетом; квитанция удалена
sent = []; await W._t.finishReceipts(env, box, [id], [], { [id]: 'x' }, [], [], { [id]: { ...card, b: [0.45, 'Бюджет на ноябрь', '4 500 из 10 000 MDL', 'осталось 5 500 MDL'] } });
d = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data);
assert(d.s === 'ok' && d.b[0] === 0.45, 'ok: бюджет');
assert(!db.prepare('SELECT 1 FROM rcpt').get(), 'квитанция удалена');
// 4) старое приложение (без cards) → текст notes в карточке, ≤1024 байт
const j = W._t.rcData('ok', undefined, 'ж'.repeat(1200));
assert(Buffer.byteLength(j) <= 1024 && JSON.parse(j).n.length > 100, `notes обрезаны до ${Buffer.byteLength(j)} байт`);
const big = W._t.rcData('ok', { o: Array(4).fill([0, 'ж'.repeat(40), '🍽️', '#aaaaaa', 'ж'.repeat(40), 'ж'.repeat(80), 1, 'ж'.repeat(80)]), b: [1, 'ж'.repeat(40), 'ж'.repeat(60), 'ж'.repeat(60)], n: 'ж'.repeat(600) });
assert(Buffer.byteLength(big) <= 1024, `большая карточка ${Buffer.byteLength(big)} байт`);
assert(JSON.parse(W._t.rcData('ok', { o: [[0, '1', '<b>', 'red;x', 'a', '', 0, '']] })).o[0][3] === '', 'цвет не из #rrggbb отброшен');
// 5) виджет не поддерживается → текст, как раньше; правка — editMessageText
failWidget = true; sent = []; await msg(8, 'такси 120');
assert(sent.some(x => x.m === 'sendMessage' && x.text.startsWith('⏳')), 'запасной путь: текст');
const id2 = db.prepare('SELECT id FROM rcpt').get().id; sent = [];
await W._t.finishReceipts(env, W._t.store(env, 8), [id2], [id2], {}, [], [], {});
assert(sent.some(x => x.m === 'editMessageText' && x.text.startsWith('⚠')), 'запасной путь: editMessageText');
// 6) выключатель WIDGETS=0
failWidget = false; sent = []; env.WIDGETS = '0'; await msg(9, 'хлеб 20');
assert(!sent.some(x => x.m === 'sendWidget') && sent.some(x => x.m === 'sendMessage'), 'WIDGETS=0 — без виджета');
// ---------- v267: кнопки карточки (категория, дата, отмена) ----------
env.WIDGETS = '1'; failWidget = false; sent = [];
await msg(11, 'кофе 300 кафе');
const sid = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 11").get(), b11 = W._t.store(env, 11);
const act = { k: [['food', '🛒 Продукты'], ['transport', '🚌 Транспорт']], td: '2026-11-11', d: '2026-11-11', v: '1700' };
sent = []; await W._t.finishReceipts(env, b11, [sid.id], [], { [sid.id]: 'x' }, [], [], { [sid.id]: { ...card, a: act } });
const capE = sent.find(x => x.m === 'editMessageCaption');
assert(capE && capE.reply_markup && capE.reply_markup.inline_keyboard[0][0].callback_data === 'rc:K', 'ok «сразу»: кнопки под карточкой');
assert(db.prepare("SELECT act FROM rcpt WHERE CAST(uid AS REAL) = 11").get().act.includes('food'), 'квитанция осталась, act сохранён');
assert(sent.some(x => x.m === 'getWebhookInfo'), 'проверка callback_query в webhook');
const cb = async data => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ callback_query: { id: 'q', from: { id: 11 }, data, message: { message_id: sid.mid, chat: { id: 11, type: 'private' }, widget: { html: '' } } } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
await cb('rc:D'); let kb = sent.find(x => x.m === 'editMessageReplyMarkup').reply_markup.inline_keyboard;
const flat = kb.flat();
assert(kb[0][1].text === 'Ноябрь 2026' && flat.some(x => x.text === '•11•') && !flat.some(x => x.callback_data === 'rc:d:2026-11-12') && flat.some(x => x.text === '·'), 'календарь: месяц, отмечен день записи, будущее недоступно');
assert(kb.every(r => r.every(x => x.text.trim() !== '' && Buffer.byteLength(x.callback_data) <= 64)), 'кнопки: текст не пустой, callback_data ≤64 байт');
assert(kb[0][2].callback_data === 'rc:n' && kb[0][0].callback_data === 'rc:M:2026-10', 'вперёд нельзя, назад — октябрь');
await cb('rc:M:2026-10'); kb = sent.find(x => x.m === 'editMessageReplyMarkup').reply_markup.inline_keyboard;
assert(kb[0][1].text === 'Октябрь 2026' && kb[2][3].text === '1' && kb[2][2].text === '\u2800', 'октябрь 2026 начинается с четверга');
await cb('rc:d:2026-11-09');
let c1 = sent.find(x => x.m === 'editMessageCaption');
assert(c1 && /дата — 9 ноя/.test(c1.caption), 'дата: подпись «⏳ … дата — 9 ноя»');
await cb('rc:K'); await cb('rc:c:1');
c1 = sent.find(x => x.m === 'editMessageCaption');
assert(/категория — 🚌 Транспорт/.test(c1.caption) && /дата — 9 ноя/.test(c1.caption), 'категория + дата в подписи');
let res = await b11.list(0); assert(res.cmds && res.cmds.length === 2 && res.cmds.every(c => c.v === '1700'), '/api/pending отдаёт 2 команды с версией');
await cb('rc:X'); assert(sent.find(x => x.m === 'editMessageReplyMarkup').reply_markup.inline_keyboard[0][0].callback_data === 'rc:Y', 'отмена: подтверждение');
await cb('rc:Y'); res = await b11.list(0);
assert(res.cmds.length === 1 && res.cmds[0].op === 'del' && /отменится/.test(sent.find(x => x.m === 'editMessageCaption').caption), 'отмена вытесняет правки');
await cb('rc:U'); res = await b11.list(0); assert(!res.cmds, '«Не отменять» снимает команду');
await cb('rc:c:0'); res = await b11.list(0);
// приложение применило: ok → новая карточка с кнопками
sent = []; await W._t.cmdFinish(env, b11, res.cmds, { [sid.id]: 'ok' }, { [sid.id]: { ...card, a: { ...act, v: '1800' } } });
assert(!(await b11.list(0)).cmds && sent.some(x => x.m === 'editMessageWidgetData') && sent.find(x => x.m === 'editMessageCaption').reply_markup, 'применено: карточка обновлена, кнопки на месте');
assert(JSON.parse(db.prepare("SELECT act FROM rcpt WHERE CAST(uid AS REAL) = 11").get().act).v === '1800', 'новая версия записи в act');
// нажатие после того, как приложение забрало команды, не теряется
await cb('rc:c:1'); const pend = (await b11.list(0)).cmds; await cb('rc:d:2026-11-10');
sent = []; await W._t.cmdFinish(env, b11, pend, { [sid.id]: 'ok' }, {});
assert((await b11.list(0)).cmds.length === 1 && !sent.some(x => x.m === 'editMessageWidgetData'), 'новое нажатие остаётся в очереди, карточку не трогаем');
// gone → подпись, кнопки убраны, квитанция удалена
sent = []; await W._t.cmdFinish(env, b11, (await b11.list(0)).cmds, { [sid.id]: 'gone' }, {});
assert(/уже изменили/.test(sent.find(x => x.m === 'editMessageCaption').caption) && !sent.find(x => x.m === 'editMessageCaption').reply_markup && !db.prepare("SELECT 1 FROM rcpt WHERE CAST(uid AS REAL) = 11").get(), 'gone: подпись, без кнопок, квитанция удалена');
await cb('rc:K'); assert(sent.some(x => x.m === 'answerCallbackQuery' && /уже не изменить/.test(x.text || '')), 'старые кнопки отвечают «уже не изменить»');
// del → «↩ Отменено»
await msg(12, 'такси 120 транспорт'); const s12 = db.prepare("SELECT id FROM rcpt WHERE CAST(uid AS REAL) = 12").get().id, b12 = W._t.store(env, 12);
await W._t.finishReceipts(env, b12, [s12], [], {}, [], [], { [s12]: { ...card, a: act } });
sent = []; await W._t.cmdFinish(env, b12, [], { [s12]: 'del' }, {});
assert(sent.find(x => x.m === 'editMessageCaption').caption.startsWith('↩ Отменено') && JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data).n, 'del: «↩ Отменено», текст в карточке');
// чужой пользователь не может нажать на чужую карточку
await msg(13, 'хлеб 20 продукты'); const r13 = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 13").get();
await W._t.finishReceipts(env, W._t.store(env, 13), [r13.id], [], {}, [], [], { [r13.id]: { ...card, a: act } });
sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ callback_query: { id: 'q', from: { id: 99 }, data: 'rc:Y', message: { message_id: r13.mid, chat: { id: 13, type: 'private' } } } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
assert(!(await W._t.store(env, 13).list(0)).cmds && !(await W._t.store(env, 99).list(0)).cmds, 'чужое нажатие не создаёт команду');
