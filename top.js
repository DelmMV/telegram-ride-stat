require('dotenv').config()
const db = require('./src/services/database')
const telegramService = require('./src/services/telegram')

async function start() {
	try {
		await db.connect()
		telegramService.start()
	} catch (error) {
		console.error('Error starting application:', error)
		process.exit(1)
	}
}

start()
