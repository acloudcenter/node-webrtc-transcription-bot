#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { PexipConnection } from './services/pexip/PexipConnection.js';
import { TranscriptionFactory } from './services/transcription/TranscriptionFactory.js';
import { TranscriptManager } from './utils/TranscriptManager.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Store active connections
const activeConnections = new Map();

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeConnections: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

/**
 * Dial-in endpoint - triggers bot to join a conference
 */
app.post('/api/dial-in', async (req, res) => {
  const {
    conferenceAlias,
    displayName = 'Transcription Bot',
    pin = '',
    pexipNode = process.env.PEXIP_NODE,
    transcriptionProvider = process.env.TRANSCRIPTION_PROVIDER || 'openai'
  } = req.body;

  // Validate required fields
  if (!conferenceAlias) {
    return res.status(400).json({ 
      error: 'Missing required field: conferenceAlias' 
    });
  }

  if (!pexipNode) {
    return res.status(400).json({ 
      error: 'Missing Pexip node address. Set PEXIP_NODE in .env or provide pexipNode in request.' 
    });
  }

  // Generate unique connection ID
  const connectionId = `${conferenceAlias}_${Date.now()}`;

  // Check if already connected to this conference
  const existingConnection = Array.from(activeConnections.values())
    .find(conn => conn.conferenceAlias === conferenceAlias && conn.isActive);
  
  if (existingConnection) {
    return res.status(409).json({ 
      error: 'Bot already connected to this conference',
      connectionId: existingConnection.id
    });
  }

  console.log(`\n📞 Dial-in request received:`);
  console.log(`   Conference: ${conferenceAlias}`);
  console.log(`   Display Name: ${displayName}`);
  console.log(`   Node: ${pexipNode}`);
  console.log(`   Provider: ${transcriptionProvider}`);

  try {
    // Validate provider
    TranscriptionFactory.validateProvider(transcriptionProvider);

    // Create transcript manager
    const transcriptManager = new TranscriptManager();

    // Create transcription service
    const transcriptionConfig = {
      apiKey: transcriptionProvider === 'gemini' ? 
        process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY,
      model: transcriptionProvider === 'gemini' ? 
        'gemini-live-2.5-flash-preview' : 
        (process.env.OPENAI_MODEL || 'gpt-4o-transcribe'),
      language: process.env.TRANSCRIPTION_LANGUAGE || 'en',
      vadEnabled: process.env.VAD_ENABLED !== 'false',
      vadType: process.env.VAD_TYPE || 'server_vad',
      vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.5'),
      vadSilenceDurationMs: parseInt(process.env.VAD_SILENCE_DURATION || '500'),
      vadEagerness: process.env.VAD_EAGERNESS || 'auto',
      debug: process.env.DEBUG_OPENAI === 'true' || process.env.DEBUG_GEMINI === 'true'
    };

    const transcriptionService = TranscriptionFactory.create(
      transcriptionProvider, 
      transcriptionConfig
    );

    // Set up transcription handlers
    transcriptionService.on('transcriptionComplete', (transcription) => {
      console.log(`[${connectionId}] Transcription:`, transcription.text);
      transcriptManager.addTranscription(transcription.text, {
        itemId: transcription.itemId,
        previousItemId: transcription.previousItemId
      });
    });

    transcriptionService.on('error', (error) => {
      console.error(`[${connectionId}] Transcription error:`, error.message);
    });

    // Connect to transcription service
    await transcriptionService.connect();
    console.log(`✅ ${transcriptionProvider} connected`);

    // Create Pexip connection
    const connection = new PexipConnection({
      nodeAddress: pexipNode,
      conferenceAlias,
      displayName,
      pin,
      onAudioData: async (audioData) => {
        try {
          await transcriptionService.processAudioChunk({
            samples: audioData.samples,
            sampleRate: audioData.sampleRate,
            timestamp: audioData.timestamp
          });
        } catch (error) {
          console.error(`[${connectionId}] Audio processing error:`, error.message);
        }
      }
    });

    // Connect to Pexip
    await connection.connect();
    console.log(`✅ Connected to conference: ${conferenceAlias}`);

    // Store connection info
    const connectionInfo = {
      id: connectionId,
      conferenceAlias,
      displayName,
      pexipNode,
      transcriptionProvider,
      connection,
      transcriptionService,
      transcriptManager,
      isActive: true,
      startTime: new Date().toISOString()
    };

    activeConnections.set(connectionId, connectionInfo);

    // Return success
    res.json({
      success: true,
      connectionId,
      message: 'Bot successfully joined conference',
      conference: {
        alias: conferenceAlias,
        displayName,
        node: pexipNode,
        provider: transcriptionProvider
      }
    });

  } catch (error) {
    console.error('❌ Dial-in failed:', error.message);
    res.status(500).json({ 
      error: 'Failed to join conference',
      message: error.message 
    });
  }
});

