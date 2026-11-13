// Переводы интерфейса (RU → EN, RO). Русская строка в коде — она же ключ; перевод лежит в i18n/dict.json.
//   NODE_PATH=<папка с acorn>/node_modules node tools/i18n.mjs wrap    — обернуть новые русские строки в LT('…') / LH`…` (повторный запуск ничего не портит)
//   … node tools/i18n.mjs scan [файл]  — список ключей без перевода (в файл — по одному в строке, с номером)
//   … node tools/i18n.mjs build        — вставить словарь из i18n/dict.json в index.html (между метками I18N-DICT)
//   … node tools/i18n.mjs keys <файл>  — все ключи по порядку появления в коде (для сверки контекста)
// acorn ставится в любую временную папку: npm i acorn acorn-walk. После правки русских текстов: wrap → scan → перевести → build.
// Как это работает в приложении (блок I18N-CORE в index.html): LT('строка') и LH`шаблон` режут текст на отрезки между тегами HTML
// (подстановки ${…} внутри отрезка становятся {0}, {1}…), ключ — отрезок без пробелов по краям; в русском режиме строка не меняется.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const rq = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname, FILE = ROOT + 'index.html', DICT = ROOT + 'i18n/dict.json';
const CY = /[а-яёА-ЯЁ«»]/;
const cmd = process.argv[2];
let html = fs.readFileSync(FILE, 'utf8');

// ---- ядро: то же, что работает в приложении ----
const coreSrc = () => { const m = /\/\*I18N-CORE\*\/([\s\S]*?)\/\*I18N-CORE-END\*\//.exec(html); if (!m) throw new Error('нет блока I18N-CORE в index.html'); return m[1]; };
const core = () => new Function(coreSrc() + ';return I18;')();

// ---- блоки <script> ----
function blocks() { const out = [], re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) out.push({ start: m.index + m[0].indexOf('>') + 1, code: m[1] }); return out; }

// названия объявлений верхнего уровня, внутри которых строки — данные разбора фраз, а не интерфейс
const SKIP_TOP = new Set((process.env.I18N_SKIP || '').split(',').filter(Boolean).concat([
  'PL_MO', 'PL_WD', 'PL_R', 'PL_C', 'plxBack', 'CURS', 'NAMES_F', 'NAMES_M', 'NWD', 'NUMW', 'NUMW2', 'ORDW', 'MI', 'WDI', 'CAT_AL', 'XI_H', 'xiDate', 'TRANSLIT', 'nomName', 'nomW', 'isFem', 'catStem', 'numWords', 'wordNums', 'xiParse', 'xiN', 'norm', 'saveCmd', 'lkMigrate', 'lkGoalEdit', 'lkDebtEdit', 'detect']));
