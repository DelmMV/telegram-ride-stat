const { Telegraf, Scenes, session, Markup } = require('telegraf')
const config = require('../config/constants')
const statsService = require('./stats')
const db = require('./database')
const fs = require('fs')
const path = require('path')
const locationService = require('./location')
const announcementService = require('./announcement')
const LocalSession = require('telegraf-session-local')
const createAnnouncementScene = require('../scenes/createAnnouncement')
const {
	CLEANUP_KIND,
	CLEANUP_STATUS,
	createCleanupEntry,
	isDueForCleanup,
	computeRetryExpiresAt,
	uniqMessageIds,
	toPersistenceDoc,
	fromPersistenceDoc,
} = require('./cleanupState')
let pRetry
let pRetryAbortError

// Динамический импорт p-retry
import('p-retry').then(module => {
	pRetry = module.default
	pRetryAbortError = module.AbortError || pRetry?.AbortError
})

class TelegramService {
	constructor() {
		this.bot = new Telegraf(config.bot.token)
		this.activeLiveByMessageId = new Map()
		this.activeLiveByUserId = new Map()
		this.pendingWarningByMessageId = new Map()
		this.loadingMessages = new Map()
		this.cleanupSweepTimer = null
		this.isCleanupSweepRunning = false
		this.avatarCache = new Map()
		this.avatarRequests = new Map()
		this.avatarCacheTtlMs = Number(process.env.AVATAR_CACHE_TTL_MS) || 3600000
		this.avatarFailureCooldownMs =
			Number(process.env.AVATAR_FAILURE_COOLDOWN_MS) || 300000
		this.avatarRequestTimeoutMs =
			Number(process.env.AVATAR_REQUEST_TIMEOUT_MS) || 4000
		this.avatarFailureUntilByUser = new Map()
		this.lastAvatarErrorLogAt = 0
		this.lastCleanupStatsSignature = null
		this.lastCleanupStatsLogAt = 0

		// Initialize session middleware with local storage
		const localSession = new LocalSession({ database: 'sessions.json' })
		this.bot.use(localSession.middleware())

		// Log configuration
		console.log('Bot configuration:', {
			moderatorChannelId: config.bot.moderatorChannelId,
			moderatorThreadId: config.bot.moderatorThreadId,
			announcementThreadId: config.bot.announcementThreadId,
			chatId: config.bot.chatId,
			messageThreadId: config.bot.messageThreadId,
		})
		this.logCleanupEvent('cleanup_config', {
			sweepIntervalMs: config.cleanup.cleanupSweepIntervalMs,
			warningDeleteDelayMs: config.cleanup.warningDeleteDelayMs,
			infiniteLiveDeleteDelayMs: config.cleanup.infiniteLiveDeleteDelayMs,
			inactiveLiveMs: config.cleanup.inactiveLiveMs,
			deleteRetryMaxAttempts: config.cleanup.deleteRetryMaxAttempts,
			deleteRetryBackoffMs: config.cleanup.deleteRetryBackoffMs,
			persistState: config.cleanup.persistState,
		})
	}

	logCleanupEvent(event, payload = {}) {
		console.log(`[cleanup] ${event}`, payload)
	}

	isCleanupPersistenceEnabled() {
		return !!config.cleanup.persistState
	}

	isTargetThread(chatId, threadId) {
		return (
			chatId?.toString() === config.bot.chatId &&
			threadId?.toString() === config.bot.messageThreadId
		)
	}

	getLiveEntryByUserId(userId) {
		const messageId = this.activeLiveByUserId.get(userId)
		if (!messageId) return null
		return this.activeLiveByMessageId.get(messageId) || null
	}

	async persistCleanupEntry(entry) {
		if (!this.isCleanupPersistenceEnabled()) return
		try {
			await db.upsertCleanupState(toPersistenceDoc(entry))
		} catch (error) {
			this.logCleanupEvent('persist_error', {
				kind: entry.kind,
				messageId: entry.messageId,
				chatId: entry.chatId,
				error: error.message,
			})
		}
	}

	async deletePersistedCleanupEntry(entry) {
		if (!this.isCleanupPersistenceEnabled()) return
		try {
			await db.deleteCleanupState(entry.id)
		} catch (error) {
			this.logCleanupEvent('persist_delete_error', {
				kind: entry.kind,
				messageId: entry.messageId,
				chatId: entry.chatId,
				error: error.message,
			})
		}
	}

	async removeLiveEntry(entry, { removePersisted = true } = {}) {
		if (!entry) return
		this.activeLiveByMessageId.delete(entry.messageId)
		if (this.activeLiveByUserId.get(entry.userId) === entry.messageId) {
			this.activeLiveByUserId.delete(entry.userId)
		}
		if (removePersisted) {
			await this.deletePersistedCleanupEntry(entry)
		}
	}

	async removeWarningEntry(entry, { removePersisted = true } = {}) {
		if (!entry) return
		this.pendingWarningByMessageId.delete(entry.messageId)
		if (removePersisted) {
			await this.deletePersistedCleanupEntry(entry)
		}
	}

	async registerLiveLocation({
		chatId,
		threadId,
		messageId,
		userId,
		username,
		locationTimestamp,
		latitude,
		longitude,
	}) {
		const now = Date.now()
		const existingForUser = this.getLiveEntryByUserId(userId)
		if (existingForUser && existingForUser.messageId !== messageId) {
			await this.markForCleanup(
				CLEANUP_KIND.LIVE,
				existingForUser.messageId,
				'replaced_live',
				0
			)
			await this.cleanupMessages(existingForUser)
		}

		const existingByMessage = this.activeLiveByMessageId.get(messageId)
		const entry = createCleanupEntry({
			kind: CLEANUP_KIND.LIVE,
			chatId,
			threadId,
			userId,
			username,
			messageId,
			messagesToDelete: existingByMessage?.messagesToDelete || [],
			lastUpdate: now,
			locationTimestamp,
			expiresAt: null,
			attempts: existingByMessage?.attempts || 0,
			status: CLEANUP_STATUS.PENDING,
			lastError: null,
		})
		entry.latitude = latitude
		entry.longitude = longitude
		this.activeLiveByMessageId.set(messageId, entry)
		this.activeLiveByUserId.set(userId, messageId)
		await this.persistCleanupEntry(entry)
	}

