const { Scenes, Markup } = require('telegraf')
const config = require('../config/constants')
const announcementService = require('../services/announcement')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const createAnnouncementScene = new Scenes.BaseScene('create_announcement')

createAnnouncementScene.enter(async ctx => {
	const keyboard = Markup.keyboard([['❌ Отмена']]).resize()

	// Send template message
	await ctx.reply(
		'Давайте создадим анонс катки! Я помогу вам заполнить все необходимые поля.\n\n' +
			'Вот шаблон анонса:\n\n' +
			announcementService.getTemplate() +
			'\n\n' +
			'В конце создания анонса вы сможете добавить варианты для голосования по маршруту. Опрос будет отправлен отдельно от основного анонса.'
	)

	// Send first request message
	const message = await ctx.reply(
		'Начнем с даты катки. Введите дату в формате ДД.ММ.ГГГГ:',
		keyboard
	)
	ctx.scene.state.messageId = message.message_id
})

// Добавляем обработчик для кнопки отмены
createAnnouncementScene.hears('❌ Отмена', async ctx => {
	await ctx.scene.leave()
	await ctx.reply(
		'Создание анонса отменено.',
		Markup.keyboard([
			['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
			['📊 Cтатистика за прошедшую неделю'],
			['📢 Создать анонс покатушки'],
		]).resize()
	)
})

// Ensure uploads directory exists
if (!fs.existsSync(path.join(__dirname, '../../uploads'))) {
	fs.mkdirSync(path.join(__dirname, '../../uploads'), { recursive: true })
}

// Helper function to update messages
const updateMessage = async (ctx, text, keyboard = null) => {
	try {
		// Delete old message if it exists
		if (ctx.scene.state.messageId) {
			await ctx.telegram.deleteMessage(ctx.chat.id, ctx.scene.state.messageId)
		}
		// Send new message
		const message = await ctx.reply(text, keyboard)
		ctx.scene.state.messageId = message.message_id
	} catch (error) {
		console.error('Error updating message:', error)
	}
}

// Helper function to download and save image
const downloadImage = async (fileId, ctx) => {
	try {
		// Get file info from Telegram
		const fileInfo = await ctx.telegram.getFile(fileId)
		const fileUrl = `https://api.telegram.org/file/bot${config.bot.token}/${fileInfo.file_path}`
		
		// Generate a unique filename
		const fileName = `track_${Date.now()}_${Math.floor(Math.random() * 10000)}.jpg`
		const filePath = path.join(__dirname, '../../uploads', fileName)
		
		// Download the file
		const response = await axios({
			method: 'GET',
			url: fileUrl,
			responseType: 'stream'
		})
		
		// Save the file
		const writer = fs.createWriteStream(filePath)
		response.data.pipe(writer)
		
		return new Promise((resolve, reject) => {
			writer.on('finish', () => resolve({
				fileName,
				filePath
			}))
			writer.on('error', reject)
		})
	} catch (error) {
		console.error('Error downloading image:', error)
		throw error
	}
}

// Handle photo uploads for track
createAnnouncementScene.on('photo', async ctx => {
	// Only process photos when we're in the routeLink step
	if (ctx.scene.state.step === 'routeLink') {
		try {
			// Get the largest photo from the array
			const photo = ctx.message.photo[ctx.message.photo.length - 1]
			const fileId = photo.file_id
			
			// Download and save the image
			const imageInfo = await downloadImage(fileId, ctx)
			
			// Store image info in the announcement state
			ctx.scene.state.announcement.routeLink = 'на картинке' // "Track on the image below"
			ctx.scene.state.announcement.trackImage = imageInfo
			
			// Move to the next step
			ctx.scene.state.step = 'charges'
			await updateMessage(ctx,
				'Дата: ' +
					ctx.scene.state.announcement.date +
					'\n' +
					'Название: ' +
					ctx.scene.state.announcement.name +
					'\n' +
					'Место сбора: ' +
					ctx.scene.state.announcement.meetingPlace +
					'\n' +
					'Время старта: ' +
					ctx.scene.state.announcement.startTime +
					'\n' +
					'Длина маршрута: ' +
					ctx.scene.state.announcement.routeDistance +
					' км\n' +
					'Трек: ' +
					ctx.scene.state.announcement.routeLink +
					'\n\n' +
					'Введите информацию о зарядках:',
				Markup.keyboard([['❌ Отмена']]).resize()
			)
		} catch (error) {
			console.error('Error processing photo:', error)
			await ctx.reply('Произошла ошибка при обработке изображения. Пожалуйста, попробуйте еще раз или введите ссылку на трек.')
		}
	}
})

createAnnouncementScene.on('text', async ctx => {
	const text = ctx.message.text

	// Убираем проверку на отмену из обработчика текста, так как теперь есть отдельный обработчик

	if (!ctx.scene.state.step) {
		// Date input
		const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/
		if (!dateRegex.test(text)) {
			await ctx.reply('Неверный формат даты. Используйте формат ДД.ММ.ГГГГ')
			return
		}
		ctx.scene.state.announcement = { date: text }
		ctx.scene.state.step = 'name'
		await updateMessage(ctx, 
			'Дата: ' + text + '\n\n' + 'Введите название катки:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'name') {
		ctx.scene.state.announcement.name = text
		ctx.scene.state.step = 'meetingPlace'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				text +
				'\n\n' +
				'Введите место сбора:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'meetingPlace') {
		ctx.scene.state.announcement.meetingPlace = text
		ctx.scene.state.step = 'startTime'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				text +
				'\n\n' +
				'Введите время старта в формате ЧЧ:ММ:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'startTime') {
		const timeRegex = /^\d{2}:\d{2}$/
		if (!timeRegex.test(text)) {
			await ctx.reply('Неверный формат времени. Используйте формат ЧЧ:ММ')
			return
		}
		ctx.scene.state.announcement.startTime = text
		ctx.scene.state.step = 'routeDistance'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				text +
				'\n\n' +
				'Введите длину маршрута в формате "X" только число:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'routeDistance') {
		if (isNaN(Number(text))) {
			await ctx.reply('Пожалуйста, введите число')
			return
		}
		ctx.scene.state.announcement.routeDistance = text
		ctx.scene.state.step = 'routeLink'
		await updateMessage(ctx,
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				text +
				' км\n\n' +
				'Введите ссылку на трек, загрузите изображение с треком или отправьте "-" если нет трека:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'routeLink') {
		ctx.scene.state.announcement.routeLink = text === '-' ? null : text
		ctx.scene.state.announcement.trackImage = null // No image for text input
		ctx.scene.state.step = 'charges'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				ctx.scene.state.announcement.routeDistance +
				' км\n' +
				'Трек: ' +
				(text === '-' ? 'нет' : text) +
				'\n\n' +
				'Введите информацию о зарядках:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'charges') {
		ctx.scene.state.announcement.charges = text
		ctx.scene.state.step = 'roadTypes'
		const keyboard = Markup.keyboard([
			['велодорожки', 'тротуары', 'пч'],
			['лесные тропы', 'бездорожье'],
			['✅ Готово'],
			['❌ Отмена'],
		]).resize()
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				ctx.scene.state.announcement.routeDistance +
				' км\n' +
				'Трек: ' +
				(ctx.scene.state.announcement.routeLink || 'нет') +
				'\n' +
				'Зарядки: ' +
				text +
				'\n\n' +
				'Выберите типы дорог (можно выбрать несколько):',
			keyboard
		)
	} else if (ctx.scene.state.step === 'roadTypes') {
		if (text === '✅ Готово') {
			if (
				!ctx.scene.state.announcement.roadTypes ||
				ctx.scene.state.announcement.roadTypes.length === 0
			) {
				await ctx.reply('Выберите хотя бы один тип дороги')
				return
			}
			ctx.scene.state.step = 'speed'
			const selectedTypes = ctx.scene.state.announcement.roadTypes
				.filter(t => t.selected)
				.map(t => t.name)
				.join(', ')
			await updateMessage(ctx, 
				'Дата: ' +
					ctx.scene.state.announcement.date +
					'\n' +
					'Название: ' +
					ctx.scene.state.announcement.name +
					'\n' +
					'Место сбора: ' +
					ctx.scene.state.announcement.meetingPlace +
					'\n' +
					'Время старта: ' +
					ctx.scene.state.announcement.startTime +
					'\n' +
					'Длина маршрута: ' +
					ctx.scene.state.announcement.routeDistance +
					' км\n' +
					'Трек: ' +
					(ctx.scene.state.announcement.routeLink || 'нет') +
					'\n' +
					'Зарядки: ' +
					ctx.scene.state.announcement.charges +
					'\n' +
					'Типы дорог: ' +
					selectedTypes +
					'\n\n' +
					'Введите скорость в формате "X" или "от X до Y":',
				Markup.keyboard([['❌ Отмена']]).resize()
			)
		} else {
			if (!ctx.scene.state.announcement.roadTypes) {
				ctx.scene.state.announcement.roadTypes = []
			}
			const roadType = text
			const existingType = ctx.scene.state.announcement.roadTypes.find(
				t => t.name === roadType
			)
			if (existingType) {
				existingType.selected = !existingType.selected
			} else {
				ctx.scene.state.announcement.roadTypes.push({
					name: roadType,
					selected: true,
				})
			}
			const selectedTypes = ctx.scene.state.announcement.roadTypes
				.filter(t => t.selected)
				.map(t => t.name)
				.join(', ')
			await ctx.reply(`Выбранные типы дорог: ${selectedTypes || 'нет'}`)
		}
	} else if (ctx.scene.state.step === 'speed') {
		// Check if the input is a range or a single number
		let speedValue = text;
		if (text.startsWith('от ') && text.includes(' до ')) {
			speedValue = text
				.replace('от ', '')
				.replace(' до ', '-')
		}
		
		// Use the same regex as in validateAnnouncement function
		const speedRegex = /^\d+-\d+$|^\d+$/
		if (!speedRegex.test(speedValue)) {
			await ctx.reply(
				'Неверный формат скорости. Используйте формат "X" или "от X до Y"'
			)
			return
		}
		// Store the validated speed value
		ctx.scene.state.announcement.speed = speedValue
		ctx.scene.state.step = 'description'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				ctx.scene.state.announcement.routeDistance +
				' км\n' +
				'Трек: ' +
				(ctx.scene.state.announcement.routeLink || 'нет') +
				'\n' +
				'Зарядки: ' +
				ctx.scene.state.announcement.charges +
				'\n' +
				'Типы дорог: ' +
				ctx.scene.state.announcement.roadTypes
					.filter(t => t.selected)
					.map(t => t.name)
					.join(', ') +
				'\n' +
				'Скорость: ' +
				(ctx.scene.state.announcement.speed.includes('-')
					? 'от ' +
					  ctx.scene.state.announcement.speed.split('-')[0] +
					  ' до ' +
					  ctx.scene.state.announcement.speed.split('-')[1]
					: ctx.scene.state.announcement.speed) +
				' км/ч' +
				'\n' +
				'\n' +
				'Введите краткое описание маршрута:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'description') {
		ctx.scene.state.announcement.description = text
		ctx.scene.state.step = 'additionalOrganizers'
		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				ctx.scene.state.announcement.routeDistance +
				' км\n' +
				'Трек: ' +
				(ctx.scene.state.announcement.routeLink || 'нет') +
				'\n' +
				'Зарядки: ' +
				ctx.scene.state.announcement.charges +
				'\n' +
				'Типы дорог: ' +
				ctx.scene.state.announcement.roadTypes
					.filter(t => t.selected)
					.map(t => t.name)
					.join(', ') +
				'\n' +
				'Скорость: ' +
				(ctx.scene.state.announcement.speed.includes('-')
					? 'от ' +
					  ctx.scene.state.announcement.speed.split('-')[0] +
					  ' до ' +
					  ctx.scene.state.announcement.speed.split('-')[1]
					: ctx.scene.state.announcement.speed) +
				' км/ч' +
				'\n' +
				'Описание: ' +
				text +
				'\n\n' +
				'Введите username дополнительных организаторов через запятую (или отправьте "-" если нет):',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'additionalOrganizers') {
		// Set main organizer as the creator
		ctx.scene.state.announcement.organizer = ctx.from.username

		// Add additional organizers if provided
		if (text !== '-') {
			const additionalOrganizers = text
				.split(',')
				.map(org => org.trim())
				.filter(org => org)
			ctx.scene.state.announcement.additionalOrganizers = additionalOrganizers
		}

		// Initialize voting options array
		ctx.scene.state.announcement.votingOptions = []
		ctx.scene.state.step = 'voting'

		await updateMessage(ctx, 
			'Дата: ' +
				ctx.scene.state.announcement.date +
				'\n' +
				'Название: ' +
				ctx.scene.state.announcement.name +
				'\n' +
				'Место сбора: ' +
				ctx.scene.state.announcement.meetingPlace +
				'\n' +
				'Время старта: ' +
				ctx.scene.state.announcement.startTime +
				'\n' +
				'Длина маршрута: ' +
				ctx.scene.state.announcement.routeDistance +
				' км\n' +
				'Трек: ' +
				(ctx.scene.state.announcement.routeLink || 'нет') +
				'\n' +
				'Зарядки: ' +
				ctx.scene.state.announcement.charges +
				'\n' +
				'Типы дорог: ' +
				ctx.scene.state.announcement.roadTypes
					.filter(t => t.selected)
					.map(t => t.name)
					.join(', ') +
				'\n' +
				'Скорость: ' +
				(ctx.scene.state.announcement.speed.includes('-')
					? 'от ' +
					  ctx.scene.state.announcement.speed.split('-')[0] +
					  ' до ' +
					  ctx.scene.state.announcement.speed.split('-')[1]
					: ctx.scene.state.announcement.speed) +
				' км/ч' +
				'\n' +
				'Описание: ' +
				ctx.scene.state.announcement.description +
				'\n' +
				'Организаторы: @' +
				ctx.scene.state.announcement.organizer +
				(ctx.scene.state.announcement.additionalOrganizers
					? ', @' +
					  ctx.scene.state.announcement.additionalOrganizers.join(', @')
					: '') +
				'\n\n' +
				'Теперь давайте добавим варианты для голосования.\n' +
				'Введите вариант для голосования или отправьте "✅ Готово" чтобы закончить:',
			Markup.keyboard([['✅ Готово'], ['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'voting') {
		if (text === '✅ Готово') {
			// Validate and format announcement
			const validation = announcementService.validateAnnouncement(
				ctx.scene.state.announcement
			)
			if (!validation.isValid) {
				await ctx.reply(`Ошибка: ${validation.errors}`)
				return
			}

			// Format announcement text without voting options for the final message
			const formattedAnnouncementFinal = announcementService.formatAnnouncement(
				ctx.scene.state.announcement
			)

			// Store the formatted announcement for final message and voting options for the poll
			ctx.scene.state.formattedAnnouncementFinal = formattedAnnouncementFinal
			ctx.scene.state.votingOptions =
				ctx.scene.state.announcement.votingOptions || []

			// Show preview with options to submit or cancel (including voting options for preview)
			const keyboard = Markup.inlineKeyboard([
				[
					Markup.button.callback(
						'✅ Отправить на модерацию',
						'submit_announcement'
					),
					Markup.button.callback('❌ Отменить', 'cancel_announcement'),
				],
			])

			// Add voting options to the preview if they exist
			const votingTextPreview =
				ctx.scene.state.votingOptions.length > 0
					? '\n\n🗳 Варианты для голосования:\n' +
					  ctx.scene.state.votingOptions
							.map((option, index) => `${index + 1}. ${option}`)
							.join('\n')
					: ''

			await ctx.reply(
				'📝 Предварительный просмотр анонса:\n\n' +
					formattedAnnouncementFinal + // Use final version for preview base
					votingTextPreview +
					'\n\n' + // Add preview voting text
					'Проверьте все данные.\n',
				keyboard
			)

			// Отправляем отдельное сообщение с клавиатурой только с кнопкой "Отмена"
			await ctx.reply(
				'Используйте кнопку "Отправить на модерацию" что-бы отправить анонс на проверку и кнопку "Отмена", если передумали отправлять анонс.',
				Markup.keyboard([['❌ Отмена']]).resize()
			)
		} else {
			// Check if we've already reached the maximum number of poll options (10)
			if (ctx.scene.state.announcement.votingOptions && ctx.scene.state.announcement.votingOptions.length >= 10) {
				await ctx.reply(
					'Ошибка: В опросе Телеграм может быть максимум 10 вариантов ответа. Вы уже добавили максимальное количество. Нажмите "✅ Готово" для завершения.'
				)
				return
			}
			
			// Check if the voting option exceeds Telegram's 100 character limit
			if (text.length > 100) {
				await ctx.reply(
					'Ошибка: Вариант для голосования не может превышать 100 символов. Ваш вариант содержит ' + 
					text.length + ' символов. Пожалуйста, сократите текст.'
				)
				return
			}

			// Add new voting option
			ctx.scene.state.announcement.votingOptions.push(text)

			// Show current voting options
			const votingOptionsText =
				ctx.scene.state.announcement.votingOptions.length > 0
					? '\n\nТекущие варианты для голосования:\n' +
					  ctx.scene.state.announcement.votingOptions
							.map((option, index) => `${index + 1}. ${option}`)
							.join('\n')
					: ''

			await updateMessage(ctx, 
				'Дата: ' +
					ctx.scene.state.announcement.date +
					'\n' +
					'Название: ' +
					ctx.scene.state.announcement.name +
					'\n' +
					'Место сбора: ' +
					ctx.scene.state.announcement.meetingPlace +
					'\n' +
					'Время старта: ' +
					ctx.scene.state.announcement.startTime +
					'\n' +
					'Длина маршрута: ' +
					ctx.scene.state.announcement.routeDistance +
					' км\n' +
					'Трек: ' +
					(ctx.scene.state.announcement.routeLink || 'нет') +
					'\n' +
					'Зарядки: ' +
					ctx.scene.state.announcement.charges +
					'\n' +
					'Типы дорог: ' +
					ctx.scene.state.announcement.roadTypes
						.filter(t => t.selected)
						.map(t => t.name)
						.join(', ') +
					'\n' +
					'Скорость: ' +
					(ctx.scene.state.announcement.speed.includes('-')
						? 'от ' +
						  ctx.scene.state.announcement.speed.split('-')[0] +
						  ' до ' +
						  ctx.scene.state.announcement.speed.split('-')[1]
						: ctx.scene.state.announcement.speed) +
					' км/ч' +
					'\n' +
					'Описание: ' +
					ctx.scene.state.announcement.description +
					'\n' +
					'Организаторы: @' +
					ctx.scene.state.announcement.organizer +
					(ctx.scene.state.announcement.additionalOrganizers
						? ', @' +
						  ctx.scene.state.announcement.additionalOrganizers.join(', @')
						: '') +
					votingOptionsText +
					'\n\n' +
					'Введите следующий вариант для голосования или отправьте "✅ Готово" чтобы закончить:',
				Markup.keyboard([['✅ Готово'], ['❌ Отмена']]).resize()
			)
		}
	}
})

createAnnouncementScene.action('submit_announcement', async ctx => {
	// Удаляем inline-кнопки превью
	try {
		await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
	} catch (e) {
		// ignore if already edited
	}
	// Send to admin channel for moderation
	const keyboard = Markup.inlineKeyboard([
		[
			Markup.button.callback('✅ Принять', 'approve_announcement'),
			Markup.button.callback('❌ Отклонить', 'reject_announcement'),
		],
	])

	// Add voting options to the moderation message if they exist for parsing in telegram.js
	const votingTextModeration =
		ctx.scene.state.votingOptions.length > 0
			? '\n\n🗳 Варианты для голосования:\n' +
			  ctx.scene.state.votingOptions
					.map((option, index) => `${index + 1}. ${option}`)
					.join('\n')
			: ''

	// Add track image metadata if present (hidden from user view)
	let trackImageMetadata = ''
	if (ctx.scene.state.announcement.trackImage) {
		// Добавляем метаданные в HTML-комментарий для обработки при одобрении
		trackImageMetadata = `\n\n<!-- TRACK_IMAGE:${ctx.scene.state.announcement.trackImage.fileName} -->`
		
		// Также добавляем видимую информацию о треке в текст анонса
		if (!ctx.scene.state.formattedAnnouncementFinal.includes('трек: на картинке')) {
			// Ищем строку с маршрутом
			const routeRegex = /(🗺 Маршрут .+?)(\n|$)/
			if (routeRegex.test(ctx.scene.state.formattedAnnouncementFinal)) {
				ctx.scene.state.formattedAnnouncementFinal = ctx.scene.state.formattedAnnouncementFinal.replace(
					routeRegex,
					'$1, трек: на картинке$2'
				)
			}
		}
	}

	// Add creator userId metadata (hidden from user view)
	const creatorMetadata = `\n\n<!-- CREATOR_ID:${ctx.from.id} -->`

	const moderationText = `Новый анонс от @${ctx.from.username}:\n\n${ctx.scene.state.formattedAnnouncementFinal}${votingTextModeration}${trackImageMetadata}${creatorMetadata}`

	console.log('SEND TO MODERATION:', {
		chatId: config.bot.adminChannelId,
		threadId: config.bot.adminThreadId,
		typeChatId: typeof config.bot.adminChannelId,
		typeThreadId: typeof config.bot.adminThreadId,
		moderationText,
		keyboard,
		hasTrackImage: !!ctx.scene.state.announcement.trackImage
	})

	try {
		// Сначала отправляем текст анонса
		const res = await ctx.telegram.sendMessage(
			config.bot.adminChannelId,
			moderationText,
			{
				...keyboard,
				message_thread_id: Number(config.bot.adminThreadId),
			}
		)
		console.log('ANNOUNCEMENT TEXT SENT:', res)
		
		// Если есть картинка трека, отправляем ее отдельным сообщением
		if (ctx.scene.state.announcement.trackImage) {
			try {
				const imagePath = path.join(__dirname, '../../uploads', ctx.scene.state.announcement.trackImage.fileName)
				const photoRes = await ctx.telegram.sendPhoto(
					config.bot.adminChannelId,
					{ source: fs.readFileSync(imagePath) },
					{
						caption: 'Трек для анонса',
						message_thread_id: Number(config.bot.adminThreadId),
					}
				)
				console.log('TRACK IMAGE SENT:', photoRes)
			} catch (imageErr) {
				console.error('ERROR SENDING ANNOUNCEMENT WITH TRACK IMAGE:', imageErr)
				// Если не удалось отправить с картинкой, отправляем только текст
				const res = await ctx.telegram.sendMessage(
					config.bot.adminChannelId,
					moderationText,
					{
						...keyboard,
						message_thread_id: Number(config.bot.adminThreadId),
					}
				)
				console.log('FALLBACK: MODERATION MESSAGE SENT WITHOUT IMAGE:', res)
			}
		} else {
			// Если картинки нет, отправляем только текст анонса
			const res = await ctx.telegram.sendMessage(
				config.bot.adminChannelId,
				moderationText,
				{
					...keyboard,
					message_thread_id: Number(config.bot.adminThreadId),
				}
			)
			console.log('MODERATION MESSAGE SENT:', res)
		}
	} catch (err) {
		console.error('ERROR SENDING MODERATION MESSAGE:', err)
	}

	// Сначала отправляем сообщение о модерации
	// await ctx.reply(
	// 	'✅ Анонс отправлен на модерацию. Вы получите уведомление после проверки.'
	// )

	// Затем отправляем сообщение со стандартной клавиатурой
	// Отправляем новое сообщение с подтверждением и стандартной клавиатурой
	await ctx.reply(
		'✅ Анонс отправлен на модерацию. Вы получите уведомление после проверки.',
		Markup.keyboard([
			['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
			['📊 Cтатистика за прошедшую неделю'],
			['📢 Создать анонс покатушки'],
		]).resize()
	)

	await ctx.scene.leave()
})

createAnnouncementScene.action('cancel_announcement', async ctx => {
	// Удаляем inline-кнопки превью
	try {
		await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
	} catch (e) {
		// ignore if already edited
	}
	await ctx.reply(
		'❌ Создание анонса отменено.',
		Markup.keyboard([
			['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
			['📊 Cтатистика за прошедшую неделю'],
			['📢 Создать анонс покатушки'],
		]).resize()
	)
	await ctx.scene.leave()
})

module.exports = createAnnouncementScene
