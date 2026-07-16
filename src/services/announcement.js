const config = require('../config/constants')

const COMMUNITY_NOTICE =
	'• Катка только для участников сообщества «МоноПитер».'

class AnnouncementService {
	constructor() {
		this.template = `01.01.2026 #катка
За тридевять земель [название катки]

📍 Место сбора: ___
▶️ Старт в 12:30
🗺 Маршрут __ км, трек: [ссылка на mapmagic.app, яндекс карты или иной планировщик треков; это желательно, но не обязательно]
🪫 Зарядки: ___
🚦 Едем по: велодорожкам, тротуарам, ПЧ, лесным тропам, бездорожью [ненужное вычеркнуть]
🚀 Скорость: от _ до _ [на велодорожках и тротуарах допустимо до 25, в иных местах до 60]

📍 ___ [кратко описываем, что из интересного будет на маршруте]

Следуем правилам поведения на катках (https://t.me/mono_piter/55).

Организатор: @__`
	}

	getTemplate() {
		return this.template
	}

	validateAnnouncement(announcement) {
		const requiredFields = [
			'date',
			'name',
			'meetingPlace',
			'startTime',
			'routeDistance',
			'charges',
			'roadTypes',
			'speed',
			'description',
			'organizer',
		]

		// Check required fields
		for (const field of requiredFields) {
			if (!announcement[field]) {
				return {
					isValid: false,
					errors: `Поле ${field} обязательно для заполнения`,
				}
			}
		}

		// Validate date format
		const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/
		if (!dateRegex.test(announcement.date)) {
			return {
				isValid: false,
				errors: 'Неверный формат даты. Используйте формат ДД.ММ.ГГГГ',
			}
		}

		// Validate time format
		const timeRegex = /^\d{2}:\d{2}$/
		if (!timeRegex.test(announcement.startTime)) {
			return {
				isValid: false,
				errors: 'Неверный формат времени. Используйте формат ЧЧ:ММ',
			}
		}

		// Validate speed format
		const speedRegex = /^\d+-\d+$|^\d+$/
		if (!speedRegex.test(announcement.speed)) {
			return {
				isValid: false,
				errors: 'Неверный формат скорости. Используйте формат "X" или "от X до Y"',
			}
		}

		return { isValid: true }
	}

	formatAnnouncement(announcement) {
		const roadTypes = announcement.roadTypes
			.filter(t => t.selected)
			.map(t => t.name)
			.join(', ')

		// Handle both single number and range formats for speed
		const speedDisplay = announcement.speed.includes('-')
			? `от ${announcement.speed.split('-')[0]} до ${
					announcement.speed.split('-')[1]
			  }`
			: announcement.speed

		const organizers = announcement.additionalOrganizers
			? `@${announcement.organizer}, @${announcement.additionalOrganizers.join(
					', @'
			  )}`
			: `@${announcement.organizer}`

		// Check if the track is provided as an image
		const hasTrackImage = announcement.trackImage !== undefined && announcement.trackImage !== null
		const trackText = hasTrackImage
			? 'на картинке' // "Track on the image below"
			: (announcement.routeLink || 'нет') // "no" if no track

		return (
			`📅 ${announcement.date}\n\n` +
			`🏁 ${announcement.name}\n\n` +
			`📍 Место сбора: ${announcement.meetingPlace}\n` +
			`⏰ Старт в ${announcement.startTime}\n` +
			`🗺 Маршрут ${announcement.routeDistance} км${announcement.routeLink ? ', трек: ' + trackText : ''}\n` +
			`🔋 Зарядки: ${announcement.charges}\n` +
			`🛣 Едем по: ${roadTypes}\n` +
			`🚀 Скорость: ${speedDisplay} км/ч\n` +
			`📝 ${announcement.description}\n\n` +
			`👥 Организаторы: ${organizers}\n\n` +
			COMMUNITY_NOTICE
		)
	}

	formatVotingMessage(announcement) {
		if (
			!announcement.votingOptions ||
			announcement.votingOptions.length === 0
		) {
			return null
		}

		return (
			`🗳 Голосование:\n\n` +
			announcement.votingOptions
				.map((option, index) => `${index + 1}. ${option}`)
				.join('\n')
		)
	}
}

module.exports = new AnnouncementService()