	async registerWarningDeletion({
		chatId,
		threadId,
		userId,
		messageId,
		messagesToDelete,
		reason,
		delayMs,
	}) {
		const now = Date.now()
		const entry = createCleanupEntry({
			kind: CLEANUP_KIND.WARNING,
			chatId,
			threadId,
			userId,
			messageId,
			messagesToDelete: uniqMessageIds(messagesToDelete),
			expiresAt: now + delayMs,
			reason,
			lastUpdate: now,
			status: CLEANUP_STATUS.PENDING,
		})
		this.pendingWarningByMessageId.set(messageId, entry)
		await this.persistCleanupEntry(entry)
	}

	async appendMessageToLiveEntry(liveMessageId, message) {
		const entry = this.activeLiveByMessageId.get(liveMessageId)
		if (!entry) return
		if (!entry.messagesToDelete.some(msg => msg === message.messageId)) {
			entry.messagesToDelete.push(message.messageId)
		}
		entry.lastUpdate = Date.now()
		entry.status = CLEANUP_STATUS.PENDING
		entry.expiresAt = null
		entry.lastError = null
		await this.persistCleanupEntry(entry)
	}

	async markForCleanup(kind, messageId, reason, delayMs = 0) {
		const now = Date.now()
		const entry =
			kind === CLEANUP_KIND.LIVE
				? this.activeLiveByMessageId.get(messageId)
				: this.pendingWarningByMessageId.get(messageId)
		if (!entry) return
		entry.reason = reason
		entry.expiresAt = now + delayMs
		if (entry.status !== CLEANUP_STATUS.CLEANING) {
			entry.status = CLEANUP_STATUS.PENDING
		}
		await this.persistCleanupEntry(entry)
	}

	isIgnorableDeleteError(error) {
		const description = error?.response?.description || ''
		return (
			description.includes('message to delete not found') ||
			description.includes("message can't be deleted")
		)
	}

	isRetryableDeleteError(error) {
		const errorCode = error?.code
		const responseCode = error?.response?.error_code
		return (
			errorCode === 'ETIMEDOUT' ||
			errorCode === 'ECONNRESET' ||
			errorCode === 'EAI_AGAIN' ||
			responseCode === 429 ||
			responseCode >= 500
		)
	}

	async safeDeleteMessage(chatId, messageId) {
		try {
			await this.bot.telegram.deleteMessage(chatId, messageId)
			return { ok: true, ignored: false }
		} catch (error) {
			if (this.isIgnorableDeleteError(error)) {
				return { ok: true, ignored: true }
			}
			return {
				ok: false,
				retryable: this.isRetryableDeleteError(error),
				error,
			}
		}
	}

	collectMessageIdsForCleanup(entry) {
		const baseMessageIds =
			entry.kind === CLEANUP_KIND.LIVE
				? [...(entry.messagesToDelete || []), entry.messageId]
				: [...(entry.messagesToDelete || [])]
		return uniqMessageIds(baseMessageIds).sort((a, b) => b - a)
	}

	async cleanupMessages(entry) {
		if (!entry || entry.status === CLEANUP_STATUS.CLEANING) return

		entry.status = CLEANUP_STATUS.CLEANING
		entry.attempts += 1
		await this.persistCleanupEntry(entry)

		const messageIds = this.collectMessageIdsForCleanup(entry)
		let cleanupError = null

		for (const msgId of messageIds) {
			const result = await this.safeDeleteMessage(entry.chatId, msgId)
			if (!result.ok) {
				cleanupError = result.error
				break
			}
		}

		if (!cleanupError) {
			this.logCleanupEvent('cleanup_success', {
				kind: entry.kind,
				messageId: entry.messageId,
				chatId: entry.chatId,
				attempt: entry.attempts,
				reason: entry.reason,
			})
			if (entry.kind === CLEANUP_KIND.LIVE) {
				await this.removeLiveEntry(entry)
			} else {
				await this.removeWarningEntry(entry)
			}
			return
		}

		const isRetryable = this.isRetryableDeleteError(cleanupError)
		entry.lastError = cleanupError.message || 'unknown cleanup error'
		const cleanupErrorCode =
			cleanupError?.response?.error_code || cleanupError?.code || 'unknown'
		if (!isRetryable || entry.attempts >= config.cleanup.deleteRetryMaxAttempts) {
			entry.status = CLEANUP_STATUS.FAILED
			entry.expiresAt = null
			this.logCleanupEvent('cleanup_failed_final', {
				kind: entry.kind,
				messageId: entry.messageId,
				chatId: entry.chatId,
				attempt: entry.attempts,
				reason: entry.reason,
				error: entry.lastError,
				errorCode: cleanupErrorCode,
			})
			await this.persistCleanupEntry(entry)
			if (entry.kind === CLEANUP_KIND.LIVE) {
				await this.removeLiveEntry(entry)
			} else {
				await this.removeWarningEntry(entry)
			}
			return
		}

		entry.status = CLEANUP_STATUS.FAILED
		entry.expiresAt = computeRetryExpiresAt(
			entry.attempts,
			config.cleanup.deleteRetryBackoffMs
		)
		this.logCleanupEvent('cleanup_failed_retry', {
			kind: entry.kind,
			messageId: entry.messageId,
			chatId: entry.chatId,
			attempt: entry.attempts,
			nextRetryAt: entry.expiresAt,
			reason: entry.reason,
			error: entry.lastError,
			errorCode: cleanupErrorCode,
		})
		await this.persistCleanupEntry(entry)
	}

