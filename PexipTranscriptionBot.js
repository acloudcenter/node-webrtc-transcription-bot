import wrtc from '@roamhq/wrtc';
import axios from 'axios';

const { RTCPeerConnection, RTCSessionDescription } = wrtc;

export class PexipTranscriptionBot {
  constructor(config) {
    this.nodeAddress = config.nodeAddress;
    this.conferenceAlias = config.conferenceAlias;
    this.displayName = config.displayName || 'Transcription Bot';
    this.pin = config.pin || '';
    
    this.baseUrl = `https://${this.nodeAddress}/api/client/v2/conferences/${this.conferenceAlias}`;
    this.token = null;
    this.participantUuid = null;
    this.callUuid = null;
    this.pc = null;
    this.audioStreams = new Map();
    this.eventSource = null;
  }

  async connect() {
    try {
      console.log('🔌 Connecting to Pexip conference...');
      
      // Step 1: Request token
      await this.requestToken();
      
      // Step 2: Create WebRTC peer connection
      await this.createPeerConnection();
      
      // Step 3: Join conference with WebRTC
      await this.joinConference();
      
      // Step 4: Start event polling
      this.startEventPolling();
      
      console.log('✅ Successfully connected to conference');
      return true;
    } catch (error) {
      console.error('❌ Connection failed:', error.message);
      throw error;
    }
  }

