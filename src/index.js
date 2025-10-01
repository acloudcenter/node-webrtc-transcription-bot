#!/usr/bin/env node

import { PexipConnection } from './services/pexip/PexipConnection.js';
import { TranscriptionFactory } from './services/transcription/TranscriptionFactory.js';
import { TranscriptManager } from './utils/TranscriptManager.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

async function main() {
  const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'openai';

  // Validate config
  if (!process.env.PEXIP_NODE || !process.env.CONFERENCE_ALIAS) {
    console.error('Missing PEXIP_NODE or CONFERENCE_ALIAS in .env');
    process.exit(1);
  }

  // Validate provider API key
  try {
    TranscriptionFactory.validateProvider(PROVIDER);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // Create transcript manager for dual output
  const transcriptManager = new TranscriptManager();

  // Create transcription service
  const VAD_ENABLED = process.env.VAD_ENABLED !== 'false';  // Default true
  const VAD_TYPE = process.env.VAD_TYPE || 'server_vad';  // 'server_vad' or 'semantic_vad'
  const VAD_EAGERNESS = process.env.VAD_EAGERNESS || 'auto'; // For semantic VAD: 'low', 'medium', 'high', 'auto'
  const DEBUG_MODE = process.env.DEBUG_OPENAI === 'true' || process.env.DEBUG_GEMINI === 'true';
  const INCLUDE_LOGPROBS = process.env.INCLUDE_LOGPROBS === 'true';
  
  if (DEBUG_MODE) {
    console.log(`Debug mode enabled for ${PROVIDER}`);
  }
  
  // Provider-specific config
  const transcriptionConfig = {
    apiKey: PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY,
    model: PROVIDER === 'gemini' ? 'gemini-live-2.5-flash-preview' : (process.env.OPENAI_MODEL || 'gpt-4o-transcribe'),
    language: process.env.TRANSCRIPTION_LANGUAGE || 'en',
    vadEnabled: VAD_ENABLED,
    vadType: VAD_TYPE,
    vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.5'),
    vadSilenceDurationMs: parseInt(process.env.VAD_SILENCE_DURATION || '500'),
    vadEagerness: VAD_EAGERNESS,
    debug: DEBUG_MODE,
    includeLogprobs: INCLUDE_LOGPROBS
  };
  
  const transcriptionService = TranscriptionFactory.create(PROVIDER, transcriptionConfig);

  // Set up transcription handlers
  transcriptionService.on('transcriptionDelta', (delta) => {
    process.stdout.write(delta.text);  // Stream partial text to console
  });

  transcriptionService.on('transcriptionComplete', (transcription) => {
    console.log('\n[Complete]:', transcription.text);
    
    // Add to transcript manager with metadata
    const metadata = {
      itemId: transcription.itemId,
      previousItemId: transcription.previousItemId,
      contentIndex: transcription.contentIndex
    };
    
    // Add logprobs if available
    if (transcription.logprobs && INCLUDE_LOGPROBS) {
      metadata.logprobs = transcription.logprobs;
      // Calculate confidence
      const avgLogprob = transcription.logprobs.reduce((sum, lp) => sum + (lp.logprob || 0), 0) / transcription.logprobs.length;
      metadata.confidence = Math.exp(avgLogprob);
    }
    
    // Save transcription
    transcriptManager.addTranscription(transcription.text, metadata);
  });

  transcriptionService.on('error', (error) => {
    console.error('[Error]', error.message);
  });

  // Connect to transcription service first
  console.log(`Connecting to ${PROVIDER}...`);
  await transcriptionService.connect();
  console.log(`\n✅ ${PROVIDER} connected\n`);

  // Track if we've logged sample rate
  let sampleRateLogged = false;
  
  // Create Pexip connection
  const connection = new PexipConnection({
    nodeAddress: process.env.PEXIP_NODE,
    conferenceAlias: process.env.CONFERENCE_ALIAS,
    displayName: process.env.DISPLAY_NAME || 'Simple Transcriber',
    pin: process.env.PIN || '',
    
    // Stream audio directly to the transcription service
    onAudioData: async (audioData) => {
      try {
        // Log the actual sample rate to understand what we're getting
        if (!sampleRateLogged) {
          console.log(`\n📊 Audio Stream Info:`);
          console.log(`  Sample Rate: ${audioData.sampleRate} Hz`);
          console.log(`  Channels: ${audioData.channelCount}`);
          console.log(`  Bits per sample: ${audioData.bitsPerSample}`);
          console.log(`  ✅ Audio pipeline connected: Pexip → Bot → ${PROVIDER}`);
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
    if (VAD_TYPE === 'semantic_vad') {
      console.log(`Semantic VAD enabled (eagerness: ${VAD_EAGERNESS}) - smarter speech detection`);
    } else {
      console.log(`Server VAD enabled - ${PROVIDER} will auto-detect speech and commit`);
    }
  }
  
  // Report stats every 30 seconds
  const statsInterval = setInterval(() => {
    const serviceStats = transcriptionService.getStats();
    const transcriptStats = transcriptManager.getStats();
    if (serviceStats.isConnected && transcriptStats.transcriptionCount > 0) {
      console.log(`\n📊 Stats: ${transcriptStats.transcriptionCount} transcriptions | ${transcriptStats.totalWords} words | ${(serviceStats.audioBytesSent/1024).toFixed(0)}KB sent | Runtime: ${serviceStats.runtime.toFixed(0)}s`);
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
    
    // Save all transcript files
    const stats = transcriptManager.getStats();
    if (stats.transcriptionCount > 0) {
      const files = await transcriptManager.save();
      console.log(`\n💾 Transcripts saved:`);
      console.log(`  ${stats.transcriptionCount} transcriptions`);
      console.log(`  ${stats.totalWords} words`);
      console.log(`  Files in: output/transcriptions/`);
    } else {
      console.log('\n📝 No transcriptions captured');
    }
    
    // Disconnect services in order
    try {
      console.log('\nDisconnecting from services...');
      await transcriptionService.disconnect();
      console.log(`  ✅ ${PROVIDER} disconnected`);
      
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
