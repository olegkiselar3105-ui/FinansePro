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
//   Variable      WIDGETS          — 0 = квитанции текстом, без карточки-виджета (v265; по умолчанию карточка)
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
      if (url.pathname === '/api/prof' && req.method === 'POST') {   // v269: словарь для предпросмотра; {off:1} — удалить
        const uid = await authUser(req, env); if (!uid) return cors(json({ error: 'auth' }, 401));
        const raw = await req.text(), box = store(env, uid);
        if (!box.rc || !box.rc.setProf) return cors(json({ ok: false }));
        let b = null; try { b = JSON.parse(raw); } catch {}
        if (!b || typeof b !== 'object' || raw.length > 20000) return cors(json({ error: 'bad' }, 400));
        await box.rc.setProf(b.off ? null : JSON.stringify(profClean(b)));
        return cors(json({ ok: true }));
      }
      if (url.pathname === '/api/sum' && req.method === 'POST') {   // v275: итоги для карточки статистики; {off:1} — удалить
        const uid = await authUser(req, env); if (!uid) return cors(json({ error: 'auth' }, 401));
        const raw = await req.text(), box = store(env, uid);
        if (!box.rc || !box.rc.sumSet) return cors(json({ ok: false }));
        let b = null; try { b = JSON.parse(raw); } catch {}
        if (!b || typeof b !== 'object' || raw.length > 8000) return cors(json({ error: 'bad' }, 400));
        if (b.off) { await box.rc.sumSet(null); return cors(json({ ok: true })); }
        const data = sumClean(b); await box.rc.sumSet(JSON.stringify(data));
        ctx.waitUntil(stLive(env, box, uid).catch(e => console.error('stlive', e && e.message)));   // последняя карточка статистики — живая
        return cors(json({ ok: true }));
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
        const cards = {};                                                                  // v265: данные карточки-квитанции {id: {o, b, n}}; старое приложение не шлёт — карточка покажет notes
        if (body.cards && typeof body.cards === 'object') for (const k of Object.keys(body.cards).slice(0, 200)) cards[String(k)] = body.cards[k];
        const box = store(env, uid), out = await box.ack(ids);
        // v267: приложение применило команды из кнопок: cmds — какие именно (sid, op, at), cres — итог по записи: ok / del / gone
        const cmdsDone = Array.isArray(body.cmds) ? body.cmds.filter(c => c && c.sid).slice(0, 100) : [];
        const cres = body.cres && typeof body.cres === 'object' ? body.cres : {};
        if (cmdsDone.length || Object.keys(cres).length) ctx.waitUntil(cmdFinish(env, box, cmdsDone, cres, cards).catch(e => console.error('cmds', e && e.stack || e)));
        ctx.waitUntil(finishReceipts(env, box, ids, bad, notes, hold, drop, cards).catch(e => console.error('receipts', e && e.stack || e)));
        return cors(json(out));
      }
      return new Response('finance bot', { status: 200 });
    } catch (e) { console.error('fetch', e && e.stack || e); return cors(json({ error: 'server' }, 500)); }
  },
  async scheduled(ev, env, ctx) {
    if (ev.cron === HOURLY) { ctx.waitUntil(evening(env).catch(e => console.error('evening', e && e.stack || e))); return; }   // v275
    if (ev.cron === WEEKLY) ctx.waitUntil(sendWeekly(env).catch(e => console.error('weekly', e && e.stack || e)));
    else { ctx.waitUntil(rollup(env).catch(e => console.error('rollup', e && e.stack || e)));
      ctx.waitUntil(staleRemind(env).catch(e => console.error('stale', e && e.stack || e))); }
  }
};


