// Cloudflare Worker: бот для финансового Mini App. Работает для нескольких людей: у каждого своя очередь.
// v24: в «✅ Записано» бот показывает, что именно сделало приложение (долг, цель, лимит, бюджет, трата); команда /help с примерами.
// v21: ответ бота «в очереди» → после забора приложением сообщение меняется на «Записано» (квитанции, таблица rcpt в D1); команда /queue; Cache-Control: no-store.
// Привязки (Settings → Bindings / Variables and Secrets):
//   KV namespace  FIN (или INBOX)  — хранилище очереди
//   Secret        BOT_TOKEN        — токен бота из BotFather
//   Secret        GROQ_KEY         — ключ Groq (для голосовых)
//   Secret        WEBHOOK_SECRET   — любая длинная строка (латиница/цифры), та же, что в setWebhook
//   Variable      ALLOWED_IDS      — ПУСТО = бот открыт для всех (у каждого свои данные). Или список id через запятую, чтобы закрыть
//   Variable      DAILY_LIMIT      — сообщений в сутки на человека (по умолчанию 30)
//   Variable      APP_URL          — адрес Mini App (https://…pages.dev): кнопка «Открыть финансы» и ссылка на политику (APP_URL + privacy.html)

//   Secret        STATS_SALT       — соль для обезличенной статистики (длинная случайная строка; НЕ менять — иначе все посчитаются новыми). Нет соли — статистика не собирается
//   Variable      OWNER_ID         — Telegram id владельца: только ему отвечает /stats
//   Cron trigger  10 0 * * *       — раз в сутки итоги дня и уборка; 0 5,6 * * 6 — недельная сводка владельцу в сб 08:00 по Кишинёву (оба ставит tools/deployworker.sh)
//   D1 database     DB             — (желательно) мгновенная очередь без задержек KV. Таблицы создаются сами. Без неё работает старый режим на KV (с задержкой до ~минуты)

const kv = env => env.INBOX || env.FIN;   // KV-привязка может называться INBOX или FIN
const TTL = 60 * 60 * 24 * 30;           // неразобранные записи живут 30 дней
const MAX_AGE = 60 * 60 * 24 * 7;        // initData не старше 7 дней; старше — 401, приложение просит перезапуск (v207)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/webhook' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
        const upd = await req.json();
        const fm = upd.message;
        if (fm && fm.from && fm.chat && fm.chat.type === 'private') ctx.waitUntil(mark(env, fm.from.id, 'bot').catch(e => console.error('mark', e && e.stack || e)));
        ctx.waitUntil(handleUpdate(upd, env).catch(e => console.error('handleUpdate', e && e.stack || e)));
        return new Response('ok');                       // Telegram всегда получает 200 быстро
      }
      if (url.pathname === '/api/pending' && req.method === 'GET') {
        const uid = await authUser(req, env); if (!uid) return cors(json({ error: 'auth' }, 401));
        ctx.waitUntil(mark(env, uid, 'app').catch(e => console.error('mark', e && e.stack || e)));
        const wait = Number(url.searchParams.get('wait')) || 0;
        const res = await store(env, uid).list(wait, req.signal, url.searchParams.get('fast') === '1');
        res.uid = String(uid);                          // приложение показывает его в «Бот: проверить сейчас» — сверьте с командой /id в боте
        return cors(json(res));
      }
      if (url.pathname === '/api/ack' && req.method === 'POST') {
        const uid = await authUser(req, env); if (!uid) return cors(json({ error: 'auth' }, 401));
        const body = await req.json();
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        const bad = Array.isArray(body.bad) ? body.bad.map(String).slice(0, 200) : [];   // записи, которые приложение не смогло разобрать
        const notes = {};                                                                  // что именно сделало приложение: {id: «Долг: Иван должен вам 500»}
        if (body.notes && typeof body.notes === 'object') for (const k of Object.keys(body.notes).slice(0, 200)) notes[String(k)] = String(body.notes[k]).slice(0, 1200);   // v166: подробный ответ (старое приложение шлёт ≤300 — совместимо)
        const hold = Array.isArray(body.hold) ? body.hold.map(String).slice(0, 200) : [];
        const drop = Array.isArray(body.drop) ? body.drop.map(String).slice(0, 200) : [];   // v167: удалены в приложении, не записаны   // v167: записи на проверке в приложении — квитанцию не удаляем, «✅ Записано» придёт вторым ack
        const box = store(env, uid), out = await box.ack(ids);
        ctx.waitUntil(finishReceipts(env, box, ids, bad, notes, hold, drop).catch(e => console.error('receipts', e && e.stack || e)));
        return cors(json(out));
      }
      return new Response('finance bot', { status: 200 });
    } catch (e) { console.error('fetch', e && e.stack || e); return cors(json({ error: 'server' }, 500)); }
  },
  async scheduled(ev, env, ctx) {
    if (ev.cron === WEEKLY) ctx.waitUntil(sendWeekly(env).catch(e => console.error('weekly', e && e.stack || e)));
    else ctx.waitUntil(rollup(env).catch(e => console.error('rollup', e && e.stack || e)));
  }
};


