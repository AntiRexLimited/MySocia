require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const { initializeVoiceAgent } = require('./assembly/assemblyService');
const { waEvents, getCurrentStatus } = require('./whatsapp/whatsappService');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (clientWs) => {
  console.log('💻 Browser UI connected');
  
  initializeVoiceAgent(clientWs);
clientWs.send(JSON.stringify({ type: 'whatsapp.status', data: getCurrentStatus() }));
  const statusListener = (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'whatsapp.status', data }));
    }
  };

  waEvents.on('status', statusListener);

  clientWs.on('close', () => {
    waEvents.removeListener('status', statusListener);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MySocia Server running on http://localhost:${PORT}`);
});