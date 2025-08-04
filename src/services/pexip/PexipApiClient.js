import axios from 'axios';

/**
 * Handles all Pexip REST API interactions
 */
export class PexipApiClient {
  constructor(nodeAddress, conferenceAlias) {
    this.nodeAddress = nodeAddress;
    this.conferenceAlias = conferenceAlias;
    this.baseUrl = `https://${nodeAddress}/api/client/v2/conferences/${conferenceAlias}`;
    this.token = null;
    this.participantUuid = null;
    this.turnServers = null;
  }

  /**
   * Request authentication token from Pexip
   */
  async requestToken(displayName, pin = '') {
    console.log('Requesting Pexip token...');
    
    const payload = {
      display_name: displayName,
      call_tag: 'transcription-bot'
    };

    // First attempt without PIN
    const response = await axios.post(
      `${this.baseUrl}/request_token`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        validateStatus: null
      }
    );

    // Handle PIN requirement
    if (response.status === 403 && response.data.pin_status === 'required') {
      console.log('PIN required, authenticating...');
      payload.pin = pin;
      
      const pinResponse = await axios.post(
        `${this.baseUrl}/request_token`,
        payload,
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      return this.handleTokenResponse(pinResponse);
    }
    
    if (response.status !== 200) {
      throw new Error(`Failed to get token: ${response.status}`);
    }

    return this.handleTokenResponse(response);
  }

  handleTokenResponse(response) {
    const result = response.data.result;
    this.token = result.token;
    this.participantUuid = result.participant_uuid;
    this.turnServers = result.turn || null;
    
    console.log(`Token obtained, participant UUID: ${this.participantUuid}`);
    if (this.turnServers) {
      console.log(`TURN servers available: ${this.turnServers.length}`);
    }
    
    return {
      token: this.token,
      participantUuid: this.participantUuid,
      turnServers: this.turnServers
    };
  }

  /**
   * Join conference with WebRTC offer
   */
  async joinCall(sdp) {
    const response = await axios.post(
      `${this.baseUrl}/participants/${this.participantUuid}/calls`,
      {
        call_type: 'WEBRTC',
        sdp: sdp,
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

    return {
      callUuid: response.data.result.call_uuid,
      sdp: response.data.result.sdp
    };
  }

  /**
   * Send ACK to start media flow
   */
  async sendAck(callUuid, sdp = null) {
    const payload = sdp ? { sdp } : {};
    
    const response = await axios.post(
      `${this.baseUrl}/participants/${this.participantUuid}/calls/${callUuid}/ack`,
      payload,
      {
        headers: { 'token': this.token }
      }
    );

    if (response.status !== 200) {
      throw new Error(`Failed to ACK call: ${response.status}`);
    }
    
    console.log('Media flow started');
  }

  /**
   * Send ICE candidate
   */
  async sendIceCandidate(callUuid, candidate) {
    try {
      await axios.post(
        `${this.baseUrl}/participants/${this.participantUuid}/calls/${callUuid}/new_candidate`,
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

  /**
   * Poll for events
   */
  async getEvents() {
    const response = await axios.get(
      `${this.baseUrl}/events`,
      {
        headers: { 'token': this.token },
        timeout: 30000
      }
    );

    return response.data?.result || [];
  }

  /**
   * Disconnect call
   */
  async disconnectCall(callUuid) {
    if (!callUuid || !this.token) return;
    
    try {
      await axios.post(
        `${this.baseUrl}/participants/${this.participantUuid}/calls/${callUuid}/disconnect`,
        {},
        { headers: { 'token': this.token } }
      );
      console.log('Call disconnected successfully');
    } catch (error) {
      // 403 means already disconnected or token expired - this is OK
      if (error.response?.status === 403) {
        console.log('Call already disconnected');
      } else {
        console.error('Disconnect error:', error.message);
      }
    }
  }

  /**
   * Release token
   */
  async releaseToken() {
    if (!this.token) return;
    
    try {
      await axios.post(
        `${this.baseUrl}/release_token`,
        {},
        { headers: { 'token': this.token } }
      );
      console.log('Token released successfully');
    } catch (error) {
      // 403 means token already released or expired - this is OK
      if (error.response?.status === 403) {
        console.log('Token already released');
      } else {
        console.error('Token release error:', error.message);
      }
    }
    
    // Clear token after release attempt
    this.token = null;
  }
}