import { PexipTranscriptionBot } from './PexipTranscriptionBot.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
  console.log('🤖 Pexip Transcription Bot Starting...\n');
  
  // Validate configuration
  if (!process.env.PEXIP_NODE || !process.env.CONFERENCE_ALIAS) {
    console.error('❌ Missing required environment variables!');
    console.error('Please set PEXIP_NODE and CONFERENCE_ALIAS in .env file');
    process.exit(1);
  }

  // Create bot instance
  const bot = new PexipTranscriptionBot({
    nodeAddress: process.env.PEXIP_NODE,
    conferenceAlias: process.env.CONFERENCE_ALIAS,
    displayName: process.env.DISPLAY_NAME || 'Transcription Bot',
    pin: process.env.PIN || ''
  });

  try {
    // Connect to conference
    await bot.connect();
    
    // Monitor audio streams
    let lastStreamCount = 0;
    const monitorInterval = setInterval(() => {
      const streamCount = bot.getStreamCount();
      if (streamCount !== lastStreamCount) {
        console.log(`\n📊 Active audio streams: ${streamCount}`);
        lastStreamCount = streamCount;
        
        const streams = bot.getActiveStreams();
        streams.forEach((stream, index) => {
          console.log(`  Stream ${index + 1}: ${stream.id}`);
        });
      }
    }, 5000);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n⏹️  Shutting down gracefully...');
      clearInterval(monitorInterval);
      await bot.disconnect();
      process.exit(0);
    });

    // Keep the bot running
    console.log('\n✨ Bot is running! Press Ctrl+C to stop.\n');
    console.log('📝 Audio streams will be logged as they are received.');
    console.log('🎧 The bot is in receive-only mode, listening for audio.\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await bot.disconnect();
    process.exit(1);
  }
}

// Run the bot
main().catch(console.error);