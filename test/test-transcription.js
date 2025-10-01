import { OpenAIRealtimeProvider } from '../src/services/transcription/providers/OpenAIRealtimeProvider.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

async function testTranscription() {
  const provider = new OpenAIRealtimeProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-transcribe',
    language: 'en',
    prompt: 'Testing transcription with sample audio',
    vadThreshold: 0.5,
    vadSilenceDuration: 500,
    noiseReduction: 'near_field',
    includeLogprobs: false,
    sendDirectly: true
  });
  
  provider.on('transcriptionDelta', (delta) => {
    console.log(`[DELTA] ${delta.text}`);
  });
  
  provider.on('transcriptionComplete', (transcription) => {
    console.log(`[COMPLETE] ${transcription.text}\n`);
  });
  
  provider.on('error', (error) => {
    console.error('[ERROR]', error);
  });
  
  provider.on('connected', () => {
    console.log('Connected to OpenAI Realtime API\n');
  });
  
  provider.on('disconnected', (info) => {
    console.log('Disconnected from OpenAI:', info);
  });
  
  try {
    console.log('Connecting to OpenAI Realtime API...');
    await provider.connect();
    
    console.log('Loading sample audio file...');
    const wavDir = path.join(process.cwd(), 'output', 'wav');
    const wavFiles = fs.readdirSync(wavDir).filter(f => f.endsWith('.wav'));
    
    if (wavFiles.length === 0) {
      console.log('No WAV files found in output/wav directory');
      console.log('Creating synthetic test audio...\n');
      
      const sampleRate = 16000;
      const duration = 2;
      const numSamples = sampleRate * duration;
      const samples = new Int16Array(numSamples);
      
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        samples[i] = Math.sin(2 * Math.PI * 440 * t) * 5000;
        
        if (i % 1600 === 0) {
          samples[i] = 0;
        }
      }
      
      console.log('Sending synthetic audio (440Hz tone) to transcription...');
      await provider.processAudioChunk({
        samples: samples,
        sampleRate: sampleRate,
        speaker: { displayName: 'Test Speaker' },
        timestamp: Date.now()
      });
      
    } else {
      // Use a few consecutive files for better testing
      const sessionPrefix = '9f54ab5b-a52a-4ed9-8e10-b62aa28802d6';
      const testFiles = wavFiles
        .filter(f => f.startsWith(sessionPrefix))
        .sort()
        .slice(0, 5);  // Use the first 5 chunks
      
      if (testFiles.length === 0) {
        testFiles.push(wavFiles[0]);
      }
      
      console.log(`Using ${testFiles.length} audio file(s) from session\n`);
      
      let totalSamples = 0;
      for (let fileIndex = 0; fileIndex < testFiles.length; fileIndex++) {
        const testFile = testFiles[fileIndex];
        console.log(`Processing: ${testFile}`);
        
        const wavPath = path.join(wavDir, testFile);
        const wavBuffer = fs.readFileSync(wavPath);
        
        const dataOffset = 44;
        const pcmData = wavBuffer.slice(dataOffset);
        const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
        
        totalSamples += samples.length;
        
        await provider.processAudioChunk({
          samples: samples,
          sampleRate: 16000,
          speaker: { displayName: 'Conference Speaker' },
          timestamp: Date.now() + (fileIndex * 1000)
        });
        
        // Add a small delay between chunks
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      console.log(`\nTotal audio processed:`);
      console.log(`  - Samples: ${totalSamples}`);
      console.log(`  - Duration: ${(totalSamples / 16000).toFixed(2)}s\n`);
    }
    
    console.log('\nWaiting for transcription results...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Commit any remaining audio in the buffer
    console.log('Attempting to commit any remaining audio buffer...');
    try {
      provider.commitAudioBuffer();
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.log('No audio left to commit (expected with server VAD)')
    }
    
    console.log('\nTest completed successfully!');
    console.log('Disconnecting...');
    await provider.disconnect();
    
  } catch (error) {
    console.error('Test failed:', error);
    if (error.message.includes('API key')) {
      console.error('\nMake sure your OPENAI_API_KEY is set correctly in .env file');
    }
    await provider.disconnect();
    process.exit(1);
  }
  
  process.exit(0);
}

testTranscription().catch(console.error);
