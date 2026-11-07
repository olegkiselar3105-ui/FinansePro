#!/bin/bash
# Копия всего кода (git bundle со всей историей) в закрытом хранилище Cloudflare KV «finansepro-code».
# Заменяет GitHub как место хранения кода. Ключ Cloudflare подставляет прокси облачной среды
# (сетевой секрет для api.cloudflare.com), в коде ключей нет.
#   tools/codebackup.sh save           — положить копию текущего репозитория (latest + история, хранится 10 последних)
#   tools/codebackup.sh list           — список копий
#   tools/codebackup.sh restore <папка> [ключ] — забрать копию (по умолчанию latest) и развернуть репозиторий в <папка>
set -euo pipefail
API=https://api.cloudflare.com/client/v4
H="Authorization: Bearer proxy-injected"
NS_TITLE=finansepro-code
KEEP=10
TMP=${TMPDIR:-/tmp}

acc(){ curl -sf "$API/accounts" -H "$H" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])"; }
ns(){ curl -sf "$API/accounts/$1/storage/kv/namespaces?per_page=100" -H "$H" | python3 -c "
import sys,json
r=[n['id'] for n in json.load(sys.stdin)['result'] if n['title']=='$NS_TITLE']
print(r[0] if r else '')"; }
keys(){ curl -sf "$API/accounts/$1/storage/kv/namespaces/$2/keys?prefix=b/&limit=1000" -H "$H" | python3 -c "
import sys,json
for k in sorted(x['name'] for x in json.load(sys.stdin)['result']): print(k)"; }

ACC=$(acc); NS=$(ns "$ACC")
[ -n "$NS" ] || { echo "Нет хранилища $NS_TITLE (или у ключа нет права Workers KV Storage: Edit)"; exit 1; }
BASE="$API/accounts/$ACC/storage/kv/namespaces/$NS/values"

case "${1:-}" in
save)
  cd "$(git rev-parse --show-toplevel)"
  [ -z "$(git status --porcelain)" ] || { echo "Есть незакоммиченные изменения — сначала коммит"; exit 1; }
  ver=$(grep -o "IB_VER='v[0-9]*'" index.html | head -1 | grep -o "v[0-9]*" || echo v0)
  key="b/$(date -u +%Y%m%d-%H%M%S)-$ver-$(git rev-parse --short HEAD)"
  f="$TMP/fp-backup.bundle"; rm -f "$f"
  git bundle create "$f" --all 2>/dev/null
  git bundle verify "$f" >/dev/null 2>&1
  for k in latest "$key"; do
    curl -sf -X PUT "$BASE/$k" -H "$H" -H "Content-Type: application/octet-stream" --data-binary @"$f" | python3 -c "import sys,json;assert json.load(sys.stdin)['success']"
  done
  # оставить KEEP последних
  mapfile -t all < <(keys "$ACC" "$NS")
  n=${#all[@]}
  if (( n > KEEP )); then for k in "${all[@]:0:n-KEEP}"; do curl -sf -X DELETE "$BASE/$k" -H "$H" >/dev/null; done; fi
  # проверка: скачанная копия совпадает с отправленной
  curl -sf "$BASE/latest" -H "$H" -o "$f.chk"; cmp -s "$f" "$f.chk" || { echo "Проверка не прошла: копия в хранилище отличается"; exit 1; }
  echo "Сохранено: latest и $key ($(stat -c %s "$f") байт); копий в истории: $(keys "$ACC" "$NS" | wc -l)"
  rm -f "$f.chk";;
list) keys "$ACC" "$NS";;
restore)
  dir=${2:?укажите папку}; k=${3:-latest}
  [ ! -e "$dir" ] || { echo "Папка $dir уже есть"; exit 1; }
  f="$TMP/fp-restore.bundle"; curl -sf "$BASE/$k" -H "$H" -o "$f"
  git bundle verify "$f" >/dev/null 2>&1 || { echo "Копия повреждена"; exit 1; }
  git clone -q "$f" "$dir"
  ( cd "$dir"; for b in $(git branch -r | grep -v HEAD | sed 's#origin/##'); do git branch -q "$b" "origin/$b" 2>/dev/null || true; done
    git checkout -q claude/nifty-sagan-pdvw4w 2>/dev/null || true; git remote remove origin )
  echo "Восстановлено в $dir из $k: $(cd "$dir"; git log -1 --format='%h %s')";;
*) echo "использование: $0 save | list | restore <папка> [ключ]"; exit 1;;
esac
