const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { wrapSocket } = require('baileys-antiban');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { setActiveContact, getActiveContact, touchActiveContact } = require('./activeContact');
const { addMessage, saveSummary, getContextForContact, getFilteredMessages } = require('./contactContext');

const waEvents = new EventEmitter();
let currentWaStatus = { status: 'initializing' };
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');

function loadContactMap() {
  if (fs.existsSync(CONTACTS_FILE)) {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
  }
  return {};
}

function saveContactMap(map) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(map, null, 2));
}

function addContactName(jid, name) {
  if (!name) return;
  if (!contactMap[jid]) {
    contactMap[jid] = { id: jid, names: [] };
  }
  const lower = name.toLowerCase();
  if (!contactMap[jid].names.includes(lower)) {
    contactMap[jid].names.push(lower);
  }
  saveContactMap(contactMap);
}

let sock;
const contactMap = loadContactMap();

function extractText(msg) {
  return msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
}

function isVoiceMessage(msg) {
  return !!msg.message?.audioMessage;
}

async function start() {
  const authPath = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const pino = require('pino');

  const rawSock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock = wrapSocket(rawSock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr);
      currentWaStatus = { status: 'qr', qrImage: qrDataUrl }; // Update state
      waEvents.emit('status', currentWaStatus);
    }

    if (connection === 'open') {
      currentWaStatus = { status: 'connected' }; // Update state
      waEvents.emit('status', currentWaStatus);
      console.log('✅ Connected successfully!');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      waEvents.emit('status', { status: 'disconnected', reconnecting: shouldReconnect });
      console.log('Connection closed. Reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        start();
      } else {
        console.log('Logged out — please delete auth_info and re-scan.');
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    const msg = m.messages[0];
    if (!msg || !msg.message) return;

    const remoteJid = msg.key.remoteJid;

    if (
      remoteJid.endsWith('@broadcast') ||
      remoteJid.endsWith('@newsletter') ||
      remoteJid.endsWith('@g.us')
    ) {
      return;
    }

    const messageTimestamp = (msg.messageTimestamp?.low || msg.messageTimestamp || 0) * 1000;
    if (messageTimestamp && Date.now() - messageTimestamp > 30000) {
      return;
    }

    const sender = msg.key.fromMe ? 'me' : remoteJid;
    const direction = msg.key.fromMe ? '📤 OUTGOING' : '📥 INCOMING';

    if (!msg.key.fromMe && msg.pushName) {
      addContactName(remoteJid, msg.pushName);
      console.log(`📇 Saved Contact: "${msg.pushName}"`);
    }

    const text = extractText(msg);
    if (text) {
      console.log(`${direction} text (${sender}): "${text}"`);
      if (!msg.key.fromMe) {
        touchActiveContact();
        const result = addMessage(sender, sender, 'text', text);
        if (result.needsSummarization) requestSummary(result.jid, result.buffer);
        handOffToLLM({ type: 'text', sender, content: text });
      }
      return;
    }

    if (isVoiceMessage(msg) && !msg.key.fromMe) {
      console.log(`${direction} voice note (${sender})`);
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      touchActiveContact();
      const result = addMessage(sender, sender, 'voice', buffer);
      if (result.needsSummarization) requestSummary(result.jid, result.buffer);
      handOffToLLM({ type: 'voice', sender, content: buffer });
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.name) addContactName(contact.id, contact.name);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const contact of updates) {
      if (contact.name) addContactName(contact.id, contact.name);
    }
  });
}

function handOffToLLM({ type, sender, content }) {
  console.log(`➡️ Handing off ${type} message from ${sender} to LLM`);
}

function requestSummary(jid, buffer) {
  console.log(`📝 Buffer for ${jid} hit limit — requesting LLM summary`);
}

async function resolveContact(name) {
  const searchTerm = name.toLowerCase();
  const match = Object.values(contactMap).find(c =>
    c.names.some(n => n.includes(searchTerm))
  );
  return match?.id || null;
}

async function sendTextMessage(contactJid, contactName, text) {
  await sock.sendMessage(contactJid, { text }, {});
  setActiveContact(contactName, contactJid, 'text');
  console.log(`✅ Sent text to ${contactName}: "${text}"`);
}

async function sendVoiceMessage(contactJid, contactName, audioBufferOrPath) {
  const buffer = Buffer.isBuffer(audioBufferOrPath)
    ? audioBufferOrPath
    : fs.readFileSync(audioBufferOrPath);

  await sock.sendMessage(contactJid, {
    audio: buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true
  }, {});
  setActiveContact(contactName, contactJid, 'voice');
  console.log(`✅ Sent voice note to ${contactName}`);
}

async function handleSend(personName, message, type) {
  const jid = await resolveContact(personName);
  if (!jid) {
    console.log(`❌ Could not find contact matching "${personName}"`);
    return { success: false, error: 'contact_not_found' };
  }

  const current = getActiveContact();
  const isSameOngoing = current && current.jid === jid;
  let context = null;
  
  if (!isSameOngoing) {
    context = getContextForContact(jid);
    console.log(`🧭 Fresh address to ${personName} — context type: ${context.type}`);
  }

  if (type === 'text') {
    await sendTextMessage(jid, personName, message);
  } else {
    await sendVoiceMessage(jid, personName, message);
  }

  addMessage(jid, 'me', type, message);
  return { success: true, contextUsed: context };
}

async function handleRead(personName, filter) {
  const jid = await resolveContact(personName);
  if (!jid) {
    return { success: false, error: 'contact_not_found' };
  }
  const result = getFilteredMessages(jid, filter);
  return { success: true, ...result };
}

start();

module.exports = { start, handleSend, handleRead, getActiveContact, waEvents, getCurrentStatus: () => currentWaStatus };