#!/usr/bin/env python3
# Правила «английские и румынские слова → слова русского разбора» живут в index.html (plx, plxCmd). Боту они нужны для предпросмотра в карточке —
# этот скрипт копирует их в worker/worker.js между метками PLX-BEGIN и PLX-END. Запускать после любой правки PL_R / PL_C в index.html: python3 tools/plxsync.py
import re, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
s = open(os.path.join(root, 'index.html'), encoding='utf-8').read()
roa = re.search(r"const roA=[^\n]*\n", s).group(0)
a = s.index('const PL_MO='); b = s.index('function plx(s){', a)
c = s.index('const PL_C='); d = s.index('// возвращает строку и список подстановок', c)
head = s[a:b].rstrip() + '\n'
assert head.count('const PL_R=(()=>{') == 1 and head.rstrip().endswith("]})();") and head.count("LNG==='ro'") == 1
head = head.replace('const PL_R=(()=>{', 'const mkPLR=ro=>{').replace("LNG==='ro'", 'ro')
head = head.rstrip()[:-len("]})();")] + "]};\n"
tail = ("const PL_R0=mkPLR(false),PL_R1=mkPLR(true);\n"
        "function plxN(s,lg){s=' '+String(s||'').toLowerCase().replace(/ё/g,'е').replace(/\\s+/g,' ')+' ';if(!/[a-z\\d]/.test(s))return s;"
        "for(const[re,f]of(lg==='ro'?PL_R1:PL_R0))s=s.replace(re,f);for(const[re,f]of PL_C)s=s.replace(re,f);return s}\n")
block = roa + head + s[c:d].rstrip() + '\n' + tail
p = os.path.join(root, 'worker/worker.js'); w = open(p, encoding='utf-8').read()
i = w.index('/*PLX-BEGIN*/') + len('/*PLX-BEGIN*/'); j = w.index('/*PLX-END*/')
new = w[:i] + '\n' + block + w[j:]
if new != w: open(p, 'w', encoding='utf-8').write(new); print('worker.js: правила обновлены,', len(block), 'символов')
else: print('worker.js: правила уже совпадают')