// ---------- очередь: D1 (мгновенно, строго согласованно) или KV (запасной вариант с задержкой) ----------
const store = (env, uid) => env.DB ? d1Store(env, uid) : kvStore(env, uid);
let d1Ready = null;
const d1Init = env => d1Ready || (d1Ready = env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS msgs (uid TEXT, id TEXT, text TEXT, ts INTEGER, at INTEGER, PRIMARY KEY (uid, id))'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS cnt (uid TEXT, day TEXT, n INTEGER, PRIMARY KEY (uid, day))'),
  // «квитанции»: какое сообщение бота нужно переписать на «Записано», когда приложение заберёт запись
  env.DB.prepare('CREATE TABLE IF NOT EXISTS rcpt (uid TEXT, id TEXT, chat INTEGER, mid INTEGER, text TEXT, at INTEGER, PRIMARY KEY (uid, id))')
]).then(async () => {
  // v-колонка: голосовые за день (для статистики) — той же записью, что и счётчик лимита; на старой таблице добавляется один раз
  try { await env.DB.prepare('ALTER TABLE cnt ADD COLUMN v INTEGER DEFAULT 0').run(); } catch {}
}).catch(e => { d1Ready = null; throw e; }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1Store = (env, uid) => {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const read = async () => (await q('SELECT id, text, ts FROM msgs WHERE uid = ? AND at >= ? ORDER BY at LIMIT 100', uid, Date.now() - TTL * 1000).all()).results || [];
  return {
    lp: true,
    async add(id, text, ts) {
      await d1Init(env);
      await q('INSERT OR REPLACE INTO msgs (uid, id, text, ts, at) VALUES (?, ?, ?, ?, ?)', uid, id, text, ts, Date.now()).run();
      // уборка старого — раз при добавлении, а не на каждом опросе
      await env.DB.batch([q('DELETE FROM msgs WHERE uid = ? AND at < ?', uid, Date.now() - TTL * 1000), q('DELETE FROM rcpt WHERE uid = ? AND at < ?', uid, Date.now() - TTL * 1000)]);
    },
    async count() { await d1Init(env); const r = await q('SELECT COUNT(*) AS n FROM msgs WHERE uid = ?', uid).first(); return Number(r && r.n) || 0; },
    async has(id) { await d1Init(env); return !!(await q('SELECT 1 AS x FROM msgs WHERE uid = ? AND id = ?', uid, String(id)).first()); },
    rc: {
      async add(id, chat, mid, text) { await d1Init(env); await q('INSERT OR REPLACE INTO rcpt (uid, id, chat, mid, text, at) VALUES (?, ?, ?, ?, ?, ?)', uid, String(id), chat, mid, text, Date.now()).run(); },
      async take(ids, keep) {
        await d1Init(env); const out = [];
        for (const id of ids.slice(0, 20)) { const r = await q('SELECT chat, mid, text FROM rcpt WHERE uid = ? AND id = ?', uid, String(id)).first(); if (r) out.push({ id: String(id), ...r }); }
        if (out.length && !keep) await env.DB.batch(out.map(o => q('DELETE FROM rcpt WHERE uid = ? AND id = ?', uid, o.id)));
        return out;
      }
    },
    // «долгий опрос»: ждём до ~12 с (параметр wait), проверяя базу раз в 2 с; как только запись появилась — отвечаем сразу
    async list(wait, signal) {
      await d1Init(env);
      let items = await read();
      for (let i = 0, n = Math.min(10, Math.ceil(wait / 2)); i < n && !items.length && !(signal && signal.aborted); i++) { await sleep(2000); items = await read(); }
      return { items, lp: true };
    },
    async ack(ids) {
      await d1Init(env);
      if (ids.length) await env.DB.batch(ids.map(id => q('DELETE FROM msgs WHERE uid = ? AND id = ?', uid, String(id))));
      return { ok: true };
    },
    async inc(day, limit, voice) {
      await d1Init(env);
      const r = await q('SELECT n FROM cnt WHERE uid = ? AND day = ?', uid, day).first();
      if (r && Number(r.n) >= limit) return { ok: false };
      // страховка: если колонки v нет (ALTER не прошёл) — счётчик лимита по-старому, без голосовых в статистике
      await q('INSERT INTO cnt (uid, day, n, v) VALUES (?, ?, 1, ?) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1, v = COALESCE(v, 0) + excluded.v', uid, day, voice ? 1 : 0).run()
        .catch(e => (console.error('cnt v', e && e.message), q('INSERT INTO cnt (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1', uid, day).run()));
      await env.DB.batch([
        q('DELETE FROM cnt WHERE uid = ? AND day < ?', uid, new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10))]);   // счётчики старше 2 дней не храним (политика)
      return { ok: true };
    }
  };
};
const kvStore = (env, uid) => ({
  lp: false,
  async count() { return (await kv(env).list({ prefix: `m:${uid}:`, limit: 100 })).keys.length; },
  async has(id) { return !!(await kv(env).get(`m:${uid}:${id}`)); },
  async add(id, text, ts) {
    await kv(env).put(`m:${uid}:${id}`, JSON.stringify({ text, ts }), { expirationTtl: TTL });
    await kv(env).put(`q:${uid}`, '1', { expirationTtl: TTL });
  },
  async list(wait, signal, fast) {
    if (fast && !(await kv(env).get(`q:${uid}`))) return { items: [] };
    const list = await kv(env).list({ prefix: `m:${uid}:`, limit: 100 });
    if (!list.keys.length) await kv(env).delete(`q:${uid}`);
    const items = (await Promise.all(list.keys.map(async k => {
      const v = await kv(env).get(k.name, 'json'); return v ? { id: k.name.slice(`m:${uid}:`.length), text: v.text, ts: v.ts } : null;
    }))).filter(Boolean);
    return { items };
  },
  async ack(ids) {
    await Promise.all(ids.map(id => kv(env).delete(`m:${uid}:${id}`)));
    if (!(await kv(env).list({ prefix: `m:${uid}:`, limit: 1 })).keys.length) await kv(env).delete(`q:${uid}`);
    return { ok: true };
  },
  async inc(day, limit) {
    const ck = `c:${uid}:${day}`, used = Number(await kv(env).get(ck)) || 0;
    if (used >= limit) return { ok: false };
    await kv(env).put(ck, String(used + 1), { expirationTtl: 172800 }); return { ok: true };
  }
});

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const cors = r => { const h = new Headers(r.headers);
  h.set('Access-Control-Allow-Origin', '*'); h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); h.set('Access-Control-Max-Age', '600');
  return new Response(r.body, { status: r.status, headers: h }); };

