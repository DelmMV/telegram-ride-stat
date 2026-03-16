const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env') })
const db = require('./src/services/database')
const telegramService = require('./src/services/telegram')

async function start() {
	try {
		await db.connect()
		telegramService.start()
	} catch (error) {
		console.error('Error starting application:', error)
		// Не завершаем процесс сразу, даем возможность nodemon перезапустить
		setTimeout(() => {
			process.exit(1)
		}, 1000)
	}
}

// Обработка завершения работы
process.on('SIGINT', async () => {
	console.log('Shutting down...')
	await db.close()
	process.exit(0)
})

process.on('SIGTERM', async () => {
	console.log('Shutting down...')
	await db.close()
	process.exit(0)
})

start()
