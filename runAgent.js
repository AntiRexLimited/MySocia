require('dotenv').config();
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { handleSend, handleRead } = require('./whatsapp/whatsappService'); // Imports Baileys WhatsApp logic

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const WS_URL = 'wss://agents.assemblyai.com/v1/ws';

if (!ASSEMBLYAI_API_KEY) {
  console.error('❌ Error: ASSEMBLYAI_API_KEY is missing in .env');
  process.exit(1);
}

// 1. Linux ALSA Audio Player (aplay - plays the Agent's voice)
let speakerProcess = null;

function createSpeaker() {
  const proc = spawn('aplay', [
    '-r', '24000',
    '-c', '1',
    '-f', 'S16_LE',
    '-t', 'raw'
  ]);
  proc.on('error', (err) => console.error('aplay error:', err));
  return proc;
}
// 2. Linux PulseAudio Recorder (parec - uses Ubuntu's default mic)
let recorderProcess = null;

function startRecorder(ws) {
  // parec routes perfectly through your Ubuntu GUI sound settings
  recorderProcess = spawn('parec', [
    '--rate=24000',
    '--channels=1',
    '--format=s16le'
  ]);

  let chunkCount = 0;

  recorderProcess.stdout.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      chunkCount++;
      // Visual indicator that mic is capturing data
      if (chunkCount % 25 === 0) {
        process.stdout.write('🎤 ');
      }

      ws.send(JSON.stringify({
        type: 'input.audio',
        audio: chunk.toString('base64')
      }));
    }
  });

  recorderProcess.on('error', (err) => {
    console.error('\n❌ parec error (is PulseAudio running?):', err.message);
  });
}   
// 3. Connect to Voice Agent API
const ws = new WebSocket(WS_URL, {
  headers: {
    Authorization: `Bearer ${ASSEMBLYAI_API_KEY}`
  }
});

// ⚠️ Verified AssemblyAI Tool Schema (Flat structure, no inner 'function' wrapper)
const tools = [
  {
    type: 'function',
    name: 'send_whatsapp_message',
    description: 'Sends a WhatsApp text message to a specific contact by their name.',
    parameters: {
      type: 'object',
      properties: {
        contact_name: {
          type: 'string',
          description: 'The name or nickname of the person (e.g., Hamza, Ali, Mom)'
        },
        message: {
          type: 'string',
          description: 'The text message to send'
        }
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
        contact_name: {
          type: 'string',
          description: 'The name of the contact whose messages should be inspected'
        },
        count: {
          type: 'number',
          description: 'Number of recent messages to fetch (default is 5)'
        }
      },
      required: ['contact_name']
    }
  }
];

ws.on('open', () => {
  console.log('✅ Connected to AssemblyAI Voice Agent API');

  // AssemblyAI requires session.update as the very first message
  const config = {
    type: 'session.update',
    session: {
      system_prompt: 'You are an executive personal assistant handling WhatsApp. Always answer briefly in 1-2 spoken sentences.',
      tools: tools
    }
  };

  ws.send(JSON.stringify(config));
});

ws.on('message', async (raw) => {
  const event = JSON.parse(raw.toString());

  // 1. Session Confirmed: Start Audio Hardware
  if (event.type === 'session.updated' || event.type === 'session.ready') {
    if (!speakerProcess) speakerProcess = createSpeaker();
    if (!recorderProcess) {
      startRecorder(ws);
      console.log('\n🎤 Microphone ACTIVE! Speak into your headset now...\n');
    }
  } 
  
  // 2. Play Audio from Agent
  else if (event.type === 'reply.audio' && event.data) {
    process.stdout.write('🔊 ');
    if (speakerProcess && speakerProcess.stdin.writable) {
      speakerProcess.stdin.write(Buffer.from(event.data, 'base64'));
    }
  } 
  
  // 3. Handle Voice Barge-in (Interruption)
  else if (event.type === 'reply.done' && event.status === 'interrupted') {
    if (speakerProcess) {
      speakerProcess.kill('SIGKILL');
      speakerProcess = createSpeaker();
    }
  } 
  
  // 4. Handle Transcripts
  else if (event.type === 'user.transcript') {
    console.log(`\n👤 You: "${event.text}"`);
  } 
  else if (event.type === 'agent.transcript') {
    console.log(`\n🤖 Agent: "${event.text}"`);
  } 
  
  // 5. Execute WhatsApp Tools
  else if (event.type === 'tool.call') {
    const { call_id, name, arguments: rawArgs } = event;
    const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

    console.log(`\n🛠️ Tool Call Triggered: [${name}]`, args);
    let toolResult = {};

    if (name === 'send_whatsapp_message') {
      const sendResult = await handleSend(args.contact_name, args.message, 'text');
      toolResult = sendResult.success
        ? { status: 'success', note: `Message sent to ${args.contact_name}` }
        : { status: 'error', error: sendResult.error };
    } 
    else if (name === 'read_whatsapp_messages') {
      const readResult = await handleRead(args.contact_name, { type: 'lastN', count: args.count || 5 });
      toolResult = readResult;
    }

    // AssemblyAI requires the tool.result event with the exact call_id
    ws.send(JSON.stringify({
      type: 'tool.result',
      call_id: call_id,
      result: JSON.stringify(toolResult)
    }));
  } 
  
  // 6. Catch any lingering schema errors
  else if (event.type === 'session.error') {
    console.error('\n❌ Server Error:', JSON.stringify(event, null, 2));
  }
});

ws.on('error', (err) => console.error('\n❌ WS Error:', err));

ws.on('close', (code, reason) => {
  console.log(`\n❌ Disconnected. Code: ${code}`);
  if (recorderProcess) recorderProcess.kill();
  if (speakerProcess) speakerProcess.kill();
});