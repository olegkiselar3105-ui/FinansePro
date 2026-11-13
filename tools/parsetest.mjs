// Проверка разбора фраз и команд на трёх языках. Снимок ожидаемого — tools/parsetest.json: {ru:[[фраза, итог]…], en:[…], ro:[…]}.
// Запуск: NODE_PATH=$(npm root -g) node tools/parsetest.mjs            — сверить со снимком (в конце «ИТОГ: OK»)
//         … node tools/parsetest.mjs --update ru|en|ro|all            — переписать снимок этого языка текущим поведением (после проверки глазами)
//         … node tools/parsetest.mjs --show en "coffee 300 cafe"      — показать разбор фраз
//         … node tools/parsetest.mjs --file <index.html> …            — проверить другую сборку
// Каждая фраза разбирается на одном и том же начальном состоянии (цели, долги, бюджет — ниже), дата — 12.11.2026.
// Кроме своего языка интерфейса, каждый набор прогоняется и на двух других: разбор не должен зависеть от языка интерфейса (сверяется всё, кроме текста ответа).
import fs from 'node:fs'; import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = new URL('..', import.meta.url).pathname, SNAP = ROOT + 'tools/parsetest.json';
const args = process.argv.slice(2); let file = ROOT + 'index.html'; { const i = args.indexOf('--file'); if (i >= 0) { file = args[i + 1]; args.splice(i, 2); } }
const snap = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : { ru: [], en: [], ro: [] };
const html = fs.readFileSync(file, 'utf8'), br = await chromium.launch();
const SEED = { budget: 20000, limits: { food: 3000 }, rates: { EUR: 19.5, USD: 17.5 }, curList: ['EUR', 'USD'],
  goals: [['g1', 'Отпуск', 50000, 1000], ['g2', 'Машина', 200000, 0], ['g3', 'Vacation', 3000, 100], ['g4', 'Vacanță', 3000, 100]].map(([id, name, target, saved]) => ({ id, name, target, saved, plan: 0, tag: '', created: '2026-10-01', log: [] })),
  debts: [['d1', 'Иван', 'in', 500], ['d2', 'Ксюша', 'out', 300], ['d3', 'John', 'in', 400], ['d4', 'Anna', 'out', 250], ['d5', 'Ion', 'in', 400], ['d6', 'Elena', 'out', 250]].map(([id, who, dir, amount]) => ({ id, who, dir, amount, paid: 0, due: '', created: '2026-10-01', log: [] })) };
async function open(lang) { const p = await br.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(String(e)));
  await p.clock.install({ time: new Date('2026-11-12T10:00:00') });
  await p.route('**/*', r => r.request().url() === 'https://app.test/' ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.fulfill({ status: 404, body: '' }));
  await p.addInitScript(l => { if (!localStorage.getItem('finapp.settings')) localStorage.setItem('finapp.settings', JSON.stringify({ cur: 'MDL', catSet: 'v3', onb: 1, wnSeen: '2026-11-12-v278', linkDebt: true, linkGoal: true, ...(l === 'ru' ? {} : { lang: l }) })); }, lang);
  await p.goto('https://app.test/'); await p.clock.runFor(3000);
  p.run = list => p.evaluate(([list, SEED]) => list.map(t => { try {
    const cl = o => JSON.parse(JSON.stringify(o)); tx = []; learn = {}; drafts = [];
    Object.assign(cfg, { budget: SEED.budget, bm: {}, limits: cl(SEED.limits), lm: {}, rates: cl(SEED.rates), rman: {}, curList: cl(SEED.curList), goals: cl(SEED.goals), debts: cl(SEED.debts), mStart: 1, catAl: {} });
    needRate.clear(); const cm = voiceCmds(t), r = parse(cm.rest), st = [];
    cfg.debts.forEach((d, i) => { const o = SEED.debts[i]; if (!o || o.amount !== d.amount || d.paid || d.due) st.push('долг ' + [d.who, d.dir, d.amount, d.paid, d.due || ''].join('/')); });
    cfg.goals.forEach((g, i) => { const o = SEED.goals[i]; if (!o || o.target !== g.target || o.saved !== g.saved || g.by) st.push('цель ' + [g.name, g.target, g.saved, g.by || ''].join('/')); });
    if (cfg.budget !== SEED.budget) st.push('бюджет ' + cfg.budget); if (Object.keys(cfg.bm || {}).length) st.push('бюджет месяца ' + JSON.stringify(cfg.bm));
    if (JSON.stringify(cfg.limits) !== JSON.stringify(SEED.limits)) st.push('лимиты ' + JSON.stringify(cfg.limits)); if (JSON.stringify(cfg.rates) !== JSON.stringify(SEED.rates)) st.push('курсы ' + JSON.stringify(cfg.rates));
    if (cfg.mStart !== 1) st.push('начало месяца ' + cfg.mStart); tx.forEach(x => st.push('связанная ' + [x.type === 'income' ? '+' : '-', x.amount, x.category].join(' ')));
    const res = r.map(d => [d.type === 'income' ? '+' : '-', d.amount, d.oc ? d.oa + d.oc : '', d.category, d.note === cd(d.category).n ? '=' : '«' + d.note + '»', d.date, (d.tags || []).map(g => '#' + g).join(''), d.cw ? 'cw:' + d.cw : ''].filter(x => x !== '').join(' ')).concat(st).join(' ; ');
    return [res, cm.msgs.join(' | ').replace(/\n/g, ' / ')]; } catch (e) { return ['ОШИБКА ' + e.message, '']; } }), [list, SEED]);
  return p; }