	async getUserAvatarUrl(userId) {
		if (!pRetry) {
			console.error('pRetry module is not loaded yet')
			return null
		}
		try {
			const photos = await pRetry(
				async () => {
					try {
						const timeoutPromise = new Promise((_, reject) => {
							setTimeout(
								() => reject(new Error('Operation timed out')),
								this.avatarRequestTimeoutMs
							)
						})
						const photosPromise = this.bot.telegram.getUserProfilePhotos(
							userId,
							0,
							1
						)
						return await Promise.race([photosPromise, timeoutPromise])
					} catch (error) {
						if (
							error.code === 'ETIMEDOUT' ||
							error.code === 'ECONNRESET' ||
							error.message === 'Operation timed out'
						) {
							if (pRetryAbortError) {
								throw new pRetryAbortError(error)
							}
						}
						throw error
					}
				},
				{
					retries: 3,
					onFailedAttempt: error => {
						console.warn(
							`Попытка ${error.attemptNumber} получения фото профиля не удалась. Осталось попыток: ${error.retriesLeft}`
						)
					},
					factor: 2,
					minTimeout: 1000,
					maxTimeout: 10000,
				}
			)

			if (photos && photos.total_count > 0) {
				const fileId = photos.photos[0][0].file_id
				const file = await pRetry(
					async () => {
						try {
							const timeoutPromise = new Promise((_, reject) => {
								setTimeout(
									() => reject(new Error('Operation timed out')),
									this.avatarRequestTimeoutMs
								)
							})
							const filePromise = this.bot.telegram.getFile(fileId)
							return await Promise.race([filePromise, timeoutPromise])
						} catch (error) {
							if (
								error.code === 'ETIMEDOUT' ||
								error.code === 'ECONNRESET' ||
								error.message === 'Operation timed out'
							) {
								if (pRetryAbortError) {
									throw new pRetryAbortError(error)
								}
							}
							throw error
						}
					},
					{
						retries: 3,
						onFailedAttempt: error => {
							console.warn(
								`Попытка ${error.attemptNumber} получения файла не удалась. Осталось попыток: ${error.retriesLeft}`
							)
						},
						factor: 2,
						minTimeout: 1000,
						maxTimeout: 10000,
					}
				)
				return `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`
			}
		} catch (error) {
			if (
				error?.message === 'Operation timed out' ||
				error?.code === 'ETIMEDOUT' ||
				error?.name === 'AbortError'
			) {
				const now = Date.now()
				if (now - this.lastAvatarErrorLogAt >= 60000) {
					console.warn(
						`Аватарка временно недоступна (timeout), userId=${userId}. Повторим позже.`
					)
					this.lastAvatarErrorLogAt = now
				}
				return null
			}
			console.error('Ошибка при получении аватарки пользователя:', error)
			// Не выбрасываем ошибку дальше, чтобы бот продолжал работать
		}
		return null
	}

	getCachedAvatarUrl(userId) {
		const cached = this.avatarCache.get(userId)
		if (!cached) return null
		if (Date.now() - cached.fetchedAt > this.avatarCacheTtlMs) {
			this.avatarCache.delete(userId)
			return null
		}
		return cached.url
	}

	async getUserAvatarUrlFast(userId, timeoutMs = 300) {
		const cached = this.getCachedAvatarUrl(userId)
		if (cached) {
			return cached
		}
		const now = Date.now()
		const failureUntil = this.avatarFailureUntilByUser.get(userId)
		if (failureUntil && now < failureUntil) {
			return null
		}

		let request = this.avatarRequests.get(userId)
		if (!request) {
			request = this.getUserAvatarUrl(userId)
				.then(url => {
					if (url) {
						this.avatarCache.set(userId, { url, fetchedAt: Date.now() })
						this.avatarFailureUntilByUser.delete(userId)
					} else {
						this.avatarFailureUntilByUser.set(
							userId,
							Date.now() + this.avatarFailureCooldownMs
						)
					}
					return url
				})
				.catch(() => {
					this.avatarFailureUntilByUser.set(
						userId,
						Date.now() + this.avatarFailureCooldownMs
					)
					return null
				})
				.finally(() => {
					this.avatarRequests.delete(userId)
				})
			this.avatarRequests.set(userId, request)
		}

		return Promise.race([
			request,
			new Promise(resolve => setTimeout(() => resolve(cached || null), timeoutMs)),
		])
	}

	async checkAndRemoveInactiveLocations() {
		await this.runCleanupSweep()
	}

	async restoreCleanupStateOnStart() {
		if (!this.isCleanupPersistenceEnabled()) {
			this.logCleanupEvent(
				'persistence_disabled',
				{
					note: 'Cleanup после рестарта будет работать только для новых сообщений',
				}
			)
			return
		}

		let states = []
		try {
			states = await db.getCleanupStates()
		} catch (error) {
			this.logCleanupEvent('restore_error', { error: error.message })
			return
		}

		for (const doc of states) {
			const entry = fromPersistenceDoc(doc)
			if (!entry) continue
			if (entry.kind === CLEANUP_KIND.LIVE) {
				this.activeLiveByMessageId.set(entry.messageId, entry)
				const existingForUser = this.getLiveEntryByUserId(entry.userId)
				if (!existingForUser || existingForUser.lastUpdate < entry.lastUpdate) {
					this.activeLiveByUserId.set(entry.userId, entry.messageId)
				}
			} else if (entry.kind === CLEANUP_KIND.WARNING) {
				this.pendingWarningByMessageId.set(entry.messageId, entry)
			}
		}

		this.logCleanupEvent('restore_complete', {
			liveCount: this.activeLiveByMessageId.size,
			warningCount: this.pendingWarningByMessageId.size,
		})
	}

