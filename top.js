const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require('mongodb');
const haversine = require('haversine-distance');
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URL = 'mongodb://192.168.0.107:27017';
const DB_NAME = 'geolocation_db';
const MONOPITER_CHAT_ID = -1001405911884;

//const MIN_DISTANCE_THRESHOLD = 3; // Порог для фильтрации небольших перемещений в метрах
const MAX_DISTANCE_THRESHOLD = 3000; // Порог для начала новой сессии в метрах
const MAX_TIME_THRESHOLD = 2 * 60 * 60;

const bot = new Telegraf(BOT_TOKEN);
let db;

// Кэширование результатов
const statsCache = {
  week: { data: null, timestamp: 0 },
  month: { data: null, timestamp: 0 }
};
const CACHE_TTL = 3600000; // 1 час в миллисекундах

const getUserAvatarUrl = async (ctx, userId) => {
	try {
		const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
		if (photos && photos.total_count > 0) {
			const fileId = photos.photos[0][0].file_id;
			const file = await ctx.telegram.getFile(fileId);
			return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
		}
	} catch (error) {
		console.error('Ошибка при получении аватарки пользователя:', error);
	}
	return null;
};

const connectToDatabase = async () => {
	try {
		const client = new MongoClient(MONGO_URL);
		await client.connect();
		db = client.db(DB_NAME);
		console.log("Connected to MongoDB");
	} catch (error) {
		console.error("MongoDB connection error:", error);
		process.exit(1);
	}
};

// Создание индексов для оптимизации запросов
const createRequiredIndexes = async () => {
  try {
    const collection = db.collection('locations');
    await collection.createIndex({ userId: 1 });
    await collection.createIndex({ timestamp: 1 });
    await collection.createIndex({ userId: 1, timestamp: 1 });
    await collection.createIndex({ sessionId: 1 });
    console.log("Indexes created successfully");
  } catch (error) {
    console.error("Error creating indexes:", error);
  }
};

const processLocation = async (userId, username, timestamp, latitude, longitude, avatarUrl) => {
	const entry = {
		userId,
		username,
		timestamp,
		latitude,
		longitude,
		sessionId: null,
		avatarUrl
	};
	
	const collection = db.collection('locations');
	const lastLocation = await collection.find({ userId }).sort({ timestamp: -1 }).limit(1).toArray();
	
	if (lastLocation.length > 0) {
		const lastEntry = lastLocation[0];
		const distance = haversine(
				{ lat: lastEntry.latitude, lon: lastEntry.longitude },
				{ lat: entry.latitude, lon: entry.longitude }
		);
		
		const timeDiff = timestamp - lastEntry.timestamp;
		
		// if (distance < MIN_DISTANCE_THRESHOLD && timeDiff < MAX_TIME_THRESHOLD) {
		// 	return;
		// }
		
		// Новое условие: новая сессия, если прошло больше 2 часов ИЛИ расстояние больше MAX_DISTANCE_THRESHOLD
		if (timeDiff > MAX_TIME_THRESHOLD || distance > MAX_DISTANCE_THRESHOLD) {
			entry.sessionId = lastEntry.sessionId + 1;
		} else {
			entry.sessionId = lastEntry.sessionId;
		}
	} else {
		entry.sessionId = 1;
	}
	
	await collection.insertOne(entry);
};

// Хранение активных геолокаций и времени последнего обновления
const activeLocations = new Map();

// Период времени без обновления до удаления геолокации
const MAX_INACTIVITY_TIME = 65 * 60 * 1000;

// Функция для проверки и удаления неактивных геолокаций
async function checkAndRemoveInactiveLocations() {
    const now = Date.now();

    for (const [messageId, { chatId, lastUpdate }] of activeLocations) {
        if (now - lastUpdate > MAX_INACTIVITY_TIME) {
            try {
                // Проверка прав бота
                const chatMember = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
                if (chatMember.can_delete_messages) {
                    await bot.telegram.deleteMessage(chatId, messageId);
                    console.log(`Message ${messageId} deleted due to inactivity.`);
                } else {
                    console.log(`Bot doesn't have permission to delete messages in chat ${chatId}`);
                }
            } catch (err) {
                if (err.response?.description === 'Bad Request: message to delete not found') {
                    console.log(`Message ${messageId} was already deleted.`);
                } else if (err.response?.description === "Bad Request: message can't be deleted") {
                    console.log(`Message ${messageId} can't be deleted (too old or not enough rights).`);
                } else {
                    console.error(`Error deleting message ${messageId}:`, err.message);
                }
            } finally {
                // Удаляем запись из activeLocations в любом случае
                activeLocations.delete(messageId);
            }
        }
    }
}