const allowed = (env, uid) => { const l = String(env.ALLOWED_IDS || '').split(',').map(x => x.trim()).filter(Boolean); return !l.length || l.includes(String(uid)); };

// Проверка подписи Telegram: по ней видно, чей это Mini App-запрос, подделать нельзя
async function authUser(req, env) {
  const m = /^tma (.+)$/.exec(req.headers.get('Authorization') || ''); if (!m) return null;
  const uid = await verifyInitData(m[1], env.BOT_TOKEN); return uid && allowed(env, uid) ? uid : null;
}
async function verifyInitData(initData, token) {
  const p = new URLSearchParams(initData), hash = p.get('hash'); if (!hash) return null; p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(data)));
  const secret = await hmac(enc.encode('WebAppData'), token);
  const hex = [...await hmac(secret, dcs)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== hash.length) return null;
  let d = 0; for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ hash.charCodeAt(i);
  if (d) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > MAX_AGE) return null;
  try { return JSON.parse(p.get('user')).id || null } catch { return null }
}

const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const HELP = `Что можно написать или сказать боту:

💸 Траты и доходы
Порядок: заметка → сумма → категория (слово сразу после суммы).
«кофе 300 кафе», «такси 120 транспорт», «зарплата 15000 зарплата»
Категорию можно не говорить: «кофе 300» — приложение подставит ту, что вы выбирали для этой заметки.
Дата и валюта — в конце: «кофе 5 евро кафе вчера»

🤝 Долги
«одолжил Ивану 500 до 20 числа» — вам должны
«занял у Марии 1000» — вы должны
«Иван вернул мне 200» — вам вернули
«вернул Марии 300» — вы вернули

🎯 Цели
«цель отпуск 50000 до декабря» — новая цель
«отложил 2000 на отпуск» — взнос
«снял из цели отпуск 500» — снять

📏 Лимит и бюджет
«лимит еда 3000», «лимит на кафе 1500»
«бюджет 20000», «бюджет на ноябрь 25000»

💱 Курс: «курс евро 19.5»

Суммы можно словами: «пятьсот», «две тысячи». Записи появляются в приложении, когда оно открыто. /queue — сколько ждёт в очереди.`;

