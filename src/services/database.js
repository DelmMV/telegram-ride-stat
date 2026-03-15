const { MongoClient } = require('mongodb')
const config = require('../config/constants')

class DatabaseService {
	constructor() {
		this.client = null
		this.db = null
		this.isConnecting = false
		this.connectionPromise = null
	}

	async connect() {
		// Если уже идет подключение, возвращаем существующий промис
		if (this.isConnecting) {
			return this.connectionPromise
		}

		// Если уже подключены, возвращаем существующее подключение
		if (this.client && this.db) {
			return { client: this.client, db: this.db }
		}

		this.isConnecting = true
		this.connectionPromise = this._connect()

		try {
			const result = await this.connectionPromise
			this.isConnecting = false
			return result
		} catch (error) {
			this.isConnecting = false
			throw error
		}
	}

	async _connect() {
		try {
			console.log('Connecting to MongoDB...')
			this.client = new MongoClient(config.database.url)
			await this.client.connect()
			this.db = this.client.db(config.database.name)
			console.log('Connected to MongoDB successfully')
			await this.createIndexes()
			return { client: this.client, db: this.db }
		} catch (error) {
			console.error('MongoDB connection error:', error)
			this.client = null
			this.db = null
			throw error
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
			const cleanupCollection = this.db.collection('cleanup_state')
			await cleanupCollection.createIndex({ kind: 1, status: 1, expiresAt: 1 })
			await cleanupCollection.createIndex({ userId: 1, kind: 1 })
			await cleanupCollection.createIndex({ updatedAt: 1 })
			console.log('Indexes created successfully')
		} catch (error) {
			console.error('Error creating indexes:', error)
			throw error
		}
	}

	async upsertCleanupState(state) {
		try {
			const collection = this.db.collection('cleanup_state')
			await collection.updateOne(
				{ _id: state._id },
				{ $set: state },
				{ upsert: true }
			)
		} catch (error) {
			console.error('Error upserting cleanup state:', error)
			throw error
		}
	}

	async deleteCleanupState(stateId) {
		try {
			const collection = this.db.collection('cleanup_state')
			await collection.deleteOne({ _id: stateId })
		} catch (error) {
			console.error('Error deleting cleanup state:', error)
			throw error
		}
	}

	async getCleanupStates() {
		try {
			const collection = this.db.collection('cleanup_state')
			return await collection.find({}).toArray()
		} catch (error) {
			console.error('Error getting cleanup states:', error)
			throw error
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

	async getLocationsInTimeRange(
		userId,
		startTimestamp,
		endTimestamp,
		{ projection = null, maxTimeMS = 0 } = {}
	) {
		try {
			const collection = this.db.collection('locations')
			let cursor = collection
				.find(
					{
						userId,
						timestamp: { $gte: startTimestamp, $lte: endTimestamp },
					},
					projection ? { projection } : undefined
				)
				.sort({ timestamp: 1 })
			if (maxTimeMS > 0) {
				cursor = cursor.maxTimeMS(maxTimeMS)
			}
			const locations = await cursor.toArray()
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
			this.client = null
			this.db = null
			console.log('MongoDB connection closed')
		}
	}
}

module.exports = new DatabaseService()
