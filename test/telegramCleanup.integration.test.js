const test = require('node:test')
const assert = require('node:assert/strict')

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST_TOKEN'

const config = require('../src/config/constants')
const db = require('../src/services/database')
const telegramService = require('../src/services/telegram')
const {
	CLEANUP_KIND,
	CLEANUP_STATUS,
	createCleanupEntry,
	toPersistenceDoc,
} = require('../src/services/cleanupState')

const originalCleanupConfig = { ...config.cleanup }
const originalDeleteMessage = telegramService.bot.telegram.deleteMessage
const originalDb = {
	upsertCleanupState: db.upsertCleanupState,
	deleteCleanupState: db.deleteCleanupState,
	getCleanupStates: db.getCleanupStates,
}

function resetState() {
	telegramService.activeLiveByMessageId.clear()
	telegramService.activeLiveByUserId.clear()
	telegramService.pendingWarningByMessageId.clear()
	telegramService.isCleanupSweepRunning = false
}

function setDeleteMessageMock(fn) {
	telegramService.bot.telegram.deleteMessage = fn
}

function setDbMocks({ upsert, del, get }) {
	db.upsertCleanupState = upsert
	db.deleteCleanupState = del
	db.getCleanupStates = get
}

test.beforeEach(() => {
	resetState()
	Object.assign(config.cleanup, originalCleanupConfig)
	config.cleanup.persistState = false

	setDeleteMessageMock(async () => undefined)
	setDbMocks({
		upsert: async () => undefined,
		del: async () => undefined,
		get: async () => [],
	})
})

test.after(() => {
	Object.assign(config.cleanup, originalCleanupConfig)
	telegramService.bot.telegram.deleteMessage = originalDeleteMessage
	db.upsertCleanupState = originalDb.upsertCleanupState
	db.deleteCleanupState = originalDb.deleteCleanupState
	db.getCleanupStates = originalDb.getCleanupStates
})

test('warning cleanup succeeds when deadline is due', async () => {
	await telegramService.registerWarningDeletion({
		chatId: -100,
		threadId: 1,
		userId: 10,
		messageId: 500,
		messagesToDelete: [500, 501],
		reason: 'no_active_live_text',
		delayMs: 0,
	})

	assert.equal(telegramService.pendingWarningByMessageId.size, 1)

	await telegramService.runCleanupSweep()

	assert.equal(telegramService.pendingWarningByMessageId.size, 0)
})

test('retryable delete error keeps entry and schedules backoff retry', async () => {
	setDeleteMessageMock(async () => {
		const error = new Error('network timeout')
		error.code = 'ETIMEDOUT'
		throw error
	})

	await telegramService.registerWarningDeletion({
		chatId: -100,
		threadId: 1,
		userId: 11,
		messageId: 600,
		messagesToDelete: [600, 601],
		reason: 'non_live_geo',
		delayMs: 0,
	})

	await telegramService.runCleanupSweep()

	const entry = telegramService.pendingWarningByMessageId.get(600)
	assert.ok(entry)
	assert.equal(entry.status, CLEANUP_STATUS.FAILED)
	assert.equal(entry.attempts, 1)
	assert.ok(typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now())

	setDeleteMessageMock(async () => undefined)
	entry.expiresAt = Date.now() - 1

	await telegramService.runCleanupSweep()
	assert.equal(telegramService.pendingWarningByMessageId.size, 0)
})

test('inactive live entry is marked and cleaned with related messages', async () => {
	const deleted = []
	setDeleteMessageMock(async (chatId, messageId) => {
		deleted.push({ chatId, messageId })
	})

	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 99,
		messageId: 700,
		userId: 12,
		username: '@rider',
		locationTimestamp: Date.now() - 10_000,
		latitude: 10,
		longitude: 20,
	})

	await telegramService.appendMessageToLiveEntry(700, {
		messageId: 701,
		timestamp: Date.now(),
		userId: 12,
	})

	const entry = telegramService.activeLiveByMessageId.get(700)
	entry.lastUpdate = Date.now() - config.cleanup.inactiveLiveMs - 100

	await telegramService.runCleanupSweep()

	assert.equal(telegramService.activeLiveByMessageId.size, 0)
	assert.equal(telegramService.activeLiveByUserId.size, 0)
	assert.deepEqual(
		deleted.map(item => item.messageId).sort((a, b) => a - b),
		[700, 701]
	)
})

