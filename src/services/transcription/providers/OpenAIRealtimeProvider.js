import WebSocket from 'ws';
import { BaseTranscriptionProvider } from '../BaseTranscriptionProvider.js';

export class OpenAIRealtimeProvider extends BaseTranscriptionProvider {
  constructor(config = {}) {
    super(config);
    
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    this.model = config.model || 'gpt-4o-transcribe';
    this.language = config.language || 'en';
    this.prompt = config.prompt || '';
    this.wsUrl = config.wsUrl || 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
    
    this.ws = null;
    this.sessionId = null;
    this.currentItemId = null;
    this.audioBuffer = [];
    this.bufferInterval = null;
    this.bufferSendRate = config.bufferSendRate || 100;
    this.sendDirectly = config.sendDirectly !== false;
    
    this.vadConfig = {
      type: 'server_vad',
      threshold: config.vadThreshold || 0.5,
      prefix_padding_ms: config.vadPrefixPadding || 300,
      silence_duration_ms: config.vadSilenceDuration || 500
    };
    
    this.noiseReduction = config.noiseReduction || 'near_field';
    this.includeLogprobs = config.includeLogprobs || false;
  }

  getInfo() {
    return {
      name: 'openai-realtime',
      version: '1.0.0',
      description: 'OpenAI Realtime API transcription provider'
    };
  }

  getCapabilities() {
    return {
      supportsRealtime: true,
      supportsDiarization: false,
      supportsLanguageDetection: false,
      supportedLanguages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'],
      supportedSampleRates: [16000, 24000, 48000],
      supportsInterimResults: true,
      requiresAudioFormat: 'pcm16',
      maxChunkDuration: null,
      minChunkDuration: null
    };
  }

