import { PexipConnection } from './services/PexipConnection.js';
import { AudioProcessor } from './services/AudioProcessor.js';
import { ParticipantTracker } from './services/ParticipantTracker.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
  console.log('Pexip Audio Extraction Bot Starting...\n');
  console.log('Configuration:');
  console.log(`   Node: ${process.env.PEXIP_NODE}`);
  console.log(`   Conference: ${process.env.CONFERENCE_ALIAS}`);
  console.log(`   Display Name: ${process.env.DISPLAY_NAME || 'Transcription Bot'}\n`);
  
  // Validate configuration
  if (!process.env.PEXIP_NODE || !process.env.CONFERENCE_ALIAS) {
    console.error('Missing required environment variables!');
    console.error('Please set PEXIP_NODE and CONFERENCE_ALIAS in .env file');
    process.exit(1);
  }

  // Create participant tracker
  const participantTracker = new ParticipantTracker();
  
  // Create audio processor
  const audioProcessor = new AudioProcessor({
    saveRawPCM: true,  // Save raw PCM chunks
    saveWAV: true,     // Also save as WAV files
    outputDir: './output',
    chunkDurationMs: 1000, // 1 second chunks
    logStats: true,
    onChunkReady: (chunk) => {
      // This is where you would send to transcription service
      if (chunk.speaker) {
        console.log(`Chunk ready: #${chunk.chunkNumber} - Speaker: ${chunk.speaker.displayName}`);
      } else {
        console.log(`Chunk ready: #${chunk.chunkNumber} - No speaker identified`);
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
    await connection.disconnect();
    process.exit(1);
  }
}

// Run the bot
main().catch(console.error);