test('non-retryable failure reaches max attempts and removes pending entry', async () => {
	config.cleanup.deleteRetryMaxAttempts = 1
	setDeleteMessageMock(async () => {
		const error = new Error('bad request')
		error.response = { error_code: 400, description: 'Bad Request: chat not found' }
		throw error
	})

	await telegramService.registerWarningDeletion({
		chatId: -100,
		threadId: 1,
		userId: 13,
		messageId: 800,
		messagesToDelete: [800, 801],
		reason: 'no_active_live_text',
		delayMs: 0,
	})

	await telegramService.runCleanupSweep()
	assert.equal(telegramService.pendingWarningByMessageId.size, 0)
})

test('restore cleanup state repopulates live and warning registries', async () => {
	config.cleanup.persistState = true

	const liveDoc = toPersistenceDoc(
		createCleanupEntry({
			kind: CLEANUP_KIND.LIVE,
			chatId: -100,
			threadId: 11,
			userId: 21,
			username: '@restore',
			messageId: 900,
			messagesToDelete: [910],
			expiresAt: Date.now() + 1000,
			reason: 'inactive_live',
			locationTimestamp: Date.now() - 2000,
			lastUpdate: Date.now() - 500,
		})
	)

	const warningDoc = toPersistenceDoc(
		createCleanupEntry({
			kind: CLEANUP_KIND.WARNING,
			chatId: -100,
			threadId: 11,
			userId: 22,
			messageId: 901,
			messagesToDelete: [901, 911],
			expiresAt: Date.now() + 1000,
			reason: 'non_live_geo',
		})
	)

	setDbMocks({
		upsert: async () => undefined,
		del: async () => undefined,
		get: async () => [liveDoc, warningDoc],
	})

	await telegramService.restoreCleanupStateOnStart()

	assert.equal(telegramService.activeLiveByMessageId.size, 1)
	assert.equal(telegramService.pendingWarningByMessageId.size, 1)
	assert.equal(telegramService.activeLiveByUserId.get(21), 900)
})

test('e2e flow: location -> edited_message -> inactive cleanup deletes in descending order', async () => {
	const deleted = []
	setDeleteMessageMock(async (chatId, messageId) => {
		deleted.push({ chatId, messageId })
	})

	const initialTimestamp = Date.now() - 30_000
	const editedTimestamp = Date.now() - 10_000

	// location
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 33,
		messageId: 1000,
		userId: 31,
		username: '@e2e',
		locationTimestamp: initialTimestamp,
		latitude: 59.93,
		longitude: 30.31,
	})

	// user message in live session
	await telegramService.appendMessageToLiveEntry(1000, {
		messageId: 1001,
		timestamp: Date.now() - 20_000,
		userId: 31,
	})

	// edited_message (same live message id)
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 33,
		messageId: 1000,
		userId: 31,
		username: '@e2e',
		locationTimestamp: editedTimestamp,
		latitude: 59.94,
		longitude: 30.32,
	})

	const entryAfterEdit = telegramService.activeLiveByMessageId.get(1000)
	assert.ok(entryAfterEdit)
	assert.equal(entryAfterEdit.locationTimestamp, editedTimestamp)
	assert.deepEqual(entryAfterEdit.messagesToDelete, [1001])

	// inactivity timeout
	entryAfterEdit.lastUpdate = Date.now() - config.cleanup.inactiveLiveMs - 100
	await telegramService.runCleanupSweep()

	assert.equal(telegramService.activeLiveByMessageId.size, 0)
	assert.equal(telegramService.activeLiveByUserId.size, 0)
	assert.deepEqual(
		deleted.map(item => item.messageId),
		[1001, 1000]
	)
})

