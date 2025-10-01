import WebSocket from 'ws';
import { resampleAudio } from '../../utils/AudioResampler.js';

/**
 * OpenAI Realtime API transcription service for bot
 * Handles WebSocket connection and audio streaming to OpenAI
 */

// OpenAI Realtime API constants
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'; // Default to gpt-4o-mini-transcribe
const OPENAI_REQUIRED_SAMPLE_RATE = 24000;  // OpenAI requires 24kHz for PCM16
const OPENAI_BETA_HEADER = 'realtime=v1';
const DEFAULT_BUFFER_DURATION_MS = 100; // 100ms at 24kHz-Required for OpenAI Realtime API
const OPENAI_AUDIO_FORMAT = 'pcm16';

export class OpenAITranscriptionService {
  constructor(config = {}) {
    this.apiKey = config.apiKey || OPENAI_API_KEY;
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    // Configuration for WebSocket connection
    this.wsUrl = config.wsUrl || OPENAI_REALTIME_URL;
    this.includeLogprobs = config.includeLogprobs || false;
    this.debug = config.debug || process.env.DEBUG_OPENAI === 'true';

    // OpenAI model and Realtime API settings
    this.id = config.id || 'transcription-session-' + Date.now();
    this.inputAudioFormat = config.inputAudioFormat || OPENAI_AUDIO_FORMAT;
    this.model = config.model || DEFAULT_TRANSCRIPTION_MODEL;
    this.transcriptionPrompt = config.transcriptionPrompt || '';
    this.language = config.language || 'en';

    // OpenAI Voice Activity Detection (VAD) configuration
    // When VAD is enabled, OpenAI automatically detects speech and commits audio buffer
    // Set vadEnabled to false to manually control when audio is committed for transcription
    this.vadEnabled = config.vadEnabled !== false; // Default true
    this.vadType = config.vadType || 'server_vad'; // 'server_vad' or 'semantic_vad'
    
    // Server VAD settings (only used when vadType is 'server_vad')
    this.vadThreshold = config.vadThreshold || 0.5;
    this.vadPrefixPaddingMs = config.vadPrefixPaddingMs || 1000;
    this.vadSilenceDurationMs = config.vadSilenceDurationMs || 500;
    
    // Semantic VAD settings (only used when vadType is 'semantic_vad')
    this.vadEagerness = config.vadEagerness || 'auto'; // 'low', 'medium', 'high', 'auto'

    // OpenAI Input audio noise reduction settings
    this.inputAudioNoiseReductionType = config.inputAudioNoiseReductionType || 'near_field';

    // WebSocket state
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.resampleLogged = false;
    this.responseTimeout = null;

    // Audio buffering state
    this.audioBuffer = [];
    this.bufferSize = OPENAI_REQUIRED_SAMPLE_RATE * (DEFAULT_BUFFER_DURATION_MS / 1000); // 100ms at 24kHz-Required for OpenAI Realtime API
    this.lastSendTime = Date.now();

    // Statistics for monitoring audio tracks and transcriptions
    this.stats = {
        audioBytesSent: 0,
        transcriptionsReceived: 0,
        errors: 0,
        startTime: null
    };

    // Event listeners for OpenAI transcription events.
    // Delta is for partial transcriptions, complete is for final transcriptions.
    this.listeners = {
        transcriptionDelta: [],
        transcriptionComplete: [],
        error: [],
        connected: [],
        disconnected: []
    };

    // Track transcription items by item_id
    this.transcriptionItems = new Map(); // Track transcriptions by item_id
    this.currentItemId = null;
    this.previousItemId = null;
  }

