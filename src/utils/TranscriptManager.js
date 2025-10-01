import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Manages transcript output with both timestamped and clean versions
 */
export class TranscriptManager {
  constructor(outputDir) {
    this.outputDir = outputDir || path.join(dirname(dirname(__dirname)), 'output', 'transcriptions');
    
    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    
    // Create timestamp for this session
    this.timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    
    // File paths
    this.timestampedFile = path.join(this.outputDir, `transcript_${this.timestamp}.txt`);
    this.cleanFile = path.join(this.outputDir, `transcript_clean_${this.timestamp}.txt`);
    this.jsonFile = path.join(this.outputDir, `transcript_${this.timestamp}.json`);
    
    // Streams and data
    this.timestampedStream = fs.createWriteStream(this.timestampedFile, { flags: 'a' });
    this.cleanTranscript = []; // Array of transcript texts
    this.transcriptData = []; // Array of full transcript objects with metadata
    this.orderedItems = new Map(); // For tracking item ordering
    
    console.log(`Transcript files:`);
    console.log(`   Timestamped: ${path.basename(this.timestampedFile)}`);
    console.log(`   Clean: ${path.basename(this.cleanFile)}`);
    console.log(`   JSON: ${path.basename(this.jsonFile)}`);
  }
  
  /**
   * Add a transcription with timestamp
   */
  addTranscription(text, metadata = {}) {
    const timestamp = new Date().toISOString();
    
    // Add to timestamped file immediately
    this.timestampedStream.write(`[${timestamp}] ${text}\n\n`);
    
    // Store for clean version
    this.cleanTranscript.push(text);
    
    // Store full data for JSON
    const entry = {
      timestamp,
      text,
      ...metadata // itemId, speaker, etc.
    };
    this.transcriptData.push(entry);
    
    // Track ordering if item_id provided
    if (metadata.itemId && metadata.previousItemId !== undefined) {
      this.orderedItems.set(metadata.itemId, {
        text,
        previousItemId: metadata.previousItemId,
        timestamp
      });
    }
    
    return entry;
  }
  
  /**
   * Get the clean transcript as a single string
   */
  getCleanTranscript() {
    return this.smartJoin(this.cleanTranscript);
  }
  
  /**
   * Get ordered transcript using item IDs (if available)
   */
  getOrderedTranscript() {
    if (this.orderedItems.size === 0) {
      return this.getCleanTranscript();
    }
    
    const ordered = [];
    
    // Find the first item (no previous_item_id or null)
    let currentId = null;
    for (const [itemId, item] of this.orderedItems) {
      if (!item.previousItemId || item.previousItemId === null) {
        currentId = itemId;
        break;
      }
    }
    
    // Build ordered list by following the chain
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const item = this.orderedItems.get(currentId);
      if (item) {
        ordered.push(item.text);
        // Find next item
        currentId = null;
        for (const [itemId, nextItem] of this.orderedItems) {
          if (nextItem.previousItemId === currentId) {
            currentId = itemId;
            break;
          }
        }
      }
    }
    
    return this.smartJoin(ordered);
  }
  
  /**
   * Intelligently join transcript segments
   */
  smartJoin(segments) {
    if (segments.length === 0) return '';
    
    return segments.reduce((combined, text) => {
      if (!combined) return text;
      
      // Skip if text is empty
      if (!text || !text.trim()) return combined;
      
      // Don't add space if:
      // - Previous ends with hyphen (word continuation)
      // - Current starts with punctuation
      // - Previous ends with opening quote/paren
      const lastChar = combined[combined.length - 1];
      const firstChar = text[0];
      
      const noSpaceChars = ['-', '(', '[', '{', '"', "'"];
      const punctuation = ['.', ',', '!', '?', ';', ':', ')', ']', '}', '"', "'"];
      
      let separator = ' ';
      if (noSpaceChars.includes(lastChar) || punctuation.includes(firstChar)) {
        separator = '';
      }
      
      return combined + separator + text;
    });
  }
  
  /**
   * Format transcript into paragraphs based on pauses
   */
  formatParagraphs(pauseThresholdMs = 5000) {
    const paragraphs = [];
    let currentParagraph = [];
    let lastTimestamp = null;
    
    for (const entry of this.transcriptData) {
      const timestamp = new Date(entry.timestamp);
      
      if (lastTimestamp) {
        const pauseMs = timestamp - lastTimestamp;
        if (pauseMs > pauseThresholdMs) {
          // Long pause, start new paragraph
          if (currentParagraph.length > 0) {
            paragraphs.push(this.smartJoin(currentParagraph));
            currentParagraph = [];
          }
        }
      }
      
      currentParagraph.push(entry.text);
      lastTimestamp = timestamp;
    }
    
    // Add final paragraph
    if (currentParagraph.length > 0) {
      paragraphs.push(this.smartJoin(currentParagraph));
    }
    
    return paragraphs.join('\n\n');
  }
  
  /**
   * Save all transcript files
   */
  async save() {
    // Close timestamped stream
    this.timestampedStream.end();
    
    // Save clean transcript
    const cleanContent = this.getOrderedTranscript();
    fs.writeFileSync(this.cleanFile, cleanContent);
    
    // Save formatted version with paragraphs
    const formattedContent = `TRANSCRIPT - ${new Date().toISOString()}\n${'='.repeat(60)}\n\n${this.formatParagraphs()}\n`;
    fs.writeFileSync(this.cleanFile, formattedContent);
    
    // Save JSON with all metadata
    fs.writeFileSync(this.jsonFile, JSON.stringify({
      session: {
        timestamp: this.timestamp,
        duration: this.transcriptData.length > 0 ? 
          new Date(this.transcriptData[this.transcriptData.length - 1].timestamp) - 
          new Date(this.transcriptData[0].timestamp) : 0
      },
      transcriptions: this.transcriptData,
      cleanTranscript: cleanContent
    }, null, 2));
    
    return {
      timestamped: this.timestampedFile,
      clean: this.cleanFile,
      json: this.jsonFile,
      transcriptionCount: this.transcriptData.length
    };
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    return {
      transcriptionCount: this.transcriptData.length,
      totalWords: this.cleanTranscript.join(' ').split(/\s+/).length,
      duration: this.transcriptData.length > 0 ? 
        new Date() - new Date(this.transcriptData[0].timestamp) : 0
    };
  }
}