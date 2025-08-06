import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();
// Validate OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const url = "wss://api.openai.com/v1/realtime?intent=transcription";
const ws = new WebSocket(url, {
  headers: {
    "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
    "OpenAI-Beta": "realtime=v1",
  },
});

ws.on("open", function open() {
  console.log("Connected to server.");
  
  // Wait a moment for session to be created
  setTimeout(() => {
    const configMessage = {
      "type": "transcription_session.update",
      "session": {
        "input_audio_format": "pcm16",
        "input_audio_transcription": {
          "model": "gpt-4o-transcribe",
      "prompt": "Transcribe this audio into text.",
      "language": "en"
    },
    "input_audio_noise_reduction": {
      "type": "near_field"
    },
    "include": [
      "item.input_audio_transcription.logprobs",
    ]
  }
}

    console.log("Sending config message...");
    ws.send(JSON.stringify(configMessage));
  }, 100);
});

ws.on("message", function incoming(message) {
  console.log(JSON.parse(message.toString()));
});

ws.on("error", function error(err) {
  console.error("WebSocket error:", err);
});

ws.on("close", function close(code, reason) {
  console.log(`Connection closed: ${code} - ${reason}`);
});
