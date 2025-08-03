import wrtc from '@roamhq/wrtc';
import axios from 'axios';

const { RTCPeerConnection, RTCSessionDescription, nonstandard } = wrtc;
const { RTCAudioSink } = nonstandard;

export class PexipConnection {
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
    this.audioSinks = new Map(); // Track ID -> RTCAudioSink
    this.eventSource = null;
    this.onAudioData = config.onAudioData || null; // Callback for audio data
    
    // Participant event callbacks
    this.onParticipantJoined = config.onParticipantJoined || null;
    this.onParticipantLeft = config.onParticipantLeft || null;
    this.onParticipantUpdated = config.onParticipantUpdated || null;
    this.onStageUpdate = config.onStageUpdate || null;
    
    // ICE candidate queue - store candidates until we have a call UUID
    this.pendingIceCandidates = [];
    this.turnServers = null;
  }

  async connect() {
    try {
      console.log('Connecting to Pexip conference...');
      
      await this.requestToken();
      await this.createPeerConnection();
      await this.joinConference();
      this.startEventPolling();
      
      console.log('Successfully connected to conference');
      return true;
    } catch (error) {
      console.error('Connection failed:', error.message);
      throw error;
    }
  }

  async requestToken() {
    console.log('Requesting authentication token...');
    
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
      
      // Store TURN servers if provided
      if (response.data.result.turn) {
        this.turnServers = response.data.result.turn;
        console.log('TURN servers provided:', this.turnServers.length);
      }
      
      console.log('Token obtained, participant UUID:', this.participantUuid);
    } else if (response.status === 403 && response.data.pin_status === 'required') {
      console.log('PIN required, authenticating...');
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
      
      // Store TURN servers if provided
      if (pinResponse.data.result.turn) {
        this.turnServers = pinResponse.data.result.turn;
        console.log('TURN servers provided:', this.turnServers.length);
      }
      
      console.log('Authenticated with PIN');
    } else {
      throw new Error(`Failed to get token: ${response.status}`);
    }
  }

  async createPeerConnection() {
    console.log('Creating WebRTC peer connection...');
    
    // Use Pexip TURN servers if available, otherwise use public STUN
    const iceServers = this.turnServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    
    console.log(`Using ${iceServers.length} ICE servers`);
    
    this.pc = new RTCPeerConnection({
      iceServers: iceServers,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    // Add audio transceiver for receiving conference audio
    const audioTransceiver = this.pc.addTransceiver('audio', { direction: 'recvonly' });
    console.log('Added audio transceiver (recvonly)');
    
    // Handle incoming tracks
    this.pc.ontrack = (event) => {
      console.log(`Received track: ${event.track.kind} - ${event.track.id}`);
      console.log(`   Transceiver mid: ${event.transceiver?.mid}`);
      
      // Only process audio tracks
      if (event.track.kind === 'audio') {
        console.log('Processing audio track:', event.track.id);
        // Wait for ICE to connect before attaching sink
        if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
          this.attachAudioSink(event.track);
        } else {
          console.log('Waiting for ICE connection before attaching audio sink...');
          this.pendingAudioTrack = event.track;
        }
      }
    };

    // Handle ICE candidates - queue them if no call UUID yet
    this.pc.onicecandidate = async (event) => {
      if (event.candidate) {
        if (!this.callUuid) {
          // Queue the candidate until we have a call UUID
          console.log('Queueing ICE candidate (no call UUID yet)');
          this.pendingIceCandidates.push(event.candidate);
        } else {
          await this.sendIceCandidate(event.candidate);
        }
      } else {
        console.log('All ICE candidates gathered');
      }
    };
    
    // Monitor ICE connection state
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc) {
        console.log('ICE connection state:', this.pc.iceConnectionState);
        
        if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
          console.log('ICE connection established!');
          
          // Attach pending audio sink if we have one
          if (this.pendingAudioTrack) {
            console.log('Attaching pending audio sink...');
            this.attachAudioSink(this.pendingAudioTrack);
            this.pendingAudioTrack = null;
          }
        } else if (this.pc.iceConnectionState === 'failed') {
          console.error('ICE connection failed!');
          console.error('   This usually means firewall/NAT issues');
        } else if (this.pc.iceConnectionState === 'disconnected') {
          console.warn('ICE disconnected - may reconnect');
        }
      }
    };

    // Handle connection state changes
    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        console.log('Peer connection state:', this.pc.connectionState);
      }
    };
  }

  attachAudioSink(track) {
    console.log('Attaching audio sink to track:', track.id);
    console.log('   Track state:', track.readyState);
    console.log('   Track enabled:', track.enabled);
    console.log('   Track kind:', track.kind);
    console.log('   Track muted:', track.muted);
    
    try {
      // Create RTCAudioSink for this track
      const audioSink = new RTCAudioSink(track);
      
      // Store the sink
      this.audioSinks.set(track.id, audioSink);
      
      let dataReceived = false;
      let sampleCount = 0;
      let lastLogTime = Date.now();
      
      // Handle incoming PCM data
      audioSink.ondata = (data) => {
        // Log first data reception
        if (!dataReceived) {
          console.log('First audio data received from RTCAudioSink!');
          console.log('   Data object keys:', Object.keys(data));
          console.log('   Samples type:', data.samples?.constructor.name);
          console.log('   Samples length:', data.samples?.length);
          console.log('   Sample rate:', data.sampleRate);
          console.log('   Bits per sample:', data.bitsPerSample);
          console.log('   Channel count:', data.channelCount);
          
          if (data.samples && data.samples.length > 0) {
            // Check first 10 samples
            const preview = Array.from(data.samples.slice(0, 10));
            console.log('   First 10 samples:', preview);
            
            // Check if we're getting silence
            const maxValue = Math.max(...Array.from(data.samples).map(Math.abs));
            const avgValue = Array.from(data.samples).reduce((a, b) => a + Math.abs(b), 0) / data.samples.length;
            console.log('   Max amplitude:', maxValue, `(${(maxValue / 32768 * 100).toFixed(1)}%)`);
            console.log('   Avg amplitude:', avgValue.toFixed(2));
            
            if (maxValue < 10) {
              console.log('   WARNING: Audio appears to be complete silence!');
            }
          }
          dataReceived = true;
        }
        
        sampleCount += data.samples?.length || 0;
        
        // Log periodically (every 5 seconds)
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log(`Audio sink stats - Track ${track.id}:`);
          console.log(`   Total samples received: ${sampleCount}`);
          console.log(`   Approx seconds: ${(sampleCount / 48000).toFixed(1)}`);
          
          // Check current amplitude
          if (data.samples && data.samples.length > 0) {
            const maxValue = Math.max(...Array.from(data.samples).map(Math.abs));
            console.log(`   Current max amplitude: ${maxValue}`);
          }
          
          lastLogTime = now;
        }
        
        // Pass to callback
        if (this.onAudioData) {
          this.onAudioData({
            trackId: track.id,
            samples: data.samples,
            sampleRate: data.sampleRate || 48000,
            bitsPerSample: data.bitsPerSample || 16,
            channelCount: data.channelCount || 1,
            timestamp: Date.now()
          });
        }
      };
      
      console.log('Audio sink attached successfully');
      
      // Handle track state changes
      track.onmute = () => console.log('Track muted:', track.id);
      track.onunmute = () => console.log('Track unmuted:', track.id);
      
      // Handle track ending
      track.onended = () => {
        console.log('Track ended:', track.id);
        const sink = this.audioSinks.get(track.id);
        if (sink) {
          sink.stop();
          this.audioSinks.delete(track.id);
        }
      };
      
    } catch (error) {
      console.error('Failed to attach audio sink:', error);
      console.error('   Error details:', error.stack);
    }
  }

  async joinConference() {
    console.log('Joining conference with WebRTC...');
    
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    const callUrl = `${this.baseUrl}/participants/${this.participantUuid}/calls`;
    console.log('Calling endpoint:', callUrl);
    
    const response = await axios.post(
      callUrl,
      {
        call_type: 'WEBRTC',
        sdp: offer.sdp,
        media_type: 'audio'
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
    console.log('Call UUID:', this.callUuid);
    
    // Send any queued ICE candidates now that we have a call UUID
    if (this.pendingIceCandidates.length > 0) {
      console.log(`Sending ${this.pendingIceCandidates.length} queued ICE candidates...`);
      for (const candidate of this.pendingIceCandidates) {
        await this.sendIceCandidate(candidate);
      }
      this.pendingIceCandidates = [];
    }
    
    // Check if we got TURN servers in the response
    if (response.data.result.turn && response.data.result.turn.length > 0) {
      console.log('TURN servers in call response:', response.data.result.turn.length);
      for (const turn of response.data.result.turn) {
        console.log(`   TURN: ${turn.urls}`);
      }
    }

    const answer = new RTCSessionDescription({
      type: 'answer',
      sdp: response.data.result.sdp
    });
    
    console.log('Setting remote description (answer from Pexip)');
    await this.pc.setRemoteDescription(answer);

    await this.sendAck();
  }

  async sendAck() {
    console.log('Starting media flow...');
    
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
    
    console.log('Media flow started');
  }

  async sendIceCandidate(candidate) {
    try {
      // Only send if we have a call UUID
      if (!this.callUuid) {
        console.warn('Cannot send ICE candidate - no call UUID yet');
        return;
      }
      
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
    console.log('Starting event polling...');
    
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

      if (this.pc && this.pc.connectionState !== 'closed') {
        setTimeout(pollEvents, 100);
      }
    };

    pollEvents();
  }

  async handleEvent(event) {
    // Only log non-participant events to reduce noise
    if (!event.event.startsWith('participant_') && event.event !== 'stage') {
      console.log('Event:', event.event);
    }
    
    switch (event.event) {
      case 'new_offer':
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
        if (event.candidate) {
          await this.pc.addIceCandidate({
            candidate: event.candidate,
            sdpMid: event.mid
          });
        }
        break;
        
      case 'participant_create':
        // New participant joined
        if (this.onParticipantJoined) {
          this.onParticipantJoined(event);
        }
        break;
        
      case 'participant_update':
        // Participant updated (could be VAD change, mute, etc.)
        if (this.onParticipantUpdated) {
          this.onParticipantUpdated(event);
        }
        break;
        
      case 'participant_delete':
        // Participant left
        if (this.onParticipantLeft) {
          this.onParticipantLeft(event);
        }
        break;
        
      case 'stage':
        // Stage update (active speakers)
        if (this.onStageUpdate) {
          this.onStageUpdate(event);
        }
        break;
        
      case 'participant_sync_begin':
        // Beginning of participant list sync
        console.log('Syncing participant list...');
        break;
        
      case 'participant_sync_end':
        // End of participant list sync
        console.log('Participant list synced');
        // Get initial participants
        this.getParticipants();
        break;
        
      case 'disconnect':
        console.log('Disconnected from conference');
        await this.disconnect();
        break;
    }
  }
  
  async getParticipants() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/participants`,
        {
          headers: {
            'token': this.token
          }
        }
      );
      
      if (response.data && response.data.result) {
        console.log(`${response.data.result.length} participants in conference`);
        // Process initial participant list
        for (const participant of response.data.result) {
          if (this.onParticipantJoined && participant.uuid !== this.participantUuid) {
            this.onParticipantJoined(participant);
          }
        }
      }
    } catch (error) {
      console.error('Failed to get participants:', error.message);
    }
  }

  async disconnect() {
    console.log('Disconnecting...');
    
    // Stop all audio sinks
    for (const [trackId, sink] of this.audioSinks) {
      console.log(`Stopping audio sink for track ${trackId}`);
      sink.stop();
    }
    this.audioSinks.clear();
    
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
    
    console.log('Disconnected');
  }

  getActiveSinks() {
    return this.audioSinks.size;
  }
}