bot.on('location', async (ctx) => {
    const location = ctx.message.location;
    const userId = ctx.message.from.id;
    const username = ctx.message.from.username
        ? `@${ctx.message.from.username}`
        : (ctx.message.from.first_name
            ? ctx.message.from.first_name
            : ctx.message.from.last_name);
    const timestamp = ctx.message.date;

    const { chat, message_id: messageId } = ctx.message;
    const live_period = ctx.message.location.live_period;

    // Проверка, что данные берутся только из чата -1001405911884
    if (chat.id !== MONOPITER_CHAT_ID) {
        return;
    }

    // Получаем URL аватарки пользователя
    const avatarUrl = await getUserAvatarUrl(ctx, userId);

    // Проверяем, если время действия геопозиции бесконечно
    if (live_period === 2147483647) {
        // Отправляем предупреждение
        const warningMessage = await ctx.reply('Нельзя кидать геопозицию с неограниченным временем. Геолокация будет удалена через 30 секунд!', {
            reply_to_message_id: messageId
        });
        // Удаляем геопозицию и предупреждение через 30 секунд
        setTimeout(async () => {
            try {
                await bot.telegram.deleteMessage(chat.id, messageId);
                await bot.telegram.deleteMessage(chat.id, warningMessage.message_id);
            } catch (err) {
                console.error('Ошибка при удалении сообщения:', err);
            }
        }, 30000);

        return; // Прекращаем дальнейшую обработку этого сообщения
    }

    // Добавляем или обновляем запись геолокации в списке активных
    activeLocations.set(messageId, { chatId: chat.id, lastUpdate: Date.now() });

    await processLocation(userId, username, timestamp, location.latitude, location.longitude, avatarUrl);
});

bot.on('edited_message', async (ctx) => {
    if (ctx.editedMessage.location) {
        const location = ctx.editedMessage.location;
        const userId = ctx.editedMessage.from.id;
        const timestamp = ctx.editedMessage.edit_date;
        const username = ctx.editedMessage.from.username
            ? `@${ctx.editedMessage.from.username}`
            : (ctx.editedMessage.from.first_name
                ? ctx.editedMessage.from.first_name
                : ctx.editedMessage.from.last_name);
        const message = ctx.editedMessage;

        // Проверка, что данные берутся только из чата -1001405911884
        if (message.chat.id !== MONOPITER_CHAT_ID) {
            return;
        }

        // Получаем URL аватарки пользователя
        const avatarUrl = await getUserAvatarUrl(ctx, userId);

        if (message?.location) {
            const { chat, message_id: messageId } = message;

            if (activeLocations.has(messageId)) {
                // Обновляем время последнего обновления
                activeLocations.set(messageId, { chatId: chat.id, lastUpdate: Date.now() });
            }
        }

        await processLocation(userId, username, timestamp, location.latitude, location.longitude, avatarUrl);
    }
});

setInterval(checkAndRemoveInactiveLocations, 60000);

// Получение временных диапазонов для периодов
const getTimestampRangeForPeriod = (period) => {
  const now = new Date();
  let startTimestamp, endTimestamp;
  
  if (period === 'week') {
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const dayOfWeek = lastWeek.getDay();
    const lastMonday = new Date(lastWeek);
    lastMonday.setHours(0, 0, 0, 0);
    lastMonday.setDate(lastWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    lastSunday.setHours(23, 59, 59, 999);
    
    startTimestamp = Math.floor(lastMonday.getTime() / 1000);
    endTimestamp = Math.floor(lastSunday.getTime() / 1000);
  } else if (period === 'month') {
    const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    lastDayOfLastMonth.setHours(23, 59, 59, 999);
    const firstDayOfLastMonth = new Date(lastDayOfLastMonth.getFullYear(), lastDayOfLastMonth.getMonth(), 1);
    firstDayOfLastMonth.setHours(0, 0, 0, 0);
    
    startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000);
    endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000);
  }
  
  return { startTimestamp, endTimestamp };
};