/**
 * Hang-up endpoint - disconnects bot from a conference
 */
app.post('/api/hang-up', async (req, res) => {
  const { connectionId, conferenceAlias } = req.body;

  let targetConnection = null;

  // Find connection by ID or conference alias
  if (connectionId) {
    targetConnection = activeConnections.get(connectionId);
  } else if (conferenceAlias) {
    targetConnection = Array.from(activeConnections.values())
      .find(conn => conn.conferenceAlias === conferenceAlias && conn.isActive);
  }

  if (!targetConnection) {
    return res.status(404).json({ 
      error: 'Connection not found' 
    });
  }

  console.log(`\n📞 Hang-up request for: ${targetConnection.conferenceAlias}`);

  try {
    // Save transcripts
    const stats = targetConnection.transcriptManager.getStats();
    if (stats.transcriptionCount > 0) {
      const files = await targetConnection.transcriptManager.save();
      console.log(`💾 Saved ${stats.transcriptionCount} transcriptions`);
    }

    // Disconnect services
    await targetConnection.connection.disconnect();
    await targetConnection.transcriptionService.disconnect();

    // Mark as inactive
    targetConnection.isActive = false;
    targetConnection.endTime = new Date().toISOString();

    // Remove from active connections
    activeConnections.delete(targetConnection.id);

    res.json({
      success: true,
      message: 'Bot disconnected from conference',
      connectionId: targetConnection.id,
      transcriptions: stats.transcriptionCount,
      duration: new Date(targetConnection.endTime) - new Date(targetConnection.startTime)
    });

  } catch (error) {
    console.error('❌ Hang-up failed:', error.message);
    res.status(500).json({ 
      error: 'Failed to disconnect',
      message: error.message 
    });
  }
});

/**
 * List active connections
 */
app.get('/api/connections', (req, res) => {
  const connections = Array.from(activeConnections.values()).map(conn => ({
    id: conn.id,
    conferenceAlias: conn.conferenceAlias,
    displayName: conn.displayName,
    provider: conn.transcriptionProvider,
    startTime: conn.startTime,
    isActive: conn.isActive,
    transcriptionCount: conn.transcriptManager.getStats().transcriptionCount
  }));

  res.json({
    count: connections.length,
    connections
  });
});

/**
 * Get connection details
 */
app.get('/api/connections/:connectionId', (req, res) => {
  const connection = activeConnections.get(req.params.connectionId);
  
  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const stats = connection.transcriptManager.getStats();
  
  res.json({
    id: connection.id,
    conferenceAlias: connection.conferenceAlias,
    displayName: connection.displayName,
    pexipNode: connection.pexipNode,
    provider: connection.transcriptionProvider,
    startTime: connection.startTime,
    isActive: connection.isActive,
    transcriptions: {
      count: stats.transcriptionCount,
      words: stats.totalWords,
      duration: stats.duration
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('PEXIP TRANSCRIPTION BOT - API SERVER');
  console.log('='.repeat(60));
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log(`  GET  /health              - Health check`);
  console.log(`  POST /api/dial-in         - Join a conference`);
  console.log(`  POST /api/hang-up         - Leave a conference`);
  console.log(`  GET  /api/connections     - List active connections`);
  console.log(`  GET  /api/connections/:id - Get connection details`);
  console.log('='.repeat(60));
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down server...');
  
  // Disconnect all active connections
  for (const [id, connection] of activeConnections) {
    if (connection.isActive) {
      console.log(`Disconnecting ${connection.conferenceAlias}...`);
      try {
        await connection.connection.disconnect();
        await connection.transcriptionService.disconnect();
      } catch (error) {
        console.error(`Error disconnecting ${id}:`, error.message);
      }
    }
  }
  
  console.log('Server stopped');
  process.exit(0);
});

export default app;