async function handleUpdate(upd, env) {
  if (upd.callback_query) return onCallback(upd.callback_query, env);
  const msg = upd.message; if (!msg || !msg.from || msg.chat.type !== 'private') return;
  const uid = msg.from.id, chat = msg.chat.id, reply = (text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, ...extra });
  const t = (msg.text || '').trim();

  if (t === '/id') return reply(`Ваш Telegram id: ${uid}`);                 // чтобы владелец мог добавить жену в ALLOWED_IDS
  if (!allowed(env, uid)) return reply('Доступ закрыт. Попросите владельца добавить ваш id (команда /id).');
  const open = env.APP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть финансы', web_app: { url: env.APP_URL } }]] } } : {};
  const priv = env.APP_URL ? new URL('privacy.html', env.APP_URL).href : '';
  if (t === '/privacy') return reply(priv ? `🔒 Политика конфиденциальности: ${priv}` : 'Политика конфиденциальности пока не опубликована.');
  if (t === '/help' || t === '/помощь') return reply(HELP + (priv ? `\n\n🔒 Политика конфиденциальности: /privacy` : ''));
  if (t === '/stats') { if (!isOwner(env, uid)) return; await ensureCallbacks(env).catch(e => console.error('hook', e && e.message)); return reply(await statsText(env), { parse_mode: 'HTML', reply_markup: STATS_KB }); }   // только владельцу (OWNER_ID); остальным — молчание
  if (t === '/queue') return reply(`В очереди на запись в приложение: ${await store(env, uid).count()}`);   // 0 = всё забрано приложением
  if (t === '/start') return reply('Привет! Я записываю ваши доходы и расходы.\n\n' +
    '✍️ Пишите или говорите: заметка, сумма, категория — «кофе 300 кафе», «такси 120 транспорт».\nЕщё: «одолжил Ивану 500», «цель отпуск 50000», «лимит еда 3000».\n' +
    '📲 Записи появляются в приложении, когда вы его открываете — кнопка ниже.\n' +
    '❓ Примеры — /help' + (priv ? `\n🔒 Политика конфиденциальности: ${priv}` : ''), open);

  if (!t && !msg.voice && !msg.audio) return reply('Я понимаю только текст и голосовые. Напишите, например: «кофе 300 кафе» — заметка, сумма, категория.');   // фото, стикеры и прочее — без списания лимита
  if (t.startsWith('/')) return;
  // защита квоты: у каждого человека не больше DAILY_LIMIT сообщений в сутки (по умолчанию 30); ответ о лимите лимит не тратит
  const day = new Date().toISOString().slice(0, 10), box = store(env, uid), lim = Number(env.DAILY_LIMIT || 30);
  if (!(await box.inc(day, lim, !t && !!(msg.voice || msg.audio))).ok) return reply(`🌙 На сегодня всё — лимит ${lim} сообщений в день исчерпан.\n\n` +
    'Записывать можно и дальше, прямо в приложении: нажмите «＋» в правом верхнем углу и напишите запись в строку ввода — так же, как боту.\n\n' +
    'Завтра бот снова будет принимать сообщения ✨', open);

  let text = t;
  if (!text && (msg.voice || msg.audio)) {
    const f = msg.voice || msg.audio;
    if ((f.duration || 0) > 120) return reply('Голосовое длиннее 2 минут — скажите короче.');
    text = await transcribe(f.file_id, env);
    if (!text) return reply('Не смог разобрать голос. Попробуйте ещё раз или напишите текстом.');
  }
  if (!text || text.startsWith('/')) return;
  const id = `${Date.now()}-${msg.message_id}`;
  await box.add(id, text.slice(0, 500), msg.date);              // сначала кладём в очередь (приложение получает мгновенно), потом отвечаем в чат
  const shown = text.slice(0, 200);
  if (!box.rc) return reply(`📥 В очереди: «${shown}»\nПоявится в приложении, когда оно откроется.`, open);
  // Бот не может сам записать в облако Telegram — это делает только открытое приложение. Поэтому: сначала «в очереди», а когда приложение
  // заберёт запись (api/ack), это же сообщение сменится на «Записано».
  const sent = await (await reply(`⏳ В очереди: «${shown}»\nПоявится в приложении, когда оно откроется.`, open)).json().catch(() => null);
  const mid = sent && sent.result && sent.result.message_id;
  if (mid) {
    await box.rc.add(id, chat, mid, shown);
    if (!(await box.has(id))) await finishReceipts(env, box, [id], []);   // приложение успело забрать запись, пока мы отвечали
  }
}

