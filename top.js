const { Telegraf } = require("telegraf");
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
		db = client.db("geolocation_db");
		console.log("Connected to MongoDB");
	} catch (error) {
		console.error("MongoDB connection error:", error);
		process.exit(1);
	}
};

bot.on('location', async (ctx) => {
	const location = ctx.message.location;
	const userId = ctx.message.from.id;
	const username = `@${ctx.message.from.username}` || ctx.message.from.first_name;
	const timestamp = ctx.message.date;
	
	const entry = {
		userId,
		username,
		timestamp,
		latitude: location.latitude,
		longitude: location.longitude,
		sessionId: null // Временное значение
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
		
		if (distance > MAX_DISTANCE_THRESHOLD) {
			entry.sessionId = lastEntry.sessionId + 1;
		} else {
			entry.sessionId = lastEntry.sessionId;
		}
	} else {
		entry.sessionId = 1;
	}
	await collection.insertOne(entry);
});


bot.on('edited_message', async (ctx) => {
	if (ctx.editedMessage.location) {
		const location = ctx.editedMessage.location;
		const userId = ctx.editedMessage.from.id;
		const timestamp = ctx.editedMessage.edit_date;
		const username = `@${ctx.editedMessage.from.username}` || ctx.editedMessage.from.first_name;
		
		const entry = {
			userId,
			username,
			timestamp,
			latitude: location.latitude,
			longitude: location.longitude,
			sessionId: null // Временное значение
		};
		
		const collection = db.collection('locations');
		const lastLocation = await collection.find({ userId }).sort({ timestamp: -1 }).limit(1).toArray();
		
		if (lastLocation.length > 0) {
			const lastEntry = lastLocation[0];
			const distance = haversine(
					{ lat: lastEntry.latitude, lon: lastEntry.longitude },
					{ lat: entry.latitude, lon: entry.longitude }
			);
			
			// Фильтрация маленьких перемещений
			if (distance < MIN_DISTANCE_THRESHOLD) {
				return; // Игнорируем перемещение
			}
			
			// Если расстояние больше определенного порога, начинаем новую сессию
			if (distance > MAX_DISTANCE_THRESHOLD) {
				entry.sessionId = lastEntry.sessionId + 1;
			} else {
				entry.sessionId = lastEntry.sessionId;
			}
		} else {
			entry.sessionId = 1;
		}
		console.log(ctx.editedMessage.location)
		
		await collection.insertOne(entry);
	}
});

async function calculateWeeklyStats(userId) {
	const collection = db.collection('locations');
	
	// Определяем начало и конец текущей недели
	const now = new Date();
	const dayOfWeek = now.getDay(); // 0 = воскресенье, 1 = понедельник, ..., 6 = суббота
	
	// Найти дату понедельника текущей недели
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0); // Устанавливаем время на начало дня
	monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)); // Если сегодня воскресенье, отнимаем 6 дней, иначе отнимаем dayOfWeek - 1
	
	// Найти дату воскресенья текущей недели
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999); // Устанавливаем время на конец дня
	
	const startTimestamp = Math.floor(monday.getTime() / 1000);
	const endTimestamp = Math.floor(sunday.getTime() / 1000);
	
	// Получаем локации за текущую неделю
	const locations = await collection.find({
		userId,
		timestamp: { $gte: startTimestamp, $lte: endTimestamp }
	}).sort({ sessionId: 1, timestamp: 1 }).toArray();
	
	if (locations.length < 2) return { distance: 0, speed: 0, dailyDistances: [] };
	
	let totalDistance = 0;
	let totalTime = 0;
	let lastSessionId = locations[0].sessionId;
	
	// Создаем массив для хранения дистанций по каждому дню
	let dailyDistances = new Array(7).fill(0);
	
	for (let i = 1; i < locations.length; i++) {
		const prev = locations[i - 1];
		const curr = locations[i];
		
		if (curr.sessionId !== lastSessionId) {
			lastSessionId = curr.sessionId;
			continue; // Началась новая сессия, пропускаем
		}
		
		const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
		);
		totalDistance += dist;
		
		const timeDiff = curr.timestamp - prev.timestamp;
		
		// Фильтрация: исключаем слишком большие промежутки времени, когда пользователь мог остановиться
		if (timeDiff < 3600) {  // 3600 секунд = 1 час
			totalTime += timeDiff;
		}
		
		// Определяем день недели (0 = воскресенье, ..., 6 = суббота)
		const dayIndex = new Date(curr.timestamp * 1000).getDay();
		// Пересчитываем индекс для понедельника = 0, ..., воскресенья = 6
		const adjustedIndex = (dayIndex + 6) % 7;
		dailyDistances[adjustedIndex] += dist;
	}
	
	const avgSpeed = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0; // Средняя скорость в км/ч
	
	// Преобразуем дневные дистанции в километры
	dailyDistances = dailyDistances.map(dist => dist / 1000);
	
	return { distance: totalDistance / 1000, speed: avgSpeed, dailyDistances };
}

