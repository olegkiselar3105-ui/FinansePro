// Тест синхронизации: два «устройства» (два контекста браузера) и общее поддельное облако Telegram (CloudStorage), очередь бота — заглушка.
// Запуск: NODE_PATH=$(npm root -g) node tools/synctest.mjs [index.html] — в конце «ИТОГ: OK». Проверяет: правку во время чтения облака, настройки и удаления
// при объединении, повторы и записи из бота на двух устройствах, нечитаемое облако, второй аккаунт Telegram на том же устройстве, метку спасения
import { createRequire } from 'node:module'; import fs from 'node:fs'; const { chromium } = createRequire(import.meta.url)('playwright');
const html = fs.readFileSync(process.argv[2] || new URL('../index.html', import.meta.url), 'utf8');
const clouds = {};   // uid -> Map
let pending = [];    // очередь бота
const br = await chromium.launch(); let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
async function device(uid, ctx) {
  ctx = ctx || await br.newContext();
  const page = await ctx.newPage(); page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e))); page.on('console', m => { if (/modal!/.test(m.text())) console.log(m.text()); });
  await page.exposeFunction('__cs', (op, a) => { const m = clouds[uid] = clouds[uid] || new Map();
    if (op === 'getItem') return m.get(a[0]) || ''; if (op === 'getItems') return Object.fromEntries(a[0].map(k => [k, m.get(k) || '']));
    if (op === 'setItem') { m.set(a[0], a[1]); return true; } if (op === 'getKeys') return [...m.keys()];
    if (op === 'removeItems') { a[0].forEach(k => m.delete(k)); return true; } if (op === 'removeItem') { m.delete(a[0]); return true; } });
  await page.addInitScript(uid => { if (!window.__rsqTest) try { localStorage.setItem('finapp.rsqd', '1'); } catch {} const cs = {}; ['getItem', 'getItems', 'setItem', 'getKeys', 'removeItems', 'removeItem'].forEach(op => { cs[op] = (...a) => { const cb = a.pop(); window.__cs(op, a).then(r => cb(null, r), e => cb(String(e))); }; });
    const noop = () => {}; window.Telegram = { WebApp: new Proxy({ initData: 'user=x', initDataUnsafe: { user: { id: uid, first_name: 'T' } }, CloudStorage: cs, version: '8.0', platform: 'ios', colorScheme: 'dark', themeParams: {},
      isVersionAtLeast: () => true, onEvent: noop, offEvent: noop, ready: noop, expand: noop, safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 }, contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 }, viewportHeight: 800, viewportStableHeight: 800,
      BiometricManager: { init: noop, isInited: false }, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop } }, { get: (t, k) => k in t ? t[k] : noop }) }; }, uid);
  await ctx.route('**/*', r => { const u = r.request().url();
    if (u.startsWith('https://app.test/')) return u.endsWith('/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.fulfill({ status: 404, body: '' });
    if (u.includes('/api/pending')) return r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ items: pending }) });
    if (u.includes('/api/')) return r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } }) : r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"ok":true}' });
    return r.abort(); });
  await page.goto('https://app.test/');
  await page.waitForFunction(() => typeof CL === 'object' && CL.ready && !CL.busy, null, { timeout: 15000 });
  await page.evaluate(() => { cfg.onb = 1; window.isModalOpen = () => false; });
  page.sync = async () => { await page.evaluate(async () => { window.__onbOn = false; document.querySelectorAll('.glass.on,#sh.on').forEach(e => e.classList.remove('on')); if (isModalOpen()) console.log('modal!', [...document.querySelectorAll('.on')].map(e => e.id).join()); clearTimeout(CL.retryT); clearTimeout(CL.timer); CL.pending = false; const w = async () => { while (CL.busy) await new Promise(r => setTimeout(r, 30)); };
    await w(); await cloudSync('t'); await w(); await new Promise(r => setTimeout(r, 350)); await w(); clearTimeout(CL.timer); CL.pending = false; }); };
  page.ctx = ctx; return page;
}
const add = (p, id, note, amount = 10) => p.evaluate(([id, note, amount]) => { tx = [{ id, type: 'expense', amount, category: 'food', note, date: ymd(new Date()) }, ...tx]; save(); }, [id, note, amount]);
const ids = p => p.evaluate(() => tx.map(t => t.id).sort());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- основа: A с данными, B пустое забирает облако ----------
const A = await device(1); await add(A, 'a0', 'база'); await A.evaluate(() => { cfg.budget = 5000; cfg.limits = { food: 100, transport: 200 }; cfg.tpls = [{ id: 't0', type: 'expense', amount: 5, category: 'food', note: 'шаблон0' }]; save(); }); await A.sync();
const B = await device(1); await B.sync();
ok((await ids(B)).join() === 'a0' && await B.evaluate(() => cfg.budget) === 5000, 'пустое устройство берёт облако целиком');
ok(!A.errs.length && !B.errs.length, 'нет ошибок страницы ' + A.errs.concat(B.errs).join(' | ').slice(0, 300));

