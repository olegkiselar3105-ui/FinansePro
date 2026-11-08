# FinansePro

Учёт доходов и расходов в Telegram: Mini App + бот.

## Структура

| Путь | Что это | Где работает |
|---|---|---|
| `index.html` | Всё приложение (интерфейс, разбор фраз, хранение, синхронизация) | Cloudflare Pages |
| `sw.js`, `manifest.webmanifest`, `icons/` | Работа офлайн и установка как приложение | Cloudflare Pages |
| `privacy.html` | Политика конфиденциальности (RU/EN): https://finansepro.pages.dev/privacy.html | Cloudflare Pages |
| `_headers` | Политика безопасности (для Cloudflare Pages/Netlify) | хостинг |
| `worker/worker.js` | Бот: приём сообщений, расшифровка голоса (Groq Whisper), очередь | Cloudflare Workers |
| `worker/wrangler.toml` | Имя, дата совместимости, привязки KV/D1 воркера | — |
| `tools/deployworker.sh`, `tools/pagesworker.py`, `tools/codebackup.sh` | Выкладка бота и сайта через API Cloudflare, копии кода | — |
| `README.txt` | Подробная инструкция по функциям и выкладке | — |
| `DECISIONS.md` | Журнал решений | — |

## Как идут данные

1. Пользователь пишет или говорит боту → Telegram отправляет сообщение на воркер (`/webhook`).
2. Голос воркер расшифровывает через Groq, текст кладёт в очередь (D1, запасной вариант — KV).
3. Открытый Mini App забирает очередь (`/api/pending`), сам разбирает фразу и сохраняет запись в облако Telegram (CloudStorage).
4. Приложение подтверждает приём (`/api/ack`) → бот меняет своё сообщение на «✅ Записано».

Вход: Mini App отправляет воркеру `initData` Telegram, воркер проверяет подпись токеном бота. Подпись действует 7 дней (`MAX_AGE`); старше — ответ 401, приложение останавливает опросы и просит перезапуск.

Команды бота: /start, /help, /privacy, /queue, /id. Лимит — `DAILY_LIMIT` сообщений в сутки (по умолчанию 30); ответ о лимите, команды и нетекстовые сообщения лимит не тратят.

## Секреты

Хранятся только в Cloudflare (Settings → Variables and Secrets): `BOT_TOKEN`, `GROQ_KEY`, `WEBHOOK_SECRET`.
Переменные: `ALLOWED_IDS` (пусто = бот открыт для всех), `DAILY_LIMIT`, `APP_URL`.
В репозиторий секреты не попадают никогда.

## Обновление

GitHub недоступен — всё выкладывается через API Cloudflare (ключ — сетевой секрет облачной среды):
- Сайт: `tools/pagesworker.py` собирает файлы (`index.html`, `sw.js`, `manifest.webmanifest`, `mail.html`, `privacy.html`, `_headers`, `icons/`) в один `_worker.js` → выкладка в проект Pages `finansepro`.
- Бот: `tools/deployworker.sh` — заливает `worker/worker.js` с привязками из `wrangler.toml`; переменные и секреты остаются из панели. Перед выкладкой сохраняет прежний код для отката.
- Код: `tools/codebackup.sh save` — копия всего репозитория в закрытое хранилище Cloudflare KV.
- Секреты и переменные (`ALLOWED_IDS`, `DAILY_LIMIT`, `APP_URL`) задаются в панели, выкладка их не трогает.
