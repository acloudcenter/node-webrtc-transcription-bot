export function downsample48to16(samples48k) {
  const ratio = 3;
  const outputLength = Math.floor(samples48k.length / ratio);
  const samples16k = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    samples16k[i] = samples48k[i * ratio];
  }
  
  return samples16k;
}

export function downsample48to24(samples48k) {
  const ratio = 2;  // 48kHz to 24kHz is divide by 2
  const outputLength = Math.floor(samples48k.length / ratio);
  const samples24k = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    samples24k[i] = samples48k[i * ratio];
  }
  
  return samples24k;
}

export function resampleAudio(samples, fromRate, toRate) {
  if (fromRate === toRate) {
    return samples;
  }
  
  if (fromRate === 48000 && toRate === 16000) {
    return downsample48to16(samples);
  }
  
  if (fromRate === 48000 && toRate === 24000) {
    return downsample48to24(samples);
  }
  
  // Handle upsampling from 16kHz to 24kHz (simple linear interpolation)
  if (fromRate === 16000 && toRate === 24000) {
    const ratio = 1.5; // 24000 / 16000 = 1.5
    const outputLength = Math.floor(samples.length * ratio);
    const output = new Int16Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i / ratio;
      const index = Math.floor(sourceIndex);
      const fraction = sourceIndex - index;
      
      if (index < samples.length - 1) {
        // Linear interpolation between samples
        output[i] = Math.round(samples[index] * (1 - fraction) + samples[index + 1] * fraction);
      } else {
        output[i] = samples[samples.length - 1];
      }
    }
    
    return output;
  }
  
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = Math.floor(i * ratio);
    output[i] = samples[sourceIndex];
  }
  
  return output;
}