module.exports = {
	bot: {
		token: process.env.TELEGRAM_BOT_TOKEN,
		chatId: process.env.MONOPITER_CHAT,
		messageThreadId: process.env.MESSAGE_THREAD_ID_MONOPITER_CHAT,
	},
	database: {
		url: 'mongodb://192.168.0.107:27017',
		name: 'geolocation_db',
	},
	thresholds: {
		maxDistance: 3000, // Порог для начала новой сессии в метрах
		maxTime: 2 * 60 * 60, // 2 часа в секундах
		maxInactivity: 45 * 60 * 1000, // гео без активности в минутах
		messageDeleteDelay: 10 * 1000, // сообщение без геолокации у
		infiniteLocationDeleteDelay: 10 * 1000, // бесконечные гео
	},
	cache: {
		ttl: 3600000, // 1 час в миллисекундах
	},
	periods: {
		week: 'week',
		month: 'month',
	},
}
