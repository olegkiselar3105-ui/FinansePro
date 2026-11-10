#!/usr/bin/env python3
"""Поиск мусора в index.html: функции без вызовов и стили для классов/id, которых нет в разметке и скриптах.
Запуск: python3 tools/codeaudit.py [index.html]. Найденное — кандидаты: проверить поиском (класс может собираться из частей строки)."""
import re,sys
p=sys.argv[1] if len(sys.argv)>1 else 'index.html'; s=open(p,encoding='utf-8').read()
js=''.join(re.findall(r'<script>([\s\S]*?)</script>',s))
fn=set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(',js))|set(re.findall(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>',js))
uf=[n for n in sorted(fn) if len(re.findall(r'(?<![\w$.])'+re.escape(n)+r'(?![\w$])',s))<=1]
css=''.join(re.findall(r'<style[^>]*>([\s\S]*?)</style>',s)); rest=re.sub(r'<style[^>]*>[\s\S]*?</style>','',s)
sel=re.sub(r'\{[^{}]*\}','{}',re.sub(r'@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}','',css))
cls=set(re.findall(r'\.([a-zA-Z][\w-]*)',sel)); ids=set(re.findall(r'#([a-zA-Z][\w-]*)',sel))
dc=[c for c in sorted(cls) if not re.search(r'(?<![\w-])'+re.escape(c)+r'(?![\w-])',rest)]
di=[i for i in sorted(ids) if not re.search(r'(?<![\w-])'+re.escape(i)+r'(?![\w-])',rest) and not re.fullmatch(r'[0-9a-fA-F]{3,8}',i)]
print(f'функций: {len(fn)}; без вызовов ({len(uf)}): {" ".join(uf) or "—"}')
print(f'классы в стилях без использования ({len(dc)}): {" ".join(dc) or "—"}')
print(f'id в стилях без использования ({len(di)}): {" ".join(di) or "—"}')