async function finishReceipts(env, box, ids, bad, notes = {}, hold = [], drop = []) {
  if (!box.rc || !ids.length) return;
  const badSet = new Set(bad.map(String)), holdSet = new Set(hold.map(String)), dropSet = new Set(drop.map(String));
  // v167: «на проверке» — сообщение меняется, квитанция остаётся (после подтверждения в приложении придёт второй ack → «✅ Записано»)
  const held = await box.rc.take(ids.map(String).filter(i => holdSet.has(i)), true);
  await Promise.all(held.map(r => tg(env, 'editMessageText', { chat_id: r.chat, message_id: r.mid,
    text: `📝 Получено: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : '') }).catch(() => {})));
  const list = await box.rc.take(ids.map(String).filter(i => !holdSet.has(i)));
  await Promise.all(list.map(r => tg(env, 'editMessageText', { chat_id: r.chat, message_id: r.mid,
    text: dropSet.has(r.id) ? `🗑 Не записано: «${r.text}»\nЗапись удалена в приложении.` : badSet.has(r.id) ? `⚠ Приложение не поняло: «${r.text}»\n\nНапишите, например:\n• «кофе 300 кафе» (заметка, сумма, категория)\n• «бюджет 20000»\n• «Иван должен 500»` : `✅ Записано: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : '') }).catch(() => {})));   // v166: подробный ответ из приложения отдельным абзацем
}

async function transcribe(fileId, env) {
  const info = await (await tg(env, 'getFile', { file_id: fileId })).json();
  const path = info && info.result && info.result.file_path; if (!path) return '';
  const audio = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`); if (!audio.ok) return '';
  const fd = new FormData();
  fd.append('file', new File([await audio.arrayBuffer()], 'voice.ogg', { type: 'audio/ogg' }));
  fd.append('model', 'whisper-large-v3-turbo'); fd.append('language', 'ru'); fd.append('temperature', '0');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_KEY}` }, body: fd });
  if (!r.ok) return ''; const j = await r.json(); return String(j.text || '').trim();
}


