const haversine = require('haversine-distance')
const config = require('../config/constants')
const db = require('./database')

class LocationService {
	async processLocation(
		userId,
		username,
		timestamp,
		latitude,
		longitude,
		avatarUrl
	) {
		const entry = {
			userId,
			username,
			timestamp,
			latitude,
			longitude,
			sessionId: null,
			avatarUrl,
		}

		const collection = db.db.collection('locations')
		const lastLocation = await collection
			.find({ userId })
			.sort({ timestamp: -1 })
			.limit(1)
			.toArray()

		if (lastLocation.length > 0) {
			const lastEntry = lastLocation[0]
			const distance = haversine(
				{ lat: lastEntry.latitude, lon: lastEntry.longitude },
				{ lat: entry.latitude, lon: entry.longitude }
			)

			const timeDiff = timestamp - lastEntry.timestamp

			if (
				timeDiff > config.thresholds.maxTime ||
				distance > config.thresholds.maxDistance
			) {
				entry.sessionId = lastEntry.sessionId + 1
			} else {
				entry.sessionId = lastEntry.sessionId
			}
		} else {
			entry.sessionId = 1
		}

		try {
			await collection.insertOne(entry)
		} catch (error) {
			console.error('Error saving location:', error)
			throw error
		}
	}

	calculateDistance(locations) {
		if (locations.length < 2) return 0

		let totalDistance = 0
		let lastSessionId = locations[0].sessionId

		for (let i = 1; i < locations.length; i++) {
			const prev = locations[i - 1]
			const curr = locations[i]

			// Пропускаем переходы между сессиями
			if (curr.sessionId !== lastSessionId) {
				lastSessionId = curr.sessionId
				continue
			}

			// Проверяем, что расстояние не превышает максимальный порог
			const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
			)

			if (dist <= config.thresholds.maxDistance) {
				totalDistance += dist
			}
		}

		return totalDistance // Возвращаем дистанцию в метрах
	}

	async getRoute(userId, startTimestamp, endTimestamp) {
		try {
			const locations = await db.getLocationsInTimeRange(
				userId,
				startTimestamp,
				endTimestamp
			)
			return locations
		} catch (error) {
			console.error('Error getting route:', error)
			throw error
		}
	}
}

module.exports = new LocationService()
