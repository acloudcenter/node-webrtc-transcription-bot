import { AudioBuffer, pcmToWav } from '../utils/AudioBuffer.js';
import fs from 'fs';
import path from 'path';

export class AudioProcessor {
  constructor(config = {}) {
    this.buffers = new Map(); // Track ID -> AudioBuffer
    this.config = {
      saveRawPCM: config.saveRawPCM || false,
      saveWAV: config.saveWAV || false,
      outputDir: config.outputDir || './output',
      chunkDurationMs: config.chunkDurationMs || 1000,
      logStats: config.logStats || true,
      onChunkReady: config.onChunkReady || null
    };
    
    this.stats = {
      totalDataReceived: 0,
      totalChunksCreated: 0,
      activeTracks: new Set(),
      startTime: Date.now()
    };
    
    this.participantTracker = null; // Will be set by index.js
    this.ensureOutputDir();
  }
  
  setParticipantTracker(tracker) {
    this.participantTracker = tracker;
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  processAudioData(audioData) {
    const { trackId, samples, sampleRate, bitsPerSample, channelCount } = audioData;
    
    // Get or create buffer for this track
    if (!this.buffers.has(trackId)) {
      console.log(`Creating new audio buffer for track: ${trackId}`);
      this.buffers.set(trackId, new AudioBuffer({
        trackId,
        sampleRate,
        targetDurationMs: this.config.chunkDurationMs,
        saveToFile: this.config.saveRawPCM,
        outputDir: path.join(this.config.outputDir, 'pcm')
      }));
      this.stats.activeTracks.add(trackId);
    }
    
    const buffer = this.buffers.get(trackId);
    
    // Log first data reception for this track
    if (buffer.getStats().totalSamples === 0) {
      console.log(`First audio data received for track ${trackId}:`);
      console.log(`   Sample Rate: ${sampleRate} Hz`);
      console.log(`   Bits Per Sample: ${bitsPerSample}`);
      console.log(`   Channels: ${channelCount}`);
      console.log(`   Samples in chunk: ${samples.length}`);
      console.log(`   Duration: ${(samples.length / sampleRate * 1000).toFixed(2)} ms`);
      
      // Log first few samples for verification
      if (samples.length > 0) {
        const preview = Array.from(samples.slice(0, 10));
        console.log(`   First 10 samples: [${preview.join(', ')}]`);
        
        // Check if we're getting actual audio data (not silence)
        const maxValue = Math.max(...Array.from(samples).map(Math.abs));
        console.log(`   Max amplitude: ${maxValue} (${(maxValue / 32768 * 100).toFixed(1)}%)`);
        
        if (maxValue < 100) {
          console.log(`   Audio appears to be silent or very quiet`);
        } else {
          console.log(`   Audio signal detected`);
        }
      }
    }
    
    // Add samples to buffer
    const chunk = buffer.addSamples(samples);
    
    // Update stats
    this.stats.totalDataReceived += samples.length * 2; // 2 bytes per sample
    
    // If we have a complete chunk
    if (chunk) {
      this.stats.totalChunksCreated++;
      
      // Add speaker attribution if we have a participant tracker
      if (this.participantTracker) {
        const speaker = this.participantTracker.getSpeakerAtTime(chunk.timestamp);
        chunk.speaker = speaker;
        
        if (this.config.logStats) {
          console.log(`Chunk ${chunk.chunkNumber} ready for track ${trackId}`);
          console.log(`   Duration: ${chunk.duration}ms`);
          console.log(`   Samples: ${chunk.samples.length}`);
          console.log(`   Speaker: ${speaker.displayName} (confidence: ${Math.round(speaker.confidence * 100)}%)`);
        }
      } else {
        if (this.config.logStats) {
          console.log(`Chunk ${chunk.chunkNumber} ready for track ${trackId}`);
          console.log(`   Duration: ${chunk.duration}ms`);
          console.log(`   Samples: ${chunk.samples.length}`);
        }
      }
      
      // Save as WAV if configured
      if (this.config.saveWAV) {
        this.saveChunkAsWav(chunk);
      }
      
      // Call callback if provided
      if (this.config.onChunkReady) {
        this.config.onChunkReady(chunk);
      }
    }
    
    // Periodically log statistics
    if (this.stats.totalDataReceived % (sampleRate * 10 * 2) === 0) { // Every 10 seconds
      this.logStatistics();
    }
  }

  saveChunkAsWav(chunk) {
    const wavDir = path.join(this.config.outputDir, 'wav');
    if (!fs.existsSync(wavDir)) {
      fs.mkdirSync(wavDir, { recursive: true });
    }
    
    // Include speaker name in filename if available
    const speakerPart = chunk.speaker ? `_${chunk.speaker.displayName.replace(/[^a-zA-Z0-9]/g, '')}` : '';
    const filename = `${chunk.trackId}_chunk_${String(chunk.chunkNumber).padStart(6, '0')}${speakerPart}.wav`;
    const filepath = path.join(wavDir, filename);
    
    const wavBuffer = pcmToWav(chunk.samples, chunk.sampleRate);
    fs.writeFileSync(filepath, wavBuffer);
    
    console.log(`Saved WAV chunk to ${filename}`);
  }

  logStatistics() {
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    const mbReceived = this.stats.totalDataReceived / (1024 * 1024);
    
    console.log('\nAudio Processing Statistics:');
    console.log(`   Runtime: ${runtime.toFixed(1)} seconds`);
    console.log(`   Active tracks: ${this.stats.activeTracks.size}`);
    console.log(`   Total chunks created: ${this.stats.totalChunksCreated}`);
    console.log(`   Data received: ${mbReceived.toFixed(2)} MB`);
    console.log(`   Data rate: ${(mbReceived / runtime * 8).toFixed(2)} Mbps`);
    
    // Per-track statistics
    for (const [trackId, buffer] of this.buffers) {
      const stats = buffer.getStats();
      console.log(`\n   Track ${trackId}:`);
      console.log(`     Chunks: ${stats.chunksCreated}`);
      console.log(`     Seconds processed: ${stats.secondsProcessed.toFixed(1)}`);
      console.log(`     Efficiency: ${(stats.efficiency * 100).toFixed(1)}%`);
    }
    console.log('');
  }

  stopTrack(trackId) {
    if (this.buffers.has(trackId)) {
      const buffer = this.buffers.get(trackId);
      const finalChunk = buffer.flush();
      
      if (finalChunk) {
        console.log(`Final chunk for track ${trackId}: ${finalChunk.samples.length} samples`);
        
        if (this.config.saveWAV) {
          this.saveChunkAsWav(finalChunk);
        }
        
        if (this.config.onChunkReady) {
          this.config.onChunkReady(finalChunk);
        }
      }
      
      this.buffers.delete(trackId);
      this.stats.activeTracks.delete(trackId);
      console.log(`Stopped processing track ${trackId}`);
    }
  }

  stop() {
    console.log('Stopping audio processor...');
    
    // Flush all buffers
    for (const trackId of this.buffers.keys()) {
      this.stopTrack(trackId);
    }
    
    // Final statistics
    this.logStatistics();
    
    console.log('Audio processor stopped');
  }
}