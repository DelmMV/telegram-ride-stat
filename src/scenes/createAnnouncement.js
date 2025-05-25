const { Scenes, Markup } = require('telegraf')
const config = require('../config/constants')
const announcementService = require('../services/announcement')

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
			['📊 Cтатистика за прошедшую неделю', '📢 Создать анонс'],
		]).resize()
	)
})

createAnnouncementScene.on('text', async ctx => {
	const text = ctx.message.text

	// Убираем проверку на отмену из обработчика текста, так как теперь есть отдельный обработчик
	const updateMessage = async (text, keyboard = null) => {
		try {
			// Delete old message
			await ctx.telegram.deleteMessage(ctx.chat.id, ctx.scene.state.messageId)
			// Send new message
			const message = await ctx.reply(text, keyboard)
			ctx.scene.state.messageId = message.message_id
		} catch (error) {
			console.error('Error updating message:', error)
		}
	}

	if (!ctx.scene.state.step) {
		// Date input
		const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/
		if (!dateRegex.test(text)) {
			await ctx.reply('Неверный формат даты. Используйте формат ДД.ММ.ГГГГ')
			return
		}
		ctx.scene.state.announcement = { date: text }
		ctx.scene.state.step = 'name'
		await updateMessage(
			'Дата: ' + text + '\n\n' + 'Введите название катки:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'name') {
		ctx.scene.state.announcement.name = text
		ctx.scene.state.step = 'meetingPlace'
		await updateMessage(
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
		await updateMessage(
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
		await updateMessage(
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
				'Введите длину маршрута в километрах:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'routeDistance') {
		if (isNaN(Number(text))) {
			await ctx.reply('Пожалуйста, введите число')
			return
		}
		ctx.scene.state.announcement.routeDistance = text
		ctx.scene.state.step = 'routeLink'
		await updateMessage(
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
				'Введите ссылку на трек (или отправьте "-" если нет):',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'routeLink') {
		ctx.scene.state.announcement.routeLink = text === '-' ? null : text
		ctx.scene.state.step = 'charges'
		await updateMessage(
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
			['Велодорожки', 'Тротуары', 'ПЧ'],
			['Лесные тропы', 'Бездорожье', '✅ Готово'],
			['❌ Отмена'],
		]).resize()
		await updateMessage(
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
			await updateMessage(
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
					'Введите скорость в формате "от X до Y":',
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
		const speedRegex = /^от \d+ до \d+$/
		if (!speedRegex.test(text)) {
			await ctx.reply(
				'Неверный формат скорости. Используйте формат "от X до Y"'
			)
			return
		}
		ctx.scene.state.announcement.speed = text
			.replace('от ', '')
			.replace(' до ', '-')
		ctx.scene.state.step = 'description'
		await updateMessage(
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
				text +
				'\n\n' +
				'Введите краткое описание маршрута:',
			Markup.keyboard([['❌ Отмена']]).resize()
		)
	} else if (ctx.scene.state.step === 'description') {
		ctx.scene.state.announcement.description = text
		ctx.scene.state.step = 'additionalOrganizers'
		await updateMessage(
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
				'Скорость: от ' +
				ctx.scene.state.announcement.speed.split('-')[0] +
				' до ' +
				ctx.scene.state.announcement.speed.split('-')[1] +
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

		await updateMessage(
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
				'Скорость: от ' +
				ctx.scene.state.announcement.speed.split('-')[0] +
				' до ' +
				ctx.scene.state.announcement.speed.split('-')[1] +
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
					'Проверьте все данные. Вы можете:\n' +
					'✅ Отправить на модерацию - отправить анонс на проверку\n' +
					'❌ Отменить - отменить создание анонса',
				keyboard
			)
		} else {
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

			await updateMessage(
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
					'Скорость: от ' +
					ctx.scene.state.announcement.speed.split('-')[0] +
					' до ' +
					ctx.scene.state.announcement.speed.split('-')[1] +
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

	await ctx.telegram.sendMessage(
		config.bot.adminChannelId,
		`Новый анонс от (тест) @${ctx.from.username}:\n\n${ctx.scene.state.formattedAnnouncementFinal}${votingTextModeration}`,keyboard,
		{
			message_thread_id: config.bot.adminThreadId,
		}
	)

	await ctx.reply(
		'✅ Анонс отправлен на модерацию. Вы получите уведомление после проверки.',
		Markup.keyboard([
			['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
			['📊 Cтатистика за прошедшую неделю', '📢 Создать анонс'],
		]).resize()
	)

	await ctx.scene.leave()
})

createAnnouncementScene.action('cancel_announcement', async ctx => {
	await ctx.reply(
		'❌ Создание анонса отменено.',
		Markup.keyboard([
			['🏆 Топ за прошедшую неделю', '📅 Топ за прошедший месяц'],
			['📊 Cтатистика за прошедшую неделю', '📢 Создать анонс'],
		]).resize()
	)
	await ctx.scene.leave()
})

module.exports = createAnnouncementScene
