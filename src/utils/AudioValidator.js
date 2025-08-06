/**
 * Audio validation and debugging utilities
 */

export class AudioValidator {
  /**
   * Validate and log audio characteristics
   */
  static validateAudio(samples, expectedRate, location) {
    if (!samples || samples.length === 0) {
      console.error(`❌ [${location}] No audio samples!`);
      return false;
    }

    // Check if audio is silence
    const maxAmplitude = Math.max(...Array.from(samples.slice(0, Math.min(1000, samples.length))).map(Math.abs));
    const avgAmplitude = samples.slice(0, Math.min(1000, samples.length))
      .reduce((sum, sample) => sum + Math.abs(sample), 0) / Math.min(1000, samples.length);
    
    const info = {
      location,
      sampleCount: samples.length,
      maxAmplitude,
      avgAmplitude: avgAmplitude.toFixed(2),
      isSilence: maxAmplitude < 10,
      expectedRate
    };

    // Log validation
    if (info.isSilence) {
      console.log(`🔇 [${location}] Audio is SILENCE (max amplitude: ${maxAmplitude})`);
    } else {
      console.log(`✅ [${location}] Audio validated - ${samples.length} samples, amplitude: ${maxAmplitude}`);
    }

    return !info.isSilence;
  }

  /**
   * Log audio pipeline stage
   */
  static logPipelineStage(stage, data) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    console.log(`[${timestamp}] 🔊 ${stage}:`, {
      sampleRate: data.sampleRate,
      samples: data.samples?.length || 0,
      format: data.format || 'pcm16'
    });
  }

  /**
   * Calculate audio duration in seconds
   */
  static calculateDuration(sampleCount, sampleRate) {
    return (sampleCount / sampleRate).toFixed(2);
  }

  /**
   * Verify resampling worked correctly
   */
  static verifyResampling(originalSamples, originalRate, newSamples, newRate, location) {
    const originalDuration = this.calculateDuration(originalSamples.length, originalRate);
    const newDuration = this.calculateDuration(newSamples.length, newRate);
    
    const durationDiff = Math.abs(parseFloat(originalDuration) - parseFloat(newDuration));
    
    if (durationDiff > 0.1) { // More than 100ms difference
      console.warn(`⚠️ [${location}] Resampling duration mismatch!`);
      console.warn(`   Original: ${originalDuration}s at ${originalRate}Hz`);
      console.warn(`   Resampled: ${newDuration}s at ${newRate}Hz`);
      return false;
    }
    
    console.log(`✅ [${location}] Resampling verified: ${originalRate}Hz → ${newRate}Hz (${originalDuration}s)`);
    return true;
  }
}