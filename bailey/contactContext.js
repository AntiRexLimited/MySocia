// In-memory store: { [jid]: { summary, buffer: [{sender, type, content, timestamp}], bufferStart, lastReadTimestamp } }
const contactStore = {}

const MAX_BUFFER_MESSAGES = 50
const MAX_BUFFER_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const ONE_HOUR_MS = 60 * 60 * 1000

function ensureContact(jid) {
  if (!contactStore[jid]) {
    contactStore[jid] = {
      summary: '',
      buffer: [],
      bufferStart: Date.now(),
      lastReadTimestamp: 0
    }
  }
  return contactStore[jid]
}

// Call every time a message (in or out, text or voice) happens with a contact
function addMessage(jid, sender, type, content) {
  const contact = ensureContact(jid)
  contact.buffer.push({ sender, type, content, timestamp: Date.now() })

  const bufferTooOld = Date.now() - contact.bufferStart > MAX_BUFFER_AGE_MS
  const bufferTooBig = contact.buffer.length > MAX_BUFFER_MESSAGES

  if (bufferTooOld || bufferTooBig) {
    return { needsSummarization: true, jid, buffer: contact.buffer }
  }
  return { needsSummarization: false }
}

// Called once teammate's LLM returns a summary for a buffer
function saveSummary(jid, newSummary) {
  const contact = ensureContact(jid)
  contact.summary = newSummary
  contact.buffer = []
  contact.bufferStart = Date.now()
}

// Used when addressing a contact fresh (send flow) — summary if it exists, else capped raw buffer
function getContextForContact(jid) {
  const contact = ensureContact(jid)

  if (contact.summary) {
    return { type: 'summary', data: contact.summary }
  }

  const oneDayAgo = Date.now() - MAX_BUFFER_AGE_MS
  let recent = contact.buffer.filter(m => m.timestamp >= oneDayAgo)
  if (recent.length > MAX_BUFFER_MESSAGES) recent = recent.slice(-MAX_BUFFER_MESSAGES)

  return { type: 'raw', data: recent }
}

// Used for explicit "read me X's messages" commands with a filter
function getFilteredMessages(jid, filter) {
  const contact = ensureContact(jid)

  switch (filter?.type) {
    case 'lastHour': {
      const cutoff = Date.now() - ONE_HOUR_MS
      return { type: 'raw', data: contact.buffer.filter(m => m.timestamp >= cutoff) }
    }
    case 'lastN': {
      const n = filter.count || 5
      return { type: 'raw', data: contact.buffer.slice(-n) }
    }
    case 'unread': {
      const unread = contact.buffer.filter(m => m.timestamp > contact.lastReadTimestamp)
      contact.lastReadTimestamp = Date.now()
      return { type: 'raw', data: unread }
    }
    default: {
      // No specifics given — same fallback logic as fresh-address context
      return getContextForContact(jid)
    }
  }
}

module.exports = { addMessage, saveSummary, getContextForContact, getFilteredMessages }