async function calculateMonthlyStats(userId) {
	const collection = db.collection('locations');
	
	// Определяем начало и конец текущего месяца
	const now = new Date();
	const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
	lastDayOfMonth.setHours(23, 59, 59, 999);
	
	const startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
	const endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
	
	// Получаем локации за текущий месяц
	const locations = await collection.find({
		userId,
		timestamp: { $gte: startTimestamp, $lte: endTimestamp }
	}).sort({ sessionId: 1, timestamp: 1 }).toArray();
	
	if (locations.length < 2) return { distance: 0, speed: 0, dailyDistances: [] };
	
	let totalDistance = 0;
	let totalTime = 0;
	let lastSessionId = locations[0].sessionId;
	
	// Создаем массив для хранения дистанций по каждому дню
	let dailyDistances = new Array(lastDayOfMonth.getDate()).fill(0);
	
	for (let i = 1; i < locations.length; i++) {
		const prev = locations[i - 1];
		const curr = locations[i];
		
		if (curr.sessionId !== lastSessionId) {
			lastSessionId = curr.sessionId;
			continue; // Началась новая сессия, пропускаем
		}
		
		const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
		);
		totalDistance += dist;
		
		const timeDiff = curr.timestamp - prev.timestamp;
		
		// Фильтрация: исключаем слишком большие промежутки времени, когда пользователь мог остановиться
		if (timeDiff < 3600) {  // 3600 секунд = 1 час
			totalTime += timeDiff;
		}
		
		// Определяем день месяца
		const date = new Date(curr.timestamp * 1000);
		const dayOfMonth = date.getDate() - 1; // Индекс для массива начинается с 0
		dailyDistances[dayOfMonth] += dist;
	}
	
	const avgSpeed = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0; // Средняя скорость в км/ч
	
	// Преобразуем дневные дистанции в километры
	dailyDistances = dailyDistances.map(dist => dist / 1000);
	
	return { distance: totalDistance / 1000, speed: avgSpeed, dailyDistances };
}


bot.command('weekstats', async (ctx) => {
	const userId = ctx.message.from.id;
	const stats = await calculateWeeklyStats(userId);
	
	let response = `На этой неделе (с понедельника по воскресенье) вы проехали ${stats.distance.toFixed(2)} км со средней скоростью ${stats.speed.toFixed(2)} км/ч.\n\n`;
	response += "Пробег по дням недели:\n";
	
	const daysOfWeek = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
	
	stats.dailyDistances.forEach((distance, index) => {
		response += `${daysOfWeek[index]}: ${distance.toFixed(2)} км\n`;
	});
	
	ctx.reply(response);
});
async function getTopUsers(period, limit) {
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
}

bot.command('top', async (ctx) => {
	const [_, period, limitStr] = ctx.message.text.split(' ');
	const limit = parseInt(limitStr, 10) || 10; // По умолчанию показываем 10 пользователей
	
	if (!['week', 'month'].includes(period)) {
		return ctx.reply('Пожалуйста, укажите период: "week" для недельной статистики или "month" для месячной статистики.');
	}
	
	try {
		const topUsers = await getTopUsers(period, limit);
		
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


const calculateStatsBetweenDates = async (userId, startDate, endDate) => {
	const collection = db.collection('locations');
	const startTimestamp = Math.floor(startDate.getTime() / 1000);
	const endTimestamp = Math.floor(endDate.getTime() / 1000);
	
	const locations = await collection.find({
		userId,
		timestamp: { $gte: startTimestamp, $lte: endTimestamp }
	}).sort({ timestamp: 1 }).toArray();
	
	if (locations.length < 2) return { distance: 0, speed: 0 };
	
	let totalDistance = 0;
	let totalTime = 0;
	let lastSessionId = locations[0].sessionId;
	let sessionStartTime = locations[0].timestamp;
	
	for (let i = 1; i < locations.length; i++) {
		const prev = locations[i - 1];
		const curr = locations[i];
		
		// Если началась новая сессия, обнуляем время начала сессии
		if (curr.sessionId !== lastSessionId) {
			lastSessionId = curr.sessionId;
			sessionStartTime = curr.timestamp;
			continue;
		}
		
		const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
		);
		totalDistance += dist;
		
		// Время с момента предыдущей точки до текущей
		const timeDiff = curr.timestamp - prev.timestamp;
		
		// Фильтрация: исключаем слишком большие промежутки времени, когда пользователь мог остановиться
		if (timeDiff < 3600) {  // 3600 секунд = 1 час, этот порог можно настроить
			totalTime += timeDiff;
		}
	}
	
	const avgSpeed = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0; // Средняя скорость в км/ч
	return { distance: totalDistance / 1000, speed: avgSpeed }; // Пройденное расстояние в км
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
	
	endDate.setHours(23, 59, 59); // Устанавливаем конец дня для конечной даты
	
	try {
		const stats = await calculateStatsBetweenDates(userId, startDate, endDate);
		ctx.reply(`За период с ${startDateStr} по ${endDateStr} вы проехали ${stats.distance.toFixed(2)} км со средней скоростью ${stats.speed.toFixed(2)} км/ч.`);
	} catch (error) {
		console.error('Ошибка при расчете статистики:', error);
		ctx.reply('Произошла ошибка при расчете статистики. Пожалуйста, попробуйте позже.');
	}
});

function parseDate(dateString) {
	const [day, month, year] = dateString.split('.');
	const date = new Date(year, month - 1, day);
	return date.toString() === 'Invalid Date' ? null : date;
}

(async () => {
	await connectToDatabase();
	bot.launch();
	console.log('Bot telegram-ride-stat is running');
})();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
