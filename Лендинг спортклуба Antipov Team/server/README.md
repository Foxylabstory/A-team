# ANTIPOV TEAM — сервер сайта

Отдаёт лендинг, принимает заявки в Telegram, подтягивает посты из Instagram, хранит ручные новости.

## Структура

```
server/
  server.js        сервер (Node 18+, Express)
  package.json
  .env.example  →  переименовать в .env и заполнить
  public/          сюда положить index.html (собранный лендинг)
  data/news.json   создаётся автоматически при добавлении новости
```

## Запуск локально

```bash
cd server
cp .env.example .env      # заполнить токены
npm install
npm start                 # http://localhost:3000
```

## Что заполнить в .env

**Telegram**
1. @BotFather → `/newbot` → токен → `TG_BOT_TOKEN`
2. Создать группу «Заявки», добавить бота, добавить @getmyid_bot → `TG_CHAT_ID` (для группы с минусом)

**Instagram** (нужен бизнес/creator-аккаунт, привязанный к странице Facebook)
1. developers.facebook.com → создать приложение (тип Business)
2. Подключить Instagram Graph API, права `instagram_basic`, `pages_show_list`
3. Graph API Explorer → получить long-lived токен (60 дней, продлевать) → `IG_ACCESS_TOKEN`
4. `IG_USER_ID` — id инстаграм-аккаунта из того же Explorer

Без токенов Instagram раздел новостей просто покажет только ручные записи.

**ADMIN_TOKEN** — любой длинный пароль, им авторизуется добавление новостей.

## API

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/lead` | заявка `{name, phone, consent:true}` → Telegram |
| GET | `/api/news` | ручные новости + посты Instagram (кэш 30 мин) |
| POST | `/api/news` | добавить новость, заголовок `Authorization: Bearer <ADMIN_TOKEN>` |
| DELETE | `/api/news/:id` | удалить новость, тот же заголовок |

Защита заявок: honeypot-поле + лимит 5 заявок с одного IP за 10 минут.

## Деплой (РФ-хостинг, требование 152-ФЗ)

Timeweb Cloud / Selectel / reg.ru VPS:

```bash
# на сервере
git clone <репозиторий> && cd server
npm install --omit=dev
cp .env.example .env && nano .env
npm i -g pm2 && pm2 start server.js --name antipov && pm2 save
```

Дальше nginx как reverse-proxy на порт 3000 и бесплатный сертификат Let's Encrypt (`certbot --nginx`).

## Важно

- Токены живут только в `.env` на сервере, в браузер не попадают.
- `.env` не коммитить в git.
- Токен Instagram истекает — продлевать раз в ~60 дней (или настроить автообновление).
