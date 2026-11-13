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
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8') + '\nexport const _t = { finishReceipts, rcData, RC_HTML, RC_DG, RC_PUB, RC_ST, store, cmdFinish, profClean, staleRemind, sumClean, evening, lkH, cardHtml, cardPub, CARD_TR, plxN, lgSet, dgPreview };\n');
const W = await import(tmp); fs.unlinkSync(tmp);
const env = { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', APP_URL: 'https://a.example/' };
const ctx = { ps: [], waitUntil(p) { this.ps.push(p.catch(() => {})); } };
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
const msg = async (uid, text) => W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: Math.floor(Date.now() / 1000), from: { id: uid }, chat: { id: uid, type: 'private' }, text } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
const z = zlib.deflateSync(Buffer.from(W._t.RC_HTML), { level: 9 }).length;
assert(Buffer.byteLength(W._t.RC_HTML) <= 32768 && z <= 4096, `html ${Buffer.byteLength(W._t.RC_HTML)} B, zlib ${z} B`);
assert(W._t.RC_HTML.includes('TelegramWidget') && !/[а-я]{3,}/i.test(W._t.RC_HTML.replace(/Обновите Telegram|Подождите пару секунд|Не получилось, попробуйте ещё раз|Применится, когда откроется приложение|Категория|Дата|Не записывать|Убрать|Отменить|Записать|Не отменять|Открыть|Да, не записывать|Да, отменить|Нет|Пн Вт Ср Чт Пт Сб Вс/g, '')), 'в HTML — только подписи меню, тексты статусов приходят в данных');
// 1) фраза → виджет «в очереди» (режим кнопок Telegram, WQ=0 — с подписью; режим меню — ниже, v270)
env.WQ = '0';
await msg(7, 'кофе 300 кафе');
const sw = sent.find(x => x.m === 'sendWidget');
assert(sw && JSON.parse(sw.chat_data).s === 'q' && sw.caption.includes('кофе 300') && sw.reply_markup && !sw.allow_queries, 'sendWidget (WQ=0): статус q, подпись, кнопка');
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
assert(pv.d.o[0][2] === '❓' && pv.d.o[0][4] === 'Категория?' && pv.kb.inline_keyboard[0][0].callback_data === 'rc:c:0' && pv.kb.inline_keyboard.flat().some(b => b.callback_data === 'rc:X'), 'неузнанное слово: сразу сетка категорий');
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
pv = await say('кофе 300'); assert(pv.d.o[0][4] === 'Продукты' && pv.d.o[0][1].replace(/\s/g, ' ') === '−300 MDL', 'v281: «кофе» уже выбирали в боте (Продукты) — бот помнит');
pv = await say('чай 300'); assert(pv.d.o[0][4] === 'Категорию подберёт приложение' && pv.d.o[0][1] === '300 MDL', 'без слова после суммы и без памяти — категория за приложением');
pv = await say('зарплата 5000 зарплата'); assert(pv.d.o[0][1].replace(/\s/g, ' ') === '+5 000 MDL' && pv.d.o[0][0] === 1, 'доход по категории: +5 000');
pv = await say('такси 100'); assert(pv.d.o[0][4] === 'Категорию подберёт приложение', '«такси 100»: слово до суммы — заметка');
pv = await say('обед 1 200 кафе вчера'); assert(pv.d.o[0][1].replace(/\s/g, ' ') === '−1 200 MDL' && /вчера/.test(pv.d.o[0][5]), '«1 200» и «вчера»');
for (const t of ['кофе 5 евро кафе', 'одолжил Ивану 500', 'бюджет 20000', 'кофе 300 12.11', 'пятьсот на кафе']) {
  pv = await say(t); assert(pv && !pv.d.o && !pv.d.a && pv.kb.inline_keyboard.length === 1, `без предпросмотра: «${t}»`); }
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
assert(sw2.allow_queries && !sw2.reply_markup && !sw2.caption && JSON.parse(sw2.public_data).i.K && d2.a && d2.a.k.length >= 3 && d2.a.st === 'q' && d2.a.p.c === -1 && d2.a.i === 0 && !d2.q, 'в очереди: только карточка — меню в данных, без подписи и кнопок Telegram');
assert(Buffer.byteLength(sw2.chat_data) <= 1024, `chat_data ${Buffer.byteLength(sw2.chat_data)} байт`);
const rv = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 31").get();
const wq = async data => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'wq1', from: { id: V }, chat: { id: V, type: 'private' }, message_id: rv.mid, chat_instance: 'x', type: { type: 'data' }, data } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
await wq('c:1');
let an = sent.find(x => x.m === 'answerWidgetQuery'), ed2 = sent.find(x => x.m === 'editMessageWidgetData');
assert(an && JSON.parse(an.data).ok && sent.indexOf(an) < sent.indexOf(ed2), 'запрос: ответ виджету — раньше перерисовки');
let dd = JSON.parse(ed2.chat_data);
assert(dd.a.p.c === 1 && dd.o[0][4] === dd.a.k[1][1] && !sent.some(x => x.m === 'editMessageCaption'), 'категория: карточка и меню (p.c), подпись не трогаем');
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
assert(dd.a.st === 'ok' && dd.a.k[0][1] === 'Кафе' && !capOk, 'записано: меню st:ok, без подписи и кнопок Telegram');
// ---------- v271: «−/+» — расход ↔ доход ----------
sent = []; await msg(V, 'кофе 300 кафе'); const rt = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 31 ORDER BY at DESC").get();
const wq2 = async data => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'wq3', from: { id: V }, chat: { id: V, type: 'private' }, message_id: rt.mid, data } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
  return JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data); };
