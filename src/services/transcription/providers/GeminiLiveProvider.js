import WebSocket from 'ws';
import { resampleAudio } from '../../../utils/AudioResampler.js';
import { AudioValidator } from '../../../utils/AudioValidator.js';

/**
 * Google Gemini Live API transcription provider
 * Handles WebSocket connection and audio streaming to Gemini
 */
export class GeminiLiveProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    if (!this.apiKey) {
      throw new Error('Gemini API key is required');
    }

    // Configuration
    this.model = config.model || 'gemini-live-2.5-flash-preview';
    this.language = config.language || 'en-US';
    this.wsUrl = `wss://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    this.debug = config.debug || process.env.DEBUG_GEMINI === 'true';
    
    // WebSocket state
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    
    // Audio buffering
    this.audioBuffer = [];
    this.bufferSize = 16000 * 0.1; // 100ms of audio at 16kHz
    this.lastSendTime = Date.now();
    
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
  }

  /**
   * Connect to Gemini Live API
   */
  async connect() {
    if (this.isConnected) return;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          console.log('Connected to Gemini Live API');
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
            console.log(`Gemini Event:`, JSON.stringify(message).slice(0, 200));
          }
          
          this.handleMessage(message);
        });

        this.ws.on('error', (error) => {
          console.error('Gemini WebSocket error:', error.message);
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`Gemini WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.emit('disconnected', { code, reason: reason.toString() });
        });

      } catch (error) {
        console.error('Failed to connect to Gemini:', error);
        reject(error);
      }
    });
  }

  /**
   * Initialize Gemini session for transcription
   */
  initializeSession() {
    const setupMessage = {
      setup: {
        model: this.model,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: {},
          speechConfig: {
            languageCode: this.language
          }
        }
      }
    };
    
    this.sendMessage(setupMessage);
  }

  /**
   * Process audio chunk from Pexip
   */
  async processAudioChunk(audioData) {
    if (!this.isConnected) {
      throw new Error('Not connected to Gemini');
    }

    // Validate audio data
    if (!audioData.samples || !audioData.sampleRate) {
      throw new Error('Invalid audio data: missing samples or sampleRate');
    }

    // Gemini expects 16kHz audio (will resample if needed but native is 16kHz)
    let samples = audioData.samples;
    const targetRate = 16000;
    
    if (audioData.sampleRate !== targetRate) {
      samples = resampleAudio(audioData.samples, audioData.sampleRate, targetRate);
      
      if (!this.resampleLogged) {
        console.log(`Resampling for Gemini: ${audioData.sampleRate}Hz \u2192 ${targetRate}Hz`);
        this.resampleLogged = true;
      }
    }
    
    // Buffer audio chunks
    this.audioBuffer.push(samples);
    
    // Calculate total buffered samples
    const totalSamples = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    
    // Send when we have enough audio (100ms worth) or every 100ms
    const now = Date.now();
    if (totalSamples >= this.bufferSize || (now - this.lastSendTime) > 100) {
      // Combine all buffered chunks
      const combinedLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedSamples = new Int16Array(combinedLength);
      
      let offset = 0;
      for (const chunk of this.audioBuffer) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Convert to PCM16 buffer
      const pcmBuffer = Buffer.from(combinedSamples.buffer);
      
      // Send to Gemini
      this.sendAudioData(pcmBuffer);
      
      // Clear buffer
      this.audioBuffer = [];
      this.lastSendTime = now;
    }
  }

  /**
   * Send audio data to Gemini
   */
  sendAudioData(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot send audio - Gemini WebSocket not open');
      return;
    }

    const base64Audio = buffer.toString('base64');
    this.stats.audioBytesSent += buffer.length;
    
    const message = {
      sendRealtimeInput: {
        audio: {
          data: base64Audio,
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    };
    
    this.sendMessage(message);
  }

  /**
   * Send message to Gemini
   */
  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Handle incoming messages from Gemini
   */
  handleMessage(message) {
    // Handle setup confirmation
    if (message.setupComplete) {
      console.log('Gemini session initialized');
      return;
    }

    // Handle server content (transcriptions)
    if (message.serverContent) {
      // Input transcription (what was said)
      if (message.serverContent.inputTranscription) {
        const transcription = message.serverContent.inputTranscription;
        console.log(`Gemini Transcription: "${transcription.text}"`);
        
        this.stats.transcriptionsCompleted++;
        this.emit('transcriptionComplete', {
          text: transcription.text,
          confidence: transcription.confidence
        });
      }

      // Turn complete
      if (message.serverContent.turnComplete) {
        if (this.debug) {
          console.log('Turn complete');
        }
      }

      // Handle interruptions
      if (message.serverContent.interrupted) {
        console.log('Speech interrupted');
        this.emit('speechStopped');
      }
    }

    // Handle text responses (model output)
    if (message.text) {
      // For transcription-only mode, we might not want model responses
      if (this.debug) {
        console.log(`Model response: ${message.text}`);
      }
    }

    // Handle errors
    if (message.error) {
      this.stats.errors++;
      console.error('Gemini Error:', message.error);
      this.emit('error', new Error(message.error.message || 'Gemini error'));
    }
  }

  /**
   * Disconnect from Gemini
   */
  async disconnect() {
    if (!this.isConnected || !this.ws) return;

    // Log statistics
    if (this.stats.startTime) {
      const duration = (new Date() - this.stats.startTime) / 1000;
      console.log('\nGemini Session Statistics:');
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
}