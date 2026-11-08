#!/usr/bin/env python3
"""Собирает _worker.js для Cloudflare Pages: весь сайт (index.html, sw.js, manifest, mail.html, icons) внутри одного скрипта,
заголовки безопасности из _headers добавляются в коде. Зачем: загрузка файлами через wrangler в облачной сессии не проходит
(прокси подменяет служебный ключ загрузки Pages), а загрузка одного _worker.js через API работает.
Запуск: python3 tools/pagesworker.py <папка_с_файлами_сайта> <куда_положить>/_worker.js
Порядок выкладки — в CLAUDE.md, раздел «Выкладка сайта (Cloudflare Pages)»."""
import base64,json,sys,os
src=sys.argv[1];out=sys.argv[2]
types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'}
files={}
for root,_,fs in os.walk(src):
    for f in fs:
        if f=='_headers':continue
        p=os.path.join(root,f);rel='/'+os.path.relpath(p,src).replace(os.sep,'/')
        ext=os.path.splitext(f)[1];b=open(p,'rb').read()
        if ext in('.html','.js','.webmanifest'):files[rel]={'t':types[ext],'s':b.decode('utf-8')}
        else:files[rel]={'t':types.get(ext,'application/octet-stream'),'b':base64.b64encode(b).decode()}
hdr=open(os.path.join(src,'_headers'),encoding='utf-8').read()
csp=[l.split(':',1)[1].strip() for l in hdr.splitlines() if l.strip().startswith('Content-Security-Policy')][0]
code='''// Сайт FinansePro: все файлы внутри этого скрипта (Pages, режим _worker.js)
const FILES=%s;
const CSP=%s;
const NOCACHE=new Set(['/sw.js','/index.html']);
const B64=s=>{const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
export default{async fetch(req){
  const u=new URL(req.url);let p=decodeURIComponent(u.pathname);if(p==='/'||p==='')p='/index.html';
  const f=FILES[p];
  if(!f)return new Response('Not found',{status:404,headers:{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'}});
  const h=new Headers({'content-type':f.t,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','permissions-policy':'camera=(), geolocation=(), microphone=()','content-security-policy':CSP});
  if(NOCACHE.has(p)||p.endsWith('.html'))h.set('cache-control','no-cache');else h.set('cache-control','public, max-age=3600');
  if(req.method==='HEAD')return new Response(null,{headers:h});
  return new Response(f.s!==undefined?f.s:B64(f.b),{headers:h})}}
'''%(json.dumps(files,ensure_ascii=False),json.dumps(csp))
open(out,'w',encoding='utf-8').write(code)
print(out,len(code.encode()),'байт;',len(files),'файлов:',', '.join(sorted(files)))