  async connect() {
    if (this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const headers = {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        };

        this.ws = new WebSocket(this.wsUrl, {
          headers,
          perMessageDeflate: false
        });

        this.ws.on('open', () => {
          console.log('Connected to OpenAI Realtime API');
          this.isConnected = true;
          this.initializeSession();
          if (!this.sendDirectly) {
            this.startBufferSender();
          }
          this.emit('connected', { provider: this.getInfo().name });
          resolve();
        });

        this.ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (process.env.DEBUG_OPENAI === 'true') {
            console.log('[OpenAI Message]', message.type, message);
          }
          this.handleMessage(message);
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.emitError(error);
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.stopBufferSender();
          this.emit('disconnected', { 
            provider: this.getInfo().name,
            code,
            reason: reason.toString()
          });
        });

      } catch (error) {
        console.error('Failed to connect to OpenAI Realtime API:', error);
        reject(error);
      }
    });
  }

  async disconnect() {
    if (!this.isConnected || !this.ws) {
      return;
    }

    this.stopBufferSender();
    
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

  initializeSession() {
    // For transcription-only mode, we need to send BOTH messages
    // First, update the session for basic config
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: 'Transcribe the audio accurately.',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: this.vadConfig,
        temperature: 0.6
      }
    };
    
    this.sendMessage(sessionUpdate);
  }

  startBufferSender() {
    this.bufferInterval = setInterval(() => {
      if (this.audioBuffer.length > 0) {
        const audioData = this.audioBuffer.shift();
        this.sendAudioData(audioData);
      }
    }, this.bufferSendRate);
  }

  stopBufferSender() {
    if (this.bufferInterval) {
      clearInterval(this.bufferInterval);
      this.bufferInterval = null;
    }
  }

  async processAudioChunk(audioData) {
    if (!this.isConnected) {
      throw new Error('Not connected to OpenAI Realtime API');
    }

    this.validateAudioData(audioData);
    
    const pcmBuffer = this.convertAudioFormat(audioData.samples, 'pcm16');
    
    if (this.sendDirectly) {
      // Send audio directly to OpenAI's buffer
      this.sendAudioData({
        buffer: pcmBuffer,
        speaker: audioData.speaker,
        timestamp: audioData.timestamp
      });
    } else {
      // Queue for later sending
      this.audioBuffer.push({
        buffer: pcmBuffer,
        speaker: audioData.speaker,
        timestamp: audioData.timestamp
      });
    }
  }

  sendAudioData(audioData) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const base64Audio = audioData.buffer.toString('base64');
    
    this.sendMessage({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'session.created':
        this.sessionId = message.session ? message.session.id : message.id;
        console.log(`Session created: ${this.sessionId}`);
        break;

      case 'session.updated':
        console.log('Session configuration updated');
        break;
        
      case 'input_audio_buffer.speech_started':
        this.emit('speechStarted');
        break;
        
      case 'input_audio_buffer.speech_stopped':
        this.emit('speechStopped');
        break;

      case 'input_audio_buffer.committed':
        this.currentItemId = message.item_id;
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.handleTranscriptionDelta(message);
        break;
        
      case 'conversation.item.input_audio_transcription.completed':
        this.handleTranscriptionCompleted(message);
        break;
        
      case 'conversation.item.input_audio_transcription.failed':
        console.log('Transcription failed:', message.error);
        this.emitError(new Error(`Transcription failed: ${message.error?.message || 'Unknown error'}`));
        break;

      case 'conversation.item.created':
        // Track item creation but don't log in production
        break;
        
      case 'response.created':
      case 'response.done':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.text.delta':
      case 'response.text.done':
      case 'response.audio_transcript.delta':
      case 'response.audio_transcript.done':
      case 'response.audio.delta':
      case 'response.audio.done':
      case 'rate_limits.updated':
        // These are response/system events, not needed for transcription-only mode
        break;

      case 'error':
        this.handleError(message);
        break;

      default:
        // Only log unknown events in debug mode
        if (process.env.DEBUG_OPENAI === 'true' && !message.type.startsWith('response.')) {
          console.log(`Unknown event type: ${message.type}`);
        }
        break;
    }
  }

  handleAssistantMessage(message) {
    if (message.item.content && message.item.content.length > 0) {
      const textContent = message.item.content.find(c => c.type === 'input_text');
      if (textContent && textContent.text) {
        this.emitTranscriptionComplete({
          itemId: message.item.id,
          text: textContent.text,
          eventId: message.event_id
        });
      }
    }
  }

  handleAudioCommitted(message) {
    this.currentItemId = message.item_id;
    console.log(`Audio buffer committed: ${message.item_id}`);
  }

  handleTranscriptionDelta(message) {
    const delta = {
      itemId: message.item_id,
      contentIndex: message.content_index,
      text: message.delta,
      eventId: message.event_id
    };

    if (message.logprobs) {
      delta.logprobs = message.logprobs;
    }

    this.emitTranscriptionDelta(delta);
  }

  handleTranscriptionCompleted(message) {
    const transcription = {
      itemId: message.item_id,
      contentIndex: message.content_index || 0,
      text: message.transcript || '',
      eventId: message.event_id
    };

    if (message.logprobs) {
      transcription.logprobs = message.logprobs;
    }

    if (transcription.text) {
      this.emitTranscriptionComplete(transcription);
    }
  }

  handleError(message) {
    const error = new Error(message.error.message || 'Unknown error');
    error.code = message.error.code || 'OPENAI_ERROR';
    error.type = message.error.type;
    error.param = message.error.param;
    
    this.emitError(error);
  }

  commitAudioBuffer() {
    if (!this.isConnected) {
      return;
    }

    this.sendMessage({
      type: 'input_audio_buffer.commit'
    });
  }

  clearAudioBuffer() {
    if (!this.isConnected) {
      return;
    }

    this.sendMessage({
      type: 'input_audio_buffer.clear'
    });
    
    this.audioBuffer = [];
  }

  updateSessionConfig(config) {
    if (!this.isConnected) {
      return;
    }

    const updateMessage = {
      type: 'transcription_session.update'
    };

    if (config.model) {
      updateMessage.input_audio_transcription = {
        ...updateMessage.input_audio_transcription,
        model: config.model
      };
    }

    if (config.language) {
      updateMessage.input_audio_transcription = {
        ...updateMessage.input_audio_transcription,
        language: config.language
      };
    }

    if (config.prompt) {
      updateMessage.input_audio_transcription = {
        ...updateMessage.input_audio_transcription,
        prompt: config.prompt
      };
    }

    if (config.vadConfig) {
      updateMessage.turn_detection = config.vadConfig;
    }

    if (config.noiseReduction) {
      updateMessage.input_audio_noise_reduction = {
        type: config.noiseReduction
      };
    }

    this.sendMessage(updateMessage);
  }
}