// Оптимизированный расчет расстояния
const calculateUserDistance = (locations) => {
  if (locations.length < 2) return 0;
  
  let totalDistance = 0;
  let lastSessionId = locations[0].sessionId;
  
  for (let i = 1; i < locations.length; i++) {
    const prev = locations[i - 1];
    const curr = locations[i];
    
    // Пропускаем переходы между сессиями
    if (curr.sessionId !== lastSessionId) {
      lastSessionId = curr.sessionId;
      continue;
    }
    
    // Проверяем, что расстояние не превышает максимальный порог
    const dist = haversine(
      { lat: prev.latitude, lon: prev.longitude },
      { lat: curr.latitude, lon: curr.longitude }
    );
    
    if (dist <= MAX_DISTANCE_THRESHOLD) {
      totalDistance += dist;
    }
  }
  
  return totalDistance / 1000; // Преобразуем в километры
};

// Оптимизированная функция получения топ пользователей
const getTopUsersOptimized = async (period, limit) => {
  // Проверяем кэш
  const now = Date.now();
  if (statsCache[period].data && (now - statsCache[period].timestamp < CACHE_TTL)) {
    return statsCache[period].data.slice(0, limit);
  }

  const collection = db.collection('locations');
  const { startTimestamp, endTimestamp } = getTimestampRangeForPeriod(period);
  
  // Получаем уникальных пользователей за указанный период
  const uniqueUsers = await collection.aggregate([
    { $match: { timestamp: { $gte: startTimestamp, $lte: endTimestamp } } },
    { $group: { _id: "$userId", username: { $first: "$username" } } }
  ]).toArray();
  
  // Вычисляем расстояния для каждого пользователя
  const userStats = [];
  for (const user of uniqueUsers) {
    const userLocations = await collection.find({
      userId: user._id,
      timestamp: { $gte: startTimestamp, $lte: endTimestamp }
    }).sort({ sessionId: 1, timestamp: 1 }).toArray();
    
    const distance = calculateUserDistance(userLocations);
    userStats.push({
      userId: user._id,
      username: user.username,
      distance
    });
  }
  
  // Сортируем и возвращаем результат
  userStats.sort((a, b) => b.distance - a.distance);
  
  // Сохраняем в кэш
  statsCache[period] = {
    data: userStats,
    timestamp: now
  };
  
  return userStats.slice(0, limit);
};

const calculateStats = async (userId, startTimestamp, endTimestamp) => {
	const collection = db.collection('locations');
	
	const locations = await collection.find({
		userId,
		timestamp: { $gte: startTimestamp, $lte: endTimestamp }
	}).sort({ sessionId: 1, timestamp: 1 }).toArray();
	
	if (locations.length < 2) return { distance: 0, speed: 0, dailyDistances: [] };
	
	let totalDistance = 0;
	let totalTime = 0;
	let lastSessionId = locations[0].sessionId;
	let dailyDistances = new Array(7).fill(0);
	
	for (let i = 1; i < locations.length; i++) {
		const prev = locations[i - 1];
		const curr = locations[i];
		
		if (curr.sessionId !== lastSessionId) {
			lastSessionId = curr.sessionId;
			continue;
		}
		
		const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
		);
		totalDistance += dist;
		
		const timeDiff = curr.timestamp - prev.timestamp;
		
		if (timeDiff < 3600) {
			totalTime += timeDiff;
		}
		
		const dayIndex = new Date(curr.timestamp * 1000).getDay();
		const adjustedIndex = (dayIndex + 6) % 7;
		dailyDistances[adjustedIndex] += dist;
	}
	
	const avgSpeed = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0;
	dailyDistances = dailyDistances.map(dist => dist / 1000);
	
	return { distance: totalDistance / 1000, speed: avgSpeed, dailyDistances };
};

const calculateWeeklyStats = async (userId) => {
	const { startTimestamp, endTimestamp } = getTimestampRangeForPeriod('week');
	return calculateStats(userId, startTimestamp, endTimestamp);
};

