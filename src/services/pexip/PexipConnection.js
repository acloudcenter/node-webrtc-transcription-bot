import { PexipApiClient } from './PexipApiClient.js';
import { WebRTCHandler } from '../webrtc/WebRTCHandler.js';

/**
 * Simplified Pexip connection orchestrator
 * Connects to Pexip conference and extracts audio stream
 */
export class PexipConnection {
  constructor(config) {
    this.config = {
      nodeAddress: config.nodeAddress,
      conferenceAlias: config.conferenceAlias,
      displayName: config.displayName || 'Transcription Bot',
      pin: config.pin || '',
      onAudioData: config.onAudioData || null
    };

    this.api = new PexipApiClient(this.config.nodeAddress, this.config.conferenceAlias);
    this.webrtc = new WebRTCHandler(this.config.onAudioData);
    
    this.callUuid = null;
    this.eventPollInterval = null;
    this.isRunning = false;
    this.pendingIceCandidates = [];  // Queue for ICE candidates before we have callUuid
    this.tokenRefreshTimer = null;  // Timer for token refresh
  }

  /**
   * Connect to Pexip conference
   */
  async connect() {
    try {
      console.log('Connecting to Pexip Conference');
      
      // Step 1: Get authentication token
      const { token, participantUuid, turnServers, expires } = await this.api.requestToken(
        this.config.displayName,
        this.config.pin
      );

      // Set up token refresh timer (refresh 30 seconds before expiry)
      this.startTokenRefresh(expires);

      // Step 2: Create WebRTC peer connection
      this.webrtc.createPeerConnection(turnServers);
      
      // Set up ICE candidate handler - queue them until we have a callUuid
      this.webrtc.setIceCandidateHandler(async (candidate) => {
        if (!this.callUuid) {
          // Queue the candidate until we have a call UUID
          console.log('Queueing ICE candidate (no call UUID yet)');
          this.pendingIceCandidates.push(candidate);
        } else {
          await this.api.sendIceCandidate(this.callUuid, candidate);
        }
      });

      // Step 3: Create offer and join conference
      const offer = await this.webrtc.createOffer();
      const { callUuid, sdp } = await this.api.joinCall(offer.sdp);
      this.callUuid = callUuid;
      
      // Send any queued ICE candidates now that we have a call UUID
      if (this.pendingIceCandidates.length > 0) {
        console.log(`Sending ${this.pendingIceCandidates.length} queued ICE candidates...`);
        for (const candidate of this.pendingIceCandidates) {
          await this.api.sendIceCandidate(this.callUuid, candidate);
        }
        this.pendingIceCandidates = [];
      }

      // Step 4: Set remote answer
      await this.webrtc.setRemoteAnswer(sdp);

      // Step 5: Send ACK to start media flow
      await this.api.sendAck(callUuid);

      // Step 6: Start event polling
      this.startEventPolling();
      
      this.isRunning = true;
      console.log('Successfully connected to conference');
      
      // Check ICE connection after 5 seconds
      setTimeout(() => {
        if (this.webrtc.pc && !this.webrtc.isConnected()) {
          console.warn('\nWebRTC media connection not established after 5 seconds');
          console.warn('  This means audio is NOT flowing yet.');
          console.warn('  Possible issues:');
          console.warn('  - Firewall blocking UDP traffic');
          console.warn('  - NAT traversal issues');
          console.warn('  - TURN servers not accessible\n');
        }
      }, 5000);
      
      return true;
    } catch (error) {
      console.error('Connection failed:', error.message);
      throw error;
    }
  }

  /**
   * Start polling for Pexip events
   */
  startEventPolling() {
    const pollEvents = async () => {
      if (!this.isRunning) return;
      
      try {
        const events = await this.api.getEvents();
        
        for (const event of events) {
          await this.handleEvent(event);
        }
      } catch (error) {
        if (error.code !== 'ECONNABORTED') {
          console.error('Event polling error:', error.message);
        }
      }

      if (this.isRunning) {
        this.eventPollTimeout = setTimeout(pollEvents, 100);
      }
    };

    pollEvents();
  }

  /**
   * Handle Pexip events
   */
  async handleEvent(event) {
    switch (event.event) {
      case 'new_offer':
        // Handle renegotiation
        const answer = await this.webrtc.handleRemoteOffer(event.sdp);
        await this.api.sendAck(this.callUuid, answer.sdp);
        console.log('Handled new offer from Pexip');
        break;
        
      case 'new_candidate':
        // Add remote ICE candidate
        if (event.candidate) {
          await this.webrtc.addIceCandidate({
            candidate: event.candidate,
            sdpMid: event.mid
          });
        }
        break;
        
      case 'disconnect':
        console.log('Conference disconnected');
        await this.disconnect();
        break;
        
      // Ignore participant events and other non-critical events
      default:
        if (!event.event.startsWith('participant_') && event.event !== 'stage') {
          console.log(`Event: ${event.event}`);
        }
        break;
    }
  }

  /**
   * Start token refresh timer
   */
  startTokenRefresh(expiresInSeconds) {
    // Clear any existing timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Refresh 30 seconds before expiry (or at 75% of lifetime for shorter tokens)
    const refreshBuffer = Math.min(30, Math.floor(expiresInSeconds * 0.25));
    const refreshInterval = (expiresInSeconds - refreshBuffer) * 1000;

    console.log(`Token refresh scheduled in ${refreshInterval / 1000} seconds`);

    this.tokenRefreshTimer = setTimeout(async () => {
      if (!this.isRunning) return;

      try {
        const { expires } = await this.api.refreshToken();
        console.log('Token refreshed successfully');
        
        // Schedule next refresh
        this.startTokenRefresh(expires);
      } catch (error) {
        console.error('Token refresh failed:', error.message);
        // Token refresh failed - connection will likely drop
        // Could implement retry logic here if needed
      }
    }, refreshInterval);
  }

  /**
   * Stop token refresh timer
   */
  stopTokenRefresh() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  /**
   * Disconnect from conference
   */
  async disconnect() {
    // Prevent multiple disconnect calls
    if (!this.isRunning) {
      console.log('Already disconnected');
      return;
    }
    
    console.log('\nDisconnecting from Pexip');
    this.isRunning = false;
    
    // Step 1: Stop token refresh
    this.stopTokenRefresh();
    
    // Step 2: Stop event polling
    if (this.eventPollTimeout) {
      clearTimeout(this.eventPollTimeout);
      this.eventPollTimeout = null;
    }

    // Step 3: Close WebRTC connection first (this stops media)
    this.webrtc.disconnect();
    
    // Step 4: Small delay to ensure WebRTC is closed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 5: Disconnect from Pexip API
    try {
      await this.api.disconnectCall(this.callUuid);
      await this.api.releaseToken();
    } catch (error) {
      // Errors are already handled in the API client
    }
    
    console.log('Disconnected from Pexip\n');
  }

  /**
   * Get connection status
   */
  isConnected() {
    return this.isRunning && this.webrtc.isConnected();
  }
}