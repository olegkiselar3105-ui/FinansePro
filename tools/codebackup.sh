#!/bin/bash
# Копия всего кода (tar: git bundle со всей историей + файл shallow — граница истории, рабочая копия была неполным клоном GitHub) в закрытом хранилище Cloudflare KV «finansepro-code».
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
  w="$TMP/fp-backup"; rm -rf "$w"; mkdir -p "$w"; f="$w.tar"; rm -f "$f"
  git bundle create "$w/repo.bundle" --all 2>/dev/null
  if [ -f .git/shallow ]; then cp .git/shallow "$w/shallow"; else : > "$w/shallow"; fi
  tar cf "$f" -C "$w" repo.bundle shallow
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
  rm -f "$f.chk"; rm -rf "$w";;
list) keys "$ACC" "$NS";;
restore)
  dir=${2:?укажите папку}; k=${3:-latest}
  [ ! -e "$dir" ] || { echo "Папка $dir уже есть"; exit 1; }
  w="$TMP/fp-restore"; rm -rf "$w"; mkdir -p "$w"; curl -sf "$BASE/$k" -H "$H" -o "$w/b.tar"; tar xf "$w/b.tar" -C "$w"
  mkdir -p "$dir"; ( cd "$dir"; git init -q; [ -s "$w/shallow" ] && cp "$w/shallow" .git/shallow
    git fetch -q "$w/repo.bundle" '+refs/heads/*:refs/heads/*'
    git checkout -q claude/nifty-sagan-pdvw4w 2>/dev/null || git checkout -q main
    git fsck --no-dangling >/dev/null 2>&1 || { echo "Копия повреждена"; exit 1; } )
  echo "Восстановлено в $dir из $k: $(cd "$dir"; git log -1 --format='%h %s')";;
*) echo "использование: $0 save | list | restore <папка> [ключ]"; exit 1;;
esac