	logCleanupStats() {
		let failedLive = 0
		let failedWarnings = 0
		for (const entry of this.activeLiveByMessageId.values()) {
			if (entry.status === CLEANUP_STATUS.FAILED) failedLive += 1
		}
		for (const entry of this.pendingWarningByMessageId.values()) {
			if (entry.status === CLEANUP_STATUS.FAILED) failedWarnings += 1
		}

		const payload = {
			livePending: this.activeLiveByMessageId.size,
			warningPending: this.pendingWarningByMessageId.size,
			liveFailed: failedLive,
			warningFailed: failedWarnings,
		}
		const signature = JSON.stringify(payload)
		const now = Date.now()
		const shouldLog =
			signature !== this.lastCleanupStatsSignature ||
			now - this.lastCleanupStatsLogAt >= 60000
		if (shouldLog) {
			this.logCleanupEvent('sweep_stats', payload)
			this.lastCleanupStatsSignature = signature
			this.lastCleanupStatsLogAt = now
		}
	}

	getCleanupStatsSnapshot() {
		let liveFailed = 0
		let warningFailed = 0
		for (const entry of this.activeLiveByMessageId.values()) {
			if (entry.status === CLEANUP_STATUS.FAILED) liveFailed += 1
		}
		for (const entry of this.pendingWarningByMessageId.values()) {
			if (entry.status === CLEANUP_STATUS.FAILED) warningFailed += 1
		}

		return {
			livePending: this.activeLiveByMessageId.size,
			warningPending: this.pendingWarningByMessageId.size,
			liveFailed,
			warningFailed,
		}
	}

	async runCleanupSweep() {
		if (this.isCleanupSweepRunning) return
		this.isCleanupSweepRunning = true
		try {
			const now = Date.now()

			for (const entry of this.activeLiveByMessageId.values()) {
				if (entry.status === CLEANUP_STATUS.CLEANING) continue
				if (now - entry.lastUpdate >= config.cleanup.inactiveLiveMs) {
					await this.markForCleanup(
						CLEANUP_KIND.LIVE,
						entry.messageId,
						'inactive_live',
						0
					)
				}
			}

			const liveDueEntries = [...this.activeLiveByMessageId.values()].filter(
				entry => isDueForCleanup(entry, now)
			)
			for (const entry of liveDueEntries) {
				await this.cleanupMessages(entry)
			}

			const warningDueEntries = [
				...this.pendingWarningByMessageId.values(),
			].filter(entry => isDueForCleanup(entry, now))
			for (const entry of warningDueEntries) {
				await this.cleanupMessages(entry)
			}

			this.logCleanupStats()
		} finally {
			this.isCleanupSweepRunning = false
		}
	}

	async sendLoadingMessage(ctx, text) {
		const loadingMessage = await ctx.reply(text)
		this.loadingMessages.set(ctx.chat.id, loadingMessage.message_id)
		return loadingMessage
	}

	async removeLoadingMessage(ctx) {
		const messageId = this.loadingMessages.get(ctx.chat.id)
		if (messageId) {
			try {
				await this.bot.telegram.deleteMessage(ctx.chat.id, messageId)
			} catch (error) {
				console.error('Error removing loading message:', error)
			}
			this.loadingMessages.delete(ctx.chat.id)
		}
	}

	setupHandlers() {
		const weekStatsButtonRegex = /^📊\s*[CС]татистика за прошедшую неделю$/
		const weekTopButtonText = '🏆 Топ за прошедшую неделю'
		const monthTopButtonText = '📅 Топ за прошедший месяц'

		const sendWeekStats = async ctx => {
			const userId = ctx.from.id
			const { startTimestamp, endTimestamp } =
				statsService.getTimestampRangeForPeriod('week')
			const stats = await statsService.calculateStats(
				userId,
				startTimestamp,
				endTimestamp
			)
			const response = statsService.formatStatsResponse(stats, 'week')
			await ctx.reply(response)
		}

		const sendWeekTop = async ctx => {
			await this.sendLoadingMessage(ctx, '⏳ Загружаем топ за прошедшую неделю...')
			const topUsers = await statsService.getTopUsers('week')
			await this.removeLoadingMessage(ctx)
			const response = statsService.formatTopUsersResponse(topUsers, 'week')
			await ctx.reply(response)
		}

		const sendMonthTop = async ctx => {
			await this.sendLoadingMessage(ctx, '⏳ Загружаем топ за прошедший месяц...')
			const topUsers = await statsService.getTopUsers('month')
			await this.removeLoadingMessage(ctx)
			const response = statsService.formatTopUsersResponse(topUsers, 'month')
			await ctx.reply(response)
		}

		// Add announcement button to main keyboard
		this.bot.command('start', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}

			const keyboard = Markup.keyboard([
				['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
				['📊 Статистика за прошедшую неделю'],
				['📢 Создать анонс покатушки'],
			]).resize()

			await ctx.reply(
				'👋 Привет! Я бот для отслеживания статистики поездок и организации совместных покатушек.\n\n' +
					'Как это работает:\n' +
					'- Отправляйте свою геолокацию в специальный тред чата для отслеживания ваших поездок\n' +
					'- Просматривайте свою статистику и достижения\n' +
					'- Создавайте анонсы предстоящих покатушек\n\n' +
					'Используйте кнопки ниже для доступа к функциям бота:',
				keyboard
			)
		})

