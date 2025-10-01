# Pexip WebRTC Transcription Bot

## Work in Progress - Demo Purposes Only

A Node.js bot that joins Pexip conferences via WebRTC to capture and process audio streams for transcription purposes. This bot operates headlessly without requiring a browser, making it ideal for server-side audio processing and transcription services.

## Features

- **Headless WebRTC Connection**: Connects to Pexip conferences using Node.js without a browser
- **Audio Stream Capture**: Extracts PCM audio data from conference participants
- **Speaker Attribution**: Tracks which participant is speaking using Voice Activity Detection (VAD)
- **Chunk-based Processing**: Processes audio in configurable chunks (default 1 second) for real-time transcription
- **Multiple Output Formats**: Saves audio as both raw PCM and WAV files
- **Participant Tracking**: Monitors when participants join, leave, and speak
- **ICE Candidate Queuing**: Handles ICE negotiation timing for reliable connections

## Prerequisites

- Node.js v16 or higher
- NPM or Yarn
- Access to a Pexip deployment
- Conference alias and optional PIN

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/node-webrtc-transcription-bot.git
cd node-webrtc-transcription-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
PEXIP_NODE=your-pexip-server.com
CONFERENCE_ALIAS=your-conference-alias
DISPLAY_NAME=Transcription Bot
PIN=optional_conference_pin
```

## Usage

Start the bot:
```bash
npm start
```

The bot will:
1. Connect to the specified Pexip conference
2. Join as an audio-only participant (receive-only)
3. Begin capturing audio streams
4. Save audio chunks to the `./output` directory
5. Track speaker changes and participant events

Stop the bot with `Ctrl+C` for graceful shutdown.

## Project Structure

```
├── src/
│   ├── index.js                 # Main entry point
│   ├── services/
│   │   ├── PexipConnection.js   # WebRTC connection management
│   │   ├── AudioProcessor.js    # Audio chunk processing
│   │   └── ParticipantTracker.js # Speaker tracking
│   └── utils/
│       └── AudioBuffer.js       # Audio buffering and WAV conversion
├── output/                      # Generated audio files (gitignored)
│   ├── pcm/                    # Raw PCM chunks
│   └── wav/                    # WAV format chunks
├── test-audio.js               # Audio verification utility
├── .env                        # Environment configuration
└── package.json                # Project dependencies
```

## Architecture

The bot uses the following flow:

1. **Authentication**: Requests a token from Pexip REST API
2. **WebRTC Setup**: Creates peer connection with audio transceiver
3. **ICE Negotiation**: Queues and sends ICE candidates after call UUID is available
4. **Audio Extraction**: Uses RTCAudioSink from @roamhq/wrtc to extract PCM data
5. **Processing**: Buffers audio into chunks with speaker attribution
6. **Output**: Saves chunks for transcription service integration

## Audio Specifications

- **Sample Rate**: 16kHz (phone quality, received from Pexip)
- **Bit Depth**: 16-bit
- **Channels**: Mono
- **Format**: PCM/WAV
- **Chunk Duration**: 1 second (configurable)
- **Codec**: Opus (decoded automatically)

## Integration with Transcription Services

The bot outputs audio chunks that can be sent to OpenAI RealTimeAPI. Other services to test in the future.
- OpenAI Realtime API


Example integration point in `AudioProcessor.js`:
```javascript
onChunkReady: (chunk) => {
  // Send chunk to your transcription service
  // chunk.samples contains PCM data
  // chunk.speaker contains speaker info
  // chunk.timestamp for synchronization
}
```

## Configuration Options

In `src/index.js`, you can configure:

- `chunkDurationMs`: Audio chunk duration (default: 1000ms)
- `saveRawPCM`: Save raw PCM files (default: true)
- `saveWAV`: Save WAV files (default: true)
- `outputDir`: Output directory (default: './output')

## Testing Audio Capture

Use the included test script to verify audio capture:
```bash
node test-audio.js
```

This analyzes captured WAV files for:
- Audio presence (not silence)
- Amplitude levels
- Sample rate verification

Example output:
```
Analyzing: ./output/wav/track_chunk_000001.wav
  Max value: 3195 (9.8%)
  Min value: -3318 (-10.1%)
  Non-zero samples: 7999 (99.99%)
  OK: This file contains audio
```

## Dependencies

- `@roamhq/wrtc`: WebRTC implementation for Node.js with audio extraction support
- `axios`: HTTP client for REST API calls
- `dotenv`: Environment variable management

## Known Limitations

- Audio is received at 16kHz instead of the expected 48kHz (Pexip's webRTC quality setting)
- Only processes mixed conference audio (not individual participant streams)
- Requires @roamhq/wrtc specifically for RTCAudioSink support

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please use the GitHub issue tracker.