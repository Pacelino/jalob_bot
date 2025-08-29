# Пошаговое руководство по развёртыванию (для начинающих)

Ниже — максимально простые и пошаговые инструкции для развёртывания на обычном компьютере (Windows и Linux/macOS), а также на Railway и других облачных сервисах.

## 1) Общее: подготовка окружения

Требования:

- Node.js 18+
- Telegram API: `API_ID`, `API_HASH` (получить на `https://my.telegram.org`)
- Bot token: `BOT_TOKEN` (получить у `@BotFather`)

Переменные окружения (минимум):

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`

Рекомендуемые:

- `ALLOWED_USERS` — доступ к боту (`@username,12345`), пусто — доступ всем
- `DEFAULT_MODE` — `test` или `run` (по умолчанию `test`)
- `DATA_DIR` — каталог хранения `db.json` и `sessions/`
- `REPORT_DELAY_MIN` / `REPORT_DELAY_MAX` — задержка жалоб (мс)
- `MAX_REPORTS_PER_HOUR` / `MAX_REPORTS_PER_DAY` — лимиты жалоб

---

## 2) Деплой на Railway

### Шаг 1. Создать проект

- Зарегистрируйтесь на Railway
- Создайте новый проект и подключите репозиторий с этим кодом

### Шаг 2. Переменные окружения

Добавьте в разделе Variables:

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`
- (опционально) `ALLOWED_USERS`, `DEFAULT_MODE`, `REPORT_DELAY_MIN`, `REPORT_DELAY_MAX`, `MAX_REPORTS_PER_HOUR`, `MAX_REPORTS_PER_DAY`
- (рекомендовано) `DATA_DIR=/data`

### Шаг 3. Постоянное хранилище (Volume)

- Создайте Volume и примонтируйте к `/data`
- Убедитесь, что установлено `DATA_DIR=/data` — там будут `db.json` и `sessions/`

### Шаг 4. Команда запуска

В Railway настройте команду запуска:

```
npm run start:railway
```

или

```
node src/app.js
```

Тип сервиса: Worker или Web (если нужен webhook).

Webhook (не обязателен):

- `USE_WEBHOOK=true`
- `WEBHOOK_URL=<ваш_домен_railway>` (без схемы), например `my-app.up.railway.app`
- (опционально) `WEBHOOK_PATH=/telegram/webhook`

### Шаг 5. Деплой и проверка

- Нажмите Deploy и смотрите логи
- После старта откройте бота в Telegram и выполните `/start`
- Через меню добавьте userbot‑аккаунты (номер → код → 2FA при необходимости)

Если добавление аккаунта затянулось или пошло не так — отправьте в чат бота `/cancel`.

---

## 3) Развертывание на обычном ПК (Windows/Linux)

### Вариант A. Windows (PowerShell)

1. Установите Node.js 18+ с официального сайта и перезапустите PowerShell.
2. Откройте папку проекта (ту, где лежат файлы бота):
```powershell
cd "C:\\путь\\к\\папке\\проекта"
```
3. Установите зависимости:
```powershell
npm install
```
4. Откройте или создайте файл `config.env` (минимум):
```powershell
notepad config.env
```
Вставьте и сохраните пример:
```env
BOT_TOKEN=ваш_токен_бота
API_ID=ваш_api_id
API_HASH=ваш_api_hash
ALLOWED_USERS=@your_username,123456789
DEFAULT_MODE=test
DATA_DIR=./
REPORT_DELAY_MIN=60000
REPORT_DELAY_MAX=180000
MAX_REPORTS_PER_HOUR=10
MAX_REPORTS_PER_DAY=50
```
5. Запустите бота:
```powershell
npm start
```
6. В Telegram откройте бота → `/start` → «👥 Аккаунты» → «➕ Добавить аккаунт». Если передумали — отправьте `/cancel`.

Автозапуск (опционально):
- Используйте Планировщик заданий Windows. Создайте задачу на запуск `npm start` в папке проекта при входе в систему.

### Вариант B. Linux/macOS (терминал)

1. Убедитесь, что Node.js 18+ установлен:
```bash
node -v   # должно быть 18+
```
2. Установите зависимости:
```bash
npm install
```
3. Откройте или создайте `config.env` в корне проекта и заполните как в примере выше.
4. Запустите бота:
```bash
npm start
```
5. В Telegram откройте бота → `/start` и добавьте аккаунт(ы). Для отмены ввода используйте `/cancel`.

Автозапуск (опционально):
- systemd (пример):
```ini
[Unit]
Description=Telegram Userbot
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/node src/app.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
```bash
sudo nano /etc/systemd/system/telegram-userbot.service
sudo systemctl daemon-reload
sudo systemctl enable telegram-userbot
sudo systemctl start telegram-userbot
```
- Или `pm2`:
```bash
npm i -g pm2
pm2 start src/app.js --name telegram-userbot
pm2 save
pm2 startup
```

---

## 4) Проверка и отладка

- В боте проверьте разделы: «👥 Аккаунты», «📢 Группы», «🚫 Стоп‑слова», «⚙️ Мониторинг»
- Для отправки жалоб нужен режим `run`, хотя тестируйте сначала в `test`
- Реалтайм‑события + опрос каждые ~45 сек; задержка жалобы 60–180 сек по умолчанию

Если «Обработка: 🔴 Неактивна» при пустой очереди — это нормально

Если при добавлении аккаунта пошли лишние SMS/появилось «Code is empty», отправьте `/cancel` и начните процесс заново.

---

## 5) Частые вопросы

- Нет жалоб в очереди — проверьте: подключенные аккаунты, список групп, стоп‑слова, режим `run`, наличие новых сообщений со стоп‑словами
- ID группы: используйте пункт «Получить ID группы» — бот определит полный `-100...`
- Сессии: после успешной авторизации сохраняются в `sessions/`; переносите каталог при миграции

## 6) Другие облака (Render, Fly.io, VPS и т.п.)

Общий алгоритм:

1. Создать сервис Node.js и задать команду запуска `node src/app.js` (или `npm start`).
2. Добавить переменные окружения: `BOT_TOKEN`, `API_ID`, `API_HASH`, при необходимости `ALLOWED_USERS`, `DEFAULT_MODE`, `DATA_DIR` и др.
3. Обеспечить постоянное хранилище для `DATA_DIR` (volume/disk), где будут `db.json` и `sessions/`.
4. Задеплоить и проверить логи. Первую авторизацию аккаунтов выполнить через интерфейс бота.

Webhook по желанию: выставьте `USE_WEBHOOK=true`, `WEBHOOK_URL`, `WEBHOOK_PATH` и убедитесь, что сервис принимает входящие запросы.