		// Команда для получения информации о сообщении
		this.bot.command('info', async ctx => {
			if (!ctx.message.reply_to_message) {
				await ctx.reply(
					'Ответьте этой командой на сообщение, чтобы получить информацию о нём'
				)
				return
			}

			const messageInfo = {
				chat_id: ctx.chat.id,
				message_id: ctx.message.reply_to_message.message_id,
				thread_id: ctx.message.reply_to_message.message_thread_id,
				chat_type: ctx.chat.type,
				chat_title: ctx.chat.title,
			}

			await ctx.reply(
				`Информация о сообщении:\n${JSON.stringify(messageInfo, null, 2)}`
			)
		})

		this.bot.command('stats', async ctx => {
			await sendWeekStats(ctx)
		})

		this.bot.command('top', async ctx => {
			await sendWeekTop(ctx)
		})

		this.bot.command('month', async ctx => {
			await sendMonthTop(ctx)
		})

		// Команда для диагностики cleanup-состояния (только админ-тред)
		this.bot.command('cleanup_debug', async ctx => {
			const isAdminThread =
				ctx.chat.id.toString() === config.bot.adminChannelId &&
				ctx.message.message_thread_id?.toString() === config.bot.adminThreadId

			if (!isAdminThread) {
				return
			}

			const stats = this.getCleanupStatsSnapshot()
			await ctx.reply(
				`🧹 Cleanup debug:\n` +
					`live pending: ${stats.livePending}\n` +
					`warning pending: ${stats.warningPending}\n` +
					`live failed: ${stats.liveFailed}\n` +
					`warning failed: ${stats.warningFailed}`
			)
		})

