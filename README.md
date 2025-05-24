# Telegram Ride Statistics Bot

Telegram бот для отслеживания статистики поездок. Бот собирает данные о геолокации пользователей и предоставляет статистику по пройденным расстояниям.

## Функциональность

- Отслеживание геолокации пользователей
- Расчет пройденного расстояния
- Статистика по неделям и месяцам
- Топ пользователей по пройденному расстоянию
- Автоматическое удаление неактивных геолокаций
- Создание анонсов каток с модерацией

## Команды

- `/stats` - Показать вашу статистику за неделю
- `/top` - Показать топ пользователей за неделю
- `/month` - Показать топ пользователей за месяц
- `📢 Создать анонс` - Создать новый анонс катки

## Установка

1. Клонируйте репозиторий:

```bash
git clone https://github.com/yourusername/telegram-ride-stat.git
cd telegram-ride-stat
```

2. Установите зависимости:

```bash
npm install
```

3. Создайте файл `.env` и добавьте необходимые переменные окружения:

```
TELEGRAM_BOT_TOKEN=your_bot_token
MONOPITER_CHAT=your_chat_id
MESSAGE_THREAD_ID_MONOPITER_CHAT=your_thread_id
ADMIN_CHANNEL_ID=your_admin_channel_id
```

4. Запустите бота:

```bash
npm start
```

Для разработки с автоматической перезагрузкой:

```bash
npm run dev
```

## Технологии

- Node.js
- MongoDB
- Telegraf.js
- Haversine Distance

## Структура проекта

```
src/
├── config/
│   └── constants.js
├── services/
│   ├── database.js
│   ├── location.js
│   ├── stats.js
│   ├── announcement.js
│   └── telegram.js
└── index.js
```

## Лицензия

ISC
