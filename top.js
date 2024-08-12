const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require('mongodb');
const haversine = require('haversine-distance');
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URL = 'mongodb://localhost:27017';
const DB_NAME = 'geolocation_db';

const MIN_DISTANCE_THRESHOLD = 60; // Порог для фильтрации небольших перемещений в метрах
const MAX_DISTANCE_THRESHOLD = 500; // Порог для начала новой сессии в метрах

// Initialize bot and database connection
const bot = new Telegraf(BOT_TOKEN);
let db;

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

const processLocation = async (userId, username, timestamp, latitude, longitude) => {
	const entry = {
		userId,
		username,
		timestamp,
		latitude,
		longitude,
		sessionId: null
	};
	
	const collection = db.collection('locations');
	const lastLocation = await collection.find({ userId }).sort({ timestamp: -1 }).limit(1).toArray();
	
	if (lastLocation.length > 0) {
		const lastEntry = lastLocation[0];
		const distance = haversine(
				{ lat: lastEntry.latitude, lon: lastEntry.longitude },
				{ lat: entry.latitude, lon: entry.longitude }
		);
		
		if (distance < MIN_DISTANCE_THRESHOLD) {
			return; // Игнорируем перемещение
		}
		
		entry.sessionId = distance > MAX_DISTANCE_THRESHOLD ? lastEntry.sessionId + 1 : lastEntry.sessionId;
	} else {
		entry.sessionId = 1;
	}
	
	await collection.insertOne(entry);
};

bot.on('location', async (ctx) => {
	const location = ctx.message.location;
	const userId = ctx.message.from.id;
	const username = `@${ctx.message.from.username}` || ctx.message.from.first_name;
	const timestamp = ctx.message.date;
	
	await processLocation(userId, username, timestamp, location.latitude, location.longitude);
});

bot.on('edited_message', async (ctx) => {
	if (ctx.editedMessage.location) {
		const location = ctx.editedMessage.location;
		const userId = ctx.editedMessage.from.id;
		const timestamp = ctx.editedMessage.edit_date;
		const username = `@${ctx.editedMessage.from.username}` || ctx.editedMessage.from.first_name;
		
		await processLocation(userId, username, timestamp, location.latitude, location.longitude);
	}
});

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
	const now = new Date();
	const dayOfWeek = now.getDay();
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999);
	
	const startTimestamp = Math.floor(monday.getTime() / 1000);
	const endTimestamp = Math.floor(sunday.getTime() / 1000);
	
	return calculateStats(userId, startTimestamp, endTimestamp);
};

const calculateMonthlyStats = async (userId) => {
	const now = new Date();
	const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
	lastDayOfMonth.setHours(23, 59, 59, 999);
	
	const startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
	const endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
	
	return calculateStats(userId, startTimestamp, endTimestamp);
};

const getTopUsers = async (period, limit) => {
	const collection = db.collection('locations');
	const now = new Date();
	let startTimestamp, endTimestamp;
	
	if (period === 'week') {
		const dayOfWeek = now.getDay();
		const monday = new Date(now);
		monday.setHours(0, 0, 0, 0);
		monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
		const sunday = new Date(monday);
		sunday.setDate(monday.getDate() + 6);
		sunday.setHours(23, 59, 59, 999);
		
		startTimestamp = Math.floor(monday.getTime() / 1000);
		endTimestamp = Math.floor(sunday.getTime() / 1000);
	} else if (period === 'month') {
		const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
		const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
		lastDayOfMonth.setHours(23, 59, 59, 999);
		
		startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
		endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
	} else {
		throw new Error('Invalid period');
	}
	
	const uniqueUsers = await collection.aggregate([
		{ $match: { timestamp: { $gte: startTimestamp, $lte: endTimestamp } } },
		{ $group: { _id: "$userId", username: { $first: "$username" } } }
	]).toArray();
	
	const userDistances = [];
	for (const user of uniqueUsers) {
		const stats = period === 'week'
				? await calculateWeeklyStats(user._id)
				: await calculateMonthlyStats(user._id);
		userDistances.push({
			userId: user._id,
			username: user.username,
			distance: stats.distance
		});
	}
	
	userDistances.sort((a, b) => b.distance - a.distance);
	return userDistances.slice(0, limit);
};

const formatStatsResponse = (stats, period) => {
	let response = `За ${period === 'week' ? 'эту неделю' : 'этот месяц'} вы проехали ${stats.distance.toFixed(2)} км со средней скоростью ${stats.speed.toFixed(2)} км/ч.\n\n`;
	
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
	ctx.reply(formatStatsResponse(stats, 'week'));
});

bot.command('top', async (ctx) => {
	const [_, period, limitStr] = ctx.message.text.split(' ');
	const limit = parseInt(limitStr, 10) || 10;
	
	if (!['week', 'month'].includes(period)) {
		return ctx.reply('Пожалуйста, укажите период: "week" для недельной статистики или "month" для месячной статистики.');
	}
	
	try {
		const topUsers = await getTopUsers(period, limit);
		if (topUsers.length === 0) {
			return ctx.reply(`На этот ${period === 'week' ? 'неделе' : 'месяц'} пока нет данных.`);
		}
		let response = `🏆 Топ ${limit} пользователей по пробегу за ${period === 'week' ? 'неделю' : 'месяц'}:\n\n`;
		topUsers.forEach((user, index) => {
			response += `${index + 1}. ${user.username}: ${user.distance.toFixed(2)} км\n`;
		});
		
		ctx.reply(response);
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
	await ctx.reply(
			'Добро пожаловать! Выберите команду:',
			Markup.keyboard([
				['📅 Статистика за неделю'],
				['📊 Топ за неделю', "📊 Топ за месяц"],
			])
					.resize()
					.oneTime()
	);
});

bot.hears('📅 Статистика за неделю', async (ctx) => {
	const userId = ctx.message.from.id;
	const stats = await calculateWeeklyStats(userId);
	ctx.reply(formatStatsResponse(stats, 'week'));
});

bot.hears('📊 Топ за неделю', async (ctx) => {
	const topUsers = await getTopUsers('week', 10);
	ctx.reply(formatTopUsersResponse(topUsers, 'неделю'));
});

bot.hears('📊 Топ за месяц', async (ctx) => {
	const topUsers = await getTopUsers('month', 10);
	ctx.reply(formatTopUsersResponse(topUsers, 'месяц'));
});

const formatTopUsersResponse = (topUsers, period) => {
	if (topUsers.length === 0) {
		return `За этот ${period} пока нет данных.`;
	}
	
	let response = `🏆 Топ-10 пользователей за этот ${period}:\n\n`;
	topUsers.forEach((user, index) => {
		response += `${index + 1}. ${user.username}: ${user.distance.toFixed(2)} км\n`;
	});
	
	return response;
};

(async () => {
	await connectToDatabase();
	bot.launch();
	console.log('Bot telegram-ride-stat is running');
})();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'))
