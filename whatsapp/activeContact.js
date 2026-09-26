let activeContact = null  // { name, jid, msgType, lastActivity }

const ACTIVE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

function setActiveContact(name, jid, msgType) {
  activeContact = { name, jid, msgType, lastActivity: Date.now() }
}

function getActiveContact() {
  if (!activeContact) return null

  const expired = Date.now() - activeContact.lastActivity > ACTIVE_TIMEOUT_MS
  if (expired) {
    activeContact = null
    return null
  }

  return activeContact
}

function touchActiveContact() {
  if (activeContact) activeContact.lastActivity = Date.now()
}

module.exports = { setActiveContact, getActiveContact, touchActiveContact }