// ---------- D1: правка во время чтения облака ----------
await sleep(5); await add(A, 'a1', 'с устройства A'); await A.sync();
await B.evaluate(() => { const cr = cloudRead; window.__hit = 0; cloudRead = async m => { const d = await cr(m); if (!window.__hit++) { tx = [{ id: 'b1', type: 'expense', amount: 7, category: 'food', note: 'во время чтения', date: ymd(new Date()) }, ...tx]; save(); } return d; }; });
await B.sync(); await B.evaluate(() => { window.__hit = 1; }); await A.sync(); await B.sync();
ok((await ids(B)).join() === 'a0,a1,b1', 'D1: B сохранило и свою запись, и запись A — ' + await ids(B));
ok((await ids(A)).join() === 'a0,a1,b1', 'D1: A получило обе — ' + await ids(A));

// ---------- D3/D6: настройки при объединении ----------
await sleep(5);
await A.evaluate(() => { cfg.budget = 6000; cfg.tpls.push({ id: 't1', type: 'expense', amount: 9, category: 'food', note: 'шаблон1' }); delete cfg.limits.transport; cfg.limits.cafe = 300; cfg.hide = [...(cfg.hide || []), 'pets']; save(); }); await A.sync();
await B.evaluate(() => { cfg.limits.food = 150; save(); });   // у B своя правка → будет объединение
await add(B, 'b2', 'своя'); await B.sync(); await A.sync(); await B.sync();
for (const [n, p] of [['B', B], ['A', A]]) { const c = await p.evaluate(() => ({ b: cfg.budget, t: cfg.tpls.map(x => x.id).join(), l: JSON.stringify(Object.fromEntries(Object.entries(cfg.limits).sort())), h: cfg.hide.includes('pets') }));
  ok(c.b === 6000, `D3 ${n}: бюджет с другого устройства не откатился — ${c.b}`); ok(c.t === 't0,t1', `D3 ${n}: шаблон не потерян — ${c.t}`);
  ok(c.l === '{"cafe":300,"food":150}', `D6 ${n}: удалённый лимит не вернулся, правки обоих на месте — ${c.l}`); ok(c.h, `D3 ${n}: скрытая категория дошла`); }
ok(await A.evaluate(() => cloudHash()) === await B.evaluate(() => cloudHash()), 'после сверок данные на A и B одинаковые');
// удаление шаблона на A + правка на B
await sleep(5); await A.evaluate(() => { cfg.tpls = cfg.tpls.filter(x => x.id !== 't0'); save(); }); await A.sync(); await add(B, 'b3', 'ещё'); await B.sync(); await A.sync();
ok(await B.evaluate(() => cfg.tpls.map(x => x.id).join()) === 't1' && await A.evaluate(() => cfg.tpls.map(x => x.id).join()) === 't1', 'D3: удалённый шаблон не вернулся');

// ---------- D5: повторяющаяся операция ----------
await sleep(5);
await A.evaluate(() => { const td = ymd(new Date()); cfg.rec.push({ id: 'rr1', type: 'expense', amount: 50, category: 'food', note: 'аренда', freq: 'month', mode: 'day', day: +td.slice(8), wd: 0, mon: 0, start: td, end: '', done: '', paused: true }); save(); }); await A.sync(); await B.sync();
await A.evaluate(() => { cfg.rec.find(r => r.id === 'rr1').paused = false; applyRec(); save(); });
await B.evaluate(() => { cfg.rec.find(r => r.id === 'rr1').paused = false; applyRec(); save(); });
const rid = await A.evaluate(() => tx.filter(t => t.rid === 'rr1').map(t => t.id).join());
ok(/^rrr1_\d{4}-\d\d-\d\d$/.test(rid) && rid === await B.evaluate(() => tx.filter(t => t.rid === 'rr1').map(t => t.id).join()), 'D5: на двух устройствах один id — ' + rid);
await A.evaluate(id => { tx = tx.filter(t => t.id !== id); tomb(id); save(); }, rid); await A.sync(); await B.sync(); await A.sync();
ok(await B.evaluate(() => tx.filter(t => t.rid === 'rr1').length) === 0 && await A.evaluate(() => tx.filter(t => t.rid === 'rr1').length) === 0, 'D5: удалённая на A не вернулась с B');
ok(await A.evaluate(() => applyRec()) === 0, 'D5: удалённая запись не создаётся заново');