const P = {}; for (const l of ['ru', 'en', 'ro']) P[l] = await open(l);
let bad = 0;
if (args[0] === '--show') { const out = await P[args[1]].run(args.slice(2)); args.slice(2).forEach((t, i) => console.log(t + '\n   ' + out[i][0] + (out[i][1] ? '\n   ↳ ' + out[i][1] : ''))); }
else if (args[0] === '--update') { for (const l of args[1] === 'all' ? ['ru', 'en', 'ro'] : [args[1]]) { const ph = snap[l].map(x => x[0]), out = await P[l].run(ph); snap[l] = ph.map((t, i) => [t, out[i][0], out[i][1]]); }
  fs.writeFileSync(SNAP, '{\n' + ['ru', 'en', 'ro'].map(l => JSON.stringify(l) + ':[\n' + snap[l].map(x => JSON.stringify(x)).join(',\n') + '\n]').join(',\n') + '\n}\n'); console.log('снимок обновлён'); }
else { for (const l of ['ru', 'en', 'ro']) { const ph = snap[l].map(x => x[0]);
    for (const ui of ['ru', 'en', 'ro']) { const out = await P[ui].run(ph); let n = 0;
      ph.forEach((t, i) => { if (ui !== l && /\d\.\d{3}(?!\d)/.test(t)) return;   // «1.500» — тысяча только при румынском интерфейсе
        const nz = x => ui === l ? x : x.replace(/ (?:=|«[^»]*») (?=\d{4}-\d\d-\d\d)/g, ' ~ '), okR = nz(out[i][0]) === nz(snap[l][i][1]), okM = ui !== l || out[i][1] === snap[l][i][2];
        if (!okR || !okM) { n++; bad++; if (n <= 12) console.log(`РАЗНИЦА [фразы ${l}, интерфейс ${ui}] ${t}\n   ждали: ${snap[l][i][1]}${okM ? '' : ' ↳ ' + snap[l][i][2]}\n   стало: ${out[i][0]}${okM ? '' : ' ↳ ' + out[i][1]}`); } });
      console.log(`фразы ${l} (${ph.length}), интерфейс ${ui}: ${n ? 'расхождений ' + n : 'совпало'}`); } } }
for (const l of ['ru', 'en', 'ro']) if (P[l].errs.length) { bad++; console.log('ошибки страницы', l, P[l].errs.join(' | ').slice(0, 300)); }
await br.close(); if (args[0] !== '--show' && args[0] !== '--update') console.log(bad ? 'ИТОГ: РАСХОЖДЕНИЙ ' + bad : 'ИТОГ: OK'); process.exit(bad ? 1 : 0);