let tdd = await wq2('t:i');
assert(tdd.a.i === 1 && tdd.o[0][0] === 1 && tdd.o[0][1].startsWith('+') && tdd.o[0][4] === 'Категория?' && tdd.a.p.t === 1, '«+»: доход, знак +, категорию выбрать заново');
const iInc = tdd.a.k.findIndex(c => c[2] === 1);
assert(iInc >= 0, 'в меню есть категории дохода');
tdd = await wq2('c:' + iInc); assert(tdd.o[0][4] === 'Зарплата' && tdd.a.i === 1, 'выбрал категорию дохода');
const pT = (await W._t.store(env, V).list(0)).cmds.filter(c => c.sid === rt.id);
assert(pT.some(c => c.op === 'type' && c.val === 'i') && pT.some(c => c.op === 'cat' && c.val === 'salary'), 'команды: type=i и cat=salary');
tdd = await wq2('t:e'); const pT2 = ((await W._t.store(env, V).list(0)).cmds || []).filter(c => c.sid === rt.id);
assert(tdd.a.i === 0 && tdd.o[0][1].startsWith('−') && tdd.o[0][4] === 'Кафе и рестораны' && !pT2.some(c => c.op === 'cat') && !pT2.some(c => c.op === 'type'), '«−» обратно: как было, лишние команды убраны');
tdd = await wq2('c:' + tdd.a.k.findIndex(c => c[2] === 1)); assert(tdd.a.i === 1 && tdd.o[0][1].startsWith('+'), 'категория дохода сама переключает на «+»');
// ---------- v272: без «Открыть»; отдельная карточка долгов и целей ----------
assert(!W._t.RC_HTML.includes('openTelegramLink') && !JSON.parse(W._t.RC_PUB).i.O, '«Открыть» убрана из карточки');
const zdg = zlib.deflateSync(Buffer.from(W._t.RC_DG), { level: 9 }).length; assert(zdg <= 4096, `карточка долгов/целей: zlib ${zdg} B`);
for (const t of ['одолжил Ивану 500', 'цель отпуск 50000', 'Маша вернула долг 300']) {
  sent = []; await msg(41, t); const s1 = sent.find(x => x.m === 'sendWidget'), d1 = JSON.parse(s1.chat_data);
  assert(s1.html === W._t.RC_DG && s1.allow_queries && !s1.caption && !s1.reply_markup && d1.s === 'q' && d1.ph === t, `«${t}» — карточка долгов/целей, в очереди`); }
