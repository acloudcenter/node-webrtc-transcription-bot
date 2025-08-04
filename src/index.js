#!/usr/bin/env node

import { PexipConnection } from './services/pexip/PexipConnection.js';
import { OpenAITranscriptionService } from './services/transcription/OpenAITranscriptionService.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

async function main() {
  console.log('='.repeat(60));
  console.log('PEXIP TO OPENAI TRANSCRIPTION');
  console.log('='.repeat(60));
  console.log(`Pexip Node: ${process.env.PEXIP_NODE}`);
  console.log(`Conference: ${process.env.CONFERENCE_ALIAS}`);
  console.log('');

  // Validate config
  if (!process.env.PEXIP_NODE || !process.env.CONFERENCE_ALIAS) {
    console.error('Missing PEXIP_NODE or CONFERENCE_ALIAS in .env');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env');
    process.exit(1);
  }

  // Create output directory for transcripts
  const outputDir = path.join(process.cwd(), 'output', 'transcriptions');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create transcript file with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const transcriptFile = path.join(outputDir, `transcript_${timestamp}.txt`);
  const transcriptJsonFile = path.join(outputDir, `transcript_${timestamp}.json`);
  const transcriptStream = fs.createWriteStream(transcriptFile, { flags: 'a' });
  const transcripts = [];

  console.log(`Saving transcripts to: output/transcriptions/`);
  console.log(`  Text: transcript_${timestamp}.txt`);
  console.log(`  JSON: transcript_${timestamp}.json\n`);

  // Create transcription service
  const VAD_ENABLED = process.env.VAD_ENABLED !== 'false';  // Default true
  const DEBUG_MODE = process.env.DEBUG_OPENAI === 'true';
  const INCLUDE_LOGPROBS = process.env.INCLUDE_LOGPROBS === 'true';
  
  if (DEBUG_MODE) {
    console.log('🔧 Debug mode enabled for OpenAI');
  }
  
  const transcriptionService = new OpenAITranscriptionService({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini-transcribe',
    language: 'en',
    vadThreshold: VAD_ENABLED ? 0.5 : 0,  // 0 disables VAD
    vadSilenceDuration: VAD_ENABLED ? 500 : 0,
    debug: DEBUG_MODE,
    includeLogprobs: INCLUDE_LOGPROBS
  });

  // Set up transcription handlers
  transcriptionService.on('transcriptionDelta', (delta) => {
    process.stdout.write(delta.text);  // Stream partial text to console
  });

  transcriptionService.on('transcriptionComplete', (transcription) => {
    console.log('\n[✅ Complete]:', transcription.text);
    
    // Save to text file
    const timestamp = new Date().toISOString();
    transcriptStream.write(`[${timestamp}] ${transcription.text}\n\n`);
    
    // Build JSON entry
    const jsonEntry = {
      timestamp,
      text: transcription.text,
      itemId: transcription.itemId
    };
    
    // Add logprobs if available
    if (transcription.logprobs && INCLUDE_LOGPROBS) {
      jsonEntry.logprobs = transcription.logprobs;
      // Calculate confidence
      const avgLogprob = transcription.logprobs.reduce((sum, lp) => sum + (lp.logprob || 0), 0) / transcription.logprobs.length;
      jsonEntry.confidence = Math.exp(avgLogprob);
    }
    
    // Add to JSON array
    transcripts.push(jsonEntry);
  });

  transcriptionService.on('error', (error) => {
    console.error('[Error]', error.message);
  });

  // Connect to OpenAI first
  console.log('Connecting to OpenAI...');
  await transcriptionService.connect();
  console.log('✅ OpenAI connected\n');

  // Track if we've logged sample rate
  let sampleRateLogged = false;
  
  // Create Pexip connection
  const connection = new PexipConnection({
    nodeAddress: process.env.PEXIP_NODE,
    conferenceAlias: process.env.CONFERENCE_ALIAS,
    displayName: process.env.DISPLAY_NAME || 'Simple Transcriber',
    pin: process.env.PIN || '',
    
    // Stream audio directly to OpenAI
    onAudioData: async (audioData) => {
      try {
        // Log actual sample rate to understand what we're getting
        if (!sampleRateLogged) {
          console.log(`\n📊 Audio Stream Info:`);
          console.log(`  Sample Rate: ${audioData.sampleRate} Hz`);
          console.log(`  Channels: ${audioData.channelCount}`);
          console.log(`  Bits per sample: ${audioData.bitsPerSample}`);
          console.log(`  ✅ Audio pipeline connected: Pexip → Bot → OpenAI`);
          sampleRateLogged = true;
        }
        
        // Pass audio with actual sample rate from Pexip
        await transcriptionService.processAudioChunk({
          samples: audioData.samples,
          sampleRate: audioData.sampleRate, // Use actual rate, likely 48000
          timestamp: audioData.timestamp
        });
      } catch (error) {
        console.error('Failed to send audio:', error.message);
      }
    }
  });

  // Connect to Pexip
  console.log('Connecting to Pexip conference...');
  await connection.connect();
  console.log('✅ Pexip connected\n');
  console.log('Transcription active. Press Ctrl+C to stop.\n');
  console.log('-'.repeat(60));

  // Only commit audio buffer if VAD is disabled
  let commitInterval = null;
  if (!VAD_ENABLED) {
    console.log('VAD disabled - will manually commit audio every 2 seconds');
    commitInterval = setInterval(() => {
      if (transcriptionService.isConnected) {
        transcriptionService.commitAudioBuffer();
      }
    }, 2000);  // Commit every 2 seconds
  } else {
    console.log('VAD enabled - OpenAI will auto-detect speech and commit');
  }
  
  // Periodic stats reporting (every 30 seconds)
  const statsInterval = setInterval(() => {
    const stats = transcriptionService.getStats();
    if (stats.isConnected && stats.transcriptionsCompleted > 0) {
      console.log(`\n📊 Stats: ${stats.transcriptionsCompleted} transcriptions | ${(stats.audioBytesSent/1024).toFixed(0)}KB sent | Runtime: ${stats.runtime.toFixed(0)}s`);
    }
  }, 30000);

  // Handle shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    // Prevent multiple shutdown calls
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    
    console.log('\n\n🛑 Shutting down gracefully...');
    
    // Clear intervals
    if (commitInterval) {
      clearInterval(commitInterval);
    }
    if (statsInterval) {
      clearInterval(statsInterval);
    }
    
    // Save final transcripts
    transcriptStream.end();
    if (transcripts.length > 0) {
      fs.writeFileSync(transcriptJsonFile, JSON.stringify(transcripts, null, 2));
      console.log(`\n💾 Transcripts saved:`);
      console.log(`  ${transcripts.length} transcriptions`);
      console.log(`  Files in: output/transcriptions/`);
    } else {
      console.log('\n📝 No transcriptions captured');
    }
    
    // Disconnect services in order
    try {
      console.log('\nDisconnecting from services...');
      await transcriptionService.disconnect();
      console.log('  ✅ OpenAI disconnected');
      
      await connection.disconnect();
      console.log('  ✅ Pexip disconnected');
    } catch (error) {
      console.error('Error during shutdown:', error.message);
    }
    
    console.log('\n👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);