const calculateMonthlyStats = async (userId) => {
	const { startTimestamp, endTimestamp } = getTimestampRangeForPeriod('month');
	return calculateStats(userId, startTimestamp, endTimestamp);
};

// Обратная совместимость со старой функцией getTopUsers
const getTopUsers = async (period, limit) => {
	return getTopUsersOptimized(period, limit);
};

const formatStatsResponse = (stats, period) => {
	let response = `За ${period === 'week' ? 'прошедшую неделю' : 'прошедший месяц'} вы проехали ${stats.distance.toFixed(2)} км со средней скоростью ${stats.speed.toFixed(2)} км/ч.\n\n`;
	
	if (stats.dailyDistances && stats.dailyDistances.length > 0) {
		response += "Пробег по дням недели:\n";
		const daysOfWeek = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
		stats.dailyDistances.forEach((distance, index) => {
			response += `${daysOfWeek[index]}: ${distance.toFixed(2)} км\n`;
		});
	}
	
	return response;
};

bot.command('weekstats', async (ctx) => {
	const userId = ctx.message.from.id;
	const stats = await calculateWeeklyStats(userId);
	const formattedStats = formatStatsResponse(stats, 'week');
	
	try {
		// Отправляем сообщение пользователю в личку
		await ctx.telegram.sendMessage(userId, formattedStats);
		
		// Отправляем подтверждение в чат, где была вызвана команда
		if (ctx.chat.type !== 'private') {
			await ctx.reply('Статистика отправлена вам в личные сообщения.');
		}
	} catch (error) {
		console.error('Ошибка при отправке статистики:', error);
		await ctx.reply('Извините, не удалось отправить статистику. Пожалуйста, убедитесь, что вы начали диалог с ботом.');
	}
});

// Обновленная команда /top с индикатором загрузки
bot.command('top', async (ctx) => {
  const [_, period, limitStr] = ctx.message.text.split(' ');
  const limit = parseInt(limitStr, 10) || 10;
  
  if (!['week', 'month'].includes(period)) {
    return ctx.reply('Пожалуйста, укажите период: "week" для недельной статистики или "month" для месячной статистики.');
  }
  
  try {
    // Сначала отправляем сообщение о загрузке
    const loadingMessage = await ctx.reply('⏳ Загрузка статистики...');
    
    const topUsers = await getTopUsersOptimized(period, limit);
    
    let response;
    if (topUsers.length === 0) {
      response = `За ${period === 'week' ? 'прошедшую неделю' : 'прошедший месяц'} пока нет данных.`;
    } else {
      response = `🏆 Топ ${limit} пользователей по пробегу за ${period === 'week' ? 'прошедшую неделю' : 'прошедший месяц'}:\n\n`;
      topUsers.forEach((user, index) => {
        response += `${index + 1}. ${user.username}: ${user.distance.toFixed(2)} км\n`;
      });
    }
    
    // Обновляем сообщение о загрузке финальным результатом
    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      loadingMessage.message_id, 
      null, 
      response
    );
  } catch (error) {
    console.error('Ошибка при получении топа пользователей:', error);
    ctx.reply('Произошла ошибка при получении статистики. Пожалуйста, попробуйте позже.');
  }
});

const parseDate = (dateString) => {
	const [day, month, year] = dateString.split('.');
	const date = new Date(year, month - 1, day);
	return date.toString() === 'Invalid Date' ? null : date;
};

bot.command('sta', async (ctx) => {
	const userId = ctx.message.from.id;
	const args = ctx.message.text.split(' ').slice(1);
	
	if (args.length !== 2) {
		return ctx.reply('Пожалуйста, укажите начальную и конечную даты в формате "ДД.ММ.ГГГГ".\nНапример: /sta 30.07.2024 10.08.2024');
	}
	
	const [startDateStr, endDateStr] = args;
	const startDate = parseDate(startDateStr);
	const endDate = parseDate(endDateStr);
	
	if (!startDate || !endDate) {
		return ctx.reply('Неверный формат даты. Пожалуйста, используйте формат ДД.ММ.ГГГГ');
	}
	
	if (startDate > endDate) {
		return ctx.reply('Начальная дата должна быть раньше конечной даты.');
	}
	
	endDate.setHours(23, 59, 59);
	
	try {
		const stats = await calculateStats(userId, Math.floor(startDate.getTime() / 1000), Math.floor(endDate.getTime() / 1000));
		ctx.reply(`За период с ${startDateStr} по ${endDateStr} вы проехали ${stats.distance.toFixed(2)} км со средней скоростью ${stats.speed.toFixed(2)} км/ч.`);
	} catch (error) {
		console.error('Ошибка при расчете статистики:', error);
		ctx.reply('Произошла ошибка при расчете статистики. Пожалуйста, попробуйте позже.');
	}
});

