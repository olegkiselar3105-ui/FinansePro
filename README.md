# FinansePro

Учёт доходов и расходов в Telegram: Mini App + бот.

## Структура

| Путь | Что это | Где работает |
|---|---|---|
| `index.html` | Всё приложение (интерфейс, разбор фраз, хранение, синхронизация) | GitHub Pages |
| `sw.js`, `manifest.webmanifest`, `icons/` | Работа офлайн и установка как приложение | GitHub Pages |
| `_headers` | Политика безопасности (для Cloudflare Pages/Netlify) | хостинг |
| `worker/worker.js` | Бот: приём сообщений, расшифровка голоса (Groq Whisper), очередь | Cloudflare Workers |
| `worker/wrangler.toml` | Настройки воркера для деплоя из командной строки | — |
| `README.txt` | Подробная инструкция по функциям и выкладке | — |
| `DECISIONS.md` | Журнал решений | — |

## Как идут данные

1. Пользователь пишет или говорит боту → Telegram отправляет сообщение на воркер (`/webhook`).
2. Голос воркер расшифровывает через Groq, текст кладёт в очередь (D1, запасной вариант — KV).
3. Открытый Mini App забирает очередь (`/api/pending`), сам разбирает фразу и сохраняет запись в облако Telegram (CloudStorage).
4. Приложение подтверждает приём (`/api/ack`) → бот меняет своё сообщение на «✅ Записано».

Вход: Mini App отправляет воркеру `initData` Telegram, воркер проверяет подпись токеном бота.

## Секреты

Хранятся только в Cloudflare (Settings → Variables and Secrets): `BOT_TOKEN`, `GROQ_KEY`, `WEBHOOK_SECRET`.
Переменные: `ALLOWED_IDS` (пусто = бот открыт для всех), `DAILY_LIMIT`, `APP_URL`.
В репозиторий секреты не попадают никогда.

## Обновление

- Приложение: загрузить `index.html` (и при изменении `sw.js`) в репозиторий → GitHub Pages обновится сам.
- Воркер: Cloudflare → Workers → finansepro → Edit code → вставить `worker/worker.js` → Deploy.
