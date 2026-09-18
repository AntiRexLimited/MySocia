const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys')
const { wrapSocket } = require('baileys-antiban')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')

const { setActiveContact, getActiveContact, touchActiveContact } = require('./activeContact')
const { addMessage, saveSummary, getContextForContact, getFilteredMessages } = require('./contactContext')

const CONTACTS_FILE = path.join(__dirname, 'contacts.json')

function loadContactMap() {
  if (fs.existsSync(CONTACTS_FILE)) {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'))
  }
  return {}
}

function saveContactMap(map) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(map, null, 2))
}

function addContactName(jid, name) {
  if (!name) return
  if (!contactMap[jid]) {
    contactMap[jid] = { id: jid, names: [] }
  }
  const lower = name.toLowerCase()
  if (!contactMap[jid].names.includes(lower)) {
    contactMap[jid].names.push(lower)
  }
  saveContactMap(contactMap)
}

let sock
const contactMap = loadContactMap()

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null
  )
}

function isVoiceMessage(msg) {
  return !!msg.message?.audioMessage
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const rawSock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  sock = wrapSocket(rawSock)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('Scan this QR code with WhatsApp (Linked Devices)')
    }

if (connection === 'open') {
  console.log('✅ Connected successfully!')
}

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('Connection closed. Reconnecting:', shouldReconnect)

      if (shouldReconnect) {
        start()
      } else {
        console.log('Logged out — please delete auth_info and re-scan.')
      }
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message) return

    const sender = msg.key.fromMe ? 'me' : msg.key.remoteJid
    const direction = msg.key.fromMe ? '📤 OUTGOING' : '📥 INCOMING'

    if (!msg.key.fromMe && msg.pushName) {
      addContactName(msg.key.remoteJid, msg.pushName)
      console.log(`📇 Captured contact: "${msg.pushName}" → ${msg.key.remoteJid}`)
    }

    const text = extractText(msg)
    if (text) {
      console.log(`${direction} text (${sender}): "${text}"`)

      if (!msg.key.fromMe) {
        touchActiveContact()
        const result = addMessage(sender, sender, 'text', text)
        if (result.needsSummarization) requestSummary(result.jid, result.buffer)
        handOffToLLM({ type: 'text', sender, content: text })
      }
      return
    }

    if (isVoiceMessage(msg) && !msg.key.fromMe) {
      console.log(`${direction} voice note (${sender}) — passing to LLM pipeline`)

      const buffer = await downloadMediaMessage(msg, 'buffer', {})
      touchActiveContact()
      const result = addMessage(sender, sender, 'voice', buffer)
      if (result.needsSummarization) requestSummary(result.jid, result.buffer)
      handOffToLLM({ type: 'voice', sender, content: buffer })
    }
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.name) addContactName(contact.id, contact.name)
    }
    console.log(`📇 Contact map updated — ${Object.keys(contactMap).length} known`)
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const contact of updates) {
      if (contact.name) addContactName(contact.id, contact.name)
    }
  })
}

function handOffToLLM({ type, sender, content }) {
  console.log(`➡️ Handing off ${type} message from ${sender} to LLM`)
}

function requestSummary(jid, buffer) {
  console.log(`📝 Buffer for ${jid} hit limit — requesting LLM summary of ${buffer.length} messages`)
}

async function resolveContact(name) {
  const searchTerm = name.toLowerCase()
  const match = Object.values(contactMap).find(c =>
    c.names.some(n => n.includes(searchTerm))
  )
  return match?.id || null
}

async function sendTextMessage(contactJid, contactName, text) {
  await sock.sendMessage(contactJid, { text }, {})
  setActiveContact(contactName, contactJid, 'text')
  console.log(`✅ Sent text to ${contactName}: "${text}"`)
}

async function sendVoiceMessage(contactJid, contactName, audioBufferOrPath) {
  const buffer = Buffer.isBuffer(audioBufferOrPath)
    ? audioBufferOrPath
    : fs.readFileSync(audioBufferOrPath)

  await sock.sendMessage(contactJid, {
    audio: buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true
  }, {})
  setActiveContact(contactName, contactJid, 'voice')
  console.log(`✅ Sent voice note to ${contactName}`)
}

async function handleSend(personName, message, type) {
  const jid = await resolveContact(personName)
  if (!jid) {
    console.log(`❌ Could not find contact matching "${personName}"`)
    return { success: false, error: 'contact_not_found' }
  }

  const current = getActiveContact()
  const isSameOngoing = current && current.jid === jid

  let context = null
  if (!isSameOngoing) {
    context = getContextForContact(jid)
    console.log(`🧭 Fresh address to ${personName} — context type: ${context.type}`)
  } else {
    console.log(`↩️ Continuing conversation with ${personName} — no context refetch`)
  }

  if (type === 'text') {
    await sendTextMessage(jid, personName, message)
  } else {
    await sendVoiceMessage(jid, personName, message)
  }

  addMessage(jid, 'me', type, message)

  return { success: true, contextUsed: context }
}

async function handleRead(personName, filter) {
  const jid = await resolveContact(personName)
  if (!jid) {
    console.log(`❌ Could not find contact matching "${personName}"`)
    return { success: false, error: 'contact_not_found' }
  }

  const result = getFilteredMessages(jid, filter)
  return { success: true, ...result }
}

start()


// ---- Interactive tester (for YOUR testing only, not the real parser) ----
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log('\n🧪 Test mode: type "send <Name> <message>" or "read <Name>"\n')

rl.on('line', async (input) => {
  const parts = input.trim().split(' ')
  const command = parts[0]

  if (command === 'send') {
    const name = parts[1]
    const message = parts.slice(2).join(' ')
    const result = await handleSend(name, message, 'text')
    console.log(result)
  } else if (command === 'read') {
    const name = parts[1]
    const result = await handleRead(name)
    console.log(result)
  } else {
    console.log('Unknown command. Try: send Rajfa hello there')
  }
})

module.exports = { handleSend, handleRead, getActiveContact }