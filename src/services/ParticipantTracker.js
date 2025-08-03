export class ParticipantTracker {
  constructor() {
    this.participants = new Map(); // UUID -> participant info
    this.currentSpeaker = null;
    this.speakingHistory = [];
    this.lastSpeakerChange = Date.now();
  }

  // Called when a new participant joins
  addParticipant(participantData) {
    const participant = {
      uuid: participantData.uuid || participantData.participant_uuid,
      displayName: participantData.display_name || 'Unknown',
      role: participantData.role || 'guest',
      joinTime: Date.now(),
      isSpeaking: false,
      lastSpokeAt: null,
      totalSpeakingTime: 0,
      speakingStartTime: null
    };
    
    this.participants.set(participant.uuid, participant);
    console.log(`Participant joined: ${participant.displayName} (${participant.uuid}`);
    
    return participant;
  }

  // Called when participant updates (including VAD changes)
  updateParticipant(participantData) {
    const uuid = participantData.uuid || participantData.participant_uuid;
    const participant = this.participants.get(uuid);
    
    if (!participant) {
      // Participant we haven't seen before
      return this.addParticipant(participantData);
    }
    
    // Update basic info if provided
    if (participantData.display_name) {
      participant.displayName = participantData.display_name;
    }
    
    // Handle VAD (Voice Activity Detection) changes
    if ('vad' in participantData) {
      const wasSppeaking = participant.isSpeaking;
      const isSpeakingNow = participantData.vad === 100;
      
      if (!wasSppeaking && isSpeakingNow) {
        // Started speaking
        this.onStartSpeaking(participant);
      } else if (wasSppeaking && !isSpeakingNow) {
        // Stopped speaking
        this.onStopSpeaking(participant);
      }
    }
    
    // Handle mute status
    if ('is_muted' in participantData) {
      participant.isMuted = participantData.is_muted;
      if (participant.isMuted && participant.isSpeaking) {
        this.onStopSpeaking(participant);
      }
    }
    
    return participant;
  }

  // Called when participant starts speaking
  onStartSpeaking(participant) {
    participant.isSpeaking = true;
    participant.speakingStartTime = Date.now();
    participant.lastSpokeAt = Date.now();
    
    // Update current speaker
    const previousSpeaker = this.currentSpeaker;
    this.currentSpeaker = participant.uuid;
    this.lastSpeakerChange = Date.now();
    
    // Add to history
    this.speakingHistory.push({
      uuid: participant.uuid,
      displayName: participant.displayName,
      startTime: Date.now(),
      endTime: null
    });
    
    console.log(`${participant.displayName} started speaking`);
    
    // If someone else was speaking, stop them
    if (previousSpeaker && previousSpeaker !== participant.uuid) {
      const prevParticipant = this.participants.get(previousSpeaker);
      if (prevParticipant && prevParticipant.isSpeaking) {
        this.onStopSpeaking(prevParticipant);
      }
    }
  }

  // Called when participant stops speaking
  onStopSpeaking(participant) {
    if (!participant.isSpeaking) return;
    
    participant.isSpeaking = false;
    
    // Update speaking time
    if (participant.speakingStartTime) {
      const speakingDuration = Date.now() - participant.speakingStartTime;
      participant.totalSpeakingTime += speakingDuration;
      participant.speakingStartTime = null;
    }
    
    // Update history
    const lastHistoryEntry = this.speakingHistory[this.speakingHistory.length - 1];
    if (lastHistoryEntry && lastHistoryEntry.uuid === participant.uuid && !lastHistoryEntry.endTime) {
      lastHistoryEntry.endTime = Date.now();
    }
    
    console.log(`${participant.displayName} stopped speaking`);
    
    // Clear current speaker if it was this participant
    if (this.currentSpeaker === participant.uuid) {
      this.currentSpeaker = null;
    }
  }

  // Called when participant leaves
  removeParticipant(participantData) {
    const uuid = participantData.uuid || participantData.participant_uuid;
    const participant = this.participants.get(uuid);
    
    if (participant) {
      // Make sure to stop speaking if they were
      if (participant.isSpeaking) {
        this.onStopSpeaking(participant);
      }
      
      console.log(`Participant left: ${participant.displayName}`);
      this.participants.delete(uuid);
    }
  }

  // Handle stage events (active speaker detection)
  updateStage(stageData) {
    if (!stageData.participants || stageData.participants.length === 0) {
      return;
    }
    
    // Stage index 0 is the current active speaker
    const activeSpeaker = stageData.participants[0];
    if (activeSpeaker && activeSpeaker.vad > 0) {
      const participant = this.participants.get(activeSpeaker.uuid);
      if (participant && !participant.isSpeaking) {
        this.onStartSpeaking(participant);
      }
    }
    
    // Update VAD for all participants in stage
    stageData.participants.forEach(stageParticipant => {
      const participant = this.participants.get(stageParticipant.uuid);
      if (participant) {
        const isSpeaking = stageParticipant.vad > 0;
        if (isSpeaking && !participant.isSpeaking) {
          this.onStartSpeaking(participant);
        } else if (!isSpeaking && participant.isSpeaking) {
          this.onStopSpeaking(participant);
        }
      }
    });
  }

  // Get current speaker info
  getCurrentSpeaker() {
    if (!this.currentSpeaker) {
      return null;
    }
    
    const participant = this.participants.get(this.currentSpeaker);
    return participant ? {
      uuid: participant.uuid,
      displayName: participant.displayName,
      speakingDuration: participant.speakingStartTime 
        ? Date.now() - participant.speakingStartTime 
        : 0
    } : null;
  }

  // Get all participants
  getAllParticipants() {
    return Array.from(this.participants.values()).map(p => ({
      uuid: p.uuid,
      displayName: p.displayName,
      role: p.role,
      isSpeaking: p.isSpeaking,
      isMuted: p.isMuted || false,
      totalSpeakingTime: p.totalSpeakingTime
    }));
  }

  // Get speaking statistics
  getStatistics() {
    const stats = {
      totalParticipants: this.participants.size,
      currentSpeaker: this.getCurrentSpeaker(),
      participants: []
    };
    
    for (const [uuid, participant] of this.participants) {
      stats.participants.push({
        displayName: participant.displayName,
        totalSpeakingTime: participant.totalSpeakingTime,
        percentageOfTime: 0, // Will calculate below
        isSpeaking: participant.isSpeaking
      });
    }
    
    // Calculate percentages
    const totalSpeakingTime = stats.participants.reduce((sum, p) => sum + p.totalSpeakingTime, 0);
    if (totalSpeakingTime > 0) {
      stats.participants.forEach(p => {
        p.percentageOfTime = Math.round((p.totalSpeakingTime / totalSpeakingTime) * 100);
      });
    }
    
    // Sort by speaking time
    stats.participants.sort((a, b) => b.totalSpeakingTime - a.totalSpeakingTime);
    
    return stats;
  }

  // Get speaker for a given timestamp (for audio chunk attribution)
  getSpeakerAtTime(timestamp) {
    // Look through history to find who was speaking at this time
    for (let i = this.speakingHistory.length - 1; i >= 0; i--) {
      const entry = this.speakingHistory[i];
      if (entry.startTime <= timestamp) {
        if (!entry.endTime || entry.endTime >= timestamp) {
          return {
            uuid: entry.uuid,
            displayName: entry.displayName,
            confidence: 0.9 // High confidence since we have exact timing
          };
        }
      }
    }
    
    // No exact match, return current speaker with lower confidence
    if (this.currentSpeaker) {
      const participant = this.participants.get(this.currentSpeaker);
      if (participant) {
        return {
          uuid: participant.uuid,
          displayName: participant.displayName,
          confidence: 0.5 // Lower confidence
        };
      }
    }
    
    return {
      uuid: 'unknown',
      displayName: 'Unknown Speaker',
      confidence: 0
    };
  }

  // Clear all data
  reset() {
    this.participants.clear();
    this.currentSpeaker = null;
    this.speakingHistory = [];
    this.lastSpeakerChange = Date.now();
    console.log('Participant tracker reset');
  }
}