// ---------- обезличенная статистика: только счётчики, без текстов, сумм и имён ----------
// act (день, хэш, бот, приложение) — кто был активен; usr (хэш, первый день) — новые; agg — итоги дня (хранятся всегда).
// Вместо Telegram id — HMAC-SHA256(STATS_SALT, id), 16 знаков: уникальных посчитать можно, узнать человека по таблице — нет.
// Запись в D1 — только при первом событии дня (≤2 на человека в день: бот + приложение); сообщения/голос — колонки n/v таблицы лимита cnt.
// Сутки — UTC (как дневной лимит). Подробные данные (act, usr неактивных) — 90 дней; cnt — 2 дня.
const KEEP = 90;
const dstr = ms => new Date(ms).toISOString().slice(0, 10);
const ago = (n, now = Date.now()) => dstr(now - n * 864e5);
const isOwner = (env, uid) => !!env.OWNER_ID && String(env.OWNER_ID).trim() === String(uid);
let stReady = null, saltKey = null, saltOf = null;
const stInit = env => stReady || (stReady = d1Init(env).then(() => env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS act (day TEXT, h TEXT, bot INTEGER DEFAULT 0, app INTEGER DEFAULT 0, PRIMARY KEY (day, h))'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS usr (h TEXT PRIMARY KEY, first TEXT)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS agg (day TEXT PRIMARY KEY, users INTEGER, bot INTEGER, app INTEGER, new INTEGER, msgs INTEGER, voice INTEGER)')
])).catch(e => { stReady = null; throw e; }));
async function uhash(env, uid) {
  if (saltOf !== env.STATS_SALT) { saltKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STATS_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); saltOf = env.STATS_SALT; }
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, new TextEncoder().encode(String(uid))));
  return [...b.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const seen = new Set(); let seenDay = '';   // память экземпляра воркера: уже отмечен сегодня — в D1 не идём
async function mark(env, uid, src) {
  if (!env.DB || !env.STATS_SALT || !uid) return;
  const day = dstr(Date.now()), k = `${uid}|${src}`;
  if (seenDay !== day) { seen.clear(); seenDay = day; }
  if (seen.has(k)) return;
  await stInit(env);
  const h = await uhash(env, uid), col = src === 'app' ? 'app' : 'bot';
  // повтор в другом экземпляре воркера ничего не пишет: WHERE col = 0 / OR IGNORE
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO act (day, h, ${col}) VALUES (?, ?, 1) ON CONFLICT(day, h) DO UPDATE SET ${col} = 1 WHERE ${col} = 0`).bind(day, h),
    env.DB.prepare('INSERT OR IGNORE INTO usr (h, first) VALUES (?, ?)').bind(h, day)
  ]);
  if (seen.size > 20000) seen.clear();
  seen.add(k);
}
// итоги дня: вчера — пересчёт, позавчера — только если пропущен (cnt позавчера ещё цел); затем уборка
const aggSql = how => `INSERT OR ${how} INTO agg (day, users, bot, app, new, msgs, voice) SELECT ?1,
  (SELECT COUNT(*) FROM act WHERE day = ?1), (SELECT COUNT(*) FROM act WHERE day = ?1 AND bot = 1), (SELECT COUNT(*) FROM act WHERE day = ?1 AND app = 1),
  (SELECT COUNT(*) FROM usr WHERE first = ?1), (SELECT COALESCE(SUM(n), 0) FROM cnt WHERE day = ?1), (SELECT COALESCE(SUM(v), 0) FROM cnt WHERE day = ?1)`;
async function rollup(env, now = Date.now()) {
  if (!env.DB) return;
  await stInit(env);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  await env.DB.batch([
    q(aggSql('REPLACE'), ago(1, now)), q(aggSql('IGNORE'), ago(2, now)),
    q('DELETE FROM act WHERE day < ?', ago(KEEP, now)),
    q('DELETE FROM usr WHERE first < ? AND h NOT IN (SELECT h FROM act)', ago(KEEP, now)),
    q('DELETE FROM cnt WHERE day < ?', ago(2, now))                 // счётчики лимита старше 2 дней — и у тех, кто больше не пишет
  ]);
}
const N = x => Number(x) || 0;
// период [from, to] (YYYY-MM-DD): люди, новые, сообщения. Сообщения: старые дни — из agg, последние 3 дня (по настоящей дате) — из cnt
async function period(env, from, to) {
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first(), D2 = ago(2);
  const u = await one('SELECT COUNT(DISTINCT h) AS a, COUNT(DISTINCT CASE WHEN bot = 1 THEN h END) AS b, COUNT(DISTINCT CASE WHEN app = 1 THEN h END) AS p FROM act WHERE day BETWEEN ? AND ?', from, to);
  const nw = await one('SELECT COUNT(*) AS c FROM usr WHERE first BETWEEN ? AND ?', from, to);
  const ag = await one('SELECT COALESCE(SUM(msgs), 0) AS m, COALESCE(SUM(voice), 0) AS v FROM agg WHERE day BETWEEN ? AND ? AND day < ?', from, to, D2);
  const cn = to < D2 ? { m: 0, v: 0 } : await one('SELECT COALESCE(SUM(n), 0) AS m, COALESCE(SUM(v), 0) AS v FROM cnt WHERE day BETWEEN ? AND ?', from > D2 ? from : D2, to);
  return { u: N(u.a), b: N(u.b), p: N(u.p), n: N(nw.c), m: N(ag.m) + N(cn.m), v: N(ag.v) + N(cn.v) };
}
// возврат: пришли n…n+6 дней назад → сколько были активны через n и более дней после первого раза
async function ret(env, n, now = Date.now()) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(EXISTS (SELECT 1 FROM act a WHERE a.h = u.h AND a.day >= date(u.first, '+${n} day'))), 0) AS r
    FROM usr u WHERE u.first BETWEEN ? AND ?`).bind(ago(n + 6, now), ago(n, now)).first();
  return { c: N(r.c), r: N(r.r) };
}
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dm = d => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return `${n} ${m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c}`; };
const ppl = n => plural(n, 'человек', 'человека', 'человек'), msgN = n => plural(n, 'сообщение', 'сообщения', 'сообщений');
const delta = (a, b) => !b ? '' : a === b ? ' (столько же, сколько неделей раньше)' : ` (неделей раньше ${b}, ${a > b ? '▲ больше' : '▼ меньше'} на ${Math.round(Math.abs(a - b) * 100 / b)}%)`;
const STATS_KB = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'st:upd' }]] };
const WEEK_KB = { inline_keyboard: [[{ text: '📊 Подробно', callback_data: 'st:new' }]] };

