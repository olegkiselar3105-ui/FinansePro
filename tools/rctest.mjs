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
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8') + '\nexport const _t = { finishReceipts, rcData, RC_HTML, RC_PUB, store, cmdFinish, profClean };\n');
const W = await import(tmp); fs.unlinkSync(tmp);
const env = { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', APP_URL: 'https://a.example/' };
const ctx = { ps: [], waitUntil(p) { this.ps.push(p.catch(() => {})); } };
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
const msg = async (uid, text) => W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: Math.floor(Date.now() / 1000), from: { id: uid }, chat: { id: uid, type: 'private' }, text } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
const z = zlib.deflateSync(Buffer.from(W._t.RC_HTML), { level: 9 }).length;
assert(Buffer.byteLength(W._t.RC_HTML) <= 32768 && z <= 4096, `html ${Buffer.byteLength(W._t.RC_HTML)} B, zlib ${z} B`);
assert(W._t.RC_HTML.includes('TelegramWidget') && !/[а-я]{3,}/i.test(W._t.RC_HTML.replace(/Обновите Telegram|Подождите пару секунд|Не получилось, попробуйте ещё раз|Применится, когда откроется приложение|Категория|Дата|Не записывать|Убрать|Отменить|Записать|Не отменять|Открыть|Да, не записывать|Да, отменить|Нет|Пн Вт Ср Чт Пт Сб Вс/g, '')), 'в HTML — только подписи меню, тексты статусов приходят в данных');
// 1) фраза → виджет «в очереди»
await msg(7, 'кофе 300 кафе');
const sw = sent.find(x => x.m === 'sendWidget');
assert(sw && JSON.parse(sw.chat_data).s === 'q' && sw.caption.includes('кофе 300') && sw.allow_queries && JSON.parse(sw.public_data).i.K && !sw.reply_markup, 'sendWidget: статус q, подпись, запросы виджета, значки в public_data');
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
env.WIDGETS = '1'; env.WQ = '0'; failWidget = false; sent = [];   // v267–v269: режим кнопок Telegram под сообщением
await msg(11, 'кофе 300 кафе');
const sid = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 11").get(), b11 = W._t.store(env, 11);
const act = { k: [['food', '🛒 Продукты'], ['transport', '🚌 Транспорт']], td: '2026-11-11', d: '2026-11-11', v: '1700' };
sent = []; await W._t.finishReceipts(env, b11, [sid.id], [], { [sid.id]: 'x' }, [], [], { [sid.id]: { ...card, a: act } });
const capE = sent.find(x => x.m === 'editMessageCaption');
assert(capE && capE.reply_markup && capE.reply_markup.inline_keyboard[0][0].callback_data === 'rc:K', 'ok «сразу»: кнопки под карточкой');
assert(db.prepare("SELECT act FROM rcpt WHERE CAST(uid AS REAL) = 11").get().act.includes('food'), 'квитанция осталась, act сохранён');
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
assert(res.cmds.some(c => c.op === 'del') && /отменится/.test(sent.find(x => x.m === 'editMessageCaption').caption) && !/категория/.test(sent.find(x => x.m === 'editMessageCaption').caption), 'отмена важнее правок (в подписи — только отмена)');
await cb('rc:U'); res = await b11.list(0); assert(!res.cmds.some(c => c.op === 'del') && res.cmds.length === 2, '«Не отменять» снимает отмену, правки остаются');
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
// ---------- v269: предпросмотр фразы в боте и правки до открытия приложения ----------
const PROF = { c: [['cafe', '🍽️', 'Кафе и рестораны', 0, '#e0703c'], ['food', '🛒', 'Продукты', 0, '#8a5cf0'], ['transport', '🚌', 'Транспорт', 0, '#3c8ce0'], ['salary', '💼', 'Зарплата', 1, '#2fa65a']],
  d: [['кафе и рестораны', 'cafe', 3], ['кафе', 'cafe', 2], ['продукты', 'food', 3], ['транспорт', 'transport', 3], ['зарплата', 'salary', 3], ['такси', 'transport', 0], ['кофейня', 'cafe', 0]],
  cur: 'MDL', tz: -120, cx: 'евро|eur|€|доллар\\S*|usd|\\$', sk: '^(?:вчера|позавчера|сегодня|домой)$', ir: ['(^|\\s)(получил|доход)', '(^|\\s)(зарплат|аванс)'] };