sent = []; await msg(41, 'кофе 300 кафе'); assert(sent.find(x => x.m === 'sendWidget').html === W._t.RC_HTML, 'обычная фраза — обычная карточка');
const r41 = db.prepare("SELECT id FROM rcpt WHERE CAST(uid AS REAL) = 41 ORDER BY at").get();
sent = []; await W._t.finishReceipts(env, W._t.store(env, 41), [r41.id], [], { [r41.id]: '💸 Долг: Иван должен вам 500 MDL' }, [], [], { [r41.id]: { o: [], n: 'x', g: [{ k: 'd', w: 'Иван', i: 1, ev: 'new', e: '500 MDL', l: '500 MDL', t: '500 MDL', p: 0, due: '', c: 0, zz: 'лишнее' }] } });
const g41 = JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data);
assert(g41.s === 'ok' && g41.g[0].w === 'Иван' && g41.g[0].i === 1 && g41.g[0].ev === 'new' && !g41.g[0].zz && !sent.some(x => x.m === 'editMessageCaption'), 'записано: данные долга, лишние поля отброшены, без подписи');
// ---------- v273: «Вернули всё», «Другая сумма», «Пополнить» ----------
const U3 = 51, b3 = W._t.store(env, U3);
sent = []; await msg(U3, 'одолжил Ивану 500'); const r3 = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 51").get();
assert(sent.find(x => x.m === 'sendWidget').allow_queries, 'карточка долга — с запросами виджета');
const gD = { k: 'd', w: 'Иван', n: 'Иван', ln: 300, i: 1, ev: 'pay', e: '200 MDL', l: '300 MDL', t: '500 MDL', p: 0.4 }, gG = { k: 'g', w: 'Отпуск', n: 'Отпуск', ln: 45000, ev: 'in', e: '5 000 MDL', s: '5 000', t: '50 000 MDL', p: 0.1 };
sent = []; await W._t.finishReceipts(env, b3, [r3.id], [], {}, [], [], { [r3.id]: { o: [], g: [gD, gG] } });
const act3 = JSON.parse(db.prepare("SELECT act FROM rcpt WHERE CAST(uid AS REAL) = 51").get().act);
assert(act3.st === 'dg' && act3.g[0].ln === 300 && act3.g[1].n === 'Отпуск', 'квитанция долга/цели осталась для кнопок');
const wq3 = async data => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'q3', from: { id: U3 }, chat: { id: U3, type: 'private' }, message_id: r3.mid, data } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
const queued = () => db.prepare("SELECT text FROM msgs WHERE CAST(uid AS REAL) = 51 ORDER BY at").all().map(r => r.text);
await wq3('r:0:a');
assert(JSON.parse(sent.find(x => x.m === 'answerWidgetQuery').data).ok && JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data).g[0].x === 1, '«Вернули всё»: ответ, отметка «Отправлено»');
assert(queued().includes('Иван вернул 300') && sent.find(x => x.m === 'sendWidget' && x.html === W._t.RC_DG), '«Вернули всё»: фраза «Иван вернул 300» в очереди, новая карточка');
await wq3('r:0:o'); const ask = sent.find(x => x.m === 'sendMessage');
assert(ask && ask.reply_markup.force_reply && /Сколько вернул/.test(ask.text), '«Другая сумма»: вопрос с ответом');
const askMid = db.prepare("SELECT mid FROM asks WHERE CAST(uid AS REAL) = 51").get().mid;
const reply3 = async (text, to) => { sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: Math.floor(Date.now() / 1000), from: { id: U3 }, chat: { id: U3, type: 'private' }, text, reply_to_message: { message_id: to } } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0))); };
await reply3('ну где-то', askMid); assert(sent.some(x => x.m === 'sendMessage' && /цифрами/.test(x.text)), 'ответ без суммы — просим цифрами');
await reply3('1 500,5', askMid); assert(queued().includes('Иван вернул 1500.5'), 'ответ «1 500,5» → «Иван вернул 1500.5»');
assert(!db.prepare("SELECT 1 FROM asks WHERE CAST(uid AS REAL) = 51").get(), 'вопрос закрыт');
await wq3('p:1:o'); const ask2 = db.prepare("SELECT mid, tpl FROM asks WHERE CAST(uid AS REAL) = 51").get();
assert(ask2 && ask2.tpl === 'в цель Отпуск {n}', '«Пополнить»: шаблон «в цель Отпуск {n}»');
await reply3('5000', ask2.mid); assert(queued().includes('в цель Отпуск 5000'), 'пополнение цели — фраза в очереди');
await wq3('p:0:o'); assert(JSON.parse(sent.find(x => x.m === 'answerWidgetQuery').data).e === 'bad', '«Пополнить» у долга — отказ');
await reply3('кофе 300 кафе', 999999); assert(queued().includes('кофе 300 кафе'), 'обычный ответ на чужое сообщение — обычная фраза');
// ---------- v274: несколько записей — несколько карточек; оформленный предпросмотр долга/цели ----------
env.WQ = '1'; const U4 = 61, b4 = W._t.store(env, U4); await b4.rc.setProf(JSON.stringify(W._t.profClean(PROF)));
sent = []; await msg(U4, 'кофе 300 кафе и такси 120 транспорт');
const ws4 = sent.filter(x => x.m === 'sendWidget'), q4 = db.prepare("SELECT text FROM msgs WHERE CAST(uid AS REAL) = 61 ORDER BY at").all().map(r => r.text);
assert(ws4.length === 2 && JSON.stringify(q4) === JSON.stringify(['кофе 300 кафе', 'такси 120 транспорт']), 'две записи — две карточки и две фразы в очереди');
assert(JSON.parse(ws4[0].chat_data).o[0][4] === 'Кафе и рестораны' && JSON.parse(ws4[1].chat_data).o[0][4] === 'Транспорт', 'у каждой — своя категория');
assert(db.prepare("SELECT COUNT(*) n FROM rcpt WHERE CAST(uid AS REAL) = 61").get().n === 2, 'две квитанции');
sent = []; await msg(U4, 'взял в долг у Пети 2000 до 20 декабря'); const wd4 = sent.find(x => x.m === 'sendWidget'), dd4 = JSON.parse(wd4.chat_data);
assert(wd4.html === W._t.RC_DG && JSON.parse(wd4.public_data).t.length > 10 && dd4.s === 'q' && dd4.g[0].w === 'Петя' && dd4.g[0].i !== 1 && dd4.g[0].e.replace(/\s/g, ' ') === '2 000 MDL' && dd4.g[0].pv === 1, 'долг: сразу оформленная карточка (Петя, 2 000 MDL, вы должны)');
sent = []; await msg(U4, 'в цель отпуск 5000'); const dg4 = JSON.parse(sent.find(x => x.m === 'sendWidget').chat_data).g[0];
assert(dg4.k === 'g' && dg4.w === 'Отпуск' && dg4.ev === 'in' && dg4.pv === 1, 'цель: «Отпуск», в копилку');
// ---------- v275: карточка долга, а записан обычный расход → обычная карточка; напоминание о зависшей записи ----------
const U5 = 71, b5 = W._t.store(env, U5); await b5.rc.setProf(JSON.stringify(W._t.profClean(PROF)));
sent = []; await msg(U5, 'Ксюша вернула 200'); const r5 = db.prepare("SELECT id, mid, act FROM rcpt WHERE CAST(uid AS REAL) = 71").get();
assert(/"st":"dgq"/.test(r5.act), 'квитанция помнит: карточка долга');
sent = []; await W._t.finishReceipts(env, b5, [r5.id], [], { [r5.id]: 'x' }, [], [], { [r5.id]: { o: [[0, '−200 MDL', '🍽️', '#e0703c', 'Кафе и рестораны', 'Ксюша вернула', 0, '']], a: { k: [['food', '🛒 Продукты', '🛒', 'Продукты', '', 0]], td: '2026-11-11', d: '2026-11-11', v: '5', n: '' } } });
const nw5 = sent.find(x => x.m === 'sendWidget'), r5b = db.prepare("SELECT mid, act FROM rcpt WHERE CAST(uid AS REAL) = 71").get();
assert(nw5 && nw5.html === W._t.RC_HTML && sent.some(x => x.m === 'deleteMessage' && x.message_id === r5.mid) && r5b.mid !== r5.mid && /"st":"ok"/.test(r5b.act), 'обычный расход — обычная карточка с меню, старая удалена');
sent = []; await msg(U5, 'кофе 300 кафе'); const r6 = db.prepare("SELECT id FROM rcpt WHERE CAST(uid AS REAL) = 71 AND text = 'кофе 300 кафе'").get();
db.prepare("UPDATE rcpt SET at = at - 3 * 864e5 WHERE CAST(uid AS REAL) = 71 AND id = ?").run(r6.id);
sent = []; await W._t.staleRemind(env); const st6 = sent.filter(x => x.m === 'editMessageWidgetData').map(x => JSON.parse(x.chat_data));
assert(st6.length === 1 && /Ждёт 3 дня/.test(st6[0].hn) && st6[0].o[0][4] === 'Кафе и рестораны' && st6[0].a, 'зависшая запись: «Ждёт 3 дня», карточка и меню на месте');
await b5.ack([r6.id]); sent = []; await W._t.staleRemind(env); assert(!sent.some(x => x.m === 'editMessageWidgetData'), 'приложение забрало — не напоминаем');
// ---------- v275: карточка статистики, вечерняя сводка ----------
const U7 = 81, b7 = W._t.store(env, U7), td7 = new Date(Date.now() + 7200e3).toISOString().slice(0, 10);
const SUM = { cur: 'MDL', tz: -120, ds: td7, d: { e: 420, i: 5000, n: 3, c: [['🛒', 'Продукты', 300, '#98ebeb'], ['🚌', 'Транспорт', 120, '#eb98e0']] },
  w: { e: 1220, i: 5000, n: 4, c: [['🍽️', 'Кафе и рестораны', 800, '#dede7c']], s: '2026-11-05', x: [0, 0, 0, 0, 800, 0, 420] }, m: { e: 1220, i: 5000, n: 4, c: [['🍽️', 'Кафе', 800, '']], l: 'Ноябрь', x: Array(31).fill(1234567), b: [1220, 10000] } };