async function statsText(env, now = Date.now()) {
  if (!env.DB) return 'Статистика работает только с базой D1.';
  if (!env.STATS_SALT) return 'Статистика не собирается: добавьте секрет STATS_SALT в Cloudflare (Settings → Variables and Secrets).';
  await stInit(env);
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first(), D = ago(0, now);
  const [d1, d7, d30, w0] = [await period(env, D, D), await period(env, ago(6, now), D), await period(env, ago(29, now), D), await period(env, ago(13, now), ago(7, now))];
  const days = (await env.DB.prepare('SELECT day, COUNT(*) AS c FROM act WHERE day >= ? GROUP BY day').bind(ago(6, now)).all()).results || [];
  const r7 = await ret(env, 7, now), r30 = await ret(env, 30, now), first = await one('SELECT MIN(day) AS d FROM act');
  // вид: сначала вывод словами, потом блоки с цифрами (<pre> — ровные колонки; эмодзи внутри <pre> не ставим — ломают выравнивание) и пояснение под каждым
  const pad = (x, w) => String(x).padStart(w), lab = (x, w = 16) => String(x).padEnd(w);
  const row = (l, k) => lab(l) + pad(d1[k], 4) + pad(d7[k], 5) + pad(d30[k], 5);
  const table = [lab('') + pad('сег', 4) + pad('7дн', 5) + pad('30дн', 5), row('Всего людей', 'u'), row(' писали боту', 'b'), row(' открывали прил', 'p'),
    row('Новые', 'n'), row('Сообщений боту', 'm'), row(' из них голосом', 'v')].join('\n');
  const bar = (x, max, w) => '█'.repeat(max ? Math.round(w * x / max) : 0) || (x ? '▏' : '');
  const cnt = Object.fromEntries(days.map(r => [r.day, N(r.c)])), list = [...Array(7)].map((_, i) => ago(6 - i, now));
  const mx = Math.max(0, ...list.map(d => cnt[d] || 0)), WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const chart = list.map(d => { const c = cnt[d] || 0; return `${WD[new Date(d + 'T12:00:00Z').getUTCDay()]} ${d.slice(8)}.${d.slice(5, 7)} ${lab(bar(c, mx, 12), 12)} ${pad(c, 3)}`; }).join('\n');
  const best = list.reduce((a, d) => (cnt[d] || 0) > (cnt[a] || 0) ? d : a, list[6]);
  const cmp = (a, b, f) => !b ? (a ? `${f(a)}, неделей раньше не было никого — сравнивать пока не с чем` : 'пока ноль') :
    a === b ? `${f(a)} — столько же, сколько неделей раньше` : `${f(a)}, неделей раньше ${b} — ${a > b ? '▲ больше' : '▼ меньше'} на ${Math.round(Math.abs(a - b) * 100 / b)}%`;
  const rline = (l, r) => r.c ? `${lab(l, 6)} ${'▓'.repeat(Math.round(10 * r.r / r.c))}${'░'.repeat(10 - Math.round(10 * r.r / r.c))} ${pad(Math.round(100 * r.r / r.c) + '%', 4)}  ${r.r} из ${r.c}` : `${lab(l, 6)} пока рано`;
  const rtext = (r, n, w) => r.c ? `• ${w}: из ${r.c} ${r.c % 10 === 1 && r.c % 100 !== 11 ? 'человека' : 'человек'}, впервые пришедших ${n}–${n + 6} дней назад, снова заходили ${r.r} (${Math.round(100 * r.r / r.c)}%).` +
      (r.c < 10 ? ' Людей пока мало — процент случайный.' : '') : `• ${w}: пока рано — нужно, чтобы со старта прошло ${n + 7}+ дней.`;
  const t = new Date(now);
  return `📊 <b>Статистика</b> · ${t.getUTCDate()} ${MON[t.getUTCMonth()]}, ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC\n\n` +
    `💬 <b>Коротко</b>\nСегодня заходили ${ppl(d1.u)}, за 7 дней — ${ppl(d7.u)}, из них новых ${d7.n}. ` +
    `Боту за неделю пришло ${msgN(d7.m)}, из них голосом ${d7.v}.\n\n` +
    `🔢 <b>Цифры</b>\n<pre>${table}</pre>\n` +
    `<i>Колонки: сегодня, последние 7 дней, последние 30 дней (включая сегодня). «Всего людей» — разные люди: кто и писал боту, и открывал приложение, считается один раз. ` +
    `«Новые» — пришли впервые. «Сообщений боту» — принятые записи текстом и голосом, без команд.</i>\n\n` +
    `📈 <b>Эта неделя и прошлая</b>\nЛюдей: ${cmp(d7.u, w0.u, String)}.\nСообщений: ${cmp(d7.m, w0.m, String)}.\n\n` +
    `📅 <b>Сколько людей заходило по дням</b>\n<pre>${chart}</pre>\n` +
    (mx ? `<i>Больше всего — ${dm(best)}: ${ppl(cnt[best])}.</i>\n\n` : '\n') +
    `↩️ <b>Возвращаются ли люди</b>\n<pre>${rline('7 дн', r7)}\n${rline('30 дн', r30)}</pre>\n` +
    `${rtext(r7, 7, 'Через неделю')}\n${rtext(r30, 30, 'Через месяц')}\n` +
    `<i>Это главный показатель спроса: пробуют многие, нужен бот тем, кто возвращается. Грубый ориентир: через неделю меньше 10% — пробуют и бросают, 25% и выше — хороший знак.</i>\n\n` +
    `<i>Сутки — по UTC (в Молдове день меняется в 2–3 часа ночи). Ваши заходы тоже считаются.` +
    (!first || !first.d ? ' Данных пока нет.' : first.d > ago(30, now) ? ` Счёт идёт с ${dm(first.d)}; в первый день все активные посчитаны новыми.` : '') + `</i>`;
}