// ---------- очередь: D1 (мгновенно, строго согласованно) или KV (запасной вариант с задержкой) ----------
const store = (env, uid) => env.DB ? d1Store(env, uid) : kvStore(env, uid);
let d1Ready = null;
const d1Init = env => d1Ready || (d1Ready = env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS msgs (uid TEXT, id TEXT, text TEXT, ts INTEGER, at INTEGER, PRIMARY KEY (uid, id))'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS cnt (uid TEXT, day TEXT, n INTEGER, PRIMARY KEY (uid, day))'),
  // «квитанции»: какое сообщение бота нужно переписать на «Записано», когда приложение заберёт запись
  env.DB.prepare('CREATE TABLE IF NOT EXISTS rcpt (uid TEXT, id TEXT, chat INTEGER, mid INTEGER, text TEXT, at INTEGER, PRIMARY KEY (uid, id))'),
  // v267: команды из кнопок карточки («Категория», «Дата», «Отменить») — ждут, пока приложение их заберёт; op: cat/date/del, v — версия записи
  env.DB.prepare('CREATE TABLE IF NOT EXISTS cmds (uid TEXT, sid TEXT, op TEXT, val TEXT, v TEXT, at INTEGER, PRIMARY KEY (uid, sid, op))'),
  // v269: словарь для предпросмотра фразы: названия категорий, их другие названия, валюта (без сумм, записей и заметок); присылает приложение
  env.DB.prepare('CREATE TABLE IF NOT EXISTS prof (uid TEXT PRIMARY KEY, data TEXT, at INTEGER)'),
  // v273: вопрос «Сколько?» от кнопки «Другая сумма» / «Пополнить»: по ответу на это сообщение бот собирает фразу (tpl с {n}); сутки
  env.DB.prepare('CREATE TABLE IF NOT EXISTS asks (uid TEXT, mid INTEGER, tpl TEXT, at INTEGER, PRIMARY KEY (uid, mid))'),
  // v275: итоги для карточки статистики — только суммы (день/неделя/месяц, топ категорий, бюджет), последняя версия; ev — вечерняя сводка, mid — последняя карточка, sent — день сводки
  env.DB.prepare("CREATE TABLE IF NOT EXISTS sums (uid TEXT PRIMARY KEY, data TEXT, at INTEGER, ev TEXT DEFAULT '1', mid INTEGER, sent TEXT)")
]).then(async () => {
  // v267: act — что можно сделать из чата с записью «сразу» (варианты категорий, сегодняшняя дата телефона, версия записи)
  try { await env.DB.prepare('ALTER TABLE rcpt ADD COLUMN act TEXT').run(); } catch {}
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
      await env.DB.batch([q('DELETE FROM msgs WHERE uid = ? AND at < ?', uid, Date.now() - TTL * 1000), q('DELETE FROM rcpt WHERE uid = ? AND at < ?', uid, Date.now() - TTL * 1000), q('DELETE FROM cmds WHERE uid = ? AND at < ?', uid, Date.now() - TTL * 1000)]);
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
      },
      // v267: кнопки в карточке
      async get(id) { await d1Init(env); const r = await q('SELECT id, chat, mid, text, act FROM rcpt WHERE uid = ? AND id = ?', uid, String(id)).first(); return r ? { ...r, id: String(r.id) } : null; },
      async byMsg(chat, mid) { await d1Init(env); const r = await q('SELECT id, chat, mid, text, act FROM rcpt WHERE uid = ? AND chat = ? AND mid = ?', uid, chat, mid).first(); return r ? { ...r, id: String(r.id) } : null; },
      async dgq(ids) { await d1Init(env); const out = new Set();   // v275: какие квитанции ушли карточкой долга/цели
        for (const id of ids.slice(0, 20)) { const r = await q('SELECT act FROM rcpt WHERE uid = ? AND id = ?', uid, String(id)).first(); if (r && /"st":"dgq"/.test(r.act || '')) out.add(String(id)); } return out; },
      async setMid(id, mid) { await d1Init(env); await q('UPDATE rcpt SET mid = ?, act = NULL WHERE uid = ? AND id = ?', mid, uid, String(id)).run(); },
      async setAct(id, act) { await d1Init(env); await q('UPDATE rcpt SET act = ? WHERE uid = ? AND id = ?', act, uid, String(id)).run(); },
      async drop(id) { await d1Init(env); await env.DB.batch([q('DELETE FROM rcpt WHERE uid = ? AND id = ?', uid, String(id)), q('DELETE FROM cmds WHERE uid = ? AND sid = ?', uid, String(id))]); },
      async cmd(sid, op, val, v) {
        await d1Init(env);
        const l = [q('INSERT OR REPLACE INTO cmds (uid, sid, op, val, v, at) VALUES (?, ?, ?, ?, ?, ?)', uid, sid, op, String(val), String(v), Date.now())];
        // отмена важнее правок: приложение смотрит её первой; правки не стираем — «Не отменять» вернёт их
        await env.DB.batch(l);
      },
      async ask(mid, tpl) { await d1Init(env); await env.DB.batch([q('INSERT OR REPLACE INTO asks (uid, mid, tpl, at) VALUES (?, ?, ?, ?)', uid, mid, tpl, Date.now()), q('DELETE FROM asks WHERE uid = ? AND at < ?', uid, Date.now() - 864e5)]); },
      async askGet(mid) { await d1Init(env); return q('SELECT tpl FROM asks WHERE uid = ? AND mid = ? AND at >= ?', uid, mid, Date.now() - 864e5).first(); },
      async askDel(mid) { await d1Init(env); await q('DELETE FROM asks WHERE uid = ? AND mid = ?', uid, mid).run(); },
      async sumGet() { await d1Init(env); const r = await q('SELECT data, at, ev, mid, sent FROM sums WHERE uid = ?', uid).first(); if (!r) return null; try { return { ...r, data: JSON.parse(r.data) }; } catch { return null; } },
      async sumSet(data) { await d1Init(env); if (data) await q("INSERT INTO sums (uid, data, at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, at = excluded.at", uid, data, Date.now()).run(); else await q('DELETE FROM sums WHERE uid = ?', uid).run(); },
      async sumUp(f, v) { await d1Init(env); if (['ev', 'mid', 'sent'].includes(f)) await q(`UPDATE sums SET ${f} = ? WHERE uid = ?`, v, uid).run(); },
      async prof() { await d1Init(env); const r = await q('SELECT data FROM prof WHERE uid = ?', uid).first(); try { return r ? JSON.parse(r.data) : null; } catch { return null; } },
      async setProf(data) { await d1Init(env); if (data) await q('INSERT OR REPLACE INTO prof (uid, data, at) VALUES (?, ?, ?)', uid, data, Date.now()).run(); else await q('DELETE FROM prof WHERE uid = ?', uid).run(); },
      async unCmd(sid, op) { await d1Init(env); await q('DELETE FROM cmds WHERE uid = ? AND sid = ? AND op = ?', uid, sid, op).run(); },
      async cmdsOf(sid) { await d1Init(env); return (await q('SELECT op, val FROM cmds WHERE uid = ? AND sid = ?', uid, sid).all()).results || []; },
      async cmds() { await d1Init(env); return (await q('SELECT sid, op, val, v, at FROM cmds WHERE uid = ? ORDER BY at LIMIT 50', uid).all()).results || []; },
      async cmdDone(list) {   // удаляем только те команды, что приложение применило (новое нажатие после опроса — останется)
        await d1Init(env); if (!list.length) return;
        await env.DB.batch(list.map(c => q('DELETE FROM cmds WHERE uid = ? AND sid = ? AND op = ? AND at = ?', uid, String(c.sid), String(c.op), Number(c.at) || 0)));
      }
    },
    // «долгий опрос»: ждём до ~12 с (параметр wait), проверяя базу раз в 2 с; как только запись появилась — отвечаем сразу
    async list(wait, signal) {
      await d1Init(env);
      let items = await read(), cmds = await this.rc.cmds();
      for (let i = 0, n = Math.min(10, Math.ceil(wait / 2)); i < n && !items.length && !cmds.length && !(signal && signal.aborted); i++) { await sleep(2000); items = await read(); cmds = await this.rc.cmds(); }
      return cmds.length ? { items, lp: true, cmds } : { items, lp: true };   // v267: cmds — отдельным полем, старое приложение его не читает
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

📊 Статистика: /report (месяц), /today (сегодня), /week (неделя) — или «статистика». Каждый вечер в 21:00 — сводка за день (отключается в самой карточке)

Суммы можно словами: «пятьсот», «две тысячи». Записи появляются в приложении, когда оно открыто. /queue — сколько ждёт в очереди.`;

async function handleUpdate(upd, env) {
  if (upd.callback_query) return onCallback(upd.callback_query, env);
  if (upd.widget_query) return onWidgetQuery(upd.widget_query, env);   // v270: нажатия в меню карточки
  const msg = upd.message; if (!msg || !msg.from || msg.chat.type !== 'private') return;
  const uid = msg.from.id, chat = msg.chat.id, reply = (text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, ...extra });
  const t = (msg.text || '').trim();

  if (t === '/id') return reply(`Ваш Telegram id: ${uid}`);                 // чтобы владелец мог добавить жену в ALLOWED_IDS
  if (!allowed(env, uid)) return reply('Доступ закрыт. Попросите владельца добавить ваш id (команда /id).');
  const open = env.APP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть финансы', web_app: { url: env.APP_URL } }]] } } : {};
  const priv = env.APP_URL ? new URL('privacy.html', env.APP_URL).href : '';
  if (t === '/privacy') return reply(priv ? `🔒 Политика конфиденциальности: ${priv}` : 'Политика конфиденциальности пока не опубликована.');
  if (t === '/help' || t === '/помощь') return reply(HELP + (priv ? `\n\n🔒 Политика конфиденциальности: /privacy` : ''));
  // v275: карточка статистики (из итогов, что прислало приложение)
  if (/^\/(report|today|month|week)(@\w+)?$/i.test(t) || /^(статистика|отч[её]т|итоги|сводка|stats?|статс)$/i.test(t)) {
    const box0 = store(env, uid), tab = /today/i.test(t) ? 0 : /week/i.test(t) ? 1 : 2;
    if (!box0.rc || !box0.rc.sumGet) return reply('Статистика недоступна.');
    const sm = await box0.rc.sumGet();
    if (!sm) return reply('📊 Откройте приложение один раз — после этого здесь можно будет смотреть статистику.', open);
    return sendSt(env, box0, chat, sm, tab);
  }
  if (t === '/stats') { if (!isOwner(env, uid)) return; await ensureCallbacks(env).catch(e => console.error('hook', e && e.message)); return sendAd(env, chat, false); }   // v276: карточкой   // только владельцу (OWNER_ID); остальным — молчание
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
  // v273: ответ на вопрос бота «Сколько вернули / отложить?» — сумма подставляется в готовую фразу
  const rq = msg.reply_to_message && box.rc && box.rc.askGet ? await box.rc.askGet(msg.reply_to_message.message_id) : null;
  if (rq) { const n = /(\d[\d\s]*(?:[.,]\d{1,2})?)/.exec(t || ''); if (!n) return reply('Нужна сумма цифрами, например: 200');
    text = rq.tpl.replace('{n}', n[1].replace(/\s/g, '').replace(',', '.')); await box.rc.askDel(msg.reply_to_message.message_id); }
  if (!text && (msg.voice || msg.audio)) {
    const f = msg.voice || msg.audio;
    if ((f.duration || 0) > 120) return reply('Голосовое длиннее 2 минут — скажите короче.');
    text = await transcribe(f.file_id, env);
    if (!text) return reply('Не смог разобрать голос. Попробуйте ещё раз или напишите текстом.');
  }
  if (!text || text.startsWith('/')) return;
  // v274: «кофе 300 и такси 200» — каждая запись своей карточкой (части — по тем же разделителям, что и parse в приложении)
  const parts = box.rc ? splitPhrase(text) : null;
  if (parts) { for (let k = 0; k < parts.length; k++) await queuePhrase(env, box, chat, parts[k], msg.date, msg.message_id + '-' + k, open, reply); return; }
  return queuePhrase(env, box, chat, text, msg.date, msg.message_id, open, reply);
}

// фраза → очередь приложения + карточка в чат (v273: и для кнопок «Вернули всё» / ответа на «Сколько?»)
async function queuePhrase(env, box, chat, text, ts, mid0, open, reply) {
  const id = `${Date.now()}-${mid0}`;
  await box.add(id, text.slice(0, 500), ts);              // сначала кладём в очередь (приложение получает мгновенно), потом отвечаем в чат
  const shown = text.slice(0, 200);
  if (!box.rc) return reply(`📥 В очереди: «${shown}»\nПоявится в приложении, когда оно откроется.`, open);
  // Бот не может сам записать в облако Telegram — это делает только открытое приложение. Поэтому: сначала «в очереди», а когда приложение
  // заберёт запись (api/ack), это же сообщение сменится на «Записано».
  // v265: квитанция-карточка (виджет Bot API 10.4); не отправилась (старый API, ошибка, WIDGETS=0) — текст, как раньше
  // v269: предпросмотр — сумма и категория сразу, кнопки до открытия приложения (нужен словарь категорий от приложения)
  let pv = null, pf = null; try { pf = box.rc.prof && await box.rc.prof(); pv = pf && preview(pf, text, ts); } catch (e) { console.error('preview', e && e.message); }
  const dgp = !pv ? dgPreview(text, pf && pf.cur) : null;   // v274: долг/цель — оформленная карточка сразу (имя, сумма, событие)
  const kb = pv ? kbFor(env, pv.act, pv.cw ? kbCat(pv.act, true) : null) : open.reply_markup;
  let mid = useW(env) ? await sendRcWidget(env, chat, shown, kb ? { reply_markup: kb } : {}, pv ? pv.card : dgp ? { o: [], g: [dgp] } : null, pv && pv.act) : null;
  if (!mid) { const sent = await (await reply(`⏳ В очереди: «${shown}»\n` + (pv ? pvText(pv) + '\n' : '') + 'Появится в приложении, когда оно откроется.', kb ? { reply_markup: kb } : {})).json().catch(() => null);
    mid = sent && sent.result && sent.result.message_id; }
  if (pv && mid) { if (!hookOk) { hookOk = true; await ensureCallbacks(env).catch(() => {}); } }
  if (mid) {
    await box.rc.add(id, chat, mid, shown);
    if (pv) await box.rc.setAct(id, JSON.stringify(pv.act));
    else if (dgp || (useW(env) && PV_DG.test(' ' + shown.toLowerCase().replace(/ё/g, 'е')))) await box.rc.setAct(id, JSON.stringify({ st: 'dgq', ...(dgp ? { g: [dgp] } : {}) }));   // v275: отправлена карточкой долга/цели
    if (!(await box.has(id))) await finishReceipts(env, box, [id], []);   // приложение успело забрать запись, пока мы отвечали
  }
}

async function finishReceipts(env, box, ids, bad, notes = {}, hold = [], drop = [], cards = {}) {
  if (!box.rc || !ids.length) return;
  // v275: ушла карточкой долга/цели, а приложение записало обычную операцию — та карточка покажет лишь строку текста.
  // Шлём обычную карточку (с меню), старую удаляем; дальше всё — как обычно, по новому сообщению
  if (box.rc.dgq && useW(env)) { const dq = await box.rc.dgq(ids.map(String).filter(i => cards[i] && !(cards[i].g && cards[i].g.length) && cards[i].o && cards[i].o.length));
    for (const r of await box.rc.take([...dq], true)) {
      const act = actOf(cards[r.id]), mid = await sendRcWidget(env, r.chat, r.text, {}, cards[r.id], act, true);
      if (!mid) continue;
      await box.rc.setMid(r.id, mid); await tg(env, 'deleteMessage', { chat_id: r.chat, message_id: r.mid }).catch(() => {});
    } }
  const badSet = new Set(bad.map(String)), holdSet = new Set(hold.map(String)), dropSet = new Set(drop.map(String));
  // v167: «на проверке» — сообщение меняется, квитанция остаётся (после подтверждения в приложении придёт второй ack → «✅ Записано»)
  const held = await box.rc.take(ids.map(String).filter(i => holdSet.has(i)), true);
  await Promise.all(held.map(async r => { const act = actOf(cards[r.id]);   // v269: черновик можно поправить из чата (категория, дата, «не записывать»)
    await box.rc.setAct(r.id, act ? JSON.stringify({ ...act, st: 'h' }) : null);
    return rcEdit(env, r, 'h', `📝 Получено: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : ''), notes[r.id], cards[r.id], act ? kbFor(env, { ...act, st: 'h' }, act.w ? kbCat(act, true) : null) : null, null, act ? { ...act, st: 'h' } : null); }));
  // v267: «✅ Записано» у записи «сразу» (card.a) — квитанция остаётся с кнопками; остальные — удаляются, как раньше
  const okA = i => !dropSet.has(i) && !badSet.has(i) && cards[i] && cards[i].a && box.rc.setAct;
  const kept = await box.rc.take(ids.map(String).filter(i => !holdSet.has(i) && okA(i)), true);
  await Promise.all(kept.map(r => rcKeep(env, box, r, notes[r.id], cards[r.id])));
  // v273: долг/цель — квитанция остаётся (кнопки «Вернули всё», «Другая сумма», «Пополнить»)
  const dgA = i => !okA(i) && !dropSet.has(i) && !badSet.has(i) && useWQ(env) && box.rc.setAct && cards[i] && Array.isArray(cards[i].g) && cards[i].g.some(x => x && !x.c && x.n);
  const keptDg = await box.rc.take(ids.map(String).filter(i => !holdSet.has(i) && dgA(i)), true);
  await Promise.all(keptDg.map(async r => { const g = JSON.parse(rcData('ok', { o: [], g: cards[r.id].g })).g || [];
    await box.rc.setAct(r.id, JSON.stringify({ st: 'dg', g })); return rcEdit(env, r, 'ok', `✅ Записано: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : ''), notes[r.id], cards[r.id]); }));
  const list = await box.rc.take(ids.map(String).filter(i => !holdSet.has(i) && !okA(i) && !dgA(i)));
  await Promise.all(list.map(r => dropSet.has(r.id) ? rcEdit(env, r, 'drop', `🗑 Не записано: «${r.text}»\nВ учёт не попало.`)
    : badSet.has(r.id) ? rcEdit(env, r, 'bad', `⚠ Приложение не поняло: «${r.text}»\n\nНапишите, например:\n• «кофе 300 кафе» (заметка, сумма, категория)\n• «бюджет 20000»\n• «Иван должен 500»`)
    : rcEdit(env, r, 'ok', `✅ Записано: «${r.text}»` + (notes[r.id] ? `\n\n${notes[r.id]}` : ''), notes[r.id], cards[r.id])));   // v166: подробный ответ из приложения отдельным абзацем
}

// ---------- v265: квитанция-карточка (виджет, Bot API 10.4) ----------
// HTML один на все квитанции и не меняется; меняются только данные сообщения (chat_data ≤1024 байт) — editMessageWidgetData.
// Подпись над карточкой — статус и фраза (её же видят клиенты без виджетов). Сеть виджету недоступна: всё — из chat_data.
// Квитанции-тексты (старые, или виджет не отправился) правятся по-старому, editMessageText. WIDGETS=0 в переменных — выключить.
const useW = env => String(env.WIDGETS ?? '1').trim() !== '0';
// v270: кнопки — внутри карточки (запросы виджета, widget_query); WQ=0 — как в v269, кнопками Telegram под сообщением
const rcPend = async r => r.pend || [];
const useWQ = env => useW(env) && String(env.WQ ?? '1').trim() !== '0';
// тексты статусов — в данных, не в HTML (экономия места в HTML)
const RC_TX = { drop: { hn: 'В учёт не попало.' },
  bad: { hn: 'Напишите, например:\n• «кофе 300 кафе»\n• «Иван должен 500»' } };
// меню карточки: k — [эмодзи, название] (запрос — по номеру), td/d — даты, st — q/h/ok, p — нажатое, но ещё не применённое
const waOf = (act, pend) => { if (!act) return null; const p = { c: -1, d: '', x: 0 };
  for (const x of pend || []) { if (x.op === 'cat') p.c = act.k.findIndex(c => c[0] === x.val); if (x.op === 'date') p.d = x.val; if (x.op === 'del') p.x = 1; if (x.op === 'type') p.t = 1; }
  return { k: act.k.map(c => [c[2] || '', c[3] || c[1], c[5] ? 1 : 0]), i: incOf(act, pend) ? 1 : 0, td: act.td, d: act.d, st: act.st || 'ok', p }; };
const RC_CAP = { q: '⏳ В очереди', h: '📝 Получено', ok: '✅ Записано', drop: '🗑 Не записано', bad: '⚠ Приложение не поняло' };
const u8 = s => new TextEncoder().encode(s).length;
// v272: долг {k:'d', w кто, i вам должны?, ev new/add/pay, e сумма события, l остаток, t всего, p доля возврата, due срок, c закрыт}; цель {k:'g', w, ev new/in/out, e, s накоплено, t цель, p, l осталось, by срок, c достигнута}
const dgClean = x => { const o = { k: x.k === 'g' ? 'g' : 'd' };
  for (const f of ['w', 'e', 'l', 't', 's', 'due', 'by']) if (x[f] != null && x[f] !== '') o[f] = String(x[f]).slice(0, 40);
  if (['new', 'add', 'pay', 'in', 'out'].includes(x.ev)) o.ev = x.ev; o.p = Math.max(0, Math.min(1, Number(x.p) || 0)); if (x.i) o.i = 1; if (x.c) o.c = 1;
  if (x.n) o.n = String(x.n).replace(/[\n\r]/g, ' ').slice(0, 40); if (Number(x.ln) > 0) o.ln = Math.round(Number(x.ln) * 100) / 100; if (x.x) o.x = 1; if (x.pv) o.pv = 1; return o; };
// фразы про долги и цели — своя карточка (решается при отправке: HTML сообщения потом не меняется)
const PV_DG = /(^|\s)(долг|долж|одолж|занял|заняла|займ|верн|цел[ьиюя]|копи|накоп|отлож)/u;
const str = (v, n) => String(v ?? '').slice(0, n);
// данные карточки: s — статус; o — операции [доход?, сумма, эмодзи, цвет, категория, подпись, доля лимита, текст лимита]; b — бюджет [доля, заголовок, значение, остаток]; n — текст
function rcData(s, card, note, x) {
  const d = { s, ...(RC_TX[s] || {}) }, c = card && typeof card === 'object' ? card : null;
  if (x && x.a) d.a = x.a;
  if (c && Array.isArray(c.o) && c.o.length) d.o = c.o.slice(0, 4).filter(Array.isArray).map(p => [p[0] ? 1 : 0, str(p[1], 40), str(p[2], 16), /^#[0-9a-f]{6}$/i.test(p[3]) ? p[3] : '', str(p[4], 40), str(p[5], 80), Math.max(0, Math.min(9, Number(p[6]) || 0)), str(p[7], 80)]);
  if (c && Array.isArray(c.g)) d.g = c.g.slice(0, 2).filter(x => x && typeof x === 'object').map(dgClean);   // v272: долг/цель
  if (x && x.ph) d.ph = str(x.ph, 120);
  if (x && x.hn) d.hn = str(x.hn, 120);
  if (c && Array.isArray(c.b)) d.b = [Math.max(0, Math.min(9, Number(c.b[0]) || 0)), str(c.b[1], 40), str(c.b[2], 60), str(c.b[3], 60)];
  const n = c && c.n ? c.n : !d.o ? note : '';   // старое приложение: только текст notes
  if (n) d.n = str(n, 600);
  let j = JSON.stringify(d);
  while (u8(j) > 1024) {                         // не влезло — сначала меньше вариантов меню, короче текст, меньше операций, без бюджета
    if (d.a && d.a.k.length > 4) d.a.k.pop();
    else if (d.g && d.g.length > 1) d.g.pop();
    else if (d.n && d.n.length > 60) d.n = d.n.slice(0, Math.floor(d.n.length * 0.75)) + '…';
    else if (d.n) delete d.n;
    else if (d.o && d.o.length > 1) d.o.pop();
    else if (d.b) delete d.b;
    else { delete d.o; }
    j = JSON.stringify(d);
  }
  return j;
}
async function sendRcWidget(env, chat, shown, open, card, act, plain) {
  const dg = !plain && !act && PV_DG.test(' ' + String(shown).toLowerCase().replace(/ё/g, 'е')), wq = useWQ(env) && !dg, x = dg ? { ph: shown } : wq ? { a: waOf(act, []), ...(!card ? { ph: shown } : {}) } : null;   // v276: без предпросмотра — сама фраза в карточке
  if (wq && !hookOk) { hookOk = true; await ensureCallbacks(env).catch(() => {}); }   // widget_query должен доходить до бота
  const r = await (await tg(env, 'sendWidget', { chat_id: chat, html: dg ? RC_DG : RC_HTML, public_data: dg ? RC_DGPUB : RC_PUB, chat_data: rcData('q', card, '', x),
    ...(wq || (dg && useWQ(env)) ? {} : { caption: `${RC_CAP.q}: «${shown}»`, show_caption_above_media: true }),
    ...(wq || (dg && useWQ(env)) ? { allow_queries: true } : open) })).json().catch(() => null);   // v273: и у карточки долгов/целей — кнопки «Вернули всё», «Пополнить»
  if (r && r.ok && r.result && r.result.message_id) return r.result.message_id;
  console.error('widget', r && r.description); return null;
}
// HTML карточки (≤32 КБ, ≤4 КБ после zlib — сейчас ~2 КБ); цвета — из темы Telegram (--tg-theme-*), есть светлая/тёмная
const RC_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--B:var(--tg-theme-button-color,#3390ec);--S:var(--tg-theme-secondary-bg-color,#f0f0f2);--H:var(--tg-theme-hint-color,#8a8a8e);--G:var(--tg-theme-bg-color,#fff);--T:var(--tg-theme-text-color,#000);--R:#e5484d;--E:#2fa65a}
*{box-sizing:border-box;margin:0}
html,body{background:var(--G)}
body{font:14px/1.3 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;color:var(--T);padding:8px 12px 26px;-webkit-user-select:none;user-select:none;}
.r{display:flex;align-items:center;gap:10px;padding:5px 0}
.i{flex:0 0 36px;height:36px;border-radius:50%;display:grid;place-items:center;font-size:19px;background:var(--S);transition:background .3s}
.m{flex:1;min-width:0}
.c,.s{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c{font-weight:600}
.s,.h{font-size:12px;color:var(--H)}
.a{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.a.in{color:var(--E)}
.l{padding:0 0 4px 46px}
.bd{margin-top:8px;padding-top:8px;border-top:1px solid rgba(128,128,128,.2)}
.k{display:flex;justify-content:space-between;gap:8px;font-size:13px}
.k b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{height:6px;border-radius:3px;background:var(--S);overflow:hidden;margin:5px 0 3px}
.bar i{display:block;height:100%;width:0;border-radius:3px;background:var(--B);transition:width .7s cubic-bezier(.2,.8,.2,1)}
.bar.x i{background:var(--R)}
.t{white-space:pre-wrap;font-size:13px;margin-top:4px}
@keyframes p{50%{opacity:.5}}
.n>*{animation:f .4s both;animation-delay:calc(var(--j)*60ms)}
@keyframes f{from{opacity:0;transform:translateY(5px)}}
.s-un .r{opacity:.45}.s-un .a{text-decoration:line-through}
#mb{display:flex;gap:6px;margin-top:10px}
.sg{flex:0 0 30px;height:30px;border-radius:50%;font-size:20px;font-weight:600;line-height:1;color:var(--R);background:#e5484d24}
.sg.in{color:var(--E);background:#2fa65a29}
.sg.go{animation:sp .45s cubic-bezier(.3,1.6,.5,1)}
@keyframes sp{40%{transform:rotate(180deg) scale(1.15)}}
.dt{flex:0 0 9px;height:9px;border-radius:50%;background:var(--E);animation:bg 1.8s ease-in-out infinite}
.s-q .dt,.s-h .dt{background:var(--H);animation:bl 1s ease-in-out infinite}
@keyframes bl{50%{opacity:.12;transform:scale(.6)}}
@keyframes bg{50%{opacity:.35;transform:scale(.8)}}
.s-un .dt,.s-gone .dt,.s-drop .dt{display:none}
button{-webkit-appearance:none;appearance:none;font:inherit;color:inherit;border:0;background:var(--S);border-radius:12px;transition:transform .15s,background .2s}
#mb button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px 6px;font-size:11px;color:var(--H)}
button:active{transform:scale(.93)}
#mb button.on{background:#3390ec26;color:#3390ec}
#mb svg{width:22px;height:22px;stroke:var(--B);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;overflow:visible}
#mb .rd svg{stroke:var(--R)}
.go .g{animation:k .6s cubic-bezier(.3,1.6,.5,1)}
@keyframes k{40%{transform:var(--k)}}
.g{transform-box:fill-box;transform-origin:center}
#pn{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.8,.2,1)}
#pn.op{grid-template-rows:1fr}
#pn>div{overflow:hidden}
.gr{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-top:8px}
.ch{display:flex;align-items:center;gap:6px;padding:9px 8px;font-size:13px;text-align:left;animation:f .3s backwards;animation-delay:calc(var(--j)*35ms)}
.ch span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sel{background:var(--B);color:#fff}
.cl{padding-top:8px}
.ch2{display:flex;justify-content:space-between;align-items:center;font-weight:600;padding:0 2px 6px}
.ch2 button{width:34px;height:30px;background:0}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center;font-size:13px}
.cg b{font-size:10px;font-weight:500;color:var(--H);padding:2px 0}
.cg button{height:27px;border-radius:9px;font-variant-numeric:tabular-nums}
.cg button:disabled{opacity:.25}
.cf{display:flex;gap:6px;padding-top:8px}
.cf .ch{flex:1;justify-content:center}
.cf .rd{background:var(--R);color:#fff}
#ht{font-size:12px;color:var(--H);text-align:center;margin-top:6px}
.bz{opacity:.55;pointer-events:none}
</style></head><body><div id="w"></div><div id="mb"></div><div id="pn"><div id="pc"></div></div><div id="ht"></div><script>
var T=window.TelegramWidget||{},w=document.getElementById("w"),mb=document.getElementById("mb"),pn=document.getElementById("pn"),pc=document.getElementById("pc"),ht=document.getElementById("ht"),j=0,D={},P="",cm="",bz=0;
function E(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function A(e){e.style.setProperty("--j",j++);w.appendChild(e);return e}
function hp(k){try{var h=T.HapticFeedback;k?h.notificationOccurred(k):h.impactOccurred("light")}catch(e){}}
function bar(r){var b=E("div","bar"+(r>1?" x":"")),i=E("i");b.appendChild(i);setTimeout(function(){i.style.width=Math.max(3,Math.min(100,r*100))+"%"},60);return b}
var IC={},TX=[];try{var PB=JSON.parse(T.publicData||"{}");IC=PB.i||{};TX=PB.t||[]}catch(e){}
function btn(k,l,f,c){var b=E("button",c||"");b.type="button";var c=IC[k];if(c)b.innerHTML='<svg viewBox="0 0 24 24" style="--k:'+c[0]+'">'+c[1]+"</svg>";b.appendChild(E("span",0,l));
b.onclick=function(){b.classList.remove("go");void b.offsetWidth;b.classList.add("go");hp();f(b)};return b}
function say(t){ht.textContent=t||""}
function rq(q,ok){if(bz)return;if(!T.request)return say(TX[3]);bz=1;document.body.classList.add("bz");
T.request(q).then(function(){bz=0;document.body.classList.remove("bz");hp("success");if(ok)ok()}).catch(function(e){bz=0;document.body.classList.remove("bz");hp("error");
say(TX[e&&e.code==="RATE_LIMITED"?0:1])})}
function open(k){P=P===k?"":k;draw2()}
function draw(){try{D=JSON.parse(T.chatData||"{}")||{}}catch(e){D={}}
w.className="";w.textContent="";j=0;

(D.o||[]).forEach(function(p){var r=A(E("div","r")),i=E("div","i",p[2]||"•"),m=E("div","m");
if(/^#[0-9a-f]{6}$/i.test(p[3]||""))i.style.background=p[3]+"2e";
m.appendChild(E("div","c",p[4]));if(p[5])m.appendChild(E("div","s",p[5]));
if(!r.previousSibling&&D.a&&!D.a.p.x){var g=E("button","sg"+(D.a.i?" in":""),D.a.i?"+":"−");g.type="button";g.onclick=function(){var n=D.a.i?0:1;g.classList.remove("go");void g.offsetWidth;g.classList.add("go");hp();D.a.i=n;g.textContent=n?"+":"−";g.className="sg go"+(n?" in":"");rq("t:"+(n?"i":"e"),function(){P="K";draw2()})};r.appendChild(g)}r.appendChild(i);r.appendChild(m);r.appendChild(E("div","a"+(p[0]?" in":""),p[1]));r.appendChild(E("i","dt"));
if(p[7]){var l=A(E("div","l"));l.appendChild(bar(+p[6]||0));l.appendChild(E("div","h",p[7]))}});
if(D.b){var b=A(E("div","bd")),k=E("div","k");k.appendChild(E("span",0,D.b[1]));k.appendChild(E("b",0,D.b[2]));b.appendChild(k);b.appendChild(bar(+D.b[0]||0));if(D.b[3])b.appendChild(E("div","h",D.b[3]))}
if(D.n)A(E("div","t",D.n));if(D.ph&&!(D.o&&D.o.length))A(E("div","t h","⏳ «"+D.ph+"»"));
if(D.hn)A(E("div","t h",D.hn));
void w.offsetWidth;w.className="n s-"+(D.s||"");draw2()}
function draw2(){var a=D.a,p=a&&a.p||{},q=a&&a.st!=="ok";mb.textContent="";pc.textContent="";
if(a){if(p.x)mb.appendChild(btn("U",q?"Записать":"Не отменять",function(){rq("u")}));
else{mb.appendChild(btn("K","Категория",function(){open("K")},P==="K"?"on":""));mb.appendChild(btn("D","Дата",function(){cm=(p.d||a.d).slice(0,7);open("D")},P==="D"?"on":""));
mb.appendChild(btn("X",q?"Убрать":"Отменить",function(){open("X")},"rd"+(P==="X"?" on":"")))}}
mb.style.display=mb.children.length?"":"none";
if(a&&!p.x&&P==="K"){var g=E("div","gr");(a.k||[]).forEach(function(c,i){if((c[2]?1:0)!==(a.i?1:0))return;var b=E("button","ch"+(p.c===i?" sel":""));b.type="button";b.style.setProperty("--j",i);
b.appendChild(E("span",0,c[0]||"•"));b.appendChild(E("span",0,c[1]));b.onclick=function(){hp();rq("c:"+i,function(){P="";draw2()})};g.appendChild(b)});pc.appendChild(g)}
if(a&&!p.x&&P==="D")pc.appendChild(cal(a,p));
if(a&&!p.x&&P==="X"){var f=E("div","cf"),y=E("button","ch rd",q?"Да, не записывать":"Да, отменить"),n=E("button","ch","Нет");y.type=n.type="button";
y.onclick=function(){rq("x",function(){P="";draw2()})};n.onclick=function(){P="";draw2()};f.appendChild(y);f.appendChild(n);pc.appendChild(f)}
pn.className=pc.children.length?"op":"";say(a&&(p.c>=0||p.d||p.x||p.t)?TX[2]:"")}
function cal(a,p){var c=E("div","cl"),y=+cm.slice(0,4),m=+cm.slice(5,7),h=E("div","ch2"),pv=E("button",0,"‹"),nx=E("button",0,"›"),td=a.td,cur=p.d||a.d,lo=(+td.slice(0,4)-1)+td.slice(4,7);
var sh=function(n){var t=new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);if(t>td.slice(0,7)||t<lo)return;cm=t;hp();pc.replaceChild(cal(a,p),c)};
pv.type=nx.type="button";pv.onclick=function(){sh(-1)};nx.onclick=function(){sh(1)};pv.disabled=cm<=lo;nx.disabled=cm>=td.slice(0,7);
h.appendChild(pv);var mn=new Date(Date.UTC(y,m-1,9)).toLocaleString("ru",{month:"long",timeZone:"UTC"});h.appendChild(E("span",0,mn[0].toUpperCase()+mn.slice(1)+" "+y));h.appendChild(nx);c.appendChild(h);
var g=E("div","cg");"Пн Вт Ср Чт Пт Сб Вс".split(" ").forEach(function(x){g.appendChild(E("b",0,x))});
var f=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,n=new Date(Date.UTC(y,m,0)).getUTCDate();for(var i=0;i<f;i++)g.appendChild(E("span"));
for(var d=1;d<=n;d++){(function(d){var ds=cm+"-"+(d<10?"0":"")+d,b=E("button",ds===cur?"sel":"",d);b.type="button";b.disabled=ds>td;
b.onclick=function(){hp();rq("d:"+ds,function(){P="";draw2()})};g.appendChild(b)})(d)}c.appendChild(g);return c}
draw();if(T.onEvent)T.onEvent("chatDataChanged",draw);if(T.ready)T.ready();
</script></body></html>`;
// v272: отдельная карточка для долгов и целей (исходник worker/card-dg.html): человек и остаток / кольцо цели, событие, срок, конфетти при закрытии
const RC_DG = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--B:var(--tg-theme-button-color,#3390ec);--S:var(--tg-theme-secondary-bg-color,#f0f0f2);--H:var(--tg-theme-hint-color,#8a8a8e);--G:var(--tg-theme-bg-color,#fff);--T:var(--tg-theme-text-color,#000);--E:#2fa65a;--O:#f08c2e}
*{box-sizing:border-box;margin:0}
html,body{background:var(--G)}
body{font:14px/1.3 system-ui,sans-serif;color:var(--T);padding:10px 12px 26px;-webkit-user-select:none;user-select:none;overflow:hidden}
.q{display:flex;gap:8px;align-items:center;color:var(--H);font-size:13px}
.q i{flex:0 0 8px;height:8px;border-radius:50%;background:var(--B);animation:p 1.2s infinite}
@keyframes p{50%{opacity:.25;transform:scale(.6)}}
.c{animation:f .45s both;animation-delay:calc(var(--j)*90ms)}
@keyframes f{from{opacity:0;transform:translateY(6px)}}
.hd{display:flex;align-items:center;gap:10px}
.av{flex:0 0 42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:19px;font-weight:700;color:#fff;background:var(--E)}
.av.o{background:var(--O)}
.m{flex:1;min-width:0}
.nm{font-weight:650;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb{font-size:12px;color:var(--H)}
.bg{text-align:right;white-space:nowrap}
.bg b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
.ev{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:5px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:#3390ec26;color:#3390ec}
.ev.e{background:#2fa65a26;color:var(--E)}
.bar{height:8px;border-radius:4px;background:var(--S);overflow:hidden;margin:10px 0 4px}
.bar i{display:block;height:100%;width:0;border-radius:4px;background:var(--E);transition:width .9s cubic-bezier(.2,.8,.2,1)}
.bar.o i{background:var(--O)}
.ln{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--H)}
.ln b{color:var(--T);font-weight:600}
.du{display:inline-block;margin-top:8px;font-size:12px;color:var(--H);padding:3px 8px;border-radius:8px;background:var(--S)}
.rg{flex:0 0 74px;height:74px;position:relative}
.rg svg{width:74px;height:74px;transform:rotate(-90deg)}
.rg circle{fill:none;stroke-width:8;stroke:var(--S)}
.rg .v{stroke:var(--E);stroke-linecap:round;stroke-dasharray:201;stroke-dashoffset:201;transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)}
.rg b{position:absolute;inset:0;display:grid;place-items:center;font-size:17px;font-variant-numeric:tabular-nums}
.ok{display:flex;align-items:center;gap:8px;margin-top:10px;font-weight:650;color:var(--E)}
.ok svg{width:22px;height:22px;stroke:var(--E);fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.ok path{stroke-dasharray:24;stroke-dashoffset:24;animation:ck .6s .5s forwards}
@keyframes ck{to{stroke-dashoffset:0}}
.cf{position:fixed;top:-10px;width:7px;height:11px;border-radius:2px;animation:fl 1.6s ease-in forwards;pointer-events:none}
@keyframes fl{to{transform:translate(var(--x),240px) rotate(var(--r));opacity:0}}
.t{white-space:pre-wrap;font-size:13px}
.sep{height:1px;background:rgba(128,128,128,.18);margin:12px 0}
.bt{display:flex;gap:6px;margin-top:10px}
.bt button{-webkit-appearance:none;appearance:none;flex:1;font:inherit;font-size:13px;font-weight:600;border:0;border-radius:12px;padding:10px 6px;color:var(--T);background:#80808033;transition:transform .15s}
.bt button.m{color:#fff;background:var(--E)}
.bt button:active{transform:scale(.94)}
.bt.bz{opacity:.5;pointer-events:none}
.dn{margin-top:10px;font-size:12.5px;color:var(--E);font-weight:600;animation:f .4s both}
.pv{padding-bottom:12px}
.er{margin-top:6px;font-size:12px;color:var(--H);text-align:center}
.pd{display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:8px;vertical-align:1px;background:var(--H);animation:bl 1s ease-in-out infinite}
@keyframes bl{50%{opacity:.12;transform:scale(.6)}}
.pd.g{background:var(--E);animation:bg 1.8s ease-in-out infinite}
@keyframes bg{50%{opacity:.35;transform:scale(.8)}}
.rg .sp{stroke:var(--H);stroke-dasharray:40 161;animation:rt 1.2s linear infinite;transform-origin:37px 37px}
@keyframes rt{to{transform:rotate(360deg)}}
</style></head><body><div id="w"></div><script>
var T=window.TelegramWidget||{},w=document.getElementById("w"),j=0,L=[];try{L=JSON.parse(T.publicData||"{}").t||[]}catch(e){}
function E(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function A(p,e){e.style.setProperty("--j",j++);p.appendChild(e);return e}
function hp(){try{T.HapticFeedback.notificationOccurred("success")}catch(e){}}
function pct(x){return Math.max(0,Math.min(1,+x||0))}
function bar(p,o){var b=E("div","bar"+(o?" o":"")),i=E("i");b.appendChild(i);setTimeout(function(){i.style.width=Math.max(2,pct(p)*100)+"%"},80);return b}
function boom(){hp();for(var k=0;k<26;k++){var s=E("i","cf");s.style.left=(Math.random()*100)+"%";s.style.background=["#2fa65a","#3390ec","#f08c2e","#e5484d","#f2c94c"][k%5];
s.style.setProperty("--x",(Math.random()*80-40)+"px");s.style.setProperty("--r",(Math.random()*720-360)+"deg");s.style.animationDelay=(Math.random()*.4)+"s";document.body.appendChild(s);setTimeout(function(e){e.remove()},2300,s)}}
// v273: кнопки — «Вернули всё» (сразу), «Другая сумма» / «Пополнить» (бот спросит сумму)
function acts(x,i){var c=E("div");if(x.c||!x.n||!T.request)return c;if(x.x){c.appendChild(E("div","dn",L[0]));return c}
var b=E("div","bt"),er=E("div","er");function go(q,el,t){if(b.classList.contains("bz"))return;b.classList.add("bz");try{T.HapticFeedback.impactOccurred("light")}catch(e){}
T.request(q).then(function(){b.classList.remove("bz");if(t){el.textContent=t}}).catch(function(e){b.classList.remove("bz");er.textContent=e&&e.code==="RATE_LIMITED"?L[1]:L[2]})}
function B(t,q,m,done){var e=E("button",m?"m":"",t);e.type="button";e.onclick=function(){go(q,e,done)};b.appendChild(e)}
if(x.k==="d"){if(x.ln)B(x.i?"Вернули всё":"Вернул всё","r:"+i+":a",1);B(L[3],"r:"+i+":o",0,L[4])}else B(L[5],"p:"+i+":o",1,L[4]);
c.appendChild(b);c.appendChild(er);return c}
function okRow(t){var o=E("div","ok");o.innerHTML='<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';o.appendChild(E("span",0,t));return o}
function debt(x,I){var c=E("div","c"),h=E("div","hd"),av=E("div","av"+(x.i?"":" o"),(x.w||"?").trim().charAt(0).toUpperCase()),m=E("div","m"),bg=E("div","bg");
m.appendChild(E("div","nm",x.w));m.appendChild(E("div","sb",x.i?L[9]:L[10]));
var bb=E("b",0,x.pv?x.e:x.c?x.t:x.l);bb.appendChild(E("i",x.pv?"pd":"pd g"));bg.appendChild(bb);bg.appendChild(E("span","sb",x.pv?L[8]:x.c?L[12]:L[11]));h.appendChild(av);h.appendChild(m);h.appendChild(bg);c.appendChild(h);
var ev={new:x.i?"Дали в долг":"Взяли в долг",add:"Добавлено к долгу",pay:x.i?"Вам вернули":"Вы вернули"}[x.ev];
if(ev&&x.e)c.appendChild(E("div","ev"+(x.ev==="pay"?" e":""),(x.ev==="pay"?"↩ ":"＋ ")+ev+" · "+x.e));if(x.pv)return c
if(x.c)c.appendChild(okRow(L[6]));
else{c.appendChild(bar(x.p,!x.i));var l=E("div","ln");l.appendChild(E("span",0,L[13]+Math.round(pct(x.p)*100)+"%"));var t=E("span");t.appendChild(document.createTextNode(L[14]));t.appendChild(E("b",0,x.t));l.appendChild(t);c.appendChild(l)}
if(x.due&&!x.c)c.appendChild(E("div","du","⏰ "+x.due));c.appendChild(acts(x,I));return c}
function goal(x,I){var c=E("div","c"),h=E("div","hd"),rg=E("div","rg"),m=E("div","m"),P=Math.round(pct(x.p)*100);
rg.innerHTML='<svg viewBox="0 0 74 74"><circle cx="37" cy="37" r="32"/><circle class="'+(x.pv?"sp":"v")+'" cx="37" cy="37" r="32"/></svg>';var n=E("b",0,x.pv?"":"0%");rg.appendChild(n);
if(x.pv){m.appendChild(E("div","nm","🎯 "+x.w));var q=E("div","sb",x.t?"Цель "+x.t:L[8]);q.appendChild(E("i","pd"));m.appendChild(q);h.appendChild(rg);h.appendChild(m);c.appendChild(h);
var v0={new:"Новая цель",in:"В копилку",out:"Из цели"}[x.ev];if(v0)c.appendChild(E("div","ev"+(x.ev==="in"?" e":""),v0+(x.e?" · "+x.e:"")));return c}
setTimeout(function(){rg.querySelector(".v").style.strokeDashoffset=201*(1-pct(x.p));var t0=Date.now();(function st(){var k=Math.min(1,(Date.now()-t0)/1000);n.textContent=Math.round(P*(1-Math.pow(1-k,3)))+"%";if(k<1)requestAnimationFrame(st)})()},80);
var nm=E("div","nm","🎯 "+x.w);nm.appendChild(E("i","pd g"));m.appendChild(nm);var s=E("div","sb");s.appendChild(document.createTextNode(L[15]));s.appendChild(E("b",0,x.s));s.appendChild(document.createTextNode(" из "+x.t));m.appendChild(s);
if(!x.c&&x.l)m.appendChild(E("div","sb",L[16]+x.l));h.appendChild(rg);h.appendChild(m);c.appendChild(h);
var ev={new:"Новая цель",in:"В копилку",out:"Из цели"}[x.ev];if(ev)c.appendChild(E("div","ev"+(x.ev==="in"?" e":""),ev+(x.e?" · "+x.e:"")));
if(x.c)c.appendChild(okRow(L[7]));if(x.by&&!x.c)c.appendChild(E("div","du","⏰ "+x.by));c.appendChild(acts(x,I));return c}
var seen="";
function draw(){var D={};try{D=JSON.parse(T.chatData||"{}")||{}}catch(e){}
w.textContent="";j=0;
if(D.s==="q"&&!(D.g&&D.g.length)){var q=E("div","q");q.appendChild(E("i"));q.appendChild(E("span",0,D.ph?"«"+D.ph+"»":""));w.appendChild(q);document.body.className="pv";return}
var g=D.g||[],any=0;g.forEach(function(x,i){if(i)w.appendChild(E("div","sep"));A(w,x.k==="g"?goal(x,i):debt(x,i));if(x.c)any=1});
(D.o||[]).forEach(function(p){A(w,E("div","t",p[1]+" · "+p[4]))});
if(D.n&&!g.length)A(w,E("div","t",D.n));if(D.hn)A(w,E("div","t sb",D.hn));
document.body.className=g.length&&g.every(function(x){return x.pv})?"pv":"";var key=JSON.stringify(g);if(any&&key!==seen)setTimeout(boom,700);seen=key}
draw();if(T.onEvent)T.onEvent("chatDataChanged",draw);if(T.ready)T.ready();
</script></body></html>`;
// v274: подписи карточки долгов/целей — в public_data (место HTML — 4 КБ после zlib)
const RC_DGPUB = JSON.stringify({ t: ["✓ Отправлено — новая запись ниже", "Подождите пару секунд", "Не получилось, попробуйте ещё раз", "Другая сумма", "Напишите сумму ↓", "＋ Пополнить", "Долг закрыт полностью", "Цель достигнута", "ждёт приложения", "Вам должны", "Вы должны", "осталось", "закрыт", "Возвращено ", "всего ", "Накоплено ", "Осталось "] });
// v270: значки меню карточки (svg) — в public_data сообщения (своё место 1024 байта), чтобы HTML уложился в 4 КБ после zlib
const RC_PUB = JSON.stringify({ i: {"K":["rotate(-20deg)","<path class=g d='M3.5 12.2V4.6c0-.6.5-1.1 1.1-1.1h7.6l8.3 8.3-8.7 8.7z'/><circle cx='8' cy='8' r='1.4'/>"],"D":["scaleY(.5)","<rect x='3.5' y='5' width='17' height='15' rx='2.5'/><path d='M8 3v4M16 3v4'/><path class=g d='M3.5 10h17M8 14h2M14 14h2M8 17h2'/>"],"X":["translate(2px,-4px) rotate(-22deg)","<path d='M6 8.5l1 11h10l1-11M10 12v5M14 12v5'/><path class=g d='M4 6.5h16M9.5 6.5V4h5v2.5'/>"],"U":["rotate(-60deg)","<path class=g d='M8 7L4 11l4 4'/><path d='M4 11h10a5 5 0 0 1 0 10h-3'/>"]}, t: ["Подождите пару секунд", "Не получилось, попробуйте ещё раз", "Применится, когда откроется приложение", "Обновите Telegram"] });

async function rcEdit(env, r, s, text, note, card, kb, cap, act) {
  const mk = kb ? { reply_markup: kb } : {}, wq = useWQ(env);
  if (useW(env)) {
    const x = wq ? { a: act ? waOf(act, await rcPend(r)) : null } : null;
    const w = await (await tg(env, 'editMessageWidgetData', { chat_id: r.chat, message_id: r.mid, chat_data: rcData(s, card, note, x) })).json().catch(() => null);
    if (w && w.ok) return wq ? w : tg(env, 'editMessageCaption', { chat_id: r.chat, message_id: r.mid, caption: cap || `${RC_CAP[s]}: «${r.text}»`, show_caption_above_media: true, ...mk }).catch(() => {});   // v271: в режиме меню подписи нет — только карточка
  }
  return tg(env, 'editMessageText', { chat_id: r.chat, message_id: r.mid, text, ...mk }).catch(() => {});   // квитанция-текст (не виджет)
}

// ---------- v267: кнопки карточки «✅ Записано» — категория, дата, отмена (только записи «сразу», cfg.bAuto в приложении) ----------
// Бот записей не меняет: нажатие кладёт команду в cmds, приложение применяет её при открытии и присылает новую карточку (cmdFinish).
// act (в rcpt, до 30 дней): k — до 6 вариантов категорий [id, «🍽️ Кафе»], td — «сегодня» по телефону, d — дата записи, v — версия записи
const CAL_M = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const CAL_G = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const isD = d => /^\d{4}-\d\d-\d\d$/.test(String(d || ''));
const dLbl = d => +d.slice(8) + ' ' + CAL_G[+d.slice(5, 7) - 1];
const dAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const B = (text, d) => ({ text, callback_data: 'rc:' + d });
const KB_MAIN = { inline_keyboard: [[B('🏷 Категория', 'K'), B('🗓 Дата', 'D')], [B('↩ Отменить запись', 'X')]] };
const KB_Q = { inline_keyboard: [[B('🏷 Категория', 'K'), B('🗓 Дата', 'D')], [B('🗑 Не записывать', 'X')]] };   // v269: в очереди и на проверке
const KB_DEL = { inline_keyboard: [[B('Да, отменить', 'Y'), B('Нет', 'B')]] };
const KB_UNDEL = { inline_keyboard: [[B('↩ Не отменять', 'U')]] };
const KB_QDEL = { inline_keyboard: [[B('Да, не записывать', 'Y'), B('Нет', 'B')]] };
const KB_QUNDEL = { inline_keyboard: [[B('↩ Всё-таки записать', 'U')]] };
const isQ = act => act.st === 'q' || act.st === 'h';   // запись ещё не в учёте
// main — сетка категорий сразу (слово не узнано): внизу «Дата» и «Не записывать» вместо «Назад»
const kbCat = (act, main) => { const rows = []; (act.k || []).forEach((c, i) => { if (i % 2 === 0) rows.push([]); rows[rows.length - 1].push(B(String(c[1]).slice(0, 30), 'c:' + i)); });
  rows.push(main ? [B('🗓 Дата', 'D'), B('🗑 Не записывать', 'X')] : [B('← Назад', 'B')]); return { inline_keyboard: rows }; };
// кнопка «Открыть финансы» — пока запись не в учёте
const kbFor = (env, act, kb) => { kb = kb || (isQ(act) ? KB_Q : KB_MAIN);
  return isQ(act) && env.APP_URL ? { inline_keyboard: [...kb.inline_keyboard, [{ text: 'Открыть финансы', web_app: { url: env.APP_URL } }]] } : kb; };
function kbCal(ym, act) {
  const [y, m] = ym.split('-').map(Number), days = new Date(Date.UTC(y, m, 0)).getUTCDate(), sh = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const N = B('\u2800', 'n'), tdm = act.td.slice(0, 7), nx = ymAdd(ym, 1), pv = ymAdd(ym, -1), lo = ymAdd(tdm, -12);
  const rows = [[pv >= lo ? B('‹', 'M:' + pv) : N, B(CAL_M[m - 1] + ' ' + y, 'n'), nx <= tdm ? B('›', 'M:' + nx) : N], ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(x => B(x, 'n'))];
  let row = Array(sh).fill(N);
  for (let d = 1; d <= days; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    row.push(ds > act.td ? B('·', 'n') : B(ds === act.d ? `•${d}•` : String(d), 'd:' + ds));
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(N); rows.push(row); }
  rows.push([B('Сегодня', 'd:' + act.td), B('Вчера', 'd:' + dAdd(act.td, -1)), B('← Назад', 'B')]);
  return { inline_keyboard: rows };
}
// act: k — варианты [id, «🍽️ Кафе», эмодзи, название, цвет, доход?]; r — строка карточки, b — бюджет, n — заметка, w — неузнанное слово, st — q/h/ok
// v271: варианты обоих типов — переключатель «−/+» в карточке меняет расход на доход и наоборот
const actOf = card => { const a = card && card.a; if (!a || !Array.isArray(a.k) || !isD(a.td) || !isD(a.d)) return null;
  const k = a.k.slice(0, 12).filter(c => Array.isArray(c) && c[0]).map(c => [str(c[0], 40), str(c[1], 30), str(c[2], 16), str(c[3], 30), /^#[0-9a-f]{6}$/i.test(c[4]) ? c[4] : '', c[5] ? 1 : 0]);
  const r = card.o && Array.isArray(card.o[0]) ? JSON.parse(rcData('ok', { o: [card.o[0]] })).o[0] : null;
  return { k, td: a.td, d: a.d, v: str(a.v, 20), ...(r ? { r } : {}), ...(Array.isArray(card.b) ? { b: JSON.parse(rcData('ok', { o: [], b: card.b })).b } : {}),
    n: str(a.n, 60), w: str(a.w, 30) }; };
const dayLbl = (d, td) => (d === td ? 'сегодня, ' : d === dAdd(td, -1) ? 'вчера, ' : '') + dLbl(d);
// карточка с учётом нажатий: выбранная категория и дата видны сразу, до открытия приложения
const incOf = (act, pend) => { const t = (pend || []).find(p => p.op === 'type'); return t ? t.val === 'i' : !!(act.r && act.r[0]); };
const cardOf = (act, pend) => { if (!act.r) return null; const r = act.r.slice(); let d = act.d, cat = false;
  for (const p of pend) { if (p.op === 'cat') { const c = act.k.find(x => x[0] === p.val); if (c) { r[2] = c[2] || r[2]; r[3] = c[4] || ''; r[4] = c[3] || c[1]; cat = true; } } if (p.op === 'date' && isD(p.val)) d = p.val; }
  const ty = pend.find(p => p.op === 'type');
  if (ty) { const inc = ty.val === 'i'; r[0] = inc ? 1 : 0; r[1] = (inc ? '+' : '−') + String(r[1]).replace(/^[+−-]\s*/, '');
    if (!cat && !!act.r[0] !== inc) { r[2] = '❓'; r[3] = ''; r[4] = 'Категория?'; } }
  r[5] = [act.n, dayLbl(d, act.td)].filter(Boolean).join(' · ');
  return { o: [r], ...(act.b ? { b: act.b } : {}) }; };
const pendLine = (act, pend) => { const l = [];
  for (const p of pend) { if (p.op === 'del') return isQ(act) ? '🗑 Не будет записано' : '⏳ Запись отменится, когда откроется приложение';
    if (p.op === 'type') l.push(p.val === 'i' ? 'доход' : 'расход');
    if (p.op === 'cat') { const c = (act.k || []).find(x => x[0] === p.val); l.push('категория — ' + (c ? c[1] : p.val)); }
    if (p.op === 'date' && isD(p.val)) l.push('дата — ' + dLbl(p.val)); }
  return l.length ? '⏳ Когда откроется приложение: ' + l.join(', ') : ''; };
let hookOk = false;
async function rcKeep(env, box, r, note, card) {   // «✅ Записано» + кнопки; act — в квитанцию
  const act = actOf(card); if (!act) { await box.rc.drop(r.id); return rcEdit(env, r, 'ok', `✅ Записано: «${r.text}»` + (note ? `\n\n${note}` : ''), note, card); }
  act.st = 'ok'; await box.rc.setAct(r.id, JSON.stringify(act));
  if (!hookOk) { hookOk = true; await ensureCallbacks(env).catch(() => {}); }   // нажатия кнопок (callback_query) должны доходить до бота
  return rcEdit(env, r, 'ok', `✅ Записано: «${r.text}»` + (note ? `\n\n${note}` : ''), note, card, KB_MAIN, null, act);
}
async function cmdFinish(env, box, done, cres, cards) {
  if (!box.rc || !box.rc.cmdDone) return;
  await box.rc.cmdDone(done);
  for (const sid of Object.keys(cres).slice(0, 50)) {
    const r = await box.rc.get(sid); if (!r) continue;
    const res = cres[sid], cap = s => ({ chat_id: r.chat, message_id: r.mid, caption: s, show_caption_above_media: true });
    if (res === 'ok') { if ((await box.rc.cmdsOf(sid)).length) continue; await rcKeep(env, box, r, '', cards[sid]); continue; }
    if (res === 'c') continue;   // v269: черновик записан или убран — квитанцию уже обновил ack «Записать» (bhFinish)
    if (res === 'h') { if ((await box.rc.cmdsOf(sid)).length) continue; const act = actOf(cards[sid]);   // черновик поправлен, но ещё не понятен — ждёт проверки
      if (act) { act.st = 'h'; await box.rc.setAct(sid, JSON.stringify(act)); }
      await rcEdit(env, r, 'h', `📝 Получено: «${r.text}»`, '', cards[sid], act ? kbFor(env, act) : null, null, act); continue; }   // ещё есть новые нажатия — карточку обновим после них
    await box.rc.drop(sid);
    const t = res === 'del' ? `↩ Отменено: «${r.text}»\nЗапись удалена из учёта.` : `✅ Записано: «${r.text}»\nℹ️ Запись уже изменили в приложении — кнопки отключены.`;
    if (res === 'del') { await rcEdit(env, r, 'un', t, 'Запись удалена из учёта.', null, null, `↩ Отменено: «${r.text}»`); continue; }
    if (useWQ(env)) { await tg(env, 'editMessageWidgetData', { chat_id: r.chat, message_id: r.mid, chat_data: rcData('gone', null, 'Запись уже изменили в приложении — здесь её больше не поправить.') }).catch(() => {}); continue; }
    const c = await (await tg(env, 'editMessageCaption', cap(t))).json().catch(() => null);   // карточка остаётся как есть, меняется подпись, кнопки убираются
    if (!(c && c.ok)) await tg(env, 'editMessageText', { chat_id: r.chat, message_id: r.mid, text: t }).catch(() => {});
  }
}
// ---------- v269: предпросмотр фразы в боте (до открытия приложения) ----------
// Узко и осторожно: одна сумма цифрами, слово после суммы — категория по словарю приложения (названия, первое слово названия, другие названия).
// Всё, что приложение разбирает сложнее (несколько сумм, другая валюта, даты, долги/цели/бюджет/лимиты/курс, числа словами) — без предпросмотра,
// как раньше: «разберёт приложение». Главный разбор — всё равно в приложении (parse); правки из кнопок оно накладывает поверх.
const PV_APP = /(^|\s)(долг|долж|одолж|занял|заняла|верн|цел[ьиюя]|копи|накоп|отлож|бюджет|лимит|курс|категори|тег|#)/u;
const PV_DATE = /\d{1,2}[./]\d{1,2}|назад|понедельник|вторник|сред[уа]|четверг|пятниц|суббот|воскресень|(^|\s)\d{1,2}\s+(янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек)/u;
const cwords = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d\s]/gu, ' ').split(/\s+/).filter(Boolean);
const stemEq = (a, b) => { if (a === b) return true; const n = Math.min(a.length, b.length); if (n < 3) return false; const k = Math.max(3, Math.min(n, Math.max(a.length, b.length) - 2)); return a.slice(0, k) === b.slice(0, k); };   // = catStem в приложении
const safeRx = (src, fl) => { try { return src ? new RegExp(src, fl) : null; } catch { return null; } };
function profClean(b) {
  const c = (Array.isArray(b.c) ? b.c : []).slice(0, 80).filter(x => Array.isArray(x) && x[0]).map(x => [str(x[0], 40), str(x[1], 16), str(x[2], 30), x[3] ? 1 : 0, /^#[0-9a-f]{6}$/i.test(x[4]) ? x[4] : '']);
  const d = (Array.isArray(b.d) ? b.d : []).slice(0, 600).filter(x => Array.isArray(x) && x[0] && x[1]).map(x => [str(x[0], 40), str(x[1], 40), Math.max(0, Math.min(3, Number(x[2]) || 0))]);
  // v281: память «заметка → категория» — хеш заметки (lkH) и id категории
  const l = (Array.isArray(b.l) ? b.l : []).slice(-400).filter(x => Array.isArray(x) && /^[0-9a-f]{8}$/.test(x[0]) && x[1]).map(x => [x[0], str(x[1], 40)]);
  return { c, d, l, cur: str(b.cur, 8), tz: Math.max(-900, Math.min(900, Number(b.tz) || 0)), cx: str(b.cx, 3000), sk: str(b.sk, 3000), ir: (Array.isArray(b.ir) ? b.ir : []).slice(0, 2).map(x => str(x, 3000)) };
}
// v281: отпечаток заметки — тот же, что lkH в приложении (FNV-1a 32 бит, 'fp:' + нижний регистр, ё → е, одиночные пробелы)
const lkH = s => { s = 'fp:' + String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
// бот запоминает выбор сразу (не дожидаясь приложения): новая пара — в конец, старая для этой заметки — убирается
async function profLearn(box, note, id) { if (!note || !id || !box.rc || !box.rc.prof) return; const P = await box.rc.prof(); if (!P) return;
  const h = lkH(note); P.l = [...(P.l || []).filter(x => x[0] !== h), [h, id]].slice(-400); await box.rc.setProf(JSON.stringify(P)); }
function pvHit(P, ws) {   // как catByWords: полные названия → первое слово (короткое — только точно) → свои другие названия → встроенные
  for (const pri of [3, 2, 1, 0]) { let best = null;
    if (pri === 2 && !(ws[0] && ws[0].length >= 3)) continue;
    for (const [w, id, p] of P.d) { if (p !== pri) continue; const aw = w.split(' '); if (aw.length > ws.length) continue;
      let ok = true; for (let i = 0; i < aw.length; i++) if (pri === 2 && aw[0].length <= 3 ? ws[i] !== aw[i] : !stemEq(ws[i], aw[i])) { ok = false; break; }
      if (ok && (!best || aw.length > best.n)) best = { id, n: aw.length }; }
    if (best) { const c = P.c.find(x => x[0] === best.id); if (c) return { c, n: best.n }; } }
  return null;
}
const fmtA = (a, cur) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(a) + ' ' + cur;
function preview(P, text, ts) {
  if (!P || !Array.isArray(P.c) || !P.c.length) return null;
  let t = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ') + ' ';
  if (PV_APP.test(t) || PV_DATE.test(t)) return null;
  const cx = safeRx(P.cx ? '(^|[\\s\\d])(' + P.cx + ')(?=\\s|$|[.,])' : '', 'u'); if (cx && cx.test(t)) return null;
  t = t.replace(/(^|[^\d.,])(\d{1,3}(?:\s\d{3})+)(?!\d)/g, (m, a, n) => a + n.replace(/\s/g, ''));
  if ((t.match(/\d+(?:[.,]\d{1,2})?/g) || []).length !== 1) return null;   // нет суммы цифрами или несколько — разберёт приложение
  const m = /(^|[\s+−–-])(\d+(?:[.,]\d{1,2})?)\s*(тыс\S*|к(?=\s|$)|k(?=\s|$))?/u.exec(t); if (!m) return null;
  let a = parseFloat(m[2].replace(',', '.')); if (m[3]) a *= 1000; if (!(a > 0 && a <= 1e12)) return null;
  const sign = /[+]/.test(m[1]) ? 1 : /[−–-]/.test(m[1]) ? -1 : 0, before = t.slice(0, m.index + m[1].length), after = t.slice(m.index + m[0].length);
  const td = new Date((Number(ts) || Date.now() / 1000) * 1000 - (Number(P.tz) || 0) * 60000).toISOString().slice(0, 10);
  const d = /позавчера/.test(t) ? dAdd(td, -2) : /вчера/.test(t) ? dAdd(td, -1) : td;
  const DW = /^(вчера|позавчера|сегодня)$/, tk = cwords(after).filter(w => !DW.test(w)).slice(0, 4), sk = safeRx(P.sk, 'u');
  let hit = tk.length ? pvHit(P, tk) : null;
  const cw = !hit && tk[0] && tk[0].length >= 4 && /^\p{L}+$/u.test(tk[0]) && !(sk && sk.test(tk[0])) ? tk[0] : '';
  if (!hit && !cw && Array.isArray(P.l) && P.l.length) {   // v281: слова после суммы нет — категория из памяти по заметке («кофе 25» → Кафе)
    const nk = lkH([...cwords(before), ...tk].filter(w => !DW.test(w)).join(' ')), lm = P.l.find(x => x[0] === nk), c = lm && P.c.find(x => x[0] === lm[1]);
    if (c) hit = { c, n: 0, mem: 1 }; }
  const irx = (P.ir || []).map(x => safeRx(x, 'u')).filter(Boolean), iw = irx.some(r => r.test(' ' + t + ' '));
  const inc = sign ? sign > 0 : hit ? !!hit.c[3] : iw;
  const rest = [...cwords(before).filter(w => !DW.test(w)), ...cwords(after).filter(w => !DW.test(w)).slice(hit ? hit.n : cw ? 1 : 0)];
  let n = rest.join(' '); n = n ? n[0].toUpperCase() + n.slice(1) : '';
  const kc = c => [c[0], (c[1] ? c[1] + ' ' : '') + c[2], c[1], c[2], c[4], c[3] ? 1 : 0];
  const k = [...P.c.filter(c => !!c[3] === inc).slice(0, 8), ...P.c.filter(c => !!c[3] !== inc).slice(0, 4)].map(kc);
  const amt = (hit || cw || sign || iw ? (inc ? '+' : '−') : '') + fmtA(a, P.cur || '');
  const r = hit ? [inc ? 1 : 0, amt, hit.c[1] || '•', hit.c[4], hit.c[2], '', 0, ''] : cw ? [0, amt, '❓', '', 'Категория?', '', 0, ''] : [inc ? 1 : 0, amt, '🔹', '', 'Категорию подберёт приложение', '', 0, ''];
  const act = { k, td, d, v: 'q', st: 'q', r, n, w: cw };
  return { act, card: cardOf(act, []), cw: !!cw, hit: !!hit };
}
// v274: деление фразы на записи — как t.split(...) в parse: части без цифр — к следующей (хвост без цифр parse отбрасывает), «вчера» первой части — и к остальным
const SPLIT_RX = /[;\n]+|,(?!\d)|\.(?!\d)|(?:^|\s)(?:и|а также|потом|затем|плюс|ещ[её]|дальше|далее|следующ[а-яё]*)(?=\s)/iu;
function splitPhrase(text) {
  const t = String(text || '').trim(), low = ' ' + t.toLowerCase().replace(/ё/g, 'е') + ' ';
  if (PV_APP.test(low) || PV_DG.test(low) || PV_DATE.test(low)) return null;   // команды и даты — целиком в приложение
  const out = []; let pend = '';
  for (const p of t.split(SPLIT_RX).map(x => (x || '').trim()).filter(Boolean)) { if (!/\d/.test(p)) { pend += (pend ? ' ' : '') + p; continue; } out.push((pend ? pend + ' ' : '') + p); pend = ''; }
  if (out.length < 2) return null;
  const dw = /(^|\s)(позавчера|вчера)(?=\s|$)/i.exec(out[0]);
  if (dw) for (let i = 1; i < out.length; i++) if (!/(позавчера|вчера|сегодня)/i.test(out[i])) out[i] += ' ' + dw[2].toLowerCase();
  return out.slice(0, 6);
}
// v274: предпросмотр долга/цели по фразе (до открытия приложения) — грубо: сумма, имя/название, событие; итог — от приложения
const nomW = w => { w = w.toLowerCase(); if (w.length < 4) return w;
  if (/ию$/.test(w)) return w.slice(0, -2) + 'ий'; if (/ею$/.test(w)) return w.slice(0, -2) + 'ей'; if (/аю$/.test(w)) return w.slice(0, -2) + 'ай';
  if (/[бвгдзклмнпрстфхцчшщ]ю$/.test(w)) return w.slice(0, -1) + 'ь'; if (/[бвгджзклмнпрстфхцчшщ]у$/.test(w)) return w.slice(0, -1);
  if (/[тнлсдр]и$/.test(w)) return w.slice(0, -1) + 'я';   // Пети → Петя, Оли → Оля
  if (/[бвгджзклмнпрстфхцчшщ][еи]$/.test(w)) return w.slice(0, -1) + 'а'; return w; };
const DG_STOP = /^(одолжил[аи]?|дал[аи]?|взял[аи]?|занял[аи]?|верн\S*|в|во|у|с|долг\S*|взаймы|мне|нам|я|мы|ему|ей|им|должен|должна|должны|на|из|цел[ьиюяей]*|отлож\S*|копи\S*|накоп\S*|сегодня|вчера|позавчера|деньги|денег|тыс\S*|к)$/;
function dgPreview(text, cur) {
  const t0 = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ') + ' ';
  if (!PV_DG.test(t0)) return null;
  let t = t0.replace(/(^|[^\d.,])(\d{1,3}(?:\s\d{3})+)(?!\d)/g, (m, a, n) => a + n.replace(/\s/g, ''));
  const m = /(\d+(?:[.,]\d{1,2})?)\s*(тыс\S*|к(?=\s|$)|k(?=\s|$))?/u.exec(t); if (!m) return null;
  let a = parseFloat(m[1].replace(',', '.')); if (m[2]) a *= 1000; if (!(a > 0 && a <= 1e12)) return null;
  const amt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(a) + (cur ? ' ' + cur : '');
  const head = t.replace(/\s(до|к)\s.*$/, ' ').replace(m[0], ' ');   // «до 20 декабря» — срок, не имя
  const ws = cwords(head).filter(w => !/\d/.test(w) && !DG_STOP.test(w));
  if (/(^|\s)(цел[ьиюя]|копи|накоп|отлож)/.test(t0)) {
    if (!ws.length) return null; const nm = ws.slice(0, 3).join(' '), w = nm[0].toUpperCase() + nm.slice(1);
    const ev = /(^|\s)из\s+цел/.test(t0) ? 'out' : /(^|\s)(в|на)\s+цел|отлож|копи|накоп/.test(t0) ? 'in' : 'new';
    return ev === 'new' ? { k: 'g', w, ev, t: amt, pv: 1 } : { k: 'g', w, ev, e: amt, pv: 1 };
  }
  if (!ws.length) return null; const w = ws.slice(0, 2).map(x => { const n = nomW(x); return n[0].toUpperCase() + n.slice(1); }).join(' ');
  const pay = /(^|\s)верн/.test(t0), out = pay ? /^\s(я\s)?верн/.test(t0) : /(занял|взял[аи]?\s+(в\s+долг|взаймы)|(^|\s)я\s+долж)/.test(t0);
  return { k: 'd', w, i: out ? 0 : 1, ev: pay ? 'pay' : 'new', e: amt, pv: 1 };
}
const pvText = pv => { const r = pv.card.o[0]; return `${r[1]} · ${r[2]} ${r[4]}` + (r[5] ? ` · ${r[5]}` : ''); };
// v270: перерисовать карточку после нажатия: выбранное видно сразу, меню знает, что уже нажато
async function wPaint(env, id, act, pend) {
  const del = pend.some(p => p.op === 'del'), q = isQ(act), c = cardOf(act, pend) || { o: [] };
  const x = useWQ(env) ? { a: waOf(act, pend) } : null;
  return tg(env, 'editMessageWidgetData', { ...id, chat_data: rcData(del ? 'un' : act.st === 'ok' ? 'ok' : act.st, c, del ? (q ? 'Не будет записано.' : 'Отменится, когда откроется приложение.') : '', x) });
}
// одно действие из меню (кнопки Telegram или запрос виджета): c:<номер> — категория, d:<дата>, x — не записывать / отменить, u — вернуть
async function rcDo(box, row, act, a, b) {
  const q = isQ(act), later = q ? 'Запишется так, когда откроется приложение' : 'Изменится, когда откроется приложение';
  const inc0 = !!(act.r && act.r[0]);
  if (a === 't' && (b === 'i' || b === 'e')) {   // v271: «−/+»: расход ↔ доход; категория другого типа сбрасывается
    if ((b === 'i') === inc0) await box.rc.unCmd(row.id, 'type'); else await box.rc.cmd(row.id, 'type', b, act.v);
    const pc = (await box.rc.cmdsOf(row.id)).find(p => p.op === 'cat'), c = pc && act.k.find(x => x[0] === pc.val);
    if (c && !!c[5] !== (b === 'i')) await box.rc.unCmd(row.id, 'cat');
    return b === 'i' ? 'Доход' : 'Расход'; }
  if (a === 'c') { const c = act.k[Number(b)]; if (!c) return null; await box.rc.cmd(row.id, 'cat', c[0], act.v);
    if (act.n && !/^(in_)?other$/.test(c[0])) await profLearn(box, act.n, c[0]).catch(() => {});   // v281: запомнить для заметки сразу
    if (!!c[5] === inc0) await box.rc.unCmd(row.id, 'type'); else await box.rc.cmd(row.id, 'type', c[5] ? 'i' : 'e', act.v); return later; }
  if (a === 'd' && isD(b) && b <= act.td) { if (b === act.d) await box.rc.unCmd(row.id, 'date'); else await box.rc.cmd(row.id, 'date', b, act.v); return b === act.d ? 'Дата остаётся прежней' : later; }
  if (a === 'x' || a === 'Y') { await box.rc.cmd(row.id, 'del', '1', act.v); return q ? 'Не будет записано' : 'Запись отменится, когда откроется приложение'; }
  if (a === 'u' || a === 'U') { await box.rc.unCmd(row.id, 'del'); return q ? 'Запишется' : 'Отмена снята'; }
  return null;
}
// v273: «Вернули всё» — сразу фраза в очередь (как будто написали сами); «Другая сумма» / «Пополнить» — вопрос «Сколько?», ответом — сумма
// фразы — те, что приложение понимает (проверено): «Иван вернул 300», «вернул Маша 300», «в цель Отпуск 5000»
const dgTpl = x => x.k === 'g' ? `в цель ${x.n} {n}` : x.i ? `${x.n} вернул {n}` : `вернул ${x.n} {n}`;
const dgAsk = x => x.k === 'g' ? `🎯 Цель «${x.n}»: сколько отложить? Напишите сумму ответом на это сообщение.` : x.i ? `💵 Сколько вернул(а) ${x.n}? Напишите сумму ответом на это сообщение.` : `💵 Долг «${x.n}»: сколько вы вернули? Напишите сумму ответом на это сообщение.`;
async function dgDo(env, box, row, act, wq, ans) {
  const [a, i, how] = String(wq.data || '').split(':'), x = (act.g || [])[Number(i)];
  if (!x || x.c || !x.n || (a !== 'r' && a !== 'p') || (a === 'r') !== (x.k === 'd')) return ans({ e: 'bad' });
  const chat = wq.chat.id, reply = (text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, ...extra });
  if (how === 'a' && x.k === 'd' && x.ln > 0) {
    await ans({ ok: 1 });
    x.x = 1; await box.rc.setAct(row.id, JSON.stringify(act));
    await tg(env, 'editMessageWidgetData', { chat_id: chat, message_id: wq.message_id, chat_data: rcData('ok', { o: [], g: act.g }) }).catch(() => {});
    return queuePhrase(env, box, chat, dgTpl(x).replace('{n}', String(x.ln)), Math.floor(Date.now() / 1000), 'w' + wq.message_id, {}, reply);
  }
  if (how !== 'o') return ans({ e: 'bad' });
  await ans({ ok: 1 });
  const m = await (await reply(dgAsk(x), { reply_markup: { force_reply: true, input_field_placeholder: 'Например, 500' } })).json().catch(() => null);
  if (m && m.ok && m.result) await box.rc.ask(m.result.message_id, dgTpl(x));
}
// v275: раз в сутки (cron итогов) — карточки, чья запись так и ждёт приложения дольше суток: «Ждёт N дн. — откройте приложение».
// Меняются только данные карточки (тихо, без уведомления); сам бот по-прежнему ничего не записывает
async function staleRemind(env, now = Date.now()) {
  if (!env.DB || !useW(env)) return;
  await d1Init(env);
  const rows = (await env.DB.prepare('SELECT r.uid, r.id, r.chat, r.mid, r.text, r.act, r.at FROM rcpt r WHERE r.at < ? AND EXISTS (SELECT 1 FROM msgs m WHERE m.uid = r.uid AND m.id = r.id) ORDER BY r.at LIMIT 200').bind(now - 864e5).all()).results || [];
  for (const r of rows) {
    const days = Math.max(1, Math.floor((now - r.at) / 864e5)), hn = `⏳ Ждёт ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'} — откройте приложение, чтобы записать`;
    let act = null; try { act = JSON.parse(r.act || 'null'); } catch {}
    const box = store(env, r.uid), pend = act && act.r ? await box.rc.cmdsOf(String(r.id)) : [];
    const card = act && act.st === 'dgq' ? (act.g ? { o: [], g: act.g } : null) : act && act.r ? cardOf(act, pend) : null;
    const x = { hn, ...(act && act.r && useWQ(env) ? { a: waOf(act, pend) } : act && act.st === 'dgq' ? { ph: r.text } : {}) };
    await tg(env, 'editMessageWidgetData', { chat_id: r.chat, message_id: r.mid, chat_data: rcData('q', card, '', x) }).catch(() => {});
  }
}
// ---------- v275: карточка статистики (worker/card-st.html) ----------
const RC_ST = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--S:var(--tg-theme-secondary-bg-color,#f0f0f2);--H:var(--tg-theme-hint-color,#8a8a8e);--G:var(--tg-theme-bg-color,#fff);--T:var(--tg-theme-text-color,#000);--E:#2fa65a;--B:#3390ec}
*{box-sizing:border-box;margin:0}
html,body{background:var(--G)}
body{font:14px/1.3 system-ui,sans-serif;color:var(--T);padding:8px 12px 10px;-webkit-user-select:none;user-select:none}
.hd{display:flex;justify-content:space-between;align-items:baseline;font-weight:650;font-size:15px}
.hd small{font-weight:400;font-size:11px;color:var(--H)}
.tb{position:relative;display:flex;margin:6px 0 8px;padding:3px;border-radius:12px;background:var(--S)}
.tb i{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/3);border-radius:9px;background:var(--G);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .35s cubic-bezier(.3,1.3,.5,1)}
.tb button{-webkit-appearance:none;appearance:none;position:relative;flex:1;border:0;background:0;font:inherit;font-size:12.5px;font-weight:600;color:var(--H);padding:4px 0;transition:color .25s}
.tb button.on{color:var(--T)}
.hr{display:flex;align-items:center;gap:14px}
.dn{flex:0 0 82px;height:82px;position:relative}
.dn svg{width:82px;height:82px;transform:rotate(-90deg)}
.dn circle{fill:none;stroke-width:13;transition:stroke-dasharray .9s cubic-bezier(.2,.8,.2,1),stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)}
.dn b{position:absolute;inset:0;display:grid;place-items:center;font-size:20px}
.tt{flex:1;min-width:0}
.tt .l{font-size:12px;color:var(--H)}
.tt .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;margin:0 0 2px}
.tt .in{font-size:13px;color:var(--E);font-weight:600}
.tt .n{font-size:12px;color:var(--H);margin-top:2px}
.lg{margin-top:6px}
.rw{display:flex;align-items:center;gap:8px;padding:2px 0;animation:f .4s both;animation-delay:calc(var(--j)*60ms)}
@keyframes f{from{opacity:0;transform:translateY(5px)}}
.dt{flex:0 0 10px;height:10px;border-radius:50%}
.rw .m{flex:1;min-width:0}
.rw .k{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.rw .k span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rw .k b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.br{height:3px;border-radius:2px;background:var(--S);margin-top:2px;overflow:hidden}
.br i{display:block;height:100%;width:0;border-radius:2px;transition:width .8s cubic-bezier(.2,.8,.2,1)}
.ch{display:flex;align-items:flex-end;gap:4px;height:50px;margin-top:8px}
.ch div{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end}
.ch i{display:block;width:100%;max-width:26px;height:0;border-radius:5px 5px 2px 2px;background:var(--B);opacity:.85;transition:height .7s cubic-bezier(.2,.8,.2,1)}
.ch .td i{background:var(--E);opacity:1}
.ch span{font-size:10px;color:var(--H)}
.bu{margin-top:8px;padding:7px 10px;border-radius:12px;background:var(--S)}
.bu .k{display:flex;justify-content:space-between;font-size:13px}
.bu .br{height:6px;border-radius:3px;background:rgba(128,128,128,.22);margin:5px 0 3px}
.bu .br i{background:var(--E)}
.bu.x .br i{background:#e5484d}
.bu small{font-size:12px;color:var(--H)}
.em{padding:18px 0;text-align:center;color:var(--H);font-size:13px}
.ev{-webkit-appearance:none;appearance:none;display:inline-block;margin-top:8px;border:0;border-radius:10px;padding:5px 10px;font:inherit;font-size:11.5px;color:var(--H);background:var(--S)}
.ev b{color:var(--T)}
</style></head><body><div id="w"></div><script>
var T=window.TelegramWidget||{},w=document.getElementById("w"),D={},tab=0,j=0;
function E(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function F(n){return String(Math.round(+n||0)).replace(/\B(?=(\d{3})+(?!\d))/g," ")+" "+(D.cur||"")}
function hp(){try{T.HapticFeedback.selectionChanged()}catch(e){}}
function cnt(el,v){var t0=Date.now();(function s(){var k=Math.min(1,(Date.now()-t0)/700);el.textContent=F(v*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(s)})()}
function draw(){try{D=JSON.parse(T.chatData||"{}")||{}}catch(e){D={}}if(D.t!=null&&!draw.k){tab=D.t;draw.k=1}paint()}
function paint(){w.textContent="";j=0;var P=[D.d,D.w,D.m][tab]||null,h=E("div","hd");h.appendChild(E("span",0,"📊 Статистика"));if(D.up)h.appendChild(E("small",0,"обновлено "+D.up));w.appendChild(h);
var tb=E("div","tb"),ind=E("i");tb.appendChild(ind);["Сегодня","Неделя",D.m&&D.m.l||"Месяц"].forEach(function(l,i){var b=E("button",i===tab?"on":"",l);b.type="button";b.onclick=function(){if(tab===i)return;tab=i;hp();paint()};tb.appendChild(b)});
ind.style.transform="translateX("+(tab*100)+"%)";w.appendChild(tb);
if(!P){w.appendChild(E("div","em","Откройте приложение — здесь появятся цифры"));return}
var hr=E("div","hr"),dn=E("div","dn"),tt=E("div","tt"),c=P.c||[],tot=c.reduce(function(s,x){return s+x[2]},0),r=48,L=2*Math.PI*r;
var sv='<svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="'+r+'" stroke="rgba(128,128,128,.18)"/>';
c.forEach(function(x){sv+='<circle cx="54" cy="54" r="'+r+'" stroke="'+(/^#[0-9a-f]{6}$/i.test(x[3])?x[3]:"#3390ec")+'" stroke-dasharray="0 '+L+'"/>'});dn.innerHTML=sv+"</svg>";dn.appendChild(E("b",0,c[0]?c[0][0]:"🌿"));
tt.appendChild(E("div","l","Расходы"));var v=E("div","v");tt.appendChild(v);cnt(v,P.e);if(P.i)tt.appendChild(E("div","in","+ "+F(P.i)+" доход"));tt.appendChild(E("div","n",P.n?P.n+" "+(P.n%10===1&&P.n%100!==11?"запись":P.n%10>=2&&P.n%10<=4&&(P.n%100<10||P.n%100>=20)?"записи":"записей"):"Записей нет"));
hr.appendChild(dn);hr.appendChild(tt);w.appendChild(hr);
setTimeout(function(){var o=0,k=dn.querySelectorAll("circle");c.forEach(function(x,i){var a=tot?x[2]/tot*L:0,g=c.length>1?2:0;k[i+1].style.strokeDasharray=Math.max(0,a-g)+" "+L;k[i+1].style.strokeDashoffset=-o;o+=a})},60);
if(c.length){var lg=E("div","lg");c.forEach(function(x){var rw=E("div","rw"),d=E("i","dt"),m=E("div","m"),k=E("div","k"),b=E("div","br"),bi=E("i");rw.style.setProperty("--j",j++);var col=/^#[0-9a-f]{6}$/i.test(x[3])?x[3]:"#3390ec";d.style.background=col;bi.style.background=col;
k.appendChild(E("span",0,x[0]+" "+x[1]));k.appendChild(E("b",0,F(x[2])));b.appendChild(bi);m.appendChild(k);m.appendChild(b);rw.appendChild(d);rw.appendChild(m);lg.appendChild(rw);setTimeout(function(){bi.style.width=(tot?x[2]/tot*100:0)+"%"},80)});w.appendChild(lg)}
if(P.x&&P.x.length>1){var ch=E("div","ch"),mx=Math.max.apply(0,P.x)||1,W="Вс Пн Вт Ср Чт Пт Сб".split(" "),s0=P.s?new Date(P.s+"T00:00:00Z").getUTCDay():0;
P.x.forEach(function(x,i){var d=E("div",i===P.x.length-1?"td":""),bi=E("i");d.appendChild(bi);if(tab===1)d.appendChild(E("span",0,W[(s0+i)%7]));ch.appendChild(d);setTimeout(function(){bi.style.height=Math.max(3,x/mx*(tab===1?36:48))+"px"},80+i*25)});w.appendChild(ch)}
if(tab===2&&P.b){var bu=E("div","bu"+(P.b[0]>P.b[1]?" x":"")),k=E("div","k"),br=E("div","br"),bi=E("i");k.appendChild(E("span",0,"Бюджет"));k.appendChild(E("b",0,F(P.b[0])+" из "+F(P.b[1])));br.appendChild(bi);bu.appendChild(k);bu.appendChild(br);
bu.appendChild(E("small",0,P.b[0]>P.b[1]?"перерасход "+F(P.b[0]-P.b[1]):"осталось "+F(P.b[1]-P.b[0])));w.appendChild(bu);setTimeout(function(){bi.style.width=Math.min(100,P.b[0]/P.b[1]*100)+"%"},80)}
if(D.ev!=null&&T.request){var ev=E("button","ev");ev.type="button";ev.innerHTML="🌙 Сводка в 21:00 · <b>"+(D.ev?"вкл":"выкл")+"</b>";ev.onclick=function(){hp();T.request("ev:"+(D.ev?0:1)).catch(function(){})};w.appendChild(ev)}}
draw();if(T.onEvent)T.onEvent("chatDataChanged",draw);if(T.ready)T.ready();
</script></body></html>`;
const num = v => Math.round(Number(v) || 0);
function perClean(p) { if (!p || typeof p !== 'object') return null;
  const o = { e: num(p.e), i: num(p.i), n: num(p.n), c: (Array.isArray(p.c) ? p.c : []).slice(0, 5).filter(Array.isArray).map(x => [str(x[0], 8), str(x[1], 16), num(x[2]), /^#[0-9a-f]{6}$/i.test(x[3]) ? x[3] : '']) };
  if (Array.isArray(p.x)) o.x = p.x.slice(0, 31).map(num); if (isD(p.s)) o.s = p.s; if (p.l) o.l = str(p.l, 12); if (Array.isArray(p.b)) o.b = [num(p.b[0]), num(p.b[1])]; return o; }
const sumClean = b => ({ cur: str(b.cur, 8), tz: Math.max(-900, Math.min(900, Number(b.tz) || 0)), ds: isD(b.ds) ? b.ds : '', d: perClean(b.d), w: perClean(b.w), m: perClean(b.m) });
const locNow = (tz, now = Date.now()) => new Date(now - (Number(tz) || 0) * 60000);   // «местное» время в UTC-полях
function stData(sm, tab) {
  const s = sm.data, up = locNow(s.tz, sm.at), today = locNow(s.tz).toISOString().slice(0, 10);
  const d = { cur: s.cur, up: (s.ds === today ? '' : String(+s.ds.slice(8)) + '.' + s.ds.slice(5, 7) + ' ') + up.toISOString().slice(11, 16), t: tab, ev: sm.ev === '0' ? 0 : 1,
    d: s.ds === today ? s.d : { e: 0, i: 0, n: 0, c: [] }, w: s.w, m: s.m };
  let j = JSON.stringify(d);
  for (const cut of [() => delete d.m.x, () => d.w && d.w.c.splice(3), () => d.m && d.m.c.splice(3), () => d.d && d.d.c.splice(3)]) { if (u8(j) <= 1024) break; try { cut(); } catch {} j = JSON.stringify(d); }
  return j;
}
async function sendSt(env, box, chat, sm, tab) {
  const r = await (await tg(env, 'sendWidget', { chat_id: chat, html: RC_ST, chat_data: stData(sm, tab), allow_queries: true })).json().catch(() => null);
  if (r && r.ok && r.result) { await box.rc.sumUp('mid', r.result.message_id); if (!hookOk) { hookOk = true; await ensureCallbacks(env).catch(() => {}); } return r.result.message_id; }
  console.error('st widget', r && r.description);
  const s = sm.data, P = s.ds === locNow(s.tz).toISOString().slice(0, 10) ? s.d : null;   // запасной путь — текстом
  return tg(env, 'sendMessage', { chat_id: chat, text: `📊 Сегодня: ${P ? num(P.e) : 0} ${s.cur}\n${s.m ? s.m.l : 'Месяц'}: ${s.m ? num(s.m.e) : 0} ${s.cur}` });
}
async function stLive(env, box, uid) { const sm = await box.rc.sumGet(); if (sm && sm.mid) await tg(env, 'editMessageWidgetData', { chat_id: Number(uid), message_id: sm.mid, chat_data: stData(sm, null) }).catch(() => {}); }
// вечерняя сводка: ежечасный cron, в 21 час по поясу человека; только если сегодня что-то записано и сводка не отключена
const HOURLY = '0 * * * *';
async function evening(env, now = Date.now()) {
  if (!env.DB || !useW(env)) return; await d1Init(env);
  const rows = (await env.DB.prepare("SELECT uid, data, at, ev, mid, sent FROM sums WHERE COALESCE(ev, '1') <> '0' LIMIT 500").all()).results || [];
  for (const r of rows) { let data = null; try { data = JSON.parse(r.data); } catch {} if (!data) continue;
    const loc = locNow(data.tz, now), day = loc.toISOString().slice(0, 10);
    if (loc.getUTCHours() !== 21 || r.sent === day || data.ds !== day || !(data.d && data.d.n > 0)) continue;
    const box = store(env, r.uid); await box.rc.sumUp('sent', day); await sendSt(env, box, Number(r.uid), { ...r, data }, 0); }
}
async function onWidgetQuery(wq, env) {
  const ans = o => tg(env, 'answerWidgetQuery', { widget_query_id: wq.id, data: JSON.stringify(o) }).catch(() => {});
  if (!wq.chat || !wq.message_id || !env.DB || !wq.from) return ans({ e: 'old' });
  if (/^ad:(up|wk)$/.test(String(wq.data))) {   // v276: «Обновить» в карточке /stats — только владельцу
    if (!isOwner(env, wq.from.id)) return ans({ e: 'bad' }); await ans({ ok: 1 });
    return tg(env, 'editMessageWidgetData', { chat_id: wq.chat.id, message_id: wq.message_id, chat_data: await adData(env, String(wq.data) === 'ad:wk') }).catch(() => {}); }
  if (/^ev:[01]$/.test(String(wq.data))) { const b = store(env, wq.from.id); await b.rc.sumUp('ev', String(wq.data).slice(3)); await ans({ ok: 1 });   // v275: вечерняя сводка вкл/выкл
    const sm = await b.rc.sumGet(); if (sm) await tg(env, 'editMessageWidgetData', { chat_id: wq.chat.id, message_id: wq.message_id, chat_data: stData(sm, null) }).catch(() => {}); return; }
  const box = store(env, wq.from.id), row = await box.rc.byMsg(wq.chat.id, wq.message_id); let act = null;
  try { act = row && JSON.parse(row.act || 'null'); } catch {}
  if (!act) return ans({ e: 'old' });
  if (act.st === 'dg') return dgDo(env, box, row, act, wq, ans);   // v273: долг/цель
  const [a, b] = String(wq.data || '').split(':'), say = await rcDo(box, row, act, a, b);
  if (say == null) return ans({ e: 'bad' });
  await ans({ ok: 1, t: say });   // ответ — сразу (виджет ждёт до 15 с), карточку перерисовываем следом
  const id = { chat_id: wq.chat.id, message_id: wq.message_id }, pend = await box.rc.cmdsOf(row.id), line = pendLine(act, pend);
  await wPaint(env, id, act, pend);
  if (!useWQ(env)) await tg(env, 'editMessageCaption', { ...id, caption: `${RC_CAP[act.st || 'ok']}: «${row.text}»` + (line ? '\n' + line : ''), show_caption_above_media: true }).catch(() => {});
}
async function onRcCallback(cq, env) {
  const m = cq.message, ans = t => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(t ? { text: t } : {}) });
  const [, a, b] = String(cq.data).split(':');
  if (a === 'n' || !m || !env.DB || !cq.from) return ans();
  const box = store(env, cq.from.id), row = await box.rc.byMsg(m.chat.id, m.message_id); let act = null;
  try { act = row && JSON.parse(row.act || 'null'); } catch {}
  const id = { chat_id: m.chat.id, message_id: m.message_id };
  const kbSet = kb => tg(env, 'editMessageReplyMarkup', { ...id, reply_markup: kb });
  if (!act) { await kbSet({ inline_keyboard: [] }); return ans('Эту запись из чата уже не изменить'); }
  const st = act.st || 'ok', q = isQ(act), undel = q ? KB_QUNDEL : KB_UNDEL;
  const mainKb = pend => kbFor(env, act, pend.some(p => p.op === 'del') ? undel : null);
  const refresh = async (kb, say) => {   // подпись со строкой «⏳ …» + карточка с выбранным + кнопки
    const pend = await box.rc.cmdsOf(row.id), line = pendLine(act, pend);
    kb = kb ? kbFor(env, act, kb) : mainKb(pend);
    if (m.widget) {
      await wPaint(env, id, act, pend);
      await tg(env, 'editMessageCaption', { ...id, caption: `${RC_CAP[st]}: «${row.text}»` + (line ? '\n' + line : ''), show_caption_above_media: true, reply_markup: kb });
    } else await tg(env, 'editMessageText', { ...id, text: String(m.text || '').split('\n\n⏳ ')[0].split('\n\n🗑 ')[0] + (line ? '\n\n' + line : ''), reply_markup: kb });
    return ans(say);
  };
  if (a === 'K') { await kbSet(kbFor(env, act, kbCat(act))); return ans(); }
  if (a === 'D') { await kbSet(kbFor(env, act, kbCal(act.d.slice(0, 7), act))); return ans(); }
  if (a === 'M' && /^\d{4}-\d\d$/.test(b || '')) { await kbSet(kbFor(env, act, kbCal(b, act))); return ans(); }
  if (a === 'B') { await kbSet(mainKb(await box.rc.cmdsOf(row.id))); return ans(); }
  if (a === 'X') { await kbSet(kbFor(env, act, q ? KB_QDEL : KB_DEL)); return ans(); }
  if (a === 'c' || a === 'd' || a === 'Y' || a === 'U') { const t = await rcDo(box, row, act, a, b); return t == null ? ans() : refresh(a === 'Y' ? undel : null, t); }
  return ans();
}

async function transcribe(fileId, env) {
  const info = await (await tg(env, 'getFile', { file_id: fileId })).json();
  const path = info && info.result && info.result.file_path; if (!path) return '';
  const audio = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`); if (!audio.ok) return '';
  const fd = new FormData();
  fd.append('file', new File([await audio.arrayBuffer()], 'voice.ogg', { type: 'audio/ogg' }));
  fd.append('model', 'whisper-large-v3-turbo'); fd.append('language', 'ru'); fd.append('temperature', '0');
  // v262: образец фразы — распознавание чаще ставит точку после категории, и несколько записей в одном голосовом делятся верно («такси 200 плюшки. линелла 100 продукты»)
  fd.append('prompt', 'Кофе 300 кафе. Такси 120 транспорт. Линелла 450 продукты. Зарплата 15000.');
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
  // v269: словарь категорий тех, кто 30 дней не открывал приложение
  try { await env.DB.prepare('DELETE FROM prof WHERE at < ?').bind(now - TTL * 1000).run(); } catch {}
  try { await env.DB.prepare('DELETE FROM sums WHERE at < ?').bind(now - TTL * 1000).run(); } catch {}   // v275: итоги тех, кто 30 дней не открывал приложение
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
// ---------- v276: /stats и недельная сводка — карточкой (worker/card-ad.html); текст — запасной путь ----------
const RC_AD = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--S:var(--tg-theme-secondary-bg-color,#f0f0f2);--H:var(--tg-theme-hint-color,#8a8a8e);--G:var(--tg-theme-bg-color,#fff);--T:var(--tg-theme-text-color,#000);--E:#2fa65a;--B:#3390ec;--V:#8a5cf0;--R:#e5484d}
*{box-sizing:border-box;margin:0}
html,body{background:var(--G)}
body{font:14px/1.3 system-ui,sans-serif;color:var(--T);padding:8px 12px 10px;-webkit-user-select:none;user-select:none}
.hd{display:flex;justify-content:space-between;align-items:baseline;font-weight:650;font-size:15px}
.hd small{font-weight:400;font-size:11px;color:var(--H);display:flex;align-items:center;gap:6px}
.tb{position:relative;display:flex;margin:6px 0 8px;padding:3px;border-radius:12px;background:var(--S)}
.tb i{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/3);border-radius:9px;background:var(--G);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .35s cubic-bezier(.3,1.3,.5,1)}
.tb button{-webkit-appearance:none;appearance:none;position:relative;flex:1;border:0;background:0;font:inherit;font-size:12.5px;font-weight:600;color:var(--H);padding:4px 0}
.tb button.on{color:var(--T)}
.hr .l{font-size:12px;color:var(--H)}.ti .l{font-size:10px;line-height:1.15;color:var(--H);height:23px;overflow:hidden}
.hr .v{font-size:26px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1.1}
.hr .n{display:inline-block;margin-left:8px;font-size:13px;font-weight:600;color:var(--E);vertical-align:6px}
.sp{display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--S);margin:6px 0 4px}
.sp i{display:block;height:100%;width:0;transition:width .8s cubic-bezier(.2,.8,.2,1)}
.lg{display:flex;gap:12px;font-size:11px;color:var(--H)}
.lg span:before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--c)}
.gr{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:8px}
.ti{padding:6px 7px;border-radius:10px;background:var(--S);min-width:0;animation:f .4s both;animation-delay:calc(var(--j)*70ms)}
@keyframes f{from{opacity:0;transform:translateY(5px)}}
.ti b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
.ti em{display:block;font-style:normal;font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up{color:var(--E)}.dw{color:var(--R)}
.st{font-size:10.5px;font-weight:650;color:var(--H);text-transform:uppercase;letter-spacing:.04em;margin:9px 0 4px}
.ch{display:flex;align-items:flex-end;gap:6px;height:62px}
.ch div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;height:100%}
.ch b{font-size:11px;font-variant-numeric:tabular-nums}
.ch i{display:block;width:100%;max-width:28px;height:0;border-radius:5px 5px 2px 2px;background:var(--B);transition:height .7s cubic-bezier(.2,.8,.2,1)}
.ch .mx i{background:var(--E)}
.ch span{font-size:10px;color:var(--H)}
.rt{display:flex;gap:10px}
.rt>div{flex:1;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;background:var(--S);font-size:12.5px}
.rg{flex:0 0 40px;height:40px;position:relative}
.rg svg{width:40px;height:40px;transform:rotate(-90deg)}
.rg circle{fill:none;stroke-width:7;stroke:rgba(128,128,128,.22)}
.rg .v{stroke:var(--V);stroke-linecap:round;stroke-dasharray:138;stroke-dashoffset:138;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)}
.rg b{position:absolute;inset:0;display:grid;place-items:center;font-size:10.5px}
.rt small{display:block;font-size:10.5px;color:var(--H)}
.rf{-webkit-appearance:none;appearance:none;border:0;border-radius:8px;padding:2px 7px;font:inherit;font-size:12px;color:var(--T);background:var(--S)}
.rf.bz{opacity:.5}
.nt{font-size:10px;color:var(--H);margin-top:6px;padding-right:44px}
</style></head><body><div id="w"></div><script>
var T=window.TelegramWidget||{},w=document.getElementById("w"),D={},tab=1,j=0;
function E(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function F(n){return String(Math.round(+n||0)).replace(/\B(?=(\d{3})+(?!\d))/g," ")}
function cnt(el,v){var t0=Date.now();(function s(){var k=Math.min(1,(Date.now()-t0)/700);el.textContent=F(v*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(s)})()}
function hp(){try{T.HapticFeedback.selectionChanged()}catch(e){}}
function ti(l,v,em,cl){var t=E("div","ti");t.style.setProperty("--j",j++);t.appendChild(E("div","l",l));var b=E("b");cnt(b,v);t.appendChild(b);if(em)t.appendChild(E("em",cl,em));return t}
function dl(a,b){if(!b)return"";var p=Math.round(Math.abs(a-b)*100/b);return a===b?"= неделя назад":(a>b?"▲ ":"▼ ")+p+"%"}
function draw(){try{D=JSON.parse(T.chatData||"{}")||{}}catch(e){D={}}if(D.t!=null&&!draw.k){tab=D.t;draw.k=1}paint()}
function paint(){w.textContent="";j=0;var h=E("div","hd");h.appendChild(E("span",0,D.wk?"🗓 "+D.wk:"📈 Бот FinansePro"));var up=E("small",0,D.up||"");h.appendChild(up);w.appendChild(h);
var P=[D.d1,D.d7,D.d30][tab];if(!P){w.appendChild(E("div","nt",D.err||"Данных пока нет"));return}
if(!D.wk){var tb=E("div","tb"),ind=E("i");tb.appendChild(ind);["Сегодня","7 дней","30 дней"].forEach(function(l,i){var b=E("button",i===tab?"on":"",l);b.type="button";b.onclick=function(){if(tab!==i){tab=i;hp();paint()}};tb.appendChild(b)});
ind.style.transform="translateX("+(tab*100)+"%)";w.appendChild(tb)}else w.appendChild(E("div","st"," "));
var hr=E("div","hr");hr.appendChild(E("div","l","Людей"));var v=E("span","v");cnt(v,P.u);hr.appendChild(v);if(P.n)hr.appendChild(E("span","n","+"+P.n+" новых"));w.appendChild(hr);
var sp=E("div","sp"),a=E("i"),b=E("i"),sm=P.b+P.p||1;a.style.background="var(--B)";b.style.background="var(--V)";sp.appendChild(a);sp.appendChild(b);w.appendChild(sp);
setTimeout(function(){a.style.width=P.b/sm*100+"%";b.style.width=P.p/sm*100+"%"},60);
var lg=E("div","lg"),l1=E("span",0,"писали боту "+P.b),l2=E("span",0,"открывали приложение "+P.p);l1.style.setProperty("--c","var(--B)");l2.style.setProperty("--c","var(--V)");lg.appendChild(l1);lg.appendChild(l2);w.appendChild(lg);
var gr=E("div","gr"),c7=tab===1&&D.w0;gr.appendChild(ti("Сообщений",P.m,c7?dl(P.m,D.w0.m):"",c7&&P.m>=D.w0.m?"up":"dw"));gr.appendChild(ti("Голосом",P.v,P.m?Math.round(P.v/P.m*100)+"%":"",""));
gr.appendChild(ti("Новых",P.n,"",""));gr.appendChild(ti(c7?"Людей":"Писали боту",c7?P.u:P.b,c7?dl(P.u,D.w0.u):"",c7&&P.u>=D.w0.u?"up":"dw"));w.appendChild(gr);
if(D.days&&D.days.length){w.appendChild(E("div","st","Заходили по дням"));var ch=E("div","ch"),mx=Math.max.apply(0,D.days.map(function(x){return x[1]}))||1;
D.days.forEach(function(x,i){var d=E("div",x[1]===mx&&mx>0?"mx":""),bi=E("i");d.appendChild(E("b",0,x[1]||""));d.appendChild(bi);d.appendChild(E("span",0,x[0]));ch.appendChild(d);setTimeout(function(){bi.style.height=Math.max(3,x[1]/mx*34)+"px"},80+i*40)});w.appendChild(ch)}
if(D.r){w.appendChild(E("div","st","Возвращаются"));var rt=E("div","rt");D.r.forEach(function(r,i){var c=E("div"),g=E("div","rg"),p=r[1]?r[0]/r[1]:0;g.innerHTML='<svg viewBox="0 0 54 54"><circle cx="27" cy="27" r="22"/><circle class="v" cx="27" cy="27" r="22"/></svg>';
g.appendChild(E("b",0,r[1]?Math.round(p*100)+"%":"—"));c.appendChild(g);var t=E("div");t.appendChild(E("b",0,i?"Через месяц":"Через 7 дней"));t.appendChild(E("small",0,r[1]?r[0]+" из "+r[1]:"пока рано"));c.appendChild(t);rt.appendChild(c);
setTimeout(function(){g.querySelector(".v").style.strokeDashoffset=138*(1-p)},120)});w.appendChild(rt)}
if(D.nt)w.appendChild(E("div","nt",D.nt));
if(T.request){var rf=E("button","rf","🔄");rf.type="button";rf.onclick=function(){if(rf.classList.contains("bz"))return;rf.classList.add("bz");hp();T.request(D.wk?"ad:wk":"ad:up").then(function(){rf.classList.remove("bz")}).catch(function(){rf.classList.remove("bz");rf.textContent="⚠️"})};up.appendChild(rf)}}
draw();if(T.onEvent)T.onEvent("chatDataChanged",draw);if(T.ready)T.ready();
</script></body></html>`;
const hhmm = ms => new Intl.DateTimeFormat('ru-RU', { timeZone: OWNER_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
async function adData(env, wk, now = Date.now()) {
  if (!env.DB || !env.STATS_SALT) return JSON.stringify({ err: !env.DB ? 'Статистика работает только с базой D1.' : 'Статистика не собирается: нет секрета STATS_SALT.' });
  await stInit(env);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], D = ago(0, now), to = wk ? ago(1, now) : D, last = wk ? 1 : 0;
  const d7 = await period(env, ago(6 + last, now), to), w0 = await period(env, ago(13 + last, now), ago(7 + last, now));
  const rows = (await env.DB.prepare('SELECT day, COUNT(*) AS c FROM act WHERE day BETWEEN ? AND ? GROUP BY day').bind(ago(6 + last, now), to).all()).results || [];
  const cn = Object.fromEntries(rows.map(r => [r.day, N(r.c)])), days = [...Array(7)].map((_, i) => { const d = ago(6 - i + last, now); return [WD[new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + Number(d.slice(8)), cn[d] || 0]; });
  const r7 = await ret(env, 7, now), r30 = await ret(env, 30, now), first = await env.DB.prepare('SELECT MIN(day) AS d FROM act').first();
  const o = { up: 'обновлено ' + hhmm(now), t: 1, d7, w0, days, r: [[r7.r, r7.c], [r30.r, r30.c]],
    nt: 'Сутки — по UTC, ваши заходы тоже считаются.' + (!first || !first.d ? '' : first.d > ago(30, now) ? ` Счёт идёт с ${dm(first.d)}.` : '') };
  if (wk) o.wk = `Неделя ${dm(ago(7, now))} — ${dm(ago(1, now))}`; else { o.d1 = await period(env, D, D); o.d30 = await period(env, ago(29, now), D); }
  return JSON.stringify(o);
}
async function sendAd(env, chat, wk) {
  const r = await (await tg(env, 'sendWidget', { chat_id: chat, html: RC_AD, chat_data: await adData(env, wk), allow_queries: true })).json().catch(() => null);
  if (r && r.ok) { if (!hookOk) { hookOk = true; await ensureCallbacks(env).catch(() => {}); } return; }
  console.error('ad widget', r && r.description);
  return tg(env, 'sendMessage', { chat_id: chat, text: wk ? await weekText(env) : await statsText(env), parse_mode: 'HTML', reply_markup: wk ? WEEK_KB : STATS_KB });
}
async function sendWeekly(env, now = Date.now()) {
  if (!env.DB || !env.STATS_SALT || !env.OWNER_ID || !env.BOT_TOKEN || localHour(now, OWNER_TZ) !== WEEKLY_HOUR) return;
  await sendAd(env, Number(String(env.OWNER_ID).trim()), true);   // v276: карточкой
}
// нажатия кнопок статистики (только владельцу): «Обновить» — переписать это же сообщение, «Подробно» — новое сообщение с полным /stats
async function onCallback(cq, env) {
  if (/^rc:/.test(cq.data || '')) return onRcCallback(cq, env);   // v267: кнопки карточки-квитанции
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
  // пустой список — Telegram шлёт всё по умолчанию; иначе дописываем нужные типы (v270: и widget_query — нажатия в карточке)
  if (!r || !r.url || !Array.isArray(r.allowed_updates) || !r.allowed_updates.length || ['callback_query', 'widget_query'].every(t => r.allowed_updates.includes(t))) return;
  await tg(env, 'setWebhook', { url: r.url, secret_token: env.WEBHOOK_SECRET, allowed_updates: [...new Set([...r.allowed_updates, 'message', 'callback_query', 'widget_query'])],
    ...(r.max_connections ? { max_connections: r.max_connections } : {}) });
}
