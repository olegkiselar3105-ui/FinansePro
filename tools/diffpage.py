# Страница изменений PR для просмотра в чате (телефон/десктоп): добавленное — зелёным, удалённое — красным, по файлам.
# Запуск из корня репозитория: python3 tools/diffpage.py origin/main HEAD "PR #NN · vNNN" <выходной.html>
import subprocess,sys,html,re,os
REPO=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
base,head,title,out=sys.argv[1:5]
d=subprocess.run(['git','diff','--no-color','-U2',base,head],capture_output=True,text=True,cwd=REPO).stdout
st=subprocess.run(['git','diff','--shortstat',base,head],capture_output=True,text=True,cwd=REPO).stdout.strip()
files=[];cur=None
for l in d.split('\n'):
    if l.startswith('diff --git'):cur={'name':l.split(' b/')[-1],'lines':[]};files.append(cur);continue
    if cur is None or l.startswith(('index ','--- ','+++ ','new file','deleted file')):continue
    cur['lines'].append(l)
def cut(s,n=600):return s if len(s)<=n else s[:n]+' …(+'+str(len(s)-n)+' симв.)'
body=[]
for f in files:
    add=sum(1 for l in f['lines'] if l.startswith('+'));rem=sum(1 for l in f['lines'] if l.startswith('-'))
    rows=[]
    for l in f['lines']:
        if l.startswith('@@'):m=re.match(r'@@ -\d+(?:,\d+)? \+(\d+)',l);rows.append('<div class="h">строка '+(m.group(1) if m else '')+'</div>');continue
        c='a' if l.startswith('+') else 'r' if l.startswith('-') else 'c'
        rows.append('<div class="'+c+'">'+html.escape(cut(l[1:]) if l else '')+'</div>')
    body.append('<details open><summary><b>'+html.escape(f['name'])+'</b> <span class="p">+'+str(add)+'</span> <span class="m">−'+str(rem)+'</span></summary><div class="code">'+''.join(rows)+'</div></details>')
page='''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Изменения · '''+html.escape(title)+'''</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--t:#16171b;--m:#6b6e76;--c:#fff;--l:#e3e5ea;--a:#e6f6ea;--at:#116329;--r:#fdebec;--rt:#a40e26;--h:#eef1f8}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e12;--t:#eceef2;--m:#9a9da6;--c:#16171d;--l:#2a2c33;--a:#12301c;--at:#7ee2a0;--r:#3a1418;--rt:#ff9aa5;--h:#1d2230}}
body{margin:0;padding:16px;background:var(--bg);color:var(--t);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
h1{font-size:19px;margin:0 0 4px}.st{color:var(--m);margin:0 0 14px;font-size:13px}
details{background:var(--c);border:1px solid var(--l);border-radius:14px;margin:0 0 12px;overflow:hidden}
summary{padding:12px 14px;cursor:pointer}.p{color:var(--at)}.m{color:var(--rt)}
.code{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;border-top:1px solid var(--l)}
.code div{padding:1px 10px;white-space:pre-wrap;word-break:break-word}
.a{background:var(--a);color:var(--at)}.r{background:var(--r);color:var(--rt)}.c{color:var(--m)}.h{background:var(--h);color:var(--m);font-family:inherit;padding:4px 10px}
</style></head><body><h1>'''+html.escape(title)+'''</h1><p class="st">'''+html.escape(st)+'''</p>'''+''.join(body)+'''</body></html>'''
open(out,'w',encoding='utf-8').write(page);print(out,len(page)//1024,'КБ')
