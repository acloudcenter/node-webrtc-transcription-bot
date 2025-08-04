/**
 * Base class for all transcription providers
 * All providers must implement these methods for consistent behavior
 */
export class BaseTranscriptionProvider {
  constructor(config = {}) {
    this.config = config;
    this.isConnected = false;
    this.listeners = {
      transcriptionDelta: [],
      transcriptionComplete: [],
      error: [],
      connected: [],
      disconnected: []
    };
  }

  /**
   * Connect to the transcription service
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('Provider must implement connect() method');
  }

  /**
   * Disconnect from the transcription service
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Provider must implement disconnect() method');
  }

  /**
   * Process an audio chunk
   * @param {Object} audioData - Audio data with samples, sampleRate, speaker info
   * @returns {Promise<void>}
   */
  async processAudioChunk(audioData) {
    throw new Error('Provider must implement processAudioChunk() method');
  }

  /**
   * Get provider capabilities
   * @returns {Object} Provider capabilities
   */
  getCapabilities() {
    return {
      supportsRealtime: false,
      supportsDiarization: false,
      supportsLanguageDetection: false,
      supportedLanguages: ['en'],
      supportedSampleRates: [16000, 48000],
      supportsInterimResults: false,
      requiresAudioFormat: 'pcm16',
      maxChunkDuration: null,
      minChunkDuration: null
    };
  }

  /**
   * Get provider information
   * @returns {Object} Provider metadata
   */
  getInfo() {
    return {
      name: 'base',
      version: '1.0.0',
      description: 'Base transcription provider'
    };
  }

  // Event handling methods

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

  // Helper methods for providers to use

  /**
   * Emit a transcription delta (partial result)
   * @param {Object} delta - Partial transcription data
   */
  emitTranscriptionDelta(delta) {
    const formattedDelta = {
      type: 'delta',
      timestamp: Date.now(),
      provider: this.getInfo().name,
      ...delta
    };
    this.emit('transcriptionDelta', formattedDelta);
  }

  /**
   * Emit a complete transcription
   * @param {Object} transcription - Complete transcription data
   */
  emitTranscriptionComplete(transcription) {
    const formattedTranscription = {
      type: 'complete',
      timestamp: Date.now(),
      provider: this.getInfo().name,
      ...transcription
    };
    this.emit('transcriptionComplete', formattedTranscription);
  }

  /**
   * Emit an error
   * @param {Error} error - Error object
   */
  emitError(error) {
    this.emit('error', {
      timestamp: Date.now(),
      provider: this.getInfo().name,
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }

  /**
   * Validate audio data format
   * @param {Object} audioData - Audio data to validate
   * @returns {boolean} True if valid
   */
  validateAudioData(audioData) {
    if (!audioData.samples || !audioData.sampleRate) {
      throw new Error('Invalid audio data: missing samples or sampleRate');
    }

    const capabilities = this.getCapabilities();
    
    if (capabilities.supportedSampleRates && 
        !capabilities.supportedSampleRates.includes(audioData.sampleRate)) {
      throw new Error(`Unsupported sample rate: ${audioData.sampleRate}. Supported: ${capabilities.supportedSampleRates.join(', ')}`);
    }

    return true;
  }

  /**
   * Convert PCM samples to required format
   * @param {Int16Array} samples - PCM samples
   * @param {string} targetFormat - Target format
   * @returns {Buffer} Converted audio data
   */
  convertAudioFormat(samples, targetFormat) {
    if (targetFormat === 'pcm16') {
      return Buffer.from(samples.buffer);
    }
    
    throw new Error(`Unsupported audio format conversion: ${targetFormat}`);
  }
}