const CLEANUP_KIND = {
	LIVE: 'live',
	WARNING: 'warning',
}

const CLEANUP_STATUS = {
	PENDING: 'pending',
	CLEANING: 'cleaning',
	FAILED: 'failed',
}

function createStateId(kind, chatId, messageId) {
	return `${kind}:${chatId}:${messageId}`
}

function uniqMessageIds(messageIds) {
	const seen = new Set()
	const result = []
	for (const id of messageIds || []) {
		if (typeof id !== 'number') continue
		if (seen.has(id)) continue
		seen.add(id)
		result.push(id)
	}
	return result
}

function createCleanupEntry({
	kind,
	chatId,
	threadId = null,
	userId,
	messageId,
	messagesToDelete = [],
	expiresAt = null,
	reason = null,
	lastUpdate = Date.now(),
	locationTimestamp = null,
	username = null,
	attempts = 0,
	status = CLEANUP_STATUS.PENDING,
	lastError = null,
}) {
	return {
		id: createStateId(kind, chatId, messageId),
		kind,
		chatId,
		threadId,
		userId,
		username,
		messageId,
		messagesToDelete: uniqMessageIds(messagesToDelete),
		expiresAt,
		reason,
		lastUpdate,
		locationTimestamp,
		attempts,
		status,
		lastError,
	}
}

function isDueForCleanup(entry, now = Date.now()) {
	if (!entry || entry.status === CLEANUP_STATUS.CLEANING) {
		return false
	}
	if (entry.status === CLEANUP_STATUS.FAILED && entry.expiresAt == null) {
		return false
	}
	if (entry.expiresAt == null) {
		return false
	}
	return now >= entry.expiresAt
}

function computeRetryExpiresAt(attempt, backoffMs, now = Date.now()) {
	const safeAttempt = Math.max(1, attempt)
	return now + backoffMs * safeAttempt
}

function toPersistenceDoc(entry) {
	return {
		_id: entry.id,
		kind: entry.kind,
		chatId: entry.chatId,
		threadId: entry.threadId,
		userId: entry.userId,
		username: entry.username,
		messageId: entry.messageId,
		messagesToDelete: uniqMessageIds(entry.messagesToDelete),
		expiresAt: entry.expiresAt,
		reason: entry.reason,
		lastUpdate: entry.lastUpdate,
		locationTimestamp: entry.locationTimestamp,
		attempts: entry.attempts,
		status: entry.status,
		lastError: entry.lastError,
		updatedAt: Date.now(),
	}
}

function fromPersistenceDoc(doc) {
	if (!doc) return null
	return createCleanupEntry({
		kind: doc.kind,
		chatId: doc.chatId,
		threadId: doc.threadId,
		userId: doc.userId,
		username: doc.username,
		messageId: doc.messageId,
		messagesToDelete: doc.messagesToDelete,
		expiresAt: doc.expiresAt,
		reason: doc.reason,
		lastUpdate: doc.lastUpdate,
		locationTimestamp: doc.locationTimestamp,
		attempts: doc.attempts,
		status: doc.status,
		lastError: doc.lastError,
	})
}

module.exports = {
	CLEANUP_KIND,
	CLEANUP_STATUS,
	createStateId,
	uniqMessageIds,
	createCleanupEntry,
	isDueForCleanup,
	computeRetryExpiresAt,
	toPersistenceDoc,
	fromPersistenceDoc,
}
