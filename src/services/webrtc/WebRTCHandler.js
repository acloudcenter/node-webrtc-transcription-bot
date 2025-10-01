import wrtc from '@roamhq/wrtc';
import { AudioValidator } from '../../utils/AudioValidator.js';

const { RTCPeerConnection, RTCSessionDescription, nonstandard } = wrtc;
const { RTCAudioSink } = nonstandard;

/**
 * Handles WebRTC peer connection and audio extraction
 */
export class WebRTCHandler {
  constructor(onAudioData) {
    this.pc = null;
    this.audioSinks = new Map();
    this.onAudioData = onAudioData;
    this.pendingIceCandidates = [];
    this.pendingAudioTrack = null;
    this.callUuid = null;
  }

  /**
   * Create and configure peer connection
   */
  createPeerConnection(iceServers = null) {
    // Use provided TURN servers or fallback to public STUN
    const servers = iceServers || [
      { urls: 'stun:stun.l.google.com:19302' }
    ];

    this.pc = new RTCPeerConnection({
      iceServers: servers,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    // Add audio transceiver for receiving
    this.pc.addTransceiver('audio', { direction: 'recvonly' });
    console.log('WebRTC: Added audio transceiver (receive-only)');

    this.setupEventHandlers();
    return this.pc;
  }

  setupEventHandlers() {
    // Handle incoming audio tracks
    this.pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        console.log(`WebRTC: Received audio track ${event.track.id}`);
        
        // Wait for ICE connection before attaching sink
        if (this.isConnected()) {
          this.attachAudioSink(event.track);
        } else {
          console.log('WebRTC: Waiting for ICE connection...');
          this.pendingAudioTrack = event.track;
        }
      }
    };

    // Monitor ICE connection state
    this.pc.oniceconnectionstatechange = () => {
      // Check if pc still exists (might be null after disconnect)
      if (!this.pc) return;
      
      const state = this.pc.iceConnectionState;
      console.log(`WebRTC: ICE state changed to ${state}`);
      
      if (state === 'checking') {
        console.log('Establishing connection to Pexip media server...');
      } else if (state === 'connected' || state === 'completed') {
        console.log('WebRTC: Media connection established - audio should be flowing');
        if (this.pendingAudioTrack) {
          console.log('WebRTC: Attaching pending audio sink');
          this.attachAudioSink(this.pendingAudioTrack);
          this.pendingAudioTrack = null;
        }
      } else if (state === 'failed') {
        console.error('WebRTC: Connection failed - possible firewall/NAT issue');
        console.error('  Try: 1) Check firewall settings');
        console.error('       2) Ensure UDP ports are open');
        console.error('       3) Try a different network');
      } else if (state === 'disconnected') {
        console.warn('WebRTC: Connection lost - may reconnect...');
      }
    };

    // Monitor connection state
    this.pc.onconnectionstatechange = () => {
      // Check if pc still exists
      if (!this.pc) return;
      console.log(`WebRTC: Connection state ${this.pc.connectionState}`);
    };
  }