// недельная сводка (суббота 08:00 по времени владельца, cron WEEKLY): последние 7 полных дней (сб–пт), коротко; «📊 Подробно» — полный /stats
// cron только в UTC: срабатывает в 05:00 и 06:00 UTC, отправка — только когда в OWNER_TZ 8 часов (зимой UTC+2 → 06:00, летом UTC+3 → 05:00)
const WEEKLY = '0 5,6 * * 6', OWNER_TZ = 'Europe/Chisinau', WEEKLY_HOUR = '08';
const localHour = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
async function weekText(env, now = Date.now()) {
  await stInit(env);
  const to = ago(1, now), from = ago(7, now), w = await period(env, from, to), w0 = await period(env, ago(14, now), ago(8, now)), r7 = await ret(env, 7, now);
  return `🗓 <b>Неделя ${dm(from)} — ${dm(to)}</b>\n\n` +
    `👥 Людей: <b>${w.u}</b>${delta(w.u, w0.u)}\n` +
    `🆕 Новых: <b>${w.n}</b>\n` +
    `💬 Сообщений боту: <b>${w.m}</b>, из них голосом ${w.v}${delta(w.m, w0.m)}\n` +
    `↩️ Вернулись через неделю: ${r7.c ? `<b>${Math.round(100 * r7.r / r7.c)}%</b> — ${r7.r} из ${r7.c}${r7.c < 10 ? ' (людей мало, процент случайный)' : ''}` : 'пока рано'}\n\n` +
    `<i>Сводка приходит по субботам в 8:00. Подробности и пояснения — кнопка ниже или /stats.</i>`;
}
async function sendWeekly(env, now = Date.now()) {
  if (!env.DB || !env.STATS_SALT || !env.OWNER_ID || !env.BOT_TOKEN || localHour(now, OWNER_TZ) !== WEEKLY_HOUR) return;
  await tg(env, 'sendMessage', { chat_id: Number(String(env.OWNER_ID).trim()), text: await weekText(env), parse_mode: 'HTML', reply_markup: WEEK_KB });
}
// нажатия кнопок статистики (только владельцу): «Обновить» — переписать это же сообщение, «Подробно» — новое сообщение с полным /stats
async function onCallback(cq, env) {
  const ok = isOwner(env, cq.from && cq.from.id) && /^st:/.test(cq.data || ''), m = cq.message;
  if (ok && m && cq.data === 'st:upd') {
    const r = await (await tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: await statsText(env), parse_mode: 'HTML', reply_markup: STATS_KB })).json().catch(() => ({}));
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Обновлено' : /not modified/.test(r.description || '') ? 'Новых данных нет' : 'Не получилось обновить' });
  }
  if (ok && m && cq.data === 'st:new') await tg(env, 'sendMessage', { chat_id: m.chat.id, text: await statsText(env), parse_mode: 'HTML', reply_markup: STATS_KB });
  return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
}
// чтобы нажатия кнопок доходили: если webhook подписан на список типов без callback_query — добавить его (адрес и секрет те же). Раз на экземпляр
let hookChecked = false;
async function ensureCallbacks(env) {
  if (hookChecked) return; hookChecked = true;
  const info = await (await tg(env, 'getWebhookInfo', {})).json().catch(() => null), r = info && info.result;
  if (!r || !r.url || !Array.isArray(r.allowed_updates) || !r.allowed_updates.length || r.allowed_updates.includes('callback_query')) return;
  await tg(env, 'setWebhook', { url: r.url, secret_token: env.WEBHOOK_SECRET, allowed_updates: [...new Set([...r.allowed_updates, 'message', 'callback_query'])],
    ...(r.max_connections ? { max_connections: r.max_connections } : {}) });
}