test('race: replacing live location does not delete new message', async () => {
	const deleted = []
	setDeleteMessageMock(async (chatId, messageId) => {
		deleted.push({ chatId, messageId })
	})

	// old live location
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 44,
		messageId: 1100,
		userId: 41,
		username: '@race',
		locationTimestamp: Date.now() - 20_000,
		latitude: 59.95,
		longitude: 30.33,
	})
	await telegramService.appendMessageToLiveEntry(1100, {
		messageId: 1101,
		timestamp: Date.now() - 19_000,
		userId: 41,
	})

	// new live location from same user arrives before scheduled inactivity cleanup
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 44,
		messageId: 1200,
		userId: 41,
		username: '@race',
		locationTimestamp: Date.now() - 5_000,
		latitude: 59.96,
		longitude: 30.34,
	})

	assert.equal(telegramService.activeLiveByUserId.get(41), 1200)
	assert.ok(telegramService.activeLiveByMessageId.has(1200))
	assert.equal(telegramService.activeLiveByMessageId.has(1100), false)

	assert.deepEqual(
		deleted.map(item => item.messageId).sort((a, b) => a - b),
		[1100, 1101]
	)
	assert.equal(deleted.some(item => item.messageId === 1200), false)

	// Sweep should not remove the fresh live entry.
	await telegramService.runCleanupSweep()
	assert.ok(telegramService.activeLiveByMessageId.has(1200))
	assert.equal(deleted.some(item => item.messageId === 1200), false)
})

test('race retry: replaced_live cleanup retries old entry and keeps new entry intact', async () => {
	const deleted = []
	let shouldFailOldDelete = true
	setDeleteMessageMock(async (chatId, messageId) => {
		if (shouldFailOldDelete && messageId === 1300) {
			const error = new Error('temporary timeout')
			error.code = 'ETIMEDOUT'
			throw error
		}
		deleted.push({ chatId, messageId })
	})

	// old live + related message
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 55,
		messageId: 1300,
		userId: 51,
		username: '@retry',
		locationTimestamp: Date.now() - 30_000,
		latitude: 59.97,
		longitude: 30.35,
	})
	await telegramService.appendMessageToLiveEntry(1300, {
		messageId: 1301,
		timestamp: Date.now() - 29_000,
		userId: 51,
	})

	// new live triggers immediate replaced_live cleanup attempt for old entry
	await telegramService.registerLiveLocation({
		chatId: -100,
		threadId: 55,
		messageId: 1400,
		userId: 51,
		username: '@retry',
		locationTimestamp: Date.now() - 5_000,
		latitude: 59.98,
		longitude: 30.36,
	})

	assert.equal(telegramService.activeLiveByUserId.get(51), 1400)
	assert.ok(telegramService.activeLiveByMessageId.has(1400))

	// old entry should remain pending retry after first failure
	const oldEntry = telegramService.activeLiveByMessageId.get(1300)
	assert.ok(oldEntry)
	assert.equal(oldEntry.reason, 'replaced_live')
	assert.equal(oldEntry.status, CLEANUP_STATUS.FAILED)
	assert.ok(oldEntry.expiresAt > Date.now())

	// retry succeeds on next sweep, new live survives
	shouldFailOldDelete = false
	oldEntry.expiresAt = Date.now() - 1
	await telegramService.runCleanupSweep()

	assert.equal(telegramService.activeLiveByMessageId.has(1300), false)
	assert.ok(telegramService.activeLiveByMessageId.has(1400))
	assert.equal(telegramService.activeLiveByUserId.get(51), 1400)
	const deletedIds = deleted.map(item => item.messageId)
	assert.ok(deletedIds.includes(1300))
	assert.ok(deletedIds.includes(1301))
	assert.equal(deleted.some(item => item.messageId === 1400), false)
})
