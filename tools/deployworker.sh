#!/bin/bash
# Выкладка бота (worker/worker.js) через API Cloudflare — вместо Workers Builds из GitHub (GitHub отключён).
# Привязки KV/D1 — из worker/wrangler.toml; переменные и секреты остаются из панели (keep_bindings), в коде их нет.
# Перед выкладкой текущий код бота сохраняется в $BK (откат: tools/deployworker.sh <сохранённый файл>).
#   tools/deployworker.sh [файл.js]   (по умолчанию worker/worker.js)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
API=https://api.cloudflare.com/client/v4; H="Authorization: Bearer proxy-injected"
SRC=${1:-worker/worker.js}; BK=${TMPDIR:-/tmp}/worker-before-$(date -u +%Y%m%d-%H%M%S).js
toml(){ grep -m1 "^$1 " "${2:-worker/wrangler.toml}" | sed 's/.*= *"\(.*\)"/\1/'; }
ACC=$(curl -sf "$API/accounts" -H "$H" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])")
S="$API/accounts/$ACC/workers/scripts/$(toml name)"
curl -sf "$S/content/v2" -H "$H" -D "$BK.h" -o "$BK.m"   # ответ multipart: достаём сам модуль worker.js
python3 - "$BK" <<'PY'
import sys,re,email.parser
bk=sys.argv[1];h=open(bk+'.h').read();body=open(bk+'.m','rb').read()
ct=re.search(r'(?im)^content-type:\s*(.+)$',h).group(1).strip()
msg=email.parser.BytesParser().parsebytes(b'Content-Type: '+ct.encode()+b'\r\n\r\n'+body)
part=[p for p in msg.get_payload() if p.get_filename()=='worker.js'][0]
open(bk,'wb').write(part.get_payload(decode=True))
PY
rm -f "$BK.h" "$BK.m"; node --check "$BK" 2>/dev/null || true; echo "Прежний код сохранён: $BK ($(stat -c %s "$BK") байт)"
META=$(python3 -c "import json,sys;print(json.dumps({'main_module':'worker.js','compatibility_date':sys.argv[1],
 'bindings':[{'type':'kv_namespace','name':sys.argv[2],'namespace_id':sys.argv[3]},{'type':'d1','name':sys.argv[4],'id':sys.argv[5]}],
 'keep_bindings':['plain_text','secret_text']}))" "$(toml compatibility_date)" "$(toml binding)" "$(toml id)" \
 "$(toml binding <(sed -n '/d1_databases/,$p' worker/wrangler.toml))" "$(toml database_id <(sed -n '/d1_databases/,$p' worker/wrangler.toml))")
curl -sf -X PUT "$S" -H "$H" -F "metadata=$META;type=application/json" -F "worker.js=@$SRC;type=application/javascript+module;filename=worker.js" \
 | python3 -c "import sys,json;d=json.load(sys.stdin);print('Выложено' if d['success'] else d['errors'])"
# расписание (cron) — из [triggers] crons в wrangler.toml: итоги статистики и уборка раз в сутки
CRONS=$(python3 -c "import tomllib,json;print(json.dumps([{'cron':c} for c in tomllib.load(open('worker/wrangler.toml','rb')).get('triggers',{}).get('crons',[])]))")
curl -sf -X PUT "$S/schedules" -H "$H" -H 'Content-Type: application/json' -d "$CRONS" \
 | python3 -c "import sys,json;d=json.load(sys.stdin);print('Расписание:',', '.join(x['cron'] for x in d['result']['schedules']) if d['success'] else d['errors'])"
curl -sf "$S/settings" -H "$H" | python3 -c "import sys,json;print('Привязки:',', '.join(b['name'] for b in json.load(sys.stdin)['result']['bindings']))"
