module.exports = {
	bot: {
		token: process.env.TELEGRAM_BOT_TOKEN,
		chatId: process.env.MONOPITER_CHAT,
		messageThreadId: process.env.MESSAGE_THREAD_ID_MONOPITER_CHAT,
		adminThreadId: process.env.MESSAGE_THREAD_ID_ADMIN_CHAT,
		adminChannelId: process.env.ADMIN_CHAT,
		moderatorChannelId: process.env.MODERATOR_CHAT,
		moderatorThreadId: process.env.MESSAGE_THREAD_ID_MODERATOR_CHAT,
		announcementThreadId: process.env.MESSAGE_THREAD_ID_MONOPITER_ANNONCE,
	},
	database: {
		url: 'mongodb://localhost:27017',
		name: 'geolocation_db',
	},
	cleanup: {
		cleanupSweepIntervalMs: Number(process.env.CLEANUP_SWEEP_INTERVAL_MS) || 1000,
		warningDeleteDelayMs: Number(process.env.WARNING_DELETE_DELAY_MS) || 3000,
		infiniteLiveDeleteDelayMs:
			Number(process.env.INFINITE_LIVE_DELETE_DELAY_MS) || 5000,
		inactiveLiveMs: Number(process.env.INACTIVE_LIVE_MS) || 45 * 60 * 1000,
		deleteRetryMaxAttempts:
			Number(process.env.CLEANUP_DELETE_RETRY_MAX_ATTEMPTS) || 5,
		deleteRetryBackoffMs:
			Number(process.env.CLEANUP_DELETE_RETRY_BACKOFF_MS) || 2000,
		persistState: process.env.CLEANUP_PERSIST_STATE !== 'false',
	},
	thresholds: {
		maxDistance: 3000, // Порог для начала новой сессии в метрах
		maxTime: 2 * 60 * 60, // 2 часа в секундах
		maxInactivity:
			Number(process.env.INACTIVE_LIVE_MS) || 45 * 60 * 1000, // backward compatibility
		messageDeleteDelay:
			Number(process.env.WARNING_DELETE_DELAY_MS) || 3 * 1000, // backward compatibility
		infiniteLocationDeleteDelay:
			Number(process.env.INFINITE_LIVE_DELETE_DELAY_MS) || 5 * 1000, // backward compatibility
	},
	cache: {
		ttl: 3600000, // 1 час в миллисекундах
	},
	periods: {
		week: 'week',
		month: 'month',
	},
}