const SKIP_M = new Set(['includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'split', 'match', 'matchAll', 'test', 'search', 'getItem', 'setItem', 'removeItem', 'has', 'get', 'delete',
  'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'localeCompare', 'normalize', 'error', 'warn', 'log', 'debug', 'exec']);

function analyse() {
  const acorn = rq('acorn'), walk = rq('acorn-walk');
  const sites = [], skipped = [];
  for (const b of blocks()) {
    if (!CY.test(b.code)) continue;
    let ast; try { ast = acorn.parse(b.code, { ecmaVersion: 'latest', sourceType: 'script', ranges: false }); } catch (e) { throw new Error('разбор блока на ' + b.start + ': ' + e.message); }
    const topOf = new Map();   // узел верхнего уровня → имя
    for (const n of ast.body) { let nm = '';
      if (n.type === 'FunctionDeclaration') nm = n.id.name; else if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') topOf.set(d, d.id.name);
      if (nm) topOf.set(n, nm); }
    const visit = (node, anc) => {
      const isT = node.type === 'TemplateLiteral';
      if (isT ? !node.quasis.some(q => CY.test(q.value.cooked || '')) : !(typeof node.value === 'string' && CY.test(node.value))) return;
      const p = anc[anc.length - 2], top = anc.map(a => topOf.get(a)).find(Boolean) || '';
      let fnName = ''; for (let i = anc.length - 2; i >= 0; i--) { const a = anc[i]; if (a.type === 'FunctionDeclaration' && a.id) { fnName = a.id.name; break; } if (a.type === 'VariableDeclarator' && a.id.type === 'Identifier' && /Function|Arrow/.test((a.init || {}).type || '')) { fnName = a.id.name; break; } }
      const site = { b, node, isT, top, fn: fnName, text: isT ? null : node.value };
      let why = '';
      if (isT && p.type === 'TaggedTemplateExpression') { if (p.tag.name === 'LH') sites.push({ ...site, done: true }); return; }
      if (!isT && p.type === 'CallExpression' && p.callee.name === 'LT' && p.arguments[0] === node) { sites.push({ ...site, done: true }); return; }
      const inRe = anc.some(a => (a.type === 'NewExpression' || a.type === 'CallExpression') && a.callee && a.callee.name === 'RegExp');
      const txt = isT ? node.quasis.map(q => q.value.cooked).join('') : node.value;
      if (top === 'CURS' && !isT && p.type === 'Property' && p.value === node && (p.key.name || p.key.value) === 'n') why = '';   // название валюты — текст, слова для разбора — данные
      else if (SKIP_TOP.has(top) || SKIP_TOP.has(fnName)) why = 'data:' + (SKIP_TOP.has(top) ? top : fnName);
      else if (inRe || /\\[sSdbwS]|\(\?[:!=<]|\[а-я|\$\d/.test(txt)) why = 'regexp';
      else if (!isT && p.type === 'CallExpression' && p.callee.type === 'MemberExpression' && /^replace(All)?$/.test(p.callee.property.name || '') && p.arguments[1] === node && (p.arguments[0].regex || txt.length <= 2)) why = 'replace-to';
      if (why) {} else if (p.type === 'Property' && p.key === node && !p.computed) why = 'key';
      else if (p.type === 'MemberExpression' && p.property === node) why = 'lookup';
      else if (p.type === 'MemberExpression' && p.object === node) why = 'object';
      else if (p.type === 'BinaryExpression' && /^(===?|!==?|in|<|>|<=|>=)$/.test(p.operator)) why = 'compare';
      else if (p.type === 'SwitchCase' && p.test === node) why = 'case';
      else if (p.type === 'NewExpression' && p.callee.name === 'RegExp') why = 'regexp';
      else if (p.type === 'CallExpression' && p.callee.type === 'MemberExpression' && !p.callee.computed) { const mn = p.callee.property.name;
        if (SKIP_M.has(mn)) why = 'method:' + mn; else if ((mn === 'replace' || mn === 'replaceAll') && p.arguments[0] === node) why = 'method:replace'; }
      if (why) { skipped.push({ ...site, why }); return; }
      sites.push(site);
    };
    walk.ancestor(ast, { Literal: visit, TemplateLiteral: visit });
  }
  return { sites, skipped };
}
const pattern = node => { let p = node.quasis[0].value.cooked; for (let i = 1; i < node.quasis.length; i++) p += '\x01' + (i - 1) + '\x02' + node.quasis[i].value.cooked; return p; };

function allKeys() {   // ключи в порядке появления: {key, ctx}
  const I18 = core(), { sites } = analyse(), seen = new Map(), add = (src, where) => I18.seg(src, k => { if (!seen.has(k)) seen.set(k, where); return null; });
  // статичная разметка страницы (без скриптов и стилей)
  const stat = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  add(stat.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), 'html');
  add(stat, 'html');
  for (const s of sites) add(s.isT ? pattern(s.node) : s.text, s.fn || s.top || '?');
  return seen;
}

if (cmd === 'wrap') {
  const { sites, skipped } = analyse(), todo = sites.filter(s => !s.done);
  const eds = todo.map(s => ({ at: s.b.start + s.node.start, end: s.b.start + s.node.end, isT: s.isT })).sort((a, b) => b.at - a.at);
  for (const e of eds) { const sp = /[\w$]/.test(html[e.at - 1] || '') ? ' ' : '';
    html = e.isT ? html.slice(0, e.at) + sp + 'LH' + html.slice(e.at) : html.slice(0, e.at) + sp + 'LT(' + html.slice(e.at, e.end) + ')' + html.slice(e.end); }
  fs.writeFileSync(FILE, html);
  console.log('обёрнуто:', todo.length, '(строк', todo.filter(s => !s.isT).length + ', шаблонов', todo.filter(s => s.isT).length + '); уже было:', sites.length - todo.length, '; пропущено:', skipped.length);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], skipped.map(s => s.why + '\t' + (s.fn || s.top) + '\t' + JSON.stringify(s.isT ? pattern(s.node) : s.text).slice(0, 160)).join('\n'));
} else if (cmd === 'report') {   // до обёртки: где сколько русских строк и что будет пропущено
  const { sites, skipped } = analyse(), by = {};
  for (const s of sites) by[s.top || s.fn || '?'] = (by[s.top || s.fn || '?'] || 0) + 1;
  console.log('к обёртке:', sites.filter(s => !s.done).length, 'готово:', sites.filter(s => s.done).length, 'пропущено:', skipped.length);
  console.log(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 60).map(e => e.join(':')).join('  '));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], skipped.map(s => s.why + '\t' + (s.fn || s.top) + '\t' + JSON.stringify(s.isT ? pattern(s.node) : s.text).slice(0, 200)).join('\n'));
} else if (cmd === 'keys' || cmd === 'scan') {
  const keys = allKeys(), dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
  const list = [...keys.entries()].filter(([k]) => cmd === 'keys' || !dict[k] || (!dict[k].x && (!dict[k].en || !dict[k].ro)));
  console.log('ключей:', keys.size, '; без перевода:', [...keys.keys()].filter(k => !dict[k] || (!dict[k].x && (!dict[k].en || !dict[k].ro))).length, '; в словаре лишних:', Object.keys(dict).filter(k => !keys.has(k)).length);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], list.map(([k, w], i) => i + '\t' + w + '\t' + JSON.stringify(k).slice(1, -1)).join('\n') + '\n');
} else if (cmd === 'build') {
  const I18 = core(), keys = allKeys(), dict = JSON.parse(fs.readFileSync(DICT, 'utf8')), out = {}, hs = new Map(); let miss = 0;
  for (const k of keys.keys()) { const h = I18.h(k); if (hs.has(h) && hs.get(h) !== k) throw new Error('совпали отпечатки: ' + k + ' / ' + hs.get(h)); hs.set(h, k);
    const d = dict[k]; if (!d || (!d.en && !d.ro)) { miss++; continue; } out[h] = [d.en || '', d.ro || '']; }
  const js = 'var I18D=' + JSON.stringify(out).replace(/</g, '\\x3c').replace(/[\u2028\u2029]/g, '') + ';';
  if (!/\/\*I18N-DICT\*\/[\s\S]*?\/\*I18N-DICT-END\*\//.test(html)) throw new Error('нет меток I18N-DICT');
  html = html.replace(/\/\*I18N-DICT\*\/[\s\S]*?\/\*I18N-DICT-END\*\//, () => '/*I18N-DICT*/' + js + '/*I18N-DICT-END*/');
  fs.writeFileSync(FILE, html); console.log('словарь:', Object.keys(out).length, 'ключей,', js.length, 'символов; без перевода:', miss);
} else if (cmd === 'add') {   // node tools/i18n.mjs add <keys.txt> <en.txt> <ro.txt>: строки «номер<TAB>перевод» к списку ключей из scan/keys
  const keys = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse('"' + l.split('\t').slice(2).join('\t') + '"'));
  const dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {}; let n = 0;
  for (const [lang, f] of [['en', process.argv[4]], ['ro', process.argv[5]]]) { if (!f || !fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = /^(\d+)[\t|](.*)$/.exec(l); if (!m) continue; const k = keys[+m[1]]; if (k == null) { console.log('нет ключа', m[1]); continue; }
      let v; try { v = JSON.parse('"' + m[2] + '"'); } catch (e) { console.log('плохая строка', lang, m[1], m[2].slice(0, 60)); continue; }
      if (v === '-') { dict[k] = dict[k] || {}; dict[k].x = 1; continue; }   // «-» — ключ намеренно без перевода
      (dict[k] = dict[k] || {})[lang] = v; n++; } }
  fs.mkdirSync(ROOT + 'i18n', { recursive: true });
  fs.writeFileSync(DICT, '{\n' + Object.keys(dict).map(k => JSON.stringify(k) + ':' + JSON.stringify(dict[k])).join(',\n') + '\n}\n'); console.log('записано переводов:', n, '; ключей в словаре:', Object.keys(dict).length);
} else console.log('wrap | report | scan [файл] | keys <файл> | build | add <keys> <en> <ro>');
