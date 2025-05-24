const { Telegraf, Markup, Scenes, session } = require('telegraf')
const config = require('../config/constants')
const locationService = require('./location')
const statsService = require('./stats')
const announcementService = require('./announcement')
const LocalSession = require('telegraf-session-local')
const createAnnouncementScene = require('../scenes/createAnnouncement')
let pRetry

// Динамический импорт p-retry
import('p-retry').then(module => {
	pRetry = module.default
})

class TelegramService {
	constructor() {
		this.bot = new Telegraf(config.bot.token)
		this.activeLocations = new Map()
		this.loadingMessages = new Map()
		
		// Initialize session middleware with local storage
		const localSession = new LocalSession({ database: 'sessions.json' })
		this.bot.use(localSession.middleware())

		// ВРЕМЕННЫЙ ОТЛАДОЧНЫЙ MIDDLEWARE ДЛЯ ПОЛУЧЕНИЯ chat id и message_thread_id
		this.bot.use((ctx, next) => {
			if (ctx.message) {
				console.log('chat id:', ctx.chat.id);
				console.log('message_thread_id:', ctx.message.message_thread_id);
			}
			return next();
		});
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
						return await this.bot.telegram.getUserProfilePhotos(userId, 0, 1)
					} catch (error) {
						if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
							throw new pRetry.AbortError(error)
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
				}
			)

			if (photos && photos.total_count > 0) {
				const fileId = photos.photos[0][0].file_id
				const file = await pRetry(
					async () => {
						try {
							return await this.bot.telegram.getFile(fileId)
						} catch (error) {
							if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
								throw new pRetry.AbortError(error)
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
					}
				)
				return `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`
			}
		} catch (error) {
			console.error('Ошибка при получении аватарки пользователя:', error)
		}
		return null
	}

	async checkAndRemoveInactiveLocations() {
		if (!pRetry) {
			console.error('pRetry module is not loaded yet')
			return
		}
		const now = Date.now()

		for (const [messageId, locationData] of this.activeLocations) {
			if (now - locationData.lastUpdate > config.thresholds.maxInactivity) {
				try {
					const chatMember = await pRetry(
						async () => {
							try {
								return await this.bot.telegram.getChatMember(
									locationData.chatId,
									this.bot.botInfo.id
								)
							} catch (error) {
								if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
									throw new pRetry.AbortError(error)
								}
								throw error
							}
						},
						{
							retries: 3,
							onFailedAttempt: error => {
								console.warn(
									`Attempt ${error.attemptNumber} failed for getChatMember. ${error.retriesLeft} retries left.`
								)
							},
						}
					)

					if (chatMember.can_delete_messages) {
						if (locationData.messages && locationData.messages.length > 0) {
							const sortedMessages = [...locationData.messages].sort(
								(a, b) => b.timestamp - a.timestamp
							)

							for (const message of sortedMessages) {
								try {
									await pRetry(
										async () => {
											try {
												await this.bot.telegram.deleteMessage(
													locationData.chatId,
													message.messageId
												)
											} catch (error) {
												if (
													error.code === 'ETIMEDOUT' ||
													error.code === 'ECONNRESET'
												) {
													throw new pRetry.AbortError(error)
												}
												throw error
											}
										},
										{
											retries: 3,
											onFailedAttempt: error => {
												console.warn(
													`Attempt ${error.attemptNumber} failed for deleteMessage. ${error.retriesLeft} retries left.`
												)
											},
										}
									)
								} catch (err) {
									// Ignore errors for already deleted messages
									if (
										err.response?.description === 'Bad Request: message to delete not found' ||
										err.response?.description === "Bad Request: message can't be deleted"
									) {
										continue
									}
									console.error(
										`Error deleting message ${message.messageId}:`,
										err.message
									)
								}
							}
						}

						try {
							await pRetry(
								async () => {
									try {
										await this.bot.telegram.deleteMessage(
											locationData.chatId,
											messageId
										)
									} catch (error) {
										if (
											error.code === 'ETIMEDOUT' ||
											error.code === 'ECONNRESET'
										) {
											throw new pRetry.AbortError(error)
										}
										throw error
									}
								},
								{
									retries: 3,
									onFailedAttempt: error => {
										console.warn(
											`Attempt ${error.attemptNumber} failed for deleteMessage. ${error.retriesLeft} retries left.`
										)
									},
								}
							)
						} catch (err) {
							// Ignore errors for already deleted messages
							if (
								err.response?.description === 'Bad Request: message to delete not found' ||
								err.response?.description === "Bad Request: message can't be deleted"
							) {
								// Continue to next iteration
								continue
							}
							console.error(
								`Error deleting location message ${messageId}:`,
								err.message
							)
						}
					}
				} catch (err) {
					console.error(
						`Error checking chat member for message ${messageId}:`,
						err.message
					)
				} finally {
					// Always remove from activeLocations regardless of deletion success
					this.activeLocations.delete(messageId)
				}
			}
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
		// Add announcement button to main keyboard
		this.bot.command('start', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}

			const keyboard = Markup.keyboard([
				['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
				['📊 Cтатистика за прошедшую неделю', '📢 Создать анонс']
			]).resize()

			await ctx.reply(
				'👋 Привет! Я бот для отслеживания статистики поездок.\n\n' +
				'📌 Отправляйте свою геолокацию, чтобы я мог отслеживать ваши поездки.\n\n' +
				'📊 Используйте кнопки ниже для просмотра статистики:',
				keyboard
			)
		})

		// Handle announcement creation button
		this.bot.hears('📢 Создать анонс', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}
			await ctx.scene.enter('create_announcement')
		})

		// Handle admin moderation callbacks
		this.bot.action('approve_announcement', async ctx => {
			const message = ctx.callbackQuery.message
			const fullModerationText = message.text

			// Extract voting options from the original message
			const votingOptionsMatch = fullModerationText.match(/🗳 Варианты для голосования:\n([\s\S]*?)(?=\n\n|$)/)
			let votingOptions = []
			let announcementTextToSend = fullModerationText.split('\n\n').slice(1).join('\n\n') // Default to full text after header

			if (votingOptionsMatch) {
				votingOptions = votingOptionsMatch[1]
					.split('\n')
					.map(line => line.replace(/^\d+\.\s*/, ''))
					.filter(option => option.trim())

				// Find the index where the voting options start and take the text before it
				const votingStartIndex = fullModerationText.indexOf('🗳 Варианты для голосования:')
				if (votingStartIndex !== -1) {
					// Take the text from after the header up to the start of voting options
					const headerEndIndex = fullModerationText.indexOf('\n\n', fullModerationText.indexOf('Новый анонс от @') + 1) + 2;
					if (headerEndIndex < votingStartIndex) {
						announcementTextToSend = fullModerationText.substring(headerEndIndex, votingStartIndex).trim()
					} else {
						// Should not happen if parsing is correct, but as a fallback
						announcementTextToSend = fullModerationText.split('\n\n')[1].trim() // Take just the first main block
					}
				}
			} else {
				 // If no voting options found, just take the main announcement text after the header
				 announcementTextToSend = fullModerationText.split('\n\n').slice(1).join('\n\n').trim()
			}

			
			// Send to main channel - ONLY the announcement text
			await ctx.telegram.sendMessage(
				config.bot.chatId,
				announcementTextToSend,
				{ message_thread_id: config.bot.announcementThreadId }
			)

			// Create poll if voting options exist
			if (votingOptions.length > 0) {
				await ctx.telegram.sendPoll(
					config.bot.chatId,
					'🗳 Голосование по вариантам маршрута:',
					votingOptions,
					{
						is_anonymous: false,
						allows_multiple_answers: false,
						message_thread_id: config.bot.announcementThreadId
					}
				)
			}
			
			// Notify user in private message
			try {
				await ctx.telegram.sendMessage(
					ctx.from.id,
					'✅ Ваш анонс одобрен и опубликован!'
				)
			} catch (error) {
				console.error('Error sending private message:', error)
			}
			
			// Update admin message
			await ctx.editMessageText(
				`${fullModerationText}\n\n✅ Анонс одобрен и опубликован`,
				{ reply_markup: { inline_keyboard: [] } }
			)
		})

		this.bot.action('reject_announcement', async ctx => {
			const message = ctx.callbackQuery.message
			const username = message.text.split('от @')[1].split(':')[0]
			
			// Send rejection notification in private message
			try {
				await ctx.telegram.sendMessage(
					ctx.from.id,
					'❌ Ваш анонс отклонен. Пожалуйста, создайте новый анонс с учетом правил.'
				)
			} catch (error) {
				console.error('Error sending private message:', error)
			}
			
			await ctx.editMessageText(
				`${message.text}\n\n❌ Анонс отклонен`,
				{ reply_markup: { inline_keyboard: [] } }
			)
		})

		this.bot.hears('📊 Cтатистика за прошедшую неделю', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}

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
		})

		this.bot.hears('🏆 Топ за прошедшую неделю', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}

			await this.sendLoadingMessage(
				ctx,
				'⏳ Загружаем топ за прошедшую неделю...'
			)
			const topUsers = await statsService.getTopUsers('week')
			await this.removeLoadingMessage(ctx)
			const response = statsService.formatTopUsersResponse(topUsers, 'week')
			await ctx.reply(response)
		})

		this.bot.hears('📅 Топ за прошедший месяц', async ctx => {
			if (ctx.chat.type !== 'private') {
				return
			}

			await this.sendLoadingMessage(
				ctx,
				'⏳ Загружаем топ за прошедший месяц...'
			)
			const topUsers = await statsService.getTopUsers('month')
			await this.removeLoadingMessage(ctx)
			const response = statsService.formatTopUsersResponse(topUsers, 'month')
			await ctx.reply(response)
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

			if (
				chat.id.toString() !== config.bot.chatId ||
				messageThreadId?.toString() !== config.bot.messageThreadId
			) {
				return
			}

			const avatarUrl = await this.getUserAvatarUrl(userId)

			if (!live_period || live_period === 2147483647) {
				try {
					const warningMessage = await ctx.reply(
						`Нельзя кидать геопозицию с неограниченным временем. Геолокация будет удалена через ${
							config.thresholds.infiniteLocationDeleteDelay / 1000
						} секунд!`,
						{
							reply_to_message_id: messageId,
							message_thread_id: config.bot.messageThreadId,
						}
					)

					this.activeLocations.set(messageId, {
						chatId: chat.id,
						lastUpdate: Date.now(),
						userId,
						username,
						latitude: location.latitude,
						longitude: location.longitude,
						timestamp: timestamp * 1000,
						messages: [
							{
								messageId: warningMessage.message_id,
								timestamp: warningMessage.date * 1000,
							},
						],
					})

					setTimeout(async () => {
						try {
							await this.bot.telegram.deleteMessage(chat.id, messageId)
							await this.bot.telegram.deleteMessage(
								chat.id,
								warningMessage.message_id
							)
						} catch (err) {
							console.error('Error deleting messages:', err)
						} finally {
							this.activeLocations.delete(messageId)
						}
					}, config.thresholds.infiniteLocationDeleteDelay)

					return
				} catch (error) {
					console.error('Error handling infinite location:', error)
				}
			}

			this.activeLocations.set(messageId, {
				chatId: chat.id,
				lastUpdate: Date.now(),
				userId,
				username,
				latitude: location.latitude,
				longitude: location.longitude,
				timestamp: timestamp * 1000,
				messages: [],
			})

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
					message.chat.id.toString() !== config.bot.chatId ||
					message.message_thread_id?.toString() !== config.bot.messageThreadId
				) {
					return
				}

				const avatarUrl = await this.getUserAvatarUrl(userId)

				if (message?.location) {
					const { chat, message_id: messageId } = message

					const existingLocation = this.activeLocations.get(messageId) || {
						messages: [],
					}
					this.activeLocations.set(messageId, {
						...existingLocation,
						chatId: chat.id,
						lastUpdate: Date.now(),
						userId,
						username,
						latitude: location.latitude,
						longitude: location.longitude,
						timestamp: timestamp * 1000,
					})
				}

				await locationService.processLocation(
					userId,
					username,
					timestamp,
					location.latitude,
					location.longitude,
					avatarUrl
				)
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

			if (
				chat.id.toString() !== config.bot.chatId ||
				messageThreadId?.toString() !== config.bot.messageThreadId
			) {
				return
			}

			if (ctx.message.location) {
				return
			}

			let hasActiveLocation = false
			for (const [_, locationData] of this.activeLocations) {
				if (locationData.userId === from.id) {
					hasActiveLocation = true
					break
				}
			}

			if (!hasActiveLocation) {
				try {
					const warningMessage = await ctx.reply(
						`⚠️ В этой ветке нельзя отправлять сообщения без активной геолокации.\nВаше сообщение будет удалено через ${
							config.thresholds.messageDeleteDelay / 1000
						} секунд.`,
						{
							reply_to_message_id: messageId,
							message_thread_id: messageThreadId,
						}
					)

					setTimeout(async () => {
						try {
							await this.bot.telegram.deleteMessage(chat.id, messageId)
							await this.bot.telegram.deleteMessage(
								chat.id,
								warningMessage.message_id
							)
						} catch (err) {
							console.error('Error deleting messages:', err)
						}
					}, config.thresholds.messageDeleteDelay)
				} catch (err) {
					console.error('Error sending warning message:', err)
				}
				return
			}

			for (const [locationMessageId, locationData] of this.activeLocations) {
				const messageTimestamp = date * 1000
				const locationTimestamp = locationData.timestamp

				if (
					messageTimestamp >= locationTimestamp &&
					from.id === locationData.userId
				) {
					const message = {
						messageId,
						timestamp: messageTimestamp,
						userId: from.id,
					}

					if (
						!locationData.messages.some(
							msg => msg.messageId === message.messageId
						)
					) {
						locationData.messages.push(message)
						locationData.lastUpdate = Date.now()
						this.activeLocations.set(locationMessageId, locationData)
					}
				}
			}
		})
	}

	start() {
		// Create stage with scenes
		const stage = new Scenes.Stage([createAnnouncementScene])
		this.bot.use(stage.middleware())
		
		this.setupHandlers()
		setInterval(() => this.checkAndRemoveInactiveLocations(), 60000)
		this.bot.launch()
		console.log('Bot started')
	}
}

module.exports = new TelegramService() 