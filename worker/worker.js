// Cloudflare Worker: бот для финансового Mini App. Работает для нескольких людей: у каждого своя очередь.
// v24: в «✅ Записано» бот показывает, что именно сделало приложение (долг, цель, лимит, бюджет, трата); команда /help с примерами.
// v21: ответ бота «в очереди» → после забора приложением сообщение меняется на «Записано» (квитанции, таблица rcpt в D1); команда /queue; Cache-Control: no-store.
// Привязки (Settings → Bindings / Variables and Secrets):
//   KV namespace  FIN (или INBOX)  — хранилище очереди
//   Secret        BOT_TOKEN        — токен бота из BotFather
//   Secret        GROQ_KEY         — ключ Groq (для голосовых)
//   Secret        WEBHOOK_SECRET   — любая длинная строка (латиница/цифры), та же, что в setWebhook
//   Variable      ALLOWED_IDS      — ПУСТО = бот открыт для всех (у каждого свои данные). Или список id через запятую, чтобы закрыть
//   Variable      DAILY_LIMIT      — сообщений в сутки на человека (по умолчанию 60)
//   Variable      APP_URL          — адрес Mini App (https://…pages.dev), нужен для кнопки «Открыть» в /start

//   D1 database     DB             — (желательно) мгновенная очередь без задержек KV. Таблицы создаются сами. Без неё работает старый режим на KV (с задержкой до ~минуты)

const kv = env => env.INBOX || env.FIN;   // KV-привязка может называться INBOX или FIN
const TTL = 60 * 60 * 24 * 30;           // неразобранные записи живут 30 дней
const MAX_AGE = 60 * 60 * 24 * 365;      // initData не старше года (окно Mini App может жить в Telegram неделями)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/webhook' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
        const upd = await req.json();
        ctx.waitUntil(handleUpdate(upd, env).catch(e => console.error('handleUpdate', e && e.stack || e)));
        return new Response('ok');                       // Telegram всегда получает 200 быстро
      }
      if (url.pathname === '/api/pending' && req.method === 'GET') {
        const uid = await authUser(req, env); if (!uid) return cors(json({ error: 'auth' }, 401));
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
        const box = store(env, uid), out = await box.ack(ids);
        ctx.waitUntil(finishReceipts(env, box, ids, bad, notes).catch(e => console.error('receipts', e && e.stack || e)));
        return cors(json(out));
      }
      return new Response('finance bot', { status: 200 });
    } catch (e) { console.error('fetch', e && e.stack || e); return cors(json({ error: 'server' }, 500)); }
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
]).catch(e => { d1Ready = null; throw e; }));
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
      async take(ids) {
        await d1Init(env); const out = [];
        for (const id of ids.slice(0, 20)) { const r = await q('SELECT chat, mid, text FROM rcpt WHERE uid = ? AND id = ?', uid, String(id)).first(); if (r) out.push({ id: String(id), ...r }); }
        if (out.length) await env.DB.batch(out.map(o => q('DELETE FROM rcpt WHERE uid = ? AND id = ?', uid, o.id)));
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
    async inc(day, limit) {
      await d1Init(env);
      const r = await q('SELECT n FROM cnt WHERE uid = ? AND day = ?', uid, day).first();
      if (r && Number(r.n) >= limit) return { ok: false };
      await q('INSERT INTO cnt (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1', uid, day).run();
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
«такси 120», «зарплата 15000», «кофе 5 евро вчера»

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
  const msg = upd.message; if (!msg || !msg.from || msg.chat.type !== 'private') return;
  const uid = msg.from.id, chat = msg.chat.id, reply = (text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, ...extra });
  const t = (msg.text || '').trim();

  if (t === '/id') return reply(`Ваш Telegram id: ${uid}`);                 // чтобы владелец мог добавить жену в ALLOWED_IDS
  if (!allowed(env, uid)) return reply('Доступ закрыт. Попросите владельца добавить ваш id (команда /id).');
  if (t === '/help' || t === '/помощь') return reply(HELP);
  if (t === '/queue') return reply(`В очереди на запись в приложение: ${await store(env, uid).count()}`);   // 0 = всё забрано приложением
  if (t === '/start') return reply('Привет! Пишите или говорите: траты («такси 120»), долги («одолжил Ивану 500»), цели («цель отпуск 50000»), лимиты («лимит еда 3000»), бюджет («бюджет 20000»). Всё попадёт в приложение, когда оно откроется. Примеры — команда /help.',
    env.APP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть финансы', web_app: { url: env.APP_URL } }]] } } : {});

  // защита квоты: у каждого человека не больше DAILY_LIMIT сообщений в сутки (по умолчанию 60)
  const day = new Date().toISOString().slice(0, 10), box = store(env, uid);
  if (!(await box.inc(day, Number(env.DAILY_LIMIT || 60))).ok) return reply('На сегодня лимит сообщений исчерпан, продолжим завтра.');

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
  if (!box.rc) return reply(`📥 В очереди: «${shown}»\nПоявится в приложении, когда оно откроется.`);
  // Бот не может сам записать в облако Telegram — это делает только открытое приложение. Поэтому: сначала «в очереди», а когда приложение
  // заберёт запись (api/ack), это же сообщение сменится на «Записано».
  const sent = await (await reply(`⏳ В очереди: «${shown}»\nПоявится в приложении, когда оно откроется.`)).json().catch(() => null);
  const mid = sent && sent.result && sent.result.message_id;
  if (mid) {
    await box.rc.add(id, chat, mid, shown);
    if (!(await box.has(id))) await finishReceipts(env, box, [id], []);   // приложение успело забрать запись, пока мы отвечали
  }
}

async function finishReceipts(env, box, ids, bad, notes = {}) {
  if (!box.rc || !ids.length) return;
  const badSet = new Set(bad.map(String));
  const list = await box.rc.take(ids);
  await Promise.all(list.map(r => tg(env, 'editMessageText', { chat_id: r.chat, message_id: r.mid,
    text: badSet.has(r.id) ? `⚠ Приложение не поняло: «${r.text}»\n\nНапишите, например:\n• «кофе 30, категория продукты»\n• «бюджет 20000»\n• «Иван должен 500»` : `✅ Записано: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : '') }).catch(() => {})));   // v166: подробный ответ из приложения отдельным абзацем
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