sent = []; await msg(U7, '/report'); assert(sent.some(x => x.m === 'sendMessage' && /Откройте приложение один раз/.test(x.text)), '/report без итогов — подсказка');
await b7.rc.sumSet(JSON.stringify(W._t.sumClean({ ...SUM, d: { ...SUM.d, c: [...SUM.d.c, ['x', '<b>', 'zz', 'red']] } })));
sent = []; await msg(U7, 'статистика'); let st7 = sent.find(x => x.m === 'sendWidget'), sd7 = JSON.parse(st7.chat_data);
assert(st7.html === W._t.RC_ST && st7.allow_queries && sd7.t === 2 && sd7.m.b[1] === 10000 && sd7.d.e === 420 && sd7.d.c[2][2] === 0 && sd7.ev === 1, '«статистика» — карточка, вкладка «месяц», данные очищены');
assert(Buffer.byteLength(st7.chat_data) <= 1024, `данные карточки ${Buffer.byteLength(st7.chat_data)} байт`);
assert(zlib.deflateSync(Buffer.from(W._t.RC_ST), { level: 9 }).length <= 4096, 'HTML статистики ≤ 4 КБ');
sent = []; await msg(U7, '/today'); assert(JSON.parse(sent.find(x => x.m === 'sendWidget').chat_data).t === 0, '/today — вкладка «сегодня»');
const mid7 = (await b7.rc.sumGet()).mid;
sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'e1', from: { id: U7 }, chat: { id: U7, type: 'private' }, message_id: mid7, data: 'ev:0' } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
assert((await b7.rc.sumGet()).ev === '0' && JSON.parse(sent.find(x => x.m === 'editMessageWidgetData').chat_data).ev === 0, 'вечерняя сводка — выключается в карточке');
const at21 = Date.parse(td7 + 'T19:00:00Z');   // 21:00 по Кишинёву (tz -120)
sent = []; await W._t.evening(env, at21); assert(!sent.some(x => x.m === 'sendWidget'), 'выключена — сводки нет');
await b7.rc.sumUp('ev', '1'); sent = []; await W._t.evening(env, at21 - 3600e3); assert(!sent.some(x => x.m === 'sendWidget'), 'в 20:00 — ещё нет');
sent = []; await W._t.evening(env, at21); assert(sent.filter(x => x.m === 'sendWidget' && x.html === W._t.RC_ST).length === 1, 'в 21:00 — сводка');
sent = []; await W._t.evening(env, at21 + 60e3); assert(!sent.some(x => x.m === 'sendWidget'), 'второй раз за день — нет');
// ---------- v281: память «заметка → категория» в боте ----------
const U8 = 91, b8 = W._t.store(env, U8); await b8.rc.setProf(JSON.stringify(W._t.profClean({ ...PROF, l: [[W._t.lkH('такси'), 'transport']] })));
const pv8 = async t => { sent = []; await msg(U8, t); return JSON.parse(sent.find(x => x.m === 'sendWidget').chat_data); };
let m8 = await pv8('такси 120'); assert(m8.o[0][4] === 'Транспорт', 'память: «такси 120» → Транспорт сразу');
m8 = await pv8('кофе 25'); assert(m8.o[0][4] === 'Категорию подберёт приложение', 'без памяти — категория за приложением');
const r8 = db.prepare("SELECT id, mid FROM rcpt WHERE CAST(uid AS REAL) = 91 ORDER BY at DESC").get();
sent = []; await W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ widget_query: { id: 'm1', from: { id: U8 }, chat: { id: U8, type: 'private' }, message_id: r8.mid, data: 'c:0' } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
m8 = await pv8('кофе 30'); assert(m8.o[0][4] === 'Кафе и рестораны', 'выбрал категорию в боте → «кофе 30» сразу «Кафе и рестораны»');
m8 = await pv8('Кофе 40'); assert(m8.o[0][4] === 'Кафе и рестораны', 'регистр не важен');
assert(W._t.lkH('кофе') === W._t.lkH('Кофе ') && W._t.lkH('ёлка') === W._t.lkH('елка'), 'отпечаток: регистр, пробелы, ё');
// ---------- v288: языки ----------
for (const kind of ['rc', 'dg', 'st']) { const base = W._t.cardHtml(kind, 'ru');
  assert(W._t.CARD_TR[kind].every(t => base.includes(t[0])), `карточка ${kind}: все русские подписи из таблицы есть в HTML`);
  for (const lg of ['en', 'ro']) { const h = W._t.cardHtml(kind, lg), zz = zlib.deflateSync(Buffer.from(h), { level: 9 }).length;
    assert(zz <= 4096 && !/[а-яё]{2,}/i.test(h.replace(/\/\/[^\n]*/g, '')), `карточка ${kind}/${lg}: zlib ${zz} Б, русских подписей не осталось`); } }
