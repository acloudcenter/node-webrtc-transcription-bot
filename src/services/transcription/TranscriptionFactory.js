import { OpenAITranscriptionService } from './OpenAITranscriptionService.js';
import { GeminiLiveProvider } from './providers/GeminiLiveProvider.js';

/**
 * Factory for creating transcription providers
 */
export class TranscriptionFactory {
  static create(provider = 'openai', config = {}) {
    const providerName = (provider || process.env.TRANSCRIPTION_PROVIDER || 'openai').toLowerCase();
    
    console.log(`Creating transcription provider: ${providerName}`);
    
    switch (providerName) {
      case 'openai':
        return new OpenAITranscriptionService(config);
        
      case 'gemini':
        return new GeminiLiveProvider(config);
        
      default:
        throw new Error(`Unknown transcription provider: ${providerName}. Supported: openai, gemini`);
    }
  }
  
  /**
   * Check if required API keys are present for the provider
   */
  static validateProvider(provider) {
    const providerName = (provider || process.env.TRANSCRIPTION_PROVIDER || 'openai').toLowerCase();
    
    switch (providerName) {
      case 'openai':
        if (!process.env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY is required for OpenAI provider');
        }
        break;
        
      case 'gemini':
        if (!process.env.GEMINI_API_KEY) {
          throw new Error('GEMINI_API_KEY is required for Gemini provider');
        }
        break;
    }
    
    return true;
  }
}