  /**
   * Attach RTCAudioSink to extract PCM audio
   */
  attachAudioSink(track) {
    console.log(`WebRTC: Attaching audio sink to track ${track.id}`);
    
    try {
      const audioSink = new RTCAudioSink(track);
      this.audioSinks.set(track.id, audioSink);
      
      let firstData = true;
      let sampleCount = 0;
      let lastReportTime = Date.now();
      let silenceReported = false;
      
      audioSink.ondata = (data) => {
        // Log first data reception for debugging
        if (firstData) {
          console.log('WebRTC: First audio data received!');
          console.log(`  Sample rate: ${data.sampleRate} Hz`);
          console.log(`  Channels: ${data.channelCount}`);
          console.log(`  Bits per sample: ${data.bitsPerSample}`);
          console.log(`  Buffer length: ${data.samples?.length}`);
          
          // Check if audio is silence
          if (data.samples) {
            const maxAmplitude = Math.max(...Array.from(data.samples).map(Math.abs));
            console.log(`  Max amplitude: ${maxAmplitude} (${(maxAmplitude/32768*100).toFixed(1)}%)`);
            
            if (maxAmplitude < 10) {
              console.log('\nConference appears to be silent - waiting for someone to speak...');
              console.log('  Possible reasons:');
              console.log('  1. No one has joined the conference yet');
              console.log('  2. All participants are muted');
              console.log('  3. No one is currently speaking\n');
            } else {
              console.log('  Audio is active!\n');
            }
          }
          firstData = false;
        }
        
        sampleCount += data.samples?.length || 0;
        
        // Report stats every 10 seconds
        const now = Date.now();
        if (now - lastReportTime > 10000) {
          const seconds = sampleCount / (data.sampleRate || 48000);
          
          // Check if we're getting silence
          if (data.samples) {
            const maxAmplitude = Math.max(...Array.from(data.samples.slice(0, 1000)).map(Math.abs));
            if (maxAmplitude < 100) {
              if (!silenceReported) {
                console.log('Receiving audio but conference is silent (no one speaking)');
                silenceReported = true;
              }
            } else {
              console.log(`Audio flowing - ${seconds.toFixed(1)}s received, amplitude: ${maxAmplitude}`);
              silenceReported = false;
            }
          }
          
          lastReportTime = now;
        }
        
        // Pass audio data to callback
        if (this.onAudioData && data.samples) {
          // Validate periodically (every 100th call to reduce logs)
          if (sampleCount % 16000 === 0) { // Once per second at 16kHz
            AudioValidator.validateAudio(data.samples, data.sampleRate, 'WebRTC Input');
          }
          
          this.onAudioData({
            trackId: track.id,
            samples: data.samples,
            sampleRate: data.sampleRate,
            bitsPerSample: data.bitsPerSample || 16,
            channelCount: data.channelCount || 1,
            timestamp: Date.now()
          });
        }
      };
      
      // Handle track ending
      track.onended = () => {
        console.log(`WebRTC: Track ${track.id} ended`);
        this.cleanup(track.id);
      };
      
      console.log('WebRTC: Audio sink attached successfully');
    } catch (error) {
      console.error('WebRTC: Failed to attach audio sink:', error);
    }
  }

  /**
   * Set ICE candidate handler
   */
  setIceCandidateHandler(handler) {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        handler(event.candidate);
      }
    };
  }

  /**
   * Create offer
   */
  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * Set remote answer
   */
  async setRemoteAnswer(sdp) {
    const answer = new RTCSessionDescription({
      type: 'answer',
      sdp: sdp
    });
    await this.pc.setRemoteDescription(answer);
  }

  /**
   * Handle new offer from remote
   */
  async handleRemoteOffer(sdp) {
    const offer = new RTCSessionDescription({
      type: 'offer',
      sdp: sdp
    });
    await this.pc.setRemoteDescription(offer);
    
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Add ICE candidate
   */
  async addIceCandidate(candidate) {
    if (this.pc && this.pc.remoteDescription) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    const state = this.pc?.iceConnectionState;
    return state === 'connected' || state === 'completed';
  }

  /**
   * Cleanup audio sink
   */
  cleanup(trackId = null) {
    if (trackId) {
      const sink = this.audioSinks.get(trackId);
      if (sink) {
        sink.stop();
        this.audioSinks.delete(trackId);
      }
    } else {
      // Cleanup all sinks
      for (const [id, sink] of this.audioSinks) {
        sink.stop();
      }
      this.audioSinks.clear();
    }
  }

  /**
   * Disconnect and cleanup
   */
  disconnect() {
    console.log('WebRTC: Disconnecting...');
    
    // Stop all audio sinks first
    this.cleanup();
    
    // Close peer connection
    if (this.pc) {
      try {
        // Remove all event handlers to prevent callbacks after close
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        
        // Close the connection
        this.pc.close();
        console.log('WebRTC: Peer connection closed');
      } catch (error) {
        console.error('WebRTC: Error closing connection:', error.message);
      }
      this.pc = null;
    }
  }
}