bot.command('start', async (ctx) => {
	if (ctx.chat.type !== 'private') {
    ctx.reply('Клавиатура скрыта', Markup.removeKeyboard());
		return; // Просто игнорируем команду в групповых чатах
	}

	await ctx.reply(
		'Добро пожаловать! Выберите команду:',
		Markup.keyboard([
			// ['📅 Статистика за неделю'],
			['📊 Топ за прошедшую неделю', "📊 Топ за прошедший месяц"],
			['🍲 Внести свой вклад в проект'],
		])
		.resize()
		.oneTime()
	);
});

// Форматирование ответа с топом пользователей
const formatTopUsersResponse = (topUsers, period) => {
  if (topUsers.length === 0) {
    return `За прошедший ${period} пока нет данных.`;
  }
  
  let response = `🏆 Топ-10 пользователей за прошедшую ${period}:\n\n`;
  topUsers.forEach((user, index) => {
    response += `${index + 1}. ${user.username}: ${user.distance.toFixed(2)} км\n`;
  });
  
  return response;
};

// Обновленные обработчики кнопок с индикатором загрузки
bot.hears('📊 Топ за прошедшую неделю', async (ctx) => {
  try {
    const loadingMessage = await ctx.reply('⏳ Загрузка статистики...');
    const topUsers = await getTopUsersOptimized('week', 10);
    const response = formatTopUsersResponse(topUsers, 'неделю');
    
    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      loadingMessage.message_id, 
      null, 
      response
    );
  } catch (error) {
    console.error('Ошибка при получении топа пользователей:', error);
    ctx.reply('Произошла ошибка при получении статистики. Пожалуйста, попробуйте позже.');
  }
});

bot.hears('📊 Топ за прошедший месяц', async (ctx) => {
  try {
    const loadingMessage = await ctx.reply('⏳ Загрузка статистики...');
    const topUsers = await getTopUsersOptimized('month', 10);
    const response = formatTopUsersResponse(topUsers, 'месяц');
    
    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      loadingMessage.message_id, 
      null, 
      response
    );
  } catch (error) {
    console.error('Ошибка при получении топа пользователей:', error);
    ctx.reply('Произошла ошибка при получении статистики. Пожалуйста, попробуйте позже.');
  }
});

bot.hears('🍲 Внести свой вклад в проект', async (ctx) => {
	ctx.reply(
`
Дорогие моноколесники!

Я очень тронут вашим желанием помочь в развитии нашего проекта. Ваша поддержка невероятно важна для меня как разработчика, и я глубоко ценю каждого из вас.

Есть пару способов, которыми вы можете поддержать наше приложение:

1. Если у вас есть идеи по улучшению приложения, пожалуйста, делитесь ими. Ваши предложения бесценны для развития проекта.
2. Для тех, кто хочет поддержать финансово, я оставлю свои номер телефона для перевода по СБП: +7 911 960-25-79 (Банк Санкт-Петербург) и номер карты: 5272690231625417

Помните, что даже простое использование приложения и обратная связь - это уже огромная поддержка. Спасибо, что вы с нами!`
	);
});

// Добавляем обработчик debug для отслеживания всех событий бота
bot.use((ctx, next) => {
  if (ctx.updateType === 'message' && ctx.message.location) {
    console.log('Получено сообщение с геолокацией:', ctx.message.message_id);
  }
  return next();
});

// Инициализация с созданием индексов
(async () => {
  await connectToDatabase();
  await createRequiredIndexes(); // Создаем индексы при запуске
  bot.launch();
  console.log('Bot telegram-ride-stat is running');
})();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));