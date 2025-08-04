import WebSocket from 'ws';
import { resampleAudio } from '../../utils/AudioResampler.js';

/**
 * OpenAI Realtime API transcription service
 * Handles WebSocket connection and audio streaming to OpenAI
 */
export class OpenAITranscriptionService {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    // Configuration
    this.model = config.model || 'gpt-4o-transcribe';
    this.language = config.language || 'en';
    this.wsUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
    this.includeLogprobs = config.includeLogprobs || false;
    this.debug = config.debug || process.env.DEBUG_OPENAI === 'true';
    
    // WebSocket state
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.resampleLogged = false;
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      transcriptionsCompleted: 0,
      errors: 0,
      audioBytesSent: 0,
      startTime: null
    };
    
    // Event listeners
    this.listeners = {
      transcriptionDelta: [],
      transcriptionComplete: [],
      error: [],
      connected: [],
      disconnected: [],
      speechStarted: [],
      speechStopped: []
    };
    
    // VAD configuration (disable if threshold is 0)
    this.vadConfig = (config.vadThreshold === 0 || config.vadSilenceDuration === 0) 
      ? null
      : {
          type: 'server_vad',
          threshold: config.vadThreshold || 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: config.vadSilenceDuration || 500
        };
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    if (this.isConnected) return;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          },
          perMessageDeflate: false
        });

        this.ws.on('open', () => {
          console.log('🔌 Connected to OpenAI Realtime API');
          this.isConnected = true;
          this.stats.startTime = new Date();
          this.initializeSession();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          this.stats.messagesReceived++;
          
          if (this.debug) {
            console.log(`📥 OpenAI Event [${message.type}]:`, 
              message.type.includes('audio') ? '(audio data)' : JSON.stringify(message).slice(0, 200));
          }
          
          this.handleMessage(message);
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.emit('disconnected', { code, reason: reason.toString() });
        });

      } catch (error) {
        console.error('Failed to connect to OpenAI:', error);
        reject(error);
      }
    });
  }

  /**
   * Initialize OpenAI session for transcription
   */
  initializeSession() {
    // Build include array based on configuration
    const includeItems = [];
    if (this.includeLogprobs) {
      includeItems.push('item.input_audio_transcription.logprobs');
    }
    
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text'],  // Text only for transcription
        instructions: 'You are a helpful transcription assistant. Transcribe the audio accurately.',
        input_audio_format: 'pcm16',  // PCM16 format (will match actual sample rate)
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'gpt-4o-mini-transcribe',  // Use the mini transcribe model
          language: this.language || 'en',
          prompt: 'Transcribe the audio accurately.'
        },
        turn_detection: this.vadConfig,
        temperature: 0.6,  // Minimum for Realtime API
        max_response_output_tokens: 4096
      }
    };
    
    // Only add include if we have items
    if (includeItems.length > 0) {
      sessionUpdate.include = includeItems;
    }
    
    this.sendMessage(sessionUpdate);
  }

  /**
   * Process audio chunk from Pexip
   */
  async processAudioChunk(audioData) {
    if (!this.isConnected) {
      throw new Error('Not connected to OpenAI');
    }

    // Validate audio data
    if (!audioData.samples || !audioData.sampleRate) {
      throw new Error('Invalid audio data: missing samples or sampleRate');
    }

    // Resample to 24kHz - OpenAI Realtime API expects 24kHz for pcm16
    let samples = audioData.samples;
    if (audioData.sampleRate === 48000) {
      samples = resampleAudio(audioData.samples, 48000, 24000);
      if (!this.resampleLogged) {
        console.log('📊 Resampling audio from 48kHz to 24kHz for OpenAI');
        this.resampleLogged = true;
      }
    } else if (audioData.sampleRate === 16000) {
      // Upsample from 16kHz to 24kHz as required by OpenAI Realtime
      samples = resampleAudio(audioData.samples, 16000, 24000);
      if (!this.resampleLogged) {
        console.log('📊 Resampling audio from 16kHz to 24kHz for OpenAI');
        this.resampleLogged = true;
      }
    } else if (audioData.sampleRate !== 24000) {
      console.warn(`⚠️ Unexpected sample rate: ${audioData.sampleRate}Hz`);
    }
    
    // Convert to PCM16 buffer
    const pcmBuffer = Buffer.from(samples.buffer);
    
    // Send to OpenAI
    this.sendAudioData(pcmBuffer);
  }

  /**
   * Send audio data to OpenAI
   */
  sendAudioData(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const base64Audio = buffer.toString('base64');
    this.stats.audioBytesSent += buffer.length;
    
    if (this.debug) {
      console.log(`📤 Sending audio: ${buffer.length} bytes`);
    }
    
    this.sendMessage({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  /**
   * Commit audio buffer for transcription
   * Note: Only needed when VAD is disabled
   */
  commitAudioBuffer() {
    if (!this.isConnected) return;
    
    // Only commit if VAD is disabled
    if (this.vadConfig) {
      console.log('Skipping manual commit - VAD is enabled');
      return;
    }
    
    this.sendMessage({
      type: 'input_audio_buffer.commit'
    });
  }

  /**
   * Send message to OpenAI
   */
  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Handle incoming messages from OpenAI
   */
  handleMessage(message) {
    switch (message.type) {
      case 'session.created':
        this.sessionId = message.session?.id;
        console.log(`✅ Session created: ${this.sessionId}`);
        if (this.debug) {
          console.log('  Session config:', JSON.stringify(message.session, null, 2));
        }
        break;

      case 'session.updated':
        console.log('✅ Session configuration updated');
        if (this.debug && message.session) {
          console.log('  Updated config:', JSON.stringify(message.session, null, 2));
        }
        break;
        
      case 'input_audio_buffer.speech_started':
        console.log('🎤 Speech detected - started');
        this.emit('speechStarted');
        break;
        
      case 'input_audio_buffer.speech_stopped':
        console.log('🔇 Speech stopped');
        this.emit('speechStopped');
        break;
        
      case 'input_audio_buffer.committed':
        console.log('📝 Audio buffer committed for transcription');
        break;
        
      case 'input_audio_buffer.cleared':
        if (this.debug) {
          console.log('🗑️ Audio buffer cleared');
        }
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (this.debug) {
          console.log(`📝 Transcription delta: "${message.delta}"`);
        }
        this.emit('transcriptionDelta', {
          text: message.delta,
          itemId: message.item_id,
          logprobs: message.logprobs
        });
        break;
        
      case 'conversation.item.input_audio_transcription.completed':
        if (message.transcript) {
          this.stats.transcriptionsCompleted++;
          console.log(`✅ Transcription complete: "${message.transcript}"`);
          
          const transcriptionData = {
            text: message.transcript,
            itemId: message.item_id
          };
          
          // Add logprobs if available
          if (message.logprobs) {
            transcriptionData.logprobs = message.logprobs;
            if (this.debug) {
              // Calculate average confidence if logprobs available
              const avgLogprob = message.logprobs.reduce((sum, lp) => sum + lp.logprob, 0) / message.logprobs.length;
              const confidence = Math.exp(avgLogprob) * 100;
              console.log(`  Confidence: ${confidence.toFixed(1)}%`);
            }
          }
          
          this.emit('transcriptionComplete', transcriptionData);
        }
        break;
        
      case 'conversation.item.input_audio_transcription.failed':
        this.stats.errors++;
        console.error('❌ Transcription failed:', message.error);
        this.emit('error', new Error(message.error?.message || 'Transcription failed'));
        break;
        
      case 'conversation.item.created':
        if (this.debug) {
          console.log(`🆕 Conversation item created: ${message.item?.type || 'unknown'}`);
        }
        break;

      case 'error':
        const errorMsg = message.error?.message || 'Unknown error';
        const errorCode = message.error?.code;
        const errorType = message.error?.type;
        
        // Don't emit error for empty buffer when VAD is enabled
        if (errorCode === 'buffer_too_small' && this.vadConfig) {
          if (this.debug) {
            console.log('ℹ️ Ignoring buffer_too_small - VAD is handling commits');
          }
          return;
        }
        
        this.stats.errors++;
        console.error(`❌ OpenAI Error [${errorType}]:`, errorMsg);
        if (errorCode) console.error(`  Code: ${errorCode}`);
        if (message.error?.param) console.error(`  Param: ${message.error.param}`);
        if (message.error?.event_id) console.error(`  Caused by event: ${message.error.event_id}`);
        
        const error = new Error(errorMsg);
        error.code = errorCode;
        error.type = errorType;
        this.emit('error', error);
        break;

      default:
        // Ignore response events in transcription-only mode
        if (!message.type.startsWith('response.') && 
            !message.type.startsWith('rate_limits.') &&
            message.type !== 'conversation.item.created') {
          if (process.env.DEBUG_OPENAI === 'true') {
            console.log(`Unknown event: ${message.type}`);
          }
        }
        break;
    }
  }

  /**
   * Disconnect from OpenAI
   */
  async disconnect() {
    if (!this.isConnected || !this.ws) return;

    // Log statistics
    if (this.stats.startTime) {
      const duration = (new Date() - this.stats.startTime) / 1000;
      console.log('\n📊 OpenAI Session Statistics:');
      console.log(`  Duration: ${duration.toFixed(1)}s`);
      console.log(`  Messages received: ${this.stats.messagesReceived}`);
      console.log(`  Transcriptions completed: ${this.stats.transcriptionsCompleted}`);
      console.log(`  Audio sent: ${(this.stats.audioBytesSent / 1024).toFixed(1)} KB`);
      console.log(`  Errors: ${this.stats.errors}`);
    }

    return new Promise((resolve) => {
      this.ws.on('close', () => {
        this.isConnected = false;
        this.ws = null;
        this.sessionId = null;
        resolve();
      });

      this.ws.close();
    });
  }

  // Event handling
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback);
      if (index > -1) {
        this.listeners[event].splice(index, 1);
      }
    }
  }

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
  
  /**
   * Get current session statistics
   */
  getStats() {
    const runtime = this.stats.startTime ? 
      (new Date() - this.stats.startTime) / 1000 : 0;
    
    return {
      ...this.stats,
      runtime,
      isConnected: this.isConnected,
      sessionId: this.sessionId
    };
  }
  
  /**
   * Enable or disable debug logging
   */
  setDebug(enabled) {
    this.debug = enabled;
    console.log(`🔧 OpenAI debug logging ${enabled ? 'enabled' : 'disabled'}`);
  }
}