const { MongoClient } = require('mongodb')
const config = require('../config/constants')

class DatabaseService {
	constructor() {
		this.client = null
		this.db = null
	}

	async connect() {
		try {
			console.log('Connecting to MongoDB...')
			this.client = new MongoClient(config.database.url)
			await this.client.connect()
			this.db = this.client.db(config.database.name)
			console.log('Connected to MongoDB successfully')
			await this.createIndexes()
		} catch (error) {
			console.error('MongoDB connection error:', error)
			process.exit(1)
		}
	}

	async createIndexes() {
		try {
			console.log('Creating indexes...')
			const collection = this.db.collection('locations')
			await collection.createIndex({ userId: 1 })
			await collection.createIndex({ timestamp: 1 })
			await collection.createIndex({ userId: 1, timestamp: 1 })
			await collection.createIndex({ sessionId: 1 })
			console.log('Indexes created successfully')
		} catch (error) {
			console.error('Error creating indexes:', error)
		}
	}

	async insertLocation(entry) {
		try {
			console.log('Inserting location into database:', {
				userId: entry.userId,
				timestamp: entry.timestamp,
				sessionId: entry.sessionId,
			})
			const collection = this.db.collection('locations')
			const result = await collection.insertOne(entry)
			console.log('Location inserted successfully:', result.insertedId)
			return result
		} catch (error) {
			console.error('Error inserting location:', error)
			throw error
		}
	}

	async getLastLocation(userId) {
		try {
			console.log('Getting last location for user:', userId)
			const collection = this.db.collection('locations')
			const result = await collection
				.find({ userId })
				.sort({ timestamp: -1 })
				.limit(1)
				.toArray()
			console.log('Last location found:', result[0] ? 'yes' : 'no')
			return result
		} catch (error) {
			console.error('Error getting last location:', error)
			throw error
		}
	}

	async getLocationsInTimeRange(userId, startTimestamp, endTimestamp) {
		try {
			const collection = this.db.collection('locations')
			const locations = await collection
				.find({
					userId,
					timestamp: { $gte: startTimestamp, $lte: endTimestamp },
				})
				.sort({ timestamp: 1 })
				.toArray()
			return locations
		} catch (error) {
			console.error('Error getting locations in time range:', error)
			throw error
		}
	}

	async close() {
		if (this.client) {
			console.log('Closing MongoDB connection...')
			await this.client.close()
			console.log('MongoDB connection closed')
		}
	}
}

module.exports = new DatabaseService()