		// Handle announcement creation button
		this.bot.hears('📢 Создать анонс покатушки', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}
			await ctx.scene.enter('create_announcement')
		})

		// Handle admin moderation callbacks
		this.bot.action('approve_announcement', async ctx => {
			const message = ctx.callbackQuery.message
			console.log(
				'APPROVE ANNOUNCEMENT MESSAGE:',
				JSON.stringify(message, null, 2)
			)

			// Получаем текст сообщения модерации
			const fullModerationText = message.text
			console.log('FULL MODERATION TEXT:', fullModerationText)

			// Проверяем, есть ли метаданные о треке в тексте
			let trackImageFileName = null
			let photoFileId = null

			// Проверяем метаданные в тексте
			const trackImageMatch = fullModerationText.match(
				/<!-- TRACK_IMAGE:([^\s]+) -->/
			)
			if (trackImageMatch) {
				trackImageFileName = trackImageMatch[1]
				console.log(
					'TRACK IMAGE FILE NAME FROM TEXT METADATA:',
					trackImageFileName
				)
			}

			// В Telegraf API нет прямого метода для получения соседних сообщений
			// Вместо этого мы будем использовать данные из метаданных в тексте анонса
			// И если есть метаданные о файле трека, будем искать файл на диске

			// Если есть имя файла трека в метаданных, проверяем его наличие на диске
			if (trackImageFileName) {
				try {
					const imagePath = path.join(
						__dirname,
						'../../uploads',
						trackImageFileName
					)
					if (fs.existsSync(imagePath)) {
						console.log('TRACK IMAGE FILE FOUND ON DISK:', imagePath)
					} else {
						console.error('TRACK IMAGE FILE NOT FOUND ON DISK:', imagePath)
						trackImageFileName = null // Сбрасываем, если файл не найден
					}
				} catch (err) {
					console.error('ERROR CHECKING TRACK IMAGE FILE:', err)
					trackImageFileName = null
				}
			}

			// Extract voting options from the original message
			const votingOptionsMatch = fullModerationText.match(
				/🗳 Варианты для голосования:\n([\s\S]*?)(?=\n\n|$)/
			)
			let votingOptions = []

			// Извлекаем текст анонса без метаданных
			// Сначала удаляем все метаданные
			let cleanedText = fullModerationText
				.replace(/<!-- TRACK_IMAGE:[^\s]+ -->/g, '')
				.replace(/<!-- CREATOR_ID:\d+ -->/g, '')

			// Затем извлекаем текст анонса без заголовка
			let announcementTextToSend = ''

			// Извлечение основного текста анонса из сообщения модерации
			// Находим заголовок "Новый анонс от @username:"
			const headerMatch = cleanedText.match(/Новый анонс от @\w+:/)
			if (headerMatch) {
				// Находим индекс конца заголовка
				const headerEndIndex =
					cleanedText.indexOf(headerMatch[0]) + headerMatch[0].length

				// Извлекаем текст после заголовка
				let textAfterHeader = cleanedText.substring(headerEndIndex).trim()

				// Если есть варианты для голосования, отделяем их от основного текста
				if (votingOptionsMatch) {
					votingOptions = votingOptionsMatch[1]
						.split('\n')
						.map(line => line.replace(/^\d+\.\s*/, ''))
						.filter(option => option.trim())

					const votingStartIndex = textAfterHeader.indexOf(
						'🗳 Варианты для голосования:'
					)
					if (votingStartIndex !== -1) {
						// Берем текст до начала вариантов голосования
						announcementTextToSend = textAfterHeader
							.substring(0, votingStartIndex)
							.trim()
					} else {
						// Если не нашли варианты голосования в тексте после заголовка, берем весь текст
						announcementTextToSend = textAfterHeader
					}
				} else {
					// Если нет вариантов для голосования, берем весь текст после заголовка
					announcementTextToSend = textAfterHeader
				}
			} else {
				// Если не нашли заголовок, берем текст после первого разделителя \n\n
				const parts = cleanedText.split('\n\n')
				if (parts.length > 1) {
					announcementTextToSend = parts.slice(1).join('\n\n').trim()
				} else {
					// Если нет разделителя, берем весь текст
					announcementTextToSend = cleanedText.trim()
				}

				// Если есть варианты для голосования, отделяем их от основного текста
				if (votingOptionsMatch) {
					votingOptions = votingOptionsMatch[1]
						.split('\n')
						.map(line => line.replace(/^\d+\.\s*/, ''))
						.filter(option => option.trim())

					const votingStartIndex = announcementTextToSend.indexOf(
						'🗳 Варианты для голосования:'
					)
					if (votingStartIndex !== -1) {
						// Берем текст до начала вариантов голосования
						announcementTextToSend = announcementTextToSend
							.substring(0, votingStartIndex)
							.trim()
					}
				}
			}

			// Store moderation message ID for later reference
			ctx.session.moderationMessageId = ctx.callbackQuery.message.message_id

			// Извлекаем userId создателя анонса из метаданных в тексте сообщения
			let creatorId = null
			const creatorIdMatch = fullModerationText.match(
				/<!-- CREATOR_ID:(\d+) -->/
			)
			if (creatorIdMatch) {
				creatorId = creatorIdMatch[1]
			}

			// Извлекаем username создателя анонса из текста сообщения (для логирования)
			let creatorUsername = null
			const creatorMatch = fullModerationText.match(/Новый анонс от @(\w+)/)
			if (creatorMatch) {
				creatorUsername = creatorMatch[1]
			}

			// Отправляем личное сообщение создателю анонса
			if (creatorId) {
				try {
					// Отправляем личное сообщение создателю анонса, используя его userId
					await ctx.telegram.sendMessage(
						creatorId,
						'✅ Ваш анонс одобрен и опубликован!'
					)
					console.log(
						`Notification sent to creator (ID: ${creatorId}, username: @${
							creatorUsername || 'unknown'
						})`
					)
				} catch (error) {
					console.error(
						`Error sending private message to creator (ID: ${creatorId}):`,
						error
					)

					// Если не удалось отправить личное сообщение, пробуем отправить в общий чат с упоминанием
					if (creatorUsername) {
						try {
							await ctx.telegram.sendMessage(
								config.bot.chatId,
								`@${creatorUsername}, ✅ Ваш анонс одобрен и опубликован!`,
								{
									message_thread_id: config.bot.announcementThreadId,
								}
							)
							console.log(
								`Fallback notification sent to @${creatorUsername} in the main chat`
							)
						} catch (fallbackError) {
							console.error(
								'Error sending fallback notification:',
								fallbackError
							)
						}
					}
				}
			} else {
				console.warn('Creator ID not found in the announcement metadata')

				// Если не нашли ID, но есть username, пробуем отправить в общий чат с упоминанием
				if (creatorUsername) {
					try {
						await ctx.telegram.sendMessage(
							config.bot.chatId,
							`@${creatorUsername}, ✅ Ваш анонс одобрен и опубликован!`,
							{
								message_thread_id: config.bot.announcementThreadId,
							}
						)
						console.log(
							`Fallback notification sent to @${creatorUsername} in the main chat`
						)
					} catch (fallbackError) {
						console.error('Error sending fallback notification:', fallbackError)
					}
				}
			}

			// Repost announcement to main chat in specified thread with HTML escaping
			const escapeHTML = text => {
				return text
					.replace(/&/g, '&')
					.replace(/</g, '<')
					.replace(/>/g, '>')
					.replace(/"/g, '"')
					.replace(/'/g, '&#039;')
			}

			try {
				// Если есть изображение трека, отправляем анонс с фото
				if (trackImageFileName) {
					try {
						// Ищем файл на диске
						const imagePath = path.join(
							__dirname,
							'../../uploads',
							trackImageFileName
						)
						if (fs.existsSync(imagePath)) {
							// Отправляем фото с текстом анонса в подписи
							await ctx.telegram.sendPhoto(
								config.bot.chatId,
								{ source: fs.readFileSync(imagePath) },
								{
									caption: escapeHTML(announcementTextToSend),
									message_thread_id: config.bot.announcementThreadId,
									parse_mode: 'HTML',
								}
							)
							console.log(
								'Announcement with track image sent to announcement thread (using file)'
							)
						} else {
							console.error(`Track image file not found: ${imagePath}`)
							// Если файл не найден, отправляем только текст анонса
							await ctx.telegram.sendMessage(
								config.bot.chatId,
								escapeHTML(announcementTextToSend),
								{
									message_thread_id: config.bot.announcementThreadId,
									parse_mode: 'HTML',
								}
							)
							console.log('Fallback: Announcement text sent without image')
						}
					} catch (imageErr) {
						console.error(
							'Error sending announcement with track image:',
							imageErr
						)
						// Если произошла ошибка при отправке фото, отправляем только текст
						await ctx.telegram.sendMessage(
							config.bot.chatId,
							escapeHTML(announcementTextToSend),
							{
								message_thread_id: config.bot.announcementThreadId,
								parse_mode: 'HTML',
							}
						)
						console.log(
							'Fallback: Announcement text sent without image due to error'
						)
					}
				} else {
					// Если нет изображения трека, отправляем только текст анонса
					await ctx.telegram.sendMessage(
						config.bot.chatId,
						escapeHTML(announcementTextToSend),
						{
							message_thread_id: config.bot.announcementThreadId,
							parse_mode: 'HTML',
						}
					)
					console.log('Announcement text sent to announcement thread')
				}

				// Затем — голосование, если есть варианты
				if (votingOptions.length > 0) {
					await ctx.telegram.sendPoll(
						config.bot.chatId,
						'🗳 Голосование:',
						votingOptions,
						{
							is_anonymous: false,
							allows_multiple_answers: true,
							message_thread_id: config.bot.announcementThreadId,
						}
					)
				}
			} catch (error) {
				console.error('Error reposting announcement to main chat:', error)
			}

			if (!fullModerationText.includes('✅ Анонс одобрен')) {
				await ctx.editMessageText(
					`${fullModerationText}\n\n✅ Анонс одобрен и опубликован`,
					{ reply_markup: { inline_keyboard: [] } }
				)
			}
		})

		this.bot.action('reject_announcement', async ctx => {
			const message = ctx.callbackQuery.message
			const fullModerationText = message.text

			// Извлекаем userId создателя анонса из метаданных в тексте сообщения
			let creatorId = null
			const creatorIdMatch = fullModerationText.match(
				/<!-- CREATOR_ID:(\d+) -->/
			)
			if (creatorIdMatch) {
				creatorId = creatorIdMatch[1]
			}

			// Извлекаем username создателя анонса из текста сообщения
			let creatorUsername = null
			const creatorMatch = fullModerationText.match(/Новый анонс от @(\w+)/)
			if (creatorMatch) {
				creatorUsername = creatorMatch[1]
			} else {
				// Пробуем найти в строке Организаторы
				const organizerMatch = fullModerationText.match(/Организаторы: @(\w+)/)
				if (organizerMatch) {
					creatorUsername = organizerMatch[1]
				}
			}

			if (!creatorUsername && !creatorId) {
				console.warn(
					'Не удалось извлечь информацию о создателе анонса из текста сообщения:',
					fullModerationText
				)
			}

			// Получаем username или имя администратора
			let adminName = ctx.from.username
			if (!adminName) {
				adminName = ctx.from.first_name || 'администратор'
			} else {
				adminName = `@${adminName}`
			}

			// Отправляем личное сообщение создателю анонса
			if (creatorId) {
				try {
					// Отправляем личное сообщение создателю анонса, используя его userId
					await ctx.telegram.sendMessage(
						creatorId,
						`❌ Ваш анонс отклонён модератором ${adminName}.\nПожалуйста, создайте новый анонс с учётом правил.`
					)
					console.log(
						`Rejection notification sent to creator (ID: ${creatorId}, username: @${
							creatorUsername || 'unknown'
						})`
					)
				} catch (error) {
					console.error(
						`Error sending private message to creator (ID: ${creatorId}):`,
						error
					)

					// Если не удалось отправить личное сообщение, пробуем отправить в общий чат с упоминанием
					if (creatorUsername) {
						try {
							await ctx.telegram.sendMessage(
								config.bot.chatId,
								`@${creatorUsername}, ❌ Ваш анонс отклонён модератором ${adminName}.\nПожалуйста, создайте новый анонс с учётом правил.`,
								{
									message_thread_id: config.bot.announcementThreadId,
								}
							)
							console.log(
								`Fallback rejection notification sent to @${creatorUsername} in the main chat`
							)
						} catch (fallbackError) {
							console.error(
								'Error sending fallback rejection notification:',
								fallbackError
							)
						}
					}
				}
			} else if (creatorUsername) {
				// Если нет userId, но есть username, отправляем сообщение в общий чат с упоминанием
				try {
					await ctx.telegram.sendMessage(
						config.bot.chatId,
						`@${creatorUsername}, ❌ Ваш анонс отклонён модератором ${adminName}.\nПожалуйста, создайте новый анонс с учётом правил.`,
						{
							message_thread_id: config.bot.announcementThreadId,
						}
					)
					console.log(
						`Fallback rejection notification sent to @${creatorUsername} in the main chat`
					)
				} catch (error) {
					console.error('Error sending rejection notification to chat:', error)
				}
			} else {
				console.warn(
					'Пропущено отправление уведомления из-за отсутствия информации о создателе анонса'
				)
			}

			await ctx.editMessageText(`${message.text}\n\n❌ Анонс отклонен`, {
				reply_markup: { inline_keyboard: [] },
			})
		})

		this.bot.hears(weekStatsButtonRegex, async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}
			await sendWeekStats(ctx)
		})

		this.bot.hears(weekTopButtonText, async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}
			await sendWeekTop(ctx)
		})

		this.bot.hears(monthTopButtonText, async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}
			await sendMonthTop(ctx)
		})

		this.bot.on('location', async ctx => {
			const location = ctx.message.location
			const userId = ctx.message.from.id
			const username = ctx.message.from.username
				? `@${ctx.message.from.username}`
				: ctx.message.from.first_name
				? ctx.message.from.first_name
				: ctx.message.from.last_name
			const timestamp = ctx.message.date
			const {
				chat,
				message_id: messageId,
				message_thread_id: messageThreadId,
			} = ctx.message
			const live_period = ctx.message.location.live_period

			if (!this.isTargetThread(chat.id, messageThreadId)) {
				return
			}

			if (live_period == null) {
				const warningMessage = await ctx.reply(
					`⚠️ В этом треде принимается только live-геолокация.\nСообщение будет удалено через ${
						config.cleanup.warningDeleteDelayMs / 1000
					} секунд.`,
					{
						reply_to_message_id: messageId,
						message_thread_id: config.bot.messageThreadId,
					}
				)
				await this.registerWarningDeletion({
					chatId: chat.id,
					threadId: messageThreadId,
					userId,
					messageId,
					messagesToDelete: [messageId, warningMessage.message_id],
					reason: 'non_live_geo',
					delayMs: config.cleanup.warningDeleteDelayMs,
				})
				return
			}

			if (live_period === 2147483647) {
				try {
					const warningMessage = await ctx.reply(
						`Нельзя кидать геопозицию с неограниченным временем. Геолокация будет удалена через ${
							config.cleanup.infiniteLiveDeleteDelayMs / 1000
						} секунд!`,
						{
							reply_to_message_id: messageId,
							message_thread_id: config.bot.messageThreadId,
						}
					)
					await this.registerWarningDeletion({
						chatId: chat.id,
						threadId: messageThreadId,
						userId,
						messageId,
						messagesToDelete: [messageId, warningMessage.message_id],
						reason: 'infinite_live',
						delayMs: config.cleanup.infiniteLiveDeleteDelayMs,
					})
					return
				} catch (error) {
					console.error('Error handling infinite location:', error)
				}
			}

			await this.registerLiveLocation({
				chatId: chat.id,
				threadId: messageThreadId,
				messageId,
				userId,
				username,
				locationTimestamp: timestamp * 1000,
				latitude: location.latitude,
				longitude: location.longitude,
			})

			const avatarUrl = await this.getUserAvatarUrlFast(userId, 1500)

			await locationService.processLocation(
				userId,
				username,
				timestamp,
				location.latitude,
				location.longitude,
				avatarUrl
			)
		})

		this.bot.on('edited_message', async ctx => {
			if (ctx.editedMessage.location) {
				const startTime = Date.now()
				try {
					const location = ctx.editedMessage.location
					const userId = ctx.editedMessage.from.id
					const timestamp = ctx.editedMessage.edit_date
					const username = ctx.editedMessage.from.username
						? `@${ctx.editedMessage.from.username}`
						: ctx.editedMessage.from.first_name
						? ctx.editedMessage.from.first_name
						: ctx.editedMessage.from.last_name
					const message = ctx.editedMessage

					if (
						!this.isTargetThread(
							message.chat.id,
							message.message_thread_id
						)
					) {
						return
					}

					let avatarUrl = null
					try {
						avatarUrl = await this.getUserAvatarUrlFast(userId, 250)
					} catch (avatarErr) {
						console.error('Ошибка получения аватарки пользователя:', avatarErr)
						avatarUrl = null
					}

					if (message?.location) {
						const { chat, message_id: messageId } = message

						await this.registerLiveLocation({
							chatId: chat.id,
							threadId: message.message_thread_id,
							messageId,
							userId,
							username,
							locationTimestamp: timestamp * 1000,
							latitude: location.latitude,
							longitude: location.longitude,
						})
					}

					const processStart = Date.now()
					try {
						await Promise.race([
							locationService.processLocation(
								userId,
								username,
								timestamp,
								location.latitude,
								location.longitude,
								avatarUrl
							),
							new Promise((_, reject) =>
								setTimeout(
									() => reject(new Error('processLocation timeout')),
									10000
								)
							),
						])
					} catch (dbErr) {
						console.error('Ошибка при сохранении локации:', dbErr)
					}
					const processEnd = Date.now()
					console.log(
						`[edited_message] userId=${userId} обработан за ${
							processEnd - startTime
						} мс (processLocation: ${processEnd - processStart} мс)`
					)
				} catch (err) {
					console.error('Ошибка в обработчике edited_message:', err)
				}
			}
		})

		this.bot.on('message', async ctx => {
			const {
				chat,
				message_id: messageId,
				date,
				message_thread_id: messageThreadId,
				from,
			} = ctx.message

			if (!this.isTargetThread(chat.id, messageThreadId)) {
				return
			}

			if (ctx.message.location) {
				return
			}

			const activeLocation = this.getLiveEntryByUserId(from.id)
			const hasActiveLocation =
				!!activeLocation && activeLocation.status !== CLEANUP_STATUS.CLEANING

			if (!hasActiveLocation) {
				try {
					const warningMessage = await ctx.reply(
						`⚠️ В этой ветке нельзя отправлять сообщения без активной геолокации.\nВаше сообщение будет удалено через ${
							config.cleanup.warningDeleteDelayMs / 1000
						} секунд.`,
						{
							reply_to_message_id: messageId,
							message_thread_id: messageThreadId,
						}
					)
					await this.registerWarningDeletion({
						chatId: chat.id,
						threadId: messageThreadId,
						userId: from.id,
						messageId,
						messagesToDelete: [messageId, warningMessage.message_id],
						reason: 'no_active_live_text',
						delayMs: config.cleanup.warningDeleteDelayMs,
					})
				} catch (err) {
					console.error('Error sending warning message:', err)
				}
				return
			}

			const messageTimestamp = date * 1000
			if (messageTimestamp >= activeLocation.locationTimestamp) {
				await this.appendMessageToLiveEntry(activeLocation.messageId, {
					messageId,
					timestamp: messageTimestamp,
					userId: from.id,
				})
			}
		})
	}

	start() {
		// Глобальный обработчик необработанных ошибок
		process.on('unhandledRejection', error => {
			console.error('Unhandled promise rejection:', error)
			// Не завершаем процесс, позволяем боту продолжить работу
		})
		// Create stage with scenes
		const stage = new Scenes.Stage([createAnnouncementScene])
		this.bot.use(stage.middleware())

		this.setupHandlers()
		this.restoreCleanupStateOnStart()
			.then(() => this.checkAndRemoveInactiveLocations())
			.catch(error => {
				this.logCleanupEvent('restore_unhandled_error', { error: error.message })
			})
		this.cleanupSweepTimer = setInterval(
			() =>
				this.checkAndRemoveInactiveLocations().catch(error => {
					this.logCleanupEvent('sweep_unhandled_error', {
						error: error.message,
					})
				}),
			config.cleanup.cleanupSweepIntervalMs
		)
		this.bot.launch()
		console.log('Bot started')
	}
}

module.exports = new TelegramService()