for (const lg of ['en', 'ro']) for (const dg of [false, true]) { const pd = W._t.cardPub(dg, lg);
  assert(Buffer.byteLength(pd) <= 1024 && JSON.parse(pd).t.length === JSON.parse(W._t.cardPub(dg, 'ru')).t.length && !/[а-яё]/i.test(pd), `public_data ${dg ? 'долг/цель' : 'запись'}/${lg}: ${Buffer.byteLength(pd)} Б`); }
const msgL = async (uid, text, lc) => W.default.fetch(new Request('https://w/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
  body: JSON.stringify({ message: { message_id: Math.random() * 1e6 | 0, date: Math.floor(Date.now() / 1000), from: { id: uid, language_code: lc }, chat: { id: uid, type: 'private' }, text } }) }), env, ctx).then(() => Promise.all(ctx.ps.splice(0)));
delete env.WQ; sent = []; await msgL(9031, '/start', 'en');
assert(sent.some(x => x.m === 'sendMessage' && /^Hi! I record/.test(x.text) && x.reply_markup.inline_keyboard[0][0].text === 'Open finances'), 'новый человек с английским Telegram: /start по-английски');
sent = []; await msgL(9031, 'coffee 300 cafe', 'en'); let swe = sent.find(x => x.m === 'sendWidget');
assert(swe && swe.html.includes('"Save"') && !swe.html.includes('"Записать"') && JSON.parse(swe.public_data).t[0] === 'Wait a couple of seconds', 'карточка записи — английские подписи');
sent = []; await msgL(9031, 'lent Peter 300 until the 20th', 'en'); swe = sent.find(x => x.m === 'sendWidget');
assert(swe && swe.html.includes('"Lent"') && JSON.parse(swe.chat_data).g && JSON.parse(swe.chat_data).g[0].w === 'Peter', 'английская фраза о долге — карточка долга, имя Peter');
sent = []; await msgL(9032, '/help', 'ro'); assert(sent.some(x => /^Ce puteți scrie/.test(x.text || '')), 'румынский Telegram: /help по-румынски');
sent = []; await msgL(9032, 'obiectiv vacanță 50000', 'ro'); swe = sent.find(x => x.m === 'sendWidget');
assert(swe && swe.html.includes('"Obiectiv nou"') && JSON.parse(swe.chat_data).g[0].w === 'Vacanță', 'румынская фраза о цели — карточка цели');
sent = []; await msgL(9033, '/start', 'ru'); assert(sent.some(x => /^Привет!/.test(x.text || '')), 'русский Telegram: по-русски, как раньше');
W._t.lgSet(9033, 'en'); sent = []; await msgL(9033, '/queue', 'ru'); assert(sent.some(x => /^Waiting to be saved/.test(x.text || '')), 'язык, выбранный в приложении, важнее языка Telegram');
assert(/одолжил peter 300 до 20 числа/.test(W._t.plxN('Lent Peter 300 until the 20th', 'en')) && /вернул → elena 100/.test(W._t.plxN('am returnat Elenei 100', 'ro')) && W._t.plxN('кофе 300 кафе', 'ru').trim() === 'кофе 300 кафе', 'правила фраз в боте: английский, румынский, русский без изменений');

