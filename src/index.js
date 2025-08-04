import { PexipConnection } from './services/PexipConnection.js';
import { AudioProcessor } from './services/AudioProcessor.js';
import { ParticipantTracker } from './services/ParticipantTracker.js';
import { OpenAIRealtimeProvider } from './services/transcription/providers/OpenAIRealtimeProvider.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
  console.log('Pexip Audio Extraction Bot Starting...\n');
  console.log('Configuration:');
  console.log(`   Node: ${process.env.PEXIP_NODE}`);
  console.log(`   Conference: ${process.env.CONFERENCE_ALIAS}`);
  console.log(`   Display Name: ${process.env.DISPLAY_NAME || 'Transcription Bot'}`);
  console.log(`   Transcription: ${process.env.ENABLE_TRANSCRIPTION === 'true' ? 'Enabled' : 'Disabled'}\n`);
  
  // Validate configuration
  if (!process.env.PEXIP_NODE || !process.env.CONFERENCE_ALIAS) {
    console.error('Missing required environment variables!');
    console.error('Please set PEXIP_NODE and CONFERENCE_ALIAS in .env file');
    process.exit(1);
  }

  // Create participant tracker
  const participantTracker = new ParticipantTracker();
  
  // Create transcription provider if enabled
  let transcriptionProvider = null;
  if (process.env.ENABLE_TRANSCRIPTION === 'true') {
    if (!process.env.OPENAI_API_KEY) {
      console.error('Transcription enabled but OPENAI_API_KEY not set!');
      process.exit(1);
    }
    
    transcriptionProvider = new OpenAIRealtimeProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-transcribe',
      language: process.env.TRANSCRIPTION_LANGUAGE || 'en',
      prompt: process.env.TRANSCRIPTION_PROMPT || '',
      vadThreshold: parseFloat(process.env.VAD_THRESHOLD) || 0.5,
      vadSilenceDuration: parseInt(process.env.VAD_SILENCE_DURATION) || 500,
      noiseReduction: process.env.NOISE_REDUCTION || 'near_field',
      includeLogprobs: process.env.INCLUDE_LOGPROBS === 'true'
    });
    
    // Set up transcription event handlers
    transcriptionProvider.on('transcriptionDelta', (delta) => {
      console.log(`[Transcription Delta] ${delta.text}`);
    });
    
    transcriptionProvider.on('transcriptionComplete', (transcription) => {
      console.log(`[Transcription Complete] ${transcription.text}`);
    });
    
    transcriptionProvider.on('error', (error) => {
      console.error('[Transcription Error]', error);
    });
    
    transcriptionProvider.on('connected', () => {
      console.log('Transcription service connected');
    });
    
    transcriptionProvider.on('disconnected', () => {
      console.log('Transcription service disconnected');
    });
  }
  
  // Create audio processor
  const audioProcessor = new AudioProcessor({
    saveRawPCM: process.env.SAVE_RAW_PCM !== 'false',
    saveWAV: process.env.SAVE_WAV !== 'false',
    outputDir: './output',
    chunkDurationMs: parseInt(process.env.CHUNK_DURATION_MS) || 1000,
    logStats: true,
    onChunkReady: async (chunk) => {
      if (chunk.speaker) {
        console.log(`Chunk ready: #${chunk.chunkNumber} - Speaker: ${chunk.speaker.displayName}`);
      } else {
        console.log(`Chunk ready: #${chunk.chunkNumber} - No speaker identified`);
      }
      
      // Send to transcription if enabled
      if (transcriptionProvider && transcriptionProvider.isConnected) {
        try {
          await transcriptionProvider.processAudioChunk({
            samples: chunk.samples,
            sampleRate: chunk.sampleRate,
            speaker: chunk.speaker,
            timestamp: chunk.timestamp
          });
        } catch (error) {
          console.error('Failed to send audio to transcription:', error);
        }
      }
    }
  });
  
  // Link participant tracker to audio processor
  audioProcessor.setParticipantTracker(participantTracker);

  // Create Pexip connection with all callbacks
  const connection = new PexipConnection({
    nodeAddress: process.env.PEXIP_NODE,
    conferenceAlias: process.env.CONFERENCE_ALIAS,
    displayName: process.env.DISPLAY_NAME || 'Transcription Bot',
    pin: process.env.PIN || '',
    
    // Audio data callback
    onAudioData: (audioData) => {
      audioProcessor.processAudioData(audioData);
    },
    
    // Participant event callbacks
    onParticipantJoined: (event) => {
      participantTracker.addParticipant(event);
    },
    
    onParticipantUpdated: (event) => {
      participantTracker.updateParticipant(event);
    },
    
    onParticipantLeft: (event) => {
      participantTracker.removeParticipant(event);
    },
    
    onStageUpdate: (event) => {
      participantTracker.updateStage(event);
    }
  });

  try {
    // Connect transcription service first if enabled
    if (transcriptionProvider) {
      console.log('Connecting to transcription service...');
      await transcriptionProvider.connect();
    }
    
    // Connect to conference
    console.log('Connecting to Pexip conference...\n');
    await connection.connect();
    
    // Monitor status
    let lastSinkCount = 0;
    let lastParticipantCount = 0;
    const monitorInterval = setInterval(() => {
      const sinkCount = connection.getActiveSinks();
      const participantCount = participantTracker.participants.size;
      
      if (sinkCount !== lastSinkCount) {
        console.log(`\nActive audio sinks: ${sinkCount}`);
        lastSinkCount = sinkCount;
      }
      
      if (participantCount !== lastParticipantCount) {
        console.log(`\nParticipants in conference: ${participantCount}`);
        const participants = participantTracker.getAllParticipants();
        participants.forEach(p => {
          const status = p.isSpeaking ? 'Speaking' : p.isMuted ? 'Muted' : 'Silent';
          console.log(`   ${p.displayName}: ${status}`);
        });
        lastParticipantCount = participantCount;
      }
      
      // Show current speaker
      const currentSpeaker = participantTracker.getCurrentSpeaker();
      if (currentSpeaker) {
        console.log(`\nCurrent speaker: ${currentSpeaker.displayName}`);
      }
    }, 5000);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\nShutting down gracefully...');
      clearInterval(monitorInterval);
      
      // Show final statistics
      console.log('\nFinal Statistics:');
      const stats = participantTracker.getStatistics();
      console.log(`   Total participants: ${stats.totalParticipants}`);
      if (stats.participants.length > 0) {
        console.log('\n   Speaking time breakdown:');
        stats.participants.forEach(p => {
          const seconds = Math.round(p.totalSpeakingTime / 1000);
          console.log(`     ${p.displayName}: ${seconds}s (${p.percentageOfTime}%)`);
        });
      }
      
      // Stop audio processor first
      audioProcessor.stop();
      
      // Disconnect transcription service
      if (transcriptionProvider) {
        await transcriptionProvider.disconnect();
      }
      
      // Then disconnect from conference
      await connection.disconnect();
      
      console.log('Goodbye!');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the bot running
    console.log('\nBot is running! Audio extraction active.\n');
    console.log('Audio data is being saved to ./output directory');
    console.log('Press Ctrl+C to stop.\n');

  } catch (error) {
    console.error('Fatal error:', error);
    audioProcessor.stop();
    if (transcriptionProvider) {
      await transcriptionProvider.disconnect();
    }
    await connection.disconnect();
    process.exit(1);
  }
}

// Run the bot
main().catch(console.error);