import fs from 'fs';
import path from 'path';

// Test script to check if audio files have actual content

function analyzeWavFile(filepath) {
  console.log(`\nAnalyzing: ${filepath}`);
  
  const buffer = fs.readFileSync(filepath);
  
  // Skip WAV header (44 bytes)
  const headerSize = 44;
  const dataSize = buffer.length - headerSize;
  
  console.log(`  File size: ${buffer.length} bytes`);
  console.log(`  Audio data size: ${dataSize} bytes`);
  console.log(`  Samples: ${dataSize / 2} (16-bit)`);
  
  // Read PCM data as Int16Array
  const pcmData = new Int16Array(buffer.buffer, buffer.byteOffset + headerSize, dataSize / 2);
  
  // Analyze the audio
  let maxValue = 0;
  let minValue = 0;
  let nonZeroCount = 0;
  let totalAbsolute = 0;
  
  for (let i = 0; i < pcmData.length; i++) {
    const sample = pcmData[i];
    if (sample !== 0) nonZeroCount++;
    if (sample > maxValue) maxValue = sample;
    if (sample < minValue) minValue = sample;
    totalAbsolute += Math.abs(sample);
  }
  
  const avgAmplitude = totalAbsolute / pcmData.length;
  const percentNonZero = (nonZeroCount / pcmData.length * 100).toFixed(2);
  
  console.log(`  Max value: ${maxValue} (${(maxValue / 32768 * 100).toFixed(1)}%)`);
  console.log(`  Min value: ${minValue} (${(minValue / 32768 * 100).toFixed(1)}%)`);
  console.log(`  Average amplitude: ${avgAmplitude.toFixed(2)}`);
  console.log(`  Non-zero samples: ${nonZeroCount} (${percentNonZero}%)`);
  
  // Show first 20 samples
  const preview = Array.from(pcmData.slice(0, 20));
  console.log(`  First 20 samples: [${preview.join(', ')}]`);
  
  if (maxValue === 0 && minValue === 0) {
    console.log('  ERROR: This file contains only silence!');
  } else if (avgAmplitude < 10) {
    console.log('  WARNING: This file is extremely quiet');
  } else {
    console.log('  OK: This file contains audio');
  }
  
  return {
    filepath,
    hasAudio: maxValue !== 0 || minValue !== 0,
    maxValue,
    avgAmplitude
  };
}

// Check all WAV files in output directory
const wavDir = './output/wav';
if (fs.existsSync(wavDir)) {
  const files = fs.readdirSync(wavDir).filter(f => f.endsWith('.wav'));
  
  console.log(`Found ${files.length} WAV files to analyze\n`);
  console.log('=' .repeat(60));
  
  const results = files.map(file => {
    return analyzeWavFile(path.join(wavDir, file));
  });
  
  console.log('\n' + '=' .repeat(60));
  console.log('SUMMARY:');
  
  const withAudio = results.filter(r => r.hasAudio).length;
  const silent = results.filter(r => !r.hasAudio).length;
  
  console.log(`  Files with audio: ${withAudio}`);
  console.log(`  Silent files: ${silent}`);
  
  if (silent === files.length) {
    console.log('\nERROR: ALL FILES ARE SILENT - No audio was captured!');
    console.log('\nPossible causes:');
    console.log('  1. Participants were muted');
    console.log('  2. RTCAudioSink is not receiving data correctly');
    console.log('  3. Audio is being sent but not mixed properly');
    console.log('  4. Conference audio mix is empty');
  }
} else {
  console.log('No WAV files found in ./output/wav');
}