const U = 21, bU = W._t.store(env, U); await bU.rc.setProf(JSON.stringify(W._t.profClean(PROF)));
const say = async t => { sent = []; await msg(U, t); const w = sent.find(x => x.m === 'sendWidget'); return w ? { d: JSON.parse(w.chat_data), kb: w.reply_markup } : null; };
let pv = await say('кофе 300 кафе');
assert(pv.d.o[0][1] === '−300 MDL' && pv.d.o[0][4] === 'Кафе и рестораны' && /Кофе · сегодня/.test(pv.d.o[0][5]) && pv.kb.inline_keyboard[0][0].callback_data === 'rc:K', 'предпросмотр: сумма, категория, дата, кнопки');
assert(pv.kb.inline_keyboard.at(-1)[0].web_app, 'в очереди — кнопка «Открыть финансы»');
pv = await say('кофе 300 зузубра');
assert(pv.d.o[0][2] === '❓' && /зузубра/.test(pv.d.o[0][4]) && pv.kb.inline_keyboard[0][0].callback_data === 'rc:c:0' && pv.kb.inline_keyboard.flat().some(b => b.callback_data === 'rc:X'), 'неузнанное слово: сразу сетка категорий');
const rz = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 21 ORDER BY at DESC").get();
const cbU = async (data, mid) => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ callback_query: { id: 'q', from: { id: U }, data, message: { message_id: mid, chat: { id: U, type: 'private' }, widget: { html: '' } } } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
await cbU('rc:c:1', rz.mid);
let wd = sent.find(x => x.m === 'editMessageWidgetData'), cap = sent.find(x => x.m === 'editMessageCaption');
assert(wd && JSON.parse(wd.chat_data).o[0][4] === 'Продукты' && JSON.parse(wd.chat_data).o[0][2] === '🛒' && JSON.parse(wd.chat_data).s === 'q', 'выбрал категорию — карточка сразу показывает её');
assert(cap && cap.caption.startsWith('⏳ В очереди') && /категория — 🛒 Продукты/.test(cap.caption) && cap.reply_markup.inline_keyboard[0][0].callback_data === 'rc:K', 'подпись «в очереди» + правка, кнопки обычные');
await cbU('rc:d:' + new Date(Date.now() + 7200e3 - 864e5).toISOString().slice(0, 10), rz.mid);
assert(/вчера/.test(JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data).o[0][5]), 'дата — сразу в карточке');
await cbU('rc:X', rz.mid); assert(sent.find(x => x.m === 'editMessageReplyMarkup').reply_markup.inline_keyboard[0][0].text === 'Да, не записывать', '«Не записывать» — подтверждение');
await cbU('rc:Y', rz.mid); assert(JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data).s === 'un' && sent.find(x => x.m === 'editMessageCaption').reply_markup.inline_keyboard[0][0].callback_data === 'rc:U', 'не записывать: карточка и «Всё-таки записать»');
await cbU('rc:U', rz.mid); assert(/категория — 🛒 Продукты/.test(sent.find(x => x.m === 'editMessageCaption').caption), '«Всё-таки записать» — правки вернулись'); const pq = (await bU.list(0)).cmds;
assert(pq.length === 2 && pq.every(c => c.v === 'q') && pq.some(c => c.op === 'cat' && c.val === 'food'), 'в /api/pending — правки с v:q');
pv = await say('кофе 300'); assert(pv.d.o[0][4] === 'Категорию подберёт приложение' && pv.d.o[0][1] === '300 MDL', 'без слова после суммы — категория за приложением');
pv = await say('зарплата 5000 зарплата'); assert(pv.d.o[0][1].replace(/\s/g, ' ') === '+5 000 MDL' && pv.d.o[0][0] === 1, 'доход по категории: +5 000');
pv = await say('такси 100'); assert(pv.d.o[0][4] === 'Категорию подберёт приложение', '«такси 100»: слово до суммы — заметка');
pv = await say('обед 1 200 кафе вчера'); assert(pv.d.o[0][1].replace(/\s/g, ' ') === '−1 200 MDL' && /вчера/.test(pv.d.o[0][5]), '«1 200» и «вчера»');
for (const t of ['кофе 5 евро кафе', 'такси 100 и обед 200', 'одолжил Ивану 500', 'бюджет 20000', 'кофе 300 12.11', 'пятьсот на кафе']) {
  pv = await say(t); assert(pv && !pv.d.o && !pv.d.a && pv.d.q && pv.kb.inline_keyboard.length === 1, `без предпросмотра: «${t}»`); }