  // Subscribe to an event
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    } else {
      throw new Error(`Unknown event: ${event}`);
    }
  }


  // Emit an event to all registered listeners
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in ${event} listener:`, error);
        }
      });
    }
  }

  // Unsubscribe from an event
  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback);
      if (index > -1) {
        this.listeners[event].splice(index, 1);
      }
    }
  }

  // Connect to OpenAI Realtime API WebSocket
  async connect() {
    if (this.isConnected) {
      console.warn('Already connected to OpenAI Realtime API');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'OpenAI-Beta': OPENAI_BETA_HEADER
          }
        });

        this.ws.on('open', () => {
          console.log('Connected to OpenAI Realtime API');
          this.isConnected = true;
          this.stats.startTime = Date.now();

          // Initialize the transcription session with our config
          setTimeout(() => this.initializeSession(), 100); // Small delay to ensure session is ready

          this.emit('connected', { sessionId: this.id });
          resolve();
        });

        // Handle incoming messages from OpenAI
        this.ws.on('message', (data) => {
          this.stats.messagesReceived++;
          try {
            const message = JSON.parse(data.toString());
            
            // Only log important events or when in debug mode
            const importantEvents = [
              'error',
              'conversation.item.input_audio_transcription.completed',
              'transcription_session.created',
              'transcription_session.updated'
            ];
            
            if (importantEvents.includes(message.type) || this.debug) {
              console.log('Received:', message.type);
            }
            
            if (this.debug || message.type === 'error') {
              console.log('Full message:', JSON.stringify(message, null, 2));
            }
            
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing message:', error);
          }
        });

        // Handle WebSocket errors
        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error.message);
          this.stats.errors++;
          this.emit('error', error);
          reject(error);  // Reject the connection promise
        });

        // Handle connection closing
        this.ws.on('close', (code, reason) => {
          console.log(`Disconnected: ${code} - ${reason}`);
          this.isConnected = false;
          this.ws = null;
          this.emit('disconnected', { code, reason: reason.toString() });
        });

      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  // Initialize the transcription session with our configuration
  initializeSession() {
    // Use transcription_session.update with session wrapper (based on working test)
    const sessionConfig = {
      type: 'transcription_session.update',
      session: {
        input_audio_format: this.inputAudioFormat,
        input_audio_transcription: {
          model: this.model,
          prompt: this.transcriptionPrompt || '',
          language: this.language
        }
      }
    };

    // Add VAD config if enabled (inside session object)
    if (this.vadEnabled) {
      if (this.vadType === 'semantic_vad') {
        // Semantic VAD configuration for transcription mode
        sessionConfig.session.turn_detection = {
          type: 'semantic_vad',
          eagerness: this.vadEagerness
          // Note: create_response and interrupt_response are only for conversation mode
        };
      } else {
        // Server VAD configuration
        sessionConfig.session.turn_detection = {
          type: 'server_vad',
          threshold: this.vadThreshold,
          prefix_padding_ms: this.vadPrefixPaddingMs,
          silence_duration_ms: this.vadSilenceDurationMs
        };
      }
    }

    // Add noise reduction if configured
    if (this.inputAudioNoiseReductionType) {
      sessionConfig.session.input_audio_noise_reduction = {
        type: this.inputAudioNoiseReductionType
      };
    }

    // Add include array if we want logprobs
    if (this.includeLogprobs) {
      sessionConfig.session.include = ['item.input_audio_transcription.logprobs'];
    }

    console.log('Sending transcription_session.update to configure model...');
    this.ws.send(JSON.stringify(sessionConfig));
  }

  // Handle incoming messages from OpenAI
  handleMessage(message) {
    // Based on the docs, we only handle transcription-specific events
    switch (message.type) {
      case 'transcription_session.created':
        // Session ID is in message.session.id based on the logs
        this.sessionId = message.session?.id || message.id;
        console.log('Transcription session created:', this.sessionId);
        if (this.debug) {
          console.log('Session details:', message);
        }
        break;

      case 'transcription_session.updated':
        console.log('Transcription session configuration updated');
        break;

      case 'session.created':
        // Handle regular session created (in case of transcription intent)
        this.sessionId = message.session?.id;
        console.log('Session created:', this.sessionId);
        break;

      case 'session.updated':
        console.log('Session configuration updated');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        // From docs: contains partial transcription
        this.emit('transcriptionDelta', {
          text: message.delta,
          itemId: message.item_id,
          contentIndex: message.content_index
        });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // From docs: contains final transcription
        this.stats.transcriptionsReceived++;
        this.emit('transcriptionComplete', {
          text: message.transcript,
          itemId: message.item_id,
          previousItemId: this.previousItemId,
          contentIndex: message.content_index
        });
        break;

      case 'input_audio_buffer.committed':
        // Track item for ordering
        this.previousItemId = message.previous_item_id || null;
        this.currentItemId = message.item_id;
        break;

      case 'input_audio_buffer.speech_started':
        // VAD detected speech start
        if (this.debug) {
          console.log(`Speech started at ${message.audio_start_ms}ms`);
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        // VAD detected speech stopped - transcription will follow
        if (this.debug) {
          console.log(`Speech stopped at ${message.audio_end_ms}ms`);
        }
        break;

      case 'conversation.item.created':
        // In transcription mode, these are created but don't contain transcripts
        // The actual transcription comes in the input_audio_transcription events
        // We can safely ignore these in transcription-only mode
        if (this.debug) {
          console.log('Item created (no transcript in transcription mode):', message.item?.id);
        }
        break;

      case 'error':
        this.stats.errors++;
        console.error('OpenAI error:', message.error);
        this.emit('error', new Error(message.error?.message || 'Unknown error'));
        break;

      default:
        if (this.debug) {
          console.log('Unhandled message type:', message.type);
        }
    }
  }

  // Process audio chunk from your audio source (e.g., Pexip)
  async processAudioChunk(audioData) {
    if (!this.isConnected) {
      throw new Error('Not connected to OpenAI');
    }

    // Validate audio data
    if (!audioData.samples || !audioData.sampleRate) {
      throw new Error('Invalid audio data');
    }

    // Check if we need to resample (OpenAI requires 24kHz)
    let samples = audioData.samples;
    if (audioData.sampleRate !== OPENAI_REQUIRED_SAMPLE_RATE) {
      samples = resampleAudio(audioData.samples, audioData.sampleRate, OPENAI_REQUIRED_SAMPLE_RATE);
    }

    // Buffer the audio
    this.audioBuffer.push(samples);

    // Send when we have enough buffered
    const totalSamples = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSamples >= this.bufferSize) {
      this.sendBufferedAudio();
    }
  }

  // Send buffered audio to OpenAI
  sendBufferedAudio() {
    if (this.audioBuffer.length === 0) return;

    // Combine all buffered chunks
    const totalLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const combinedSamples = new Int16Array(totalLength);
    
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      combinedSamples.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to base64
    const buffer = Buffer.from(combinedSamples.buffer);
    const base64Audio = buffer.toString('base64');

    // Send to OpenAI using input_audio_buffer.append
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    }));

    // Update stats and clear buffer
    this.stats.audioBytesSent += buffer.length;
    this.audioBuffer = [];
  }

  // Commit audio buffer to trigger transcription
  commitAudioBuffer() {
    if (!this.isConnected) return;

    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.commit'
    }));
  }

  // Disconnect from OpenAI
  async disconnect() {
    if (!this.isConnected) return;

    // Send any remaining buffered audio
    if (this.audioBuffer.length > 0) {
      this.sendBufferedAudio();
      this.commitAudioBuffer();
    }

    // Close WebSocket
    return new Promise((resolve) => {
      this.ws.once('close', () => {
        resolve();
      });
      this.ws.close();
    });
  }

  // Get current statistics
  getStats() {
    const runtime = this.stats.startTime ? 
      (Date.now() - this.stats.startTime) / 1000 : 0;
    
    return {
      ...this.stats,
      runtime,
      isConnected: this.isConnected,
      sessionId: this.sessionId
    };
  }
}