  async requestToken() {
    console.log('🔑 Requesting authentication token...');
    
    const response = await axios.post(
      `${this.baseUrl}/request_token`,
      {
        display_name: this.displayName,
        call_tag: 'transcription-bot'
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: null
      }
    );

    if (response.status === 200) {
      this.token = response.data.result.token;
      this.participantUuid = response.data.result.participant_uuid;
      console.log('✅ Token obtained, participant UUID:', this.participantUuid);
    } else if (response.status === 403 && response.data.pin_status === 'required') {
      // PIN required
      console.log('🔐 PIN required, authenticating...');
      const pinResponse = await axios.post(
        `${this.baseUrl}/request_token`,
        {
          display_name: this.displayName,
          pin: this.pin,
          call_tag: 'transcription-bot'
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      this.token = pinResponse.data.result.token;
      this.participantUuid = pinResponse.data.result.participant_uuid;
      console.log('✅ Authenticated with PIN');
    } else {
      throw new Error(`Failed to get token: ${response.status}`);
    }
  }

  async createPeerConnection() {
    console.log('🎧 Creating WebRTC peer connection...');
    
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Add receive-only audio transceiver
    this.pc.addTransceiver('audio', { direction: 'recvonly' });
    
    // Handle incoming tracks
    this.pc.ontrack = (event) => {
      console.log('🎵 Received audio track:', event.track.id);
      this.handleAudioTrack(event.track, event.streams[0]);
    };

    // Handle ICE candidates
    this.pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await this.sendIceCandidate(event.candidate);
      }
    };

    // Handle connection state changes
    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        console.log('📡 Connection state:', this.pc.connectionState);
      }
    };
  }

  async joinConference() {
    console.log('📞 Joining conference with WebRTC...');
    
    // Create offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    // Send offer to Pexip - MUST include participant UUID in the path
    const callUrl = `${this.baseUrl}/participants/${this.participantUuid}/calls`;
    console.log('📡 Calling endpoint:', callUrl);
    
    const response = await axios.post(
      callUrl,
      {
        call_type: 'WEBRTC',
        sdp: offer.sdp,
        media_type: 'audio'  // Audio-only bot
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'token': this.token
        }
      }
    );

    if (response.status !== 200) {
      throw new Error(`Failed to join conference: ${response.status}`);
    }

    this.callUuid = response.data.result.call_uuid;
    console.log('📞 Call UUID:', this.callUuid);

    // Set remote description
    const answer = new RTCSessionDescription({
      type: 'answer',
      sdp: response.data.result.sdp
    });
    await this.pc.setRemoteDescription(answer);

    // Send ACK to start media
    await this.sendAck();
  }

  async sendAck() {
    console.log('🎬 Starting media flow...');
    
    const response = await axios.post(
      `${this.baseUrl}/participants/${this.participantUuid}/calls/${this.callUuid}/ack`,
      {},
      {
        headers: {
          'token': this.token
        }
      }
    );

    if (response.status !== 200) {
      throw new Error(`Failed to ACK call: ${response.status}`);
    }
    
    console.log('✅ Media flow started');
  }

  async sendIceCandidate(candidate) {
    try {
      await axios.post(
        `${this.baseUrl}/participants/${this.participantUuid}/calls/${this.callUuid}/new_candidate`,
        {
          candidate: candidate.candidate,
          mid: candidate.sdpMid,
          ufrag: candidate.usernameFragment,
          pwd: ''
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'token': this.token
          }
        }
      );
    } catch (error) {
      console.error('Failed to send ICE candidate:', error.message);
    }
  }

  async startEventPolling() {
    console.log('👂 Starting event polling...');
    
    const pollEvents = async () => {
      try {
        const response = await axios.get(
          `${this.baseUrl}/events`,
          {
            headers: {
              'token': this.token
            },
            timeout: 30000
          }
        );

        if (response.data && response.data.result) {
          for (const event of response.data.result) {
            await this.handleEvent(event);
          }
        }
      } catch (error) {
        if (error.code !== 'ECONNABORTED') {
          console.error('Event polling error:', error.message);
        }
      }

      // Continue polling if connected
      if (this.pc && this.pc.connectionState !== 'closed') {
        setTimeout(pollEvents, 100);
      }
    };

    pollEvents();
  }

  async handleEvent(event) {
    console.log('📨 Event:', event.event);
    
    switch (event.event) {
      case 'new_offer':
        // Handle renegotiation
        const offer = new RTCSessionDescription({
          type: 'offer',
          sdp: event.sdp
        });
        await this.pc.setRemoteDescription(offer);
        
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        
        await axios.post(
          `${this.baseUrl}/participants/${this.participantUuid}/calls/${this.callUuid}/ack`,
          {
            sdp: answer.sdp
          },
          {
            headers: {
              'token': this.token
            }
          }
        );
        break;
        
      case 'new_candidate':
        // Handle remote ICE candidate
        if (event.candidate) {
          await this.pc.addIceCandidate({
            candidate: event.candidate,
            sdpMid: event.mid
          });
        }
        break;
        
      case 'participant_sync_begin':
      case 'participant_sync_end':
      case 'participant_create':
      case 'participant_update':
        console.log(`  Participant event: ${event.event}`);
        break;
        
      case 'disconnect':
        console.log('📴 Disconnected from conference');
        await this.disconnect();
        break;
    }
  }

  handleAudioTrack(track, stream) {
    console.log(`🎙️ Processing audio track: ${track.id}`);
    console.log(`   Track kind: ${track.kind}`);
    console.log(`   Track enabled: ${track.enabled}`);
    console.log(`   Track readyState: ${track.readyState}`);
    
    // Store the stream
    this.audioStreams.set(track.id, stream);
    
    // Log stream information
    console.log(`📊 Stream ID: ${stream.id}`);
    console.log(`   Active: ${stream.active}`);
    console.log(`   Audio tracks: ${stream.getAudioTracks().length}`);
    
    // Note: To actually capture audio data, you would need to:
    // 1. Use a ScriptProcessorNode or AudioWorklet (in browser context)
    // 2. Or use wrtc's nonstandard addons for audio extraction
    // 3. Or pipe to an external process like FFmpeg
    
    // For this POC, we're confirming we can receive the audio tracks
    console.log(`✅ Successfully receiving audio track: ${track.id}`);
    
    // Monitor track state
    track.onmute = () => console.log(`🔇 Track muted: ${track.id}`);
    track.onunmute = () => console.log(`🔊 Track unmuted: ${track.id}`);
    track.onended = () => {
      console.log(`🔚 Track ended: ${track.id}`);
      this.audioStreams.delete(track.id);
    };
  }

  async disconnect() {
    console.log('🔌 Disconnecting...');
    
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    
    if (this.callUuid && this.token) {
      try {
        await axios.post(
          `${this.baseUrl}/participants/${this.participantUuid}/calls/${this.callUuid}/disconnect`,
          {},
          {
            headers: {
              'token': this.token
            }
          }
        );
      } catch (error) {
        console.error('Disconnect error:', error.message);
      }
    }
    
    if (this.token) {
      try {
        await axios.post(
          `${this.baseUrl}/release_token`,
          {},
          {
            headers: {
              'token': this.token
            }
          }
        );
      } catch (error) {
        console.error('Token release error:', error.message);
      }
    }
    
    console.log('✅ Disconnected');
  }

  getActiveStreams() {
    return Array.from(this.audioStreams.values());
  }

  getStreamCount() {
    return this.audioStreams.size;
  }
}