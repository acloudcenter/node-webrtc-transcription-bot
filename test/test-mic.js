import { OpenAITranscriptionService } from '../src/services/transcription/OpenAITranscriptionService.js';
import recorder from 'node-record-lpcm16';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

async function testMicrophoneTranscription() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not found in .env file');
    process.exit(1);
  }
  
  // Create output directory for transcriptions
  const outputDir = path.join(dirname(__dirname), 'output', 'transcriptions');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Create transcription file with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const transcriptionFile = path.join(outputDir, `transcription_${timestamp}.txt`);
  const transcriptionJsonFile = path.join(outputDir, `transcription_${timestamp}.json`);
  const transcriptionStream = fs.createWriteStream(transcriptionFile, { flags: 'a' });
  const transcriptions = [];
  
  console.log('Saving transcriptions to:');
  console.log(`   Text: ${path.basename(transcriptionFile)}`);
  console.log(`   JSON: ${path.basename(transcriptionJsonFile)}\n`);
  
  // Enable debug mode to see all messages (set to 'true' for debugging)
  // process.env.DEBUG_OPENAI = 'true';
  
  // Create the transcription provider
  const provider = new OpenAITranscriptionService({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-transcribe',
    language: 'en',
    transcriptionPrompt: '',
    vadThreshold: 0.5,
    vadSilenceDurationMs: 1000,
    inputAudioNoiseReductionType: 'near_field',
    includeLogprobs: false,
    debug: false
  });
  
  // Set up event handlers
  let lastTranscript = '';
  
  provider.on('transcriptionDelta', (delta) => {
    // Clear previous line and write new text
    process.stdout.write(`\r[LIVE] ${delta.text}`);
    lastTranscript = delta.text;
  });
  
  provider.on('transcriptionComplete', (transcription) => {
    // Move to new line for completed transcription
    console.log(`\n[COMPLETE] ${transcription.text}\n`);
    
    // Save to file with timestamp
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      text: transcription.text,
      itemId: transcription.itemId
    };
    
    // Save to text file
    transcriptionStream.write(`[${timestamp}] ${transcription.text}\n\n`);
    
    // Add to JSON array
    transcriptions.push(entry);
    
    lastTranscript = '';
  });
  
  provider.on('error', (error) => {
    console.error('\n[ERROR]', error.message);
  });
  
  provider.on('connected', () => {
    console.log('Connected to OpenAI Realtime API');
  });
  
  provider.on('disconnected', (info) => {
    console.log('\nDisconnected from OpenAI:', info.reason || 'Unknown reason');
  });
  
  try {
    // Connect to OpenAI
    console.log('Connecting to OpenAI Realtime API...');
    await provider.connect();
    
    console.log('Starting microphone capture...\n');
    console.log('Speak into your microphone. Press Ctrl+C to stop.\n');
    
    // Start recording from microphone
    const recording = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: 'raw',
      recorder: 'sox', // or 'rec' or 'arecord'
      silence: '0.0',
      threshold: 0,
      device: null // use default device
    });
    
    let audioBuffer = Buffer.alloc(0);
    const chunkSize = 16000; // 1 second of audio at 16kHz
    let chunkCount = 0;
    let totalAudioSent = 0;
    
    // Periodically commit the audio buffer for transcription
    const commitInterval = setInterval(() => {
      if (totalAudioSent > 0) {
        console.log('\nCommitting audio buffer for transcription...');
        provider.commitAudioBuffer();
        totalAudioSent = 0;
      }
    }, 2000); // Commit every 2 seconds
    
    recording.stream().on('data', async (data) => {
      // Accumulate audio data
      audioBuffer = Buffer.concat([audioBuffer, data]);
      
      // Process chunks of audio
      while (audioBuffer.length >= chunkSize * 2) { // *2 because 16-bit = 2 bytes per sample
        const chunk = audioBuffer.slice(0, chunkSize * 2);
        audioBuffer = audioBuffer.slice(chunkSize * 2);
        
        // Convert to Int16Array
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        
        chunkCount++;
        totalAudioSent += samples.length;
        
        if (chunkCount % 5 === 0) {
          // Show activity indicator every 5 seconds
          process.stdout.write('[Recording] ');
        }
        
        // Send to OpenAI
        try {
          await provider.processAudioChunk({
            samples: samples,
            sampleRate: 16000,
            speaker: { displayName: 'You' },
            timestamp: Date.now()
          });
        } catch (error) {
          console.error('\nFailed to send audio:', error.message);
        }
      }
    });
    
    recording.stream().on('error', (error) => {
      console.error('\nRecording error:', error);
      console.error('\nTips:');
      console.error('   - Make sure sox is installed: brew install sox');
      console.error('   - Check microphone permissions in System Settings > Privacy & Security > Microphone');
      console.error('   - Try running: sox -d -t raw -r 16000 -c 1 -b 16 -e signed-integer - | xxd | head');
      process.exit(1);
    });
    
    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\nStopping microphone capture...');
      
      // Clear the commit interval
      clearInterval(commitInterval);
      
      // Stop recording
      recording.stop();
      
      // Send any remaining audio
      if (audioBuffer.length > 0) {
        console.log('Sending remaining audio...');
        const samples = new Int16Array(
          audioBuffer.buffer, 
          audioBuffer.byteOffset, 
          audioBuffer.byteLength / 2
        );
        await provider.processAudioChunk({
          samples: samples,
          sampleRate: 16000,
          speaker: { displayName: 'You' },
          timestamp: Date.now()
        });
      }
      
      // Wait for final transcriptions
      console.log('Waiting for final transcriptions...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Close transcription file
      transcriptionStream.end();
      
      // Save JSON file
      fs.writeFileSync(transcriptionJsonFile, JSON.stringify(transcriptions, null, 2));
      
      console.log('\nTranscriptions saved:');
      console.log(`   Text: ${path.basename(transcriptionFile)}`);
      console.log(`   JSON: ${path.basename(transcriptionJsonFile)}`);
      console.log(`   Total transcriptions: ${transcriptions.length}`);
      
      // Disconnect from OpenAI
      await provider.disconnect();
      console.log('\nTest completed successfully');
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    // Keep the process running
    await new Promise(() => {});
    
  } catch (error) {
    console.error('\nFatal error:', error.message);
    if (error.message.includes('API key')) {
      console.error('\nMake sure OPENAI_API_KEY is set in your .env file');
    }
    process.exit(1);
  }
}

// Run the test
console.log('Starting microphone transcription test...\n');
testMicrophoneTranscription().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});