// ---------- D4: одна фраза из бота на двух открытых устройствах ----------
pending = [{ id: 'm777', text: 'кофе 300 продукты', ts: Math.floor(Date.now() / 1000) }];
for (const p of [A, B]) await p.evaluate(async () => { IB.busy = false; IB.proc = false; await inboxPull(false); if (drafts.length) commit(drafts.splice(0), false); });
pending = [];
const bi = await A.evaluate(() => tx.filter(t => t.bs === 'm777').map(t => t.id).join());
ok(bi === 'bm777_0' && bi === await B.evaluate(() => tx.filter(t => t.bs === 'm777').map(t => t.id).join()), 'D4: запись из бота получила id из фразы на обоих — ' + bi);
await A.sync(); await B.sync(); await A.sync();
ok(await A.evaluate(() => tx.filter(t => t.bs === 'm777').length) === 1 && await B.evaluate(() => tx.filter(t => t.bs === 'm777').length) === 1, 'D4: после сверки одна операция, не две');
ok(await A.evaluate(() => cloudHash()) === await B.evaluate(() => cloudHash()), 'в конце данные на A и B одинаковые');

// ---------- нечитаемое облако ----------
const m1 = clouds[1]; const keep = m1.get('d0'); m1.set('d0', 'мусор'); { const mm = JSON.parse(m1.get('meta')); mm.h = 'zzz'; m1.set('meta', JSON.stringify(mm)); }
await add(B, 'b9', 'после порчи'); await B.sync();
ok(m1.get('d0') === 'мусор', 'нечитаемое облако с первой попытки не затирается');
await B.sync(); await B.sync(); await B.sync();
ok(m1.get('d0') !== 'мусор' && (await B.evaluate(() => CL.st)) === 'ok', 'после трёх неудач устройство отправляет свою копию');
await A.sync(); ok((await ids(A)).includes('b9'), 'A после восстановления получило запись B');

// ---------- D2: другой аккаунт Telegram на том же устройстве ----------
const nA = (await ids(A)).length; await A.close();
const A2 = await device(2, A.ctx);   // тот же localStorage, другой аккаунт
ok((await ids(A2)).length === 0, 'D2: второй аккаунт не видит записи первого — ' + (await ids(A2)).length);
await add(A2, 'u2', 'второй аккаунт'); await A2.sync();
ok(clouds[2] && !JSON.stringify([...clouds[2].values()]).includes('a0') , 'D2: в облако второго аккаунта чужие записи не ушли');
await A2.close(); const A1 = await device(1, A.ctx); await A1.sync();
const back = await ids(A1); ok(back.length === nA + 0 || back.includes('a0'), 'D2: первый аккаунт вернулся к своим записям — ' + back.length + ' из ' + nA); ok(!back.includes('u2'), 'D2: записи второго к первому не попали');
ok(!A1.errs.length && !A2.errs.length && !B.errs.length, 'нет ошибок страницы ' + [...A1.errs, ...A2.errs, ...B.errs].join(' | ').slice(0, 300));
// ---------- метка спасения у нового человека ----------
{ const ctx = await br.newContext(); await ctx.addInitScript(() => { window.__rsqTest = 1; }); const N = await device(9, ctx);
  ok(/rescue/.test(clouds[9].get('meta') || ''), 'новый человек: метка спасения поставлена');
  await add(N, 'n1', 'первая запись'); await N.sync(); ok(/rescue/.test(clouds[9].get('meta')), 'свежая метка: ждём (как раньше)');
  clouds[9].set('meta', JSON.stringify({ rescue: 1, t: Date.now() - 3 * 864e5 })); await N.sync(); await N.sync();
  ok(!/rescue/.test(clouds[9].get('meta')) && clouds[9].has('d0'), 'метке больше 2 суток и есть данные — записи ушли в облако');
  ok((await ids(N)).join() === 'n1' && !N.errs.length, 'данные на месте, ошибок нет ' + N.errs.join('|').slice(0, 200)); }
await br.close(); console.log(fails ? 'ИТОГ: FAIL ' + fails : 'ИТОГ: OK'); process.exit(fails ? 1 : 0);
