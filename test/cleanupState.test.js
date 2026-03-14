const test = require('node:test')
const assert = require('node:assert/strict')

const {
	CLEANUP_KIND,
	CLEANUP_STATUS,
	createCleanupEntry,
	isDueForCleanup,
	computeRetryExpiresAt,
	toPersistenceDoc,
	fromPersistenceDoc,
} = require('../src/services/cleanupState')

test('createCleanupEntry builds deterministic shape and deduplicates message ids', () => {
	const entry = createCleanupEntry({
		kind: CLEANUP_KIND.WARNING,
		chatId: -100,
		userId: 123,
		messageId: 50,
		messagesToDelete: [1, 2, 2, 3, 'bad'],
		reason: 'no_active_live_text',
		expiresAt: 1000,
	})

	assert.equal(entry.id, 'warning:-100:50')
	assert.deepEqual(entry.messagesToDelete, [1, 2, 3])
	assert.equal(entry.status, CLEANUP_STATUS.PENDING)
})

test('isDueForCleanup respects status and expiresAt', () => {
	const now = 10_000
	const pendingDue = createCleanupEntry({
		kind: CLEANUP_KIND.LIVE,
		chatId: -1,
		userId: 1,
		messageId: 10,
		expiresAt: now - 1,
	})
	assert.equal(isDueForCleanup(pendingDue, now), true)

	const cleaning = createCleanupEntry({
		kind: CLEANUP_KIND.LIVE,
		chatId: -1,
		userId: 1,
		messageId: 11,
		expiresAt: now - 1,
		status: CLEANUP_STATUS.CLEANING,
	})
	assert.equal(isDueForCleanup(cleaning, now), false)

	const failedFinal = createCleanupEntry({
		kind: CLEANUP_KIND.LIVE,
		chatId: -1,
		userId: 1,
		messageId: 12,
		status: CLEANUP_STATUS.FAILED,
		expiresAt: null,
	})
	assert.equal(isDueForCleanup(failedFinal, now), false)
})

test('computeRetryExpiresAt grows with attempts', () => {
	const base = 1_000
	assert.equal(computeRetryExpiresAt(1, 2_000, base), 3_000)
	assert.equal(computeRetryExpiresAt(3, 2_000, base), 7_000)
})

test('cleanup state persists and restores round-trip', () => {
	const source = createCleanupEntry({
		kind: CLEANUP_KIND.LIVE,
		chatId: -100,
		threadId: 77,
		userId: 321,
		messageId: 88,
		messagesToDelete: [201, 202],
		expiresAt: 50_000,
		reason: 'inactive_live',
		lastUpdate: 40_000,
		locationTimestamp: 39_000,
		attempts: 2,
		status: CLEANUP_STATUS.FAILED,
		lastError: 'timeout',
	})

	const doc = toPersistenceDoc(source)
	const restored = fromPersistenceDoc(doc)

	assert.equal(restored.id, source.id)
	assert.equal(restored.kind, source.kind)
	assert.equal(restored.chatId, source.chatId)
	assert.equal(restored.threadId, source.threadId)
	assert.equal(restored.userId, source.userId)
	assert.equal(restored.messageId, source.messageId)
	assert.deepEqual(restored.messagesToDelete, source.messagesToDelete)
	assert.equal(restored.expiresAt, source.expiresAt)
	assert.equal(restored.reason, source.reason)
	assert.equal(restored.lastUpdate, source.lastUpdate)
	assert.equal(restored.locationTimestamp, source.locationTimestamp)
	assert.equal(restored.attempts, source.attempts)
	assert.equal(restored.status, source.status)
	assert.equal(restored.lastError, source.lastError)
})