// приложение забрало фразу и применило правки (preDone) — команды удаляются, квитанция по обычному пути
sent = []; await W._t.cmdFinish(env, bU, pq, {}, {}); assert(!(await bU.list(0)).cmds, 'preDone: команды удалены');
// черновик поправлен из бота, но всё ещё на проверке → «h» с кнопками
await W._t.cmdFinish(env, bU, [], { [rz.id]: 'h' }, { [rz.id]: { o: [[0, '−300 MDL', '❓', '', '«зузубра» — категория?', '', 0, '']], a: { k: [['food', '🛒 Продукты', '🛒', 'Продукты', '']], td: '2026-11-11', d: '2026-11-11', v: 'q', n: 'Кофе', w: 'зузубра' } } });
assert(sent.find(x => x.m === 'editMessageCaption' && x.caption.startsWith('📝')).reply_markup.inline_keyboard[0][0].callback_data === 'rc:K', 'черновик на проверке — кнопки');
// без словаря (приложение ещё не прислало) — как раньше
pv = await say.call(null, 'x'); await bU.rc.setProf(null); pv = await say('кофе 300 кафе'); assert(!pv.d.o && !pv.d.a, 'без словаря — без предпросмотра');
// ---------- v270: меню внутри карточки (запросы виджета) ----------
env.WQ = '1'; const V = 31, bV = W._t.store(env, V); await bV.rc.setProf(JSON.stringify(W._t.profClean(PROF)));
assert(Buffer.byteLength(W._t.RC_PUB) <= 1024, `значки в public_data: ${Buffer.byteLength(W._t.RC_PUB)} байт`);
sent = []; await msg(V, 'кофе 300 зузубра'); let sw2 = sent.find(x => x.m === 'sendWidget'), d2 = JSON.parse(sw2.chat_data);
assert(sw2.allow_queries && !sw2.reply_markup && d2.a && d2.a.k.length >= 3 && d2.a.st === 'q' && d2.a.p.c === -1 && d2.q, 'в очереди: меню в данных карточки, без кнопок Telegram');
assert(Buffer.byteLength(sw2.chat_data) <= 1024, `chat_data ${Buffer.byteLength(sw2.chat_data)} байт`);
const rv = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 31").get();
const wq = async data => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'wq1', from: { id: V }, chat: { id: V, type: 'private' }, message_id: rv.mid, chat_instance: 'x', type: { type: 'data' }, data } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
await wq('c:1');
let an = sent.find(x => x.m === 'answerWidgetQuery'), ed2 = sent.find(x => x.m === 'editMessageWidgetData');
assert(an && JSON.parse(an.data).ok && sent.indexOf(an) < sent.indexOf(ed2), 'запрос: ответ виджету — раньше перерисовки');
let dd = JSON.parse(ed2.chat_data);
assert(dd.a.p.c === 1 && dd.o[0][4] === dd.a.k[1][1] && /категория/.test(sent.find(x => x.m === 'editMessageCaption').caption), 'категория: карточка, меню (p.c) и подпись');
const yd2 = new Date(Date.now() + 7200e3 - 864e5).toISOString().slice(0, 10);
await wq('d:' + yd2); dd = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data);
assert(dd.a.p.d === yd2 && /вчера/.test(dd.o[0][5]), 'дата: p.d и подпись строки');
await wq('d:2099-01-01'); assert(JSON.parse(sent.find(x => x.m === 'answerWidgetQuery').data).e === 'bad', 'будущая дата отклонена');
await wq('x'); dd = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data);
assert(dd.s === 'un' && dd.a.p.x === 1, 'не записывать: статус и p.x');
await wq('u'); dd = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data);
assert(dd.a.p.x === 0 && dd.a.p.c === 1, 'вернуть: правки на месте');
await wq('zz'); assert(JSON.parse(sent.find(x => x.m === 'answerWidgetQuery').data).e === 'bad', 'непонятный запрос — e:bad');
sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'wq2', from: { id: 77 }, chat: { id: V, type: 'private' }, message_id: rv.mid, data: 'x' } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
assert(JSON.parse(sent.find(x => x.m === 'answerWidgetQuery').data).e === 'old' && !(await W._t.store(env, 77).list(0)).cmds, 'чужой запрос — отказ');
// записано (ack приложения) — меню st:ok, без кнопок Telegram
const cmdsV = (await bV.list(0)).cmds; await W._t.cmdFinish(env, bV, cmdsV, {}, {});
sent = []; await W._t.finishReceipts(env, bV, [rv.id], [], { [rv.id]: 'x' }, [], [], { [rv.id]: { o: [[0, '−300 MDL', '🛒', '#8a5cf0', 'Продукты', 'Кофе', 0, '']], a: { k: [['cafe', '🍽️ Кафе', '🍽️', 'Кафе', '']], td: '2026-11-11', d: '2026-11-10', v: '99', n: 'Кофе' } } });
dd = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data); const capOk = sent.find(x => x.m === 'editMessageCaption');
assert(dd.a.st === 'ok' && dd.a.k[0][1] === 'Кафе' && capOk.caption.startsWith('✅') && !capOk.reply_markup, 'записано: меню st:ok, без кнопок Telegram');
