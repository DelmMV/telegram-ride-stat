const { Telegraf, Scenes, session, Markup } = require('telegraf')
const config = require('../config/constants')
const statsService = require('./stats')
const fs = require('fs')
const path = require('path')
const locationService = require('./location')
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
										err.response?.description ===
											'Bad Request: message to delete not found' ||
										err.response?.description ===
											"Bad Request: message can't be deleted"
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
								err.response?.description ===
									'Bad Request: message to delete not found' ||
								err.response?.description ===
									"Bad Request: message can't be deleted"
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
				['📊 Cтатистика за прошедшую неделю'],
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
			console.log('APPROVE ANNOUNCEMENT MESSAGE:', JSON.stringify(message, null, 2))
			
			// Получаем текст сообщения модерации
			const fullModerationText = message.text
			console.log('FULL MODERATION TEXT:', fullModerationText)
			
			// Проверяем, есть ли метаданные о треке в тексте
			let trackImageFileName = null
			let photoFileId = null
			
			// Проверяем метаданные в тексте
			const trackImageMatch = fullModerationText.match(/<!-- TRACK_IMAGE:([^\s]+) -->/)
			if (trackImageMatch) {
				trackImageFileName = trackImageMatch[1]
				console.log('TRACK IMAGE FILE NAME FROM TEXT METADATA:', trackImageFileName)
			}
			
			// В Telegraf API нет прямого метода для получения соседних сообщений
			// Вместо этого мы будем использовать данные из метаданных в тексте анонса
			// И если есть метаданные о файле трека, будем искать файл на диске
			
			// Если есть имя файла трека в метаданных, проверяем его наличие на диске
			if (trackImageFileName) {
				try {
					const imagePath = path.join(__dirname, '../../uploads', trackImageFileName)
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
				const headerEndIndex = cleanedText.indexOf(headerMatch[0]) + headerMatch[0].length
				
				// Извлекаем текст после заголовка
				let textAfterHeader = cleanedText.substring(headerEndIndex).trim()
				
				// Если есть варианты для голосования, отделяем их от основного текста
				if (votingOptionsMatch) {
					votingOptions = votingOptionsMatch[1]
						.split('\n')
						.map(line => line.replace(/^\d+\.\s*/, ''))
						.filter(option => option.trim())
					
					const votingStartIndex = textAfterHeader.indexOf('🗳 Варианты для голосования:')
					if (votingStartIndex !== -1) {
						// Берем текст до начала вариантов голосования
						announcementTextToSend = textAfterHeader.substring(0, votingStartIndex).trim()
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
					
					const votingStartIndex = announcementTextToSend.indexOf('🗳 Варианты для голосования:')
					if (votingStartIndex !== -1) {
						// Берем текст до начала вариантов голосования
						announcementTextToSend = announcementTextToSend.substring(0, votingStartIndex).trim()
					}
				}
			}

			// Store moderation message ID for later reference
			ctx.session.moderationMessageId = ctx.callbackQuery.message.message_id

			// Извлекаем userId создателя анонса из метаданных в тексте сообщения
			let creatorId = null
			const creatorIdMatch = fullModerationText.match(/<!-- CREATOR_ID:(\d+) -->/)
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
					console.log(`Notification sent to creator (ID: ${creatorId}, username: @${creatorUsername || 'unknown'})`)
				} catch (error) {
					console.error(`Error sending private message to creator (ID: ${creatorId}):`, error)
					
					// Если не удалось отправить личное сообщение, пробуем отправить в общий чат с упоминанием
					if (creatorUsername) {
						try {
							await ctx.telegram.sendMessage(
								config.bot.chatId,
								`@${creatorUsername}, ✅ Ваш анонс одобрен и опубликован!`,
								{
									message_thread_id: config.bot.announcementThreadId
								}
							)
							console.log(`Fallback notification sent to @${creatorUsername} in the main chat`)
						} catch (fallbackError) {
							console.error('Error sending fallback notification:', fallbackError)
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
								message_thread_id: config.bot.announcementThreadId
							}
						)
						console.log(`Fallback notification sent to @${creatorUsername} in the main chat`)
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
						const imagePath = path.join(__dirname, '../../uploads', trackImageFileName)
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
							console.log('Announcement with track image sent to announcement thread (using file)')
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
						console.error('Error sending announcement with track image:', imageErr)
						// Если произошла ошибка при отправке фото, отправляем только текст
						await ctx.telegram.sendMessage(
							config.bot.chatId,
							escapeHTML(announcementTextToSend),
							{
								message_thread_id: config.bot.announcementThreadId,
								parse_mode: 'HTML',
							}
						)
						console.log('Fallback: Announcement text sent without image due to error')
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
			const creatorIdMatch = fullModerationText.match(/<!-- CREATOR_ID:(\d+) -->/)
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
					console.log(`Rejection notification sent to creator (ID: ${creatorId}, username: @${creatorUsername || 'unknown'})`)
				} catch (error) {
					console.error(`Error sending private message to creator (ID: ${creatorId}):`, error)
					
					// Если не удалось отправить личное сообщение, пробуем отправить в общий чат с упоминанием
					if (creatorUsername) {
						try {
							await ctx.telegram.sendMessage(
								config.bot.chatId,
								`@${creatorUsername}, ❌ Ваш анонс отклонён модератором ${adminName}.\nПожалуйста, создайте новый анонс с учётом правил.`,
								{
									message_thread_id: config.bot.announcementThreadId
								}
							)
							console.log(`Fallback rejection notification sent to @${creatorUsername} in the main chat`)
						} catch (fallbackError) {
							console.error('Error sending fallback rejection notification:', fallbackError)
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
							message_thread_id: config.bot.announcementThreadId
						}
					)
					console.log(`Fallback rejection notification sent to @${creatorUsername} in the main chat`)
				} catch (error) {
					console.error('Error sending rejection notification to chat:', error)
				}
			} else {
				console.warn('Пропущено отправление уведомления из-за отсутствия информации о создателе анонса')
			}

			await ctx.editMessageText(`${message.text}\n\n❌ Анонс отклонен`, {
				reply_markup: { inline_keyboard: [] },
			})
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

			// Удаляем все предыдущие активные геолокации пользователя
			for (const [key, locationData] of this.activeLocations) {
				if (typeof key === 'string' && key.startsWith('warning_')) continue
				if (locationData.userId === userId) {
					// Удаляем все связанные сообщения
					if (locationData.messages && locationData.messages.length > 0) {
						for (const msg of locationData.messages) {
							try {
								await this.bot.telegram.deleteMessage(
									locationData.chatId,
									msg.messageId
								)
							} catch (err) {
								if (
									err.response?.description ===
										'Bad Request: message to delete not found' ||
									err.response?.description ===
										"Bad Request: message can't be deleted"
								) {
									// Не критично
								} else {
									console.error('Error deleting geo message:', err)
								}
							}
						}
					}
					// Удаляем основное сообщение геолокации
					try {
						await this.bot.telegram.deleteMessage(locationData.chatId, key)
					} catch (err) {
						if (
							err.response?.description ===
								'Bad Request: message to delete not found' ||
							err.response?.description ===
								"Bad Request: message can't be deleted"
						) {
							// Не критично
						} else {
							console.error('Error deleting geo main message:', err)
						}
					}
					this.activeLocations.delete(key)
				}
			}

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
			for (const [key, locationData] of this.activeLocations) {
				if (typeof key === 'string' && key.startsWith('warning_')) continue
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

					// Store both messages in activeLocations for cleanup
					this.activeLocations.set(`warning_${messageId}`, {
						chatId: chat.id,
						messageId,
						warningMessageId: warningMessage.message_id,
						userId: from.id,
						timeout: setTimeout(async () => {
							try {
								await this.bot.telegram.deleteMessage(chat.id, messageId)
							} catch (err) {
								if (
									err.response?.description ===
										'Bad Request: message to delete not found' ||
									err.response?.description ===
										"Bad Request: message can't be deleted"
								) {
									// Не критично, сообщение уже удалено
								} else {
									console.error('Error deleting user message:', err)
								}
							}

							try {
								await this.bot.telegram.deleteMessage(
									chat.id,
									warningMessage.message_id
								)
							} catch (err) {
								if (
									err.response?.description ===
										'Bad Request: message to delete not found' ||
									err.response?.description ===
										"Bad Request: message can't be deleted"
								) {
									// Не критично, сообщение уже удалено
								} else {
									console.error('Error deleting warning message:', err)
								}
							}
						}, config.thresholds.messageDeleteDelay),
					})
				} catch (err) {
					console.error('Error sending warning message:', err)
				}
				return
			}

			for (const [key, locationData] of this.activeLocations) {
				// Skip warning messages
				if (typeof key === 'string' && key.startsWith('warning_')) continue

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
						// Update lastUpdate for text messages to keep location active
						locationData.lastUpdate = Date.now()
						this.activeLocations.set(key, locationData)
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
		// Add cleanup for warning messages
		setInterval(() => {
			const now = Date.now()
			for (const [key, locationData] of this.activeLocations) {
				if (
					typeof key === 'string' &&
					key.startsWith('warning_') &&
					locationData.timeout &&
					now >=
						locationData.timeout._idleStart +
							config.thresholds.messageDeleteDelay
				) {
					// Delete both messages before removing from activeLocations
					;(async () => {
						try {
							await this.bot.telegram.deleteMessage(
								locationData.chatId,
								locationData.messageId
							)
						} catch (err) {
							if (
								err.response?.description ===
									'Bad Request: message to delete not found' ||
								err.response?.description ===
									"Bad Request: message can't be deleted"
							) {
								// Не критично, сообщение уже удалено
							} else {
								console.error('Error deleting user message:', err)
							}
						}
						try {
							await this.bot.telegram.deleteMessage(
								locationData.chatId,
								locationData.warningMessageId
							)
						} catch (err) {
							if (
								err.response?.description ===
									'Bad Request: message to delete not found' ||
								err.response?.description ===
									"Bad Request: message can't be deleted"
							) {
								// Не критично, сообщение уже удалено
							} else {
								console.error('Error deleting warning message:', err)
							}
						}
						this.activeLocations.delete(key)
					})()
				}
			}
		}, 60000)
		this.bot.launch()
		console.log('Bot started')
	}
}

module.exports = new TelegramService()
