const WebSocket = require('ws');
const { handleSend, handleRead } = require('../whatsapp/whatsappService');

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

const tools = [
  {
    type: 'function',
    name: 'send_whatsapp_message',
    description: 'Sends a WhatsApp text message to a specific contact by their name.',
    parameters: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Name or nickname of the person' },
        message: { type: 'string', description: 'The text message to send' }
      },
      required: ['contact_name', 'message']
    }
  },
  {
    type: 'function',
    name: 'read_whatsapp_messages',
    description: 'Reads recent incoming WhatsApp messages from a specific contact.',
    parameters: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'The name of the contact' },
        count: { type: 'number', description: 'Number of recent messages to fetch' }
      },
      required: ['contact_name']
    }
  }
];

function initializeVoiceAgent(clientWs) {
  let sessionReady = false;
  const aaiWs = new WebSocket('wss://agents.assemblyai.com/v1/ws', {
    headers: { Authorization: `Bearer ${ASSEMBLYAI_API_KEY}` }
  });

  aaiWs.on('open', () => {
    aaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        system_prompt: 'You are an executive personal assistant handling WhatsApp. You MUST listen and respond exclusively in English. Always answer briefly in 1-2 spoken sentences.',
        tools: tools
      }
    }));
  });

  clientWs.on('message', (message, isBinary) => {
    if (isBinary && sessionReady && aaiWs.readyState === WebSocket.OPEN) {
      aaiWs.send(JSON.stringify({
        type: 'input.audio',
        audio: message.toString('base64')
      }));
    }
  });

  aaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString());

    if (event.type === 'session.ready' || event.type === 'session.updated') sessionReady = true;
    if (event.type === 'session.ended') sessionReady = false;
    
    if (event.type !== 'reply.audio') {
      console.log(`📡 AssemblyAI Event: ${event.type}`);
      if (event.type === 'session.error') console.error(event);
    }

    if (
      ['session.ready', 'session.updated', 'session.error', 'session.ended', 'reply.audio', 'reply.done', 'transcript.user.delta', 'transcript.user', 'transcript.agent.delta', 'transcript.agent'].includes(event.type)
    ) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(event));
      }
    } 
    else if (event.type === 'tool.call') {
      const { call_id, name, arguments: rawArgs } = event;
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      
      let toolResult = {};
      if (name === 'send_whatsapp_message') {
        const sendResult = await handleSend(args.contact_name, args.message, 'text');
        toolResult = sendResult.success ? { status: 'success' } : { status: 'error', error: sendResult.error };
      } else if (name === 'read_whatsapp_messages') {
        toolResult = await handleRead(args.contact_name, { type: 'lastN', count: args.count || 5 });
      }

      aaiWs.send(JSON.stringify({
        type: 'tool.result',
        call_id: call_id,
        result: JSON.stringify(toolResult)
      }));
    }
  });

  clientWs.on('close', () => aaiWs.close());
  aaiWs.on('close', () => clientWs.close());
}

module.exports = { initializeVoiceAgent };