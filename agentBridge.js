const WebSocket = require('ws');
const { handleSend, handleRead } = require('./test'); // Imports directly from test.js

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || 'YOUR_API_KEY_HERE';

// 1. Declare tool schemas for AssemblyAI's LLM engine
const tools = [
  {
    type: "function",
    function: {
      name: "send_whatsapp_message",
      description: "Sends a WhatsApp text message to a contact by their name or nickname.",
      parameters: {
        type: "object",
        properties: {
          recipient_name: {
            type: "string",
            description: "The name of the recipient (e.g., Hamza, Ali, Mom)"
          },
          message_body: {
            type: "string",
            description: "The text content of the message"
          }
        },
        required: ["recipient_name", "message_body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_recent_messages",
      description: "Reads recent incoming messages from a contact to check what they said.",
      parameters: {
        type: "object",
        properties: {
          contact_name: {
            type: "string",
            description: "The name of the contact"
          },
          count: {
            type: "number",
            description: "Number of recent messages to inspect (default is 5)"
          }
        },
        required: ["contact_name"]
      }
    }
  }
];

function initVoiceAgent() {
  const ws = new WebSocket('wss://api.assemblyai.com/v2/voice-agent', {
    headers: {
      Authorization: ASSEMBLYAI_API_KEY
    }
  });

  ws.on('open', () => {
    console.log('✅ Connected to AssemblyAI Voice Agent API');

    // 2. Configure instructions and inject WhatsApp tools
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: "You are a voice assistant that can manage WhatsApp. Use send_whatsapp_message to send messages and read_recent_messages to read chats. Keep voice replies short and clear.",
        tools: tools
      }
    }));
  });

  ws.on('message', async (data) => {
    const event = JSON.parse(data.toString());

    // 3. Intercept tool invocations requested by the Agent
    if (event.type === 'tool_call') {
      const { call_id, name, arguments: rawArgs } = event;
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

      console.log(`🛠️ Voice Agent called tool: ${name}`, args);

      let output = {};

      if (name === 'send_whatsapp_message') {
        const result = await handleSend(args.recipient_name, args.message_body, 'text'); // Handled by test.js
        output = result.success 
          ? { status: 'success', detail: `Message dispatched to ${args.recipient_name}` }
          : { status: 'failed', error: result.error };
      } 
      else if (name === 'read_recent_messages') {
        const result = await handleRead(args.contact_name, { type: 'lastN', count: args.count || 5 }); // Handled by test.js[cite: 6]
        output = result;
      }

      // 4. Return execution result back to AssemblyAI so it speaks the answer
      ws.send(JSON.stringify({
        type: 'tool_result',
        call_id: call_id,
        result: JSON.stringify(output)
      }));
    }

    if (event.type === 'transcript') {
      console.log(`🎙️ Spoken: "${event.text}"`);
    }
  });

  ws.on('error', (err) => console.error('Agent WS Error:', err));
}

module.exports = { initVoiceAgent };