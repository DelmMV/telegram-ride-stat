const config = require('../config/constants')
const db = require('./database')
const locationService = require('./location')

class StatsService {
	constructor() {
		this.cache = {
			week: { data: null, timestamp: 0 },
			month: { data: null, timestamp: 0 },
		}
		this.userStatsCache = new Map()
	}

	getTimestampRangeForPeriod(period) {
		const now = new Date()
		let startTimestamp, endTimestamp

		if (period === 'week') {
			const lastWeek = new Date(now)
			lastWeek.setDate(lastWeek.getDate() - 7)
			const dayOfWeek = lastWeek.getDay()
			const lastMonday = new Date(lastWeek)
			lastMonday.setHours(0, 0, 0, 0)
			lastMonday.setDate(
				lastWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)
			)
			const lastSunday = new Date(lastMonday)
			lastSunday.setDate(lastMonday.getDate() + 6)
			lastSunday.setHours(23, 59, 59, 999)

			startTimestamp = Math.floor(lastMonday.getTime() / 1000)
			endTimestamp = Math.floor(lastSunday.getTime() / 1000)
		} else if (period === 'month') {
			const firstDayOfLastMonth = new Date(
				now.getFullYear(),
				now.getMonth() - 1,
				1
			)
			firstDayOfLastMonth.setHours(0, 0, 0, 0)
			const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0)
			lastDayOfLastMonth.setHours(23, 59, 59, 999)

			startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000)
			endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000)
		}

		return { startTimestamp, endTimestamp }
	}

	async calculateStats(userId, startTimestamp, endTimestamp) {
		const cacheKey = `${userId}:${startTimestamp}:${endTimestamp}`
		const cached = this.userStatsCache.get(cacheKey)
		if (
			cached &&
			Date.now() - cached.timestamp < config.stats.userStatsCacheTtlMs
		) {
			return cached.data
		}

		const locations = await db.getLocationsInTimeRange(
			userId,
			startTimestamp,
			endTimestamp,
			{
				projection: { latitude: 1, longitude: 1, sessionId: 1, timestamp: 1 },
				maxTimeMS: 20000,
			}
		)
		if (locations.length < 2) {
			this.userStatsCache.set(cacheKey, { data: null, timestamp: Date.now() })
			return null
		}

		const totalDistance = locationService.calculateDistance(locations)
		const sessions = new Set(locations.map(loc => loc.sessionId)).size

		const result = {
			totalDistance,
			sessions,
			points: locations.length,
		}
		this.userStatsCache.set(cacheKey, { data: result, timestamp: Date.now() })
		return result
	}

	async getTopUsers(period, limit = 10) {
		const now = Date.now()
		if (
			this.cache[period] &&
			now - this.cache[period].timestamp < config.cache.ttl
		) {
			return this.cache[period].data
		}

		const { startTimestamp, endTimestamp } =
			this.getTimestampRangeForPeriod(period)
		const collection = db.db.collection('locations')

		// Сначала получаем все локации за период
		const locations = await collection
			.find({
				timestamp: { $gte: startTimestamp, $lte: endTimestamp },
			})
			.sort({ userId: 1, timestamp: 1 })
			.toArray()

		// Группируем локации по пользователям
		const userLocations = {}
		locations.forEach(location => {
			if (!userLocations[location.userId]) {
				userLocations[location.userId] = {
					userId: location.userId,
					username: location.username,
					avatarUrl: location.avatarUrl,
					locations: [],
				}
			}
			userLocations[location.userId].locations.push(location)
		})

		// Рассчитываем дистанцию для каждого пользователя
		const usersWithDistance = Object.values(userLocations).map(user => {
			const distance = locationService.calculateDistance(user.locations)
			return {
				...user,
				totalDistance: distance,
			}
		})

		// Сортируем по дистанции
		const topUsers = usersWithDistance
			.sort((a, b) => b.totalDistance - a.totalDistance)
			.slice(0, limit)

		this.cache[period] = {
			data: topUsers,
			timestamp: now,
		}

		return topUsers
	}

	formatStatsResponse(stats, period) {
		if (!stats) return 'Недостаточно данных для расчета статистики.'

		const periodText = period === 'week' ? 'неделю' : 'месяц'
		const distanceKm = (stats.totalDistance / 1000).toFixed(2)

		return (
			`📊 Статистика за ${periodText}:\n\n` + `Пройдено: ${distanceKm} км`
		)
	}

	formatTopUsersResponse(topUsers, period) {
		const { startTimestamp, endTimestamp } =
			this.getTimestampRangeForPeriod(period)
		const startDate = new Date(startTimestamp * 1000)
		const endDate = new Date(endTimestamp * 1000)

		const formatDate = date => {
			return date.toLocaleDateString('ru-RU', {
				day: '2-digit',
				month: '2-digit',
				year: 'numeric',
			})
		}

		const periodText = period === 'week' ? 'неделю' : 'месяц'
		let response = `🏆 Топ пользователей за ${periodText} (${formatDate(
			startDate
		)} - ${formatDate(endDate)}):\n\n`

		topUsers.forEach((user, index) => {
			const distanceKm = user.totalDistance
				? (user.totalDistance / 1000).toFixed(2)
				: '0.00'
			const medal =
				index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅'
			response += `${medal} ${user.username} ${distanceKm} км\n`
		})

		return response
	}
}

module.exports = new StatsService()
