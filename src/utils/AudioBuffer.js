import fs from 'fs';
import path from 'path';

export class AudioBuffer {
  constructor(config = {}) {
    this.sampleRate = config.sampleRate || 48000;
    this.targetDurationMs = config.targetDurationMs || 1000; // 1 second chunks by default
    this.targetSamples = Math.floor(this.sampleRate * (this.targetDurationMs / 1000));
    this.buffer = [];
    this.trackId = config.trackId;
    this.saveToFile = config.saveToFile || false;
    this.outputDir = config.outputDir || './output';
    
    // Statistics
    this.stats = {
      totalSamples: 0,
      chunksCreated: 0,
      startTime: Date.now(),
      lastChunkTime: null
    };
    
    if (this.saveToFile) {
      this.ensureOutputDir();
    }
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  addSamples(samples) {
    // Add new samples to buffer
    this.buffer.push(...samples);
    this.stats.totalSamples += samples.length;
    
    // Check if we have enough samples for a chunk
    if (this.buffer.length >= this.targetSamples) {
      return this.createChunk();
    }
    
    return null;
  }

  createChunk() {
    // Extract target number of samples
    const chunkSamples = this.buffer.splice(0, this.targetSamples);
    const chunk = new Int16Array(chunkSamples);
    
    this.stats.chunksCreated++;
    this.stats.lastChunkTime = Date.now();
    
    const chunkData = {
      samples: chunk,
      sampleRate: this.sampleRate,
      duration: this.targetDurationMs,
      timestamp: Date.now(),
      chunkNumber: this.stats.chunksCreated,
      trackId: this.trackId
    };
    
    if (this.saveToFile) {
      this.saveChunkToFile(chunkData);
    }
    
    return chunkData;
  }

  saveChunkToFile(chunkData) {
    const filename = `${this.trackId}_chunk_${String(chunkData.chunkNumber).padStart(6, '0')}.pcm`;
    const filepath = path.join(this.outputDir, filename);
    
    // Convert Int16Array to Buffer and save
    const buffer = Buffer.from(chunkData.samples.buffer);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`Saved chunk ${chunkData.chunkNumber} to ${filename}`);
  }

  flush() {
    if (this.buffer.length > 0) {
      const remainingSamples = new Int16Array(this.buffer);
      this.buffer = [];
      
      const chunkData = {
        samples: remainingSamples,
        sampleRate: this.sampleRate,
        duration: (remainingSamples.length / this.sampleRate) * 1000,
        timestamp: Date.now(),
        chunkNumber: this.stats.chunksCreated + 1,
        trackId: this.trackId,
        isFinal: true
      };
      
      if (this.saveToFile) {
        this.saveChunkToFile(chunkData);
      }
      
      return chunkData;
    }
    
    return null;
  }

  getStats() {
    const runtime = Date.now() - this.stats.startTime;
    const expectedSamples = Math.floor((runtime / 1000) * this.sampleRate);
    const efficiency = this.stats.totalSamples / expectedSamples;
    
    return {
      ...this.stats,
      runtime,
      expectedSamples,
      efficiency: Math.min(efficiency, 1.0),
      bufferSize: this.buffer.length,
      secondsProcessed: this.stats.totalSamples / this.sampleRate
    };
  }

  reset() {
    this.buffer = [];
    this.stats = {
      totalSamples: 0,
      chunksCreated: 0,
      startTime: Date.now(),
      lastChunkTime: null
    };
  }
}

// Utility function to convert PCM to WAV
export function pcmToWav(pcmData, sampleRate = 48000, bitsPerSample = 16, channels = 1) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  
  const buffer = Buffer.alloc(bufferSize);
  
  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(bufferSize - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  // Copy PCM data
  const pcmBuffer = Buffer.from(pcmData.buffer);
  pcmBuffer.copy(buffer, 44);
  
  return buffer;
}