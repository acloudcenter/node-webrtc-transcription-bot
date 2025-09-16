# API Mode - Remote Control for Transcription Bot

The transcription bot can run in API mode, allowing external applications (like Pexip widgets) to trigger the bot to join conferences on demand.

## Quick Start

1. **Install dependencies** (if not already done):
   ```bash
   npm install
   ```

2. **Start the API server**:
   ```bash
   npm run start:server
   # or for development with auto-reload:
   npm run dev:server
   ```

3. **Test with the widget**:
   - Open `test/test-widget.html` in your browser
   - Enter conference details
   - Click "Dial In" to have the bot join

## API Endpoints

### Health Check
```
GET /health
```
Returns server status and active connection count.

### Dial In (Join Conference)
```
POST /api/dial-in
Content-Type: application/json

{
  "conferenceAlias": "testalias",        // Required
  "displayName": "Transcription Bot",   // Optional
  "pin": "1234",                        // Optional
  "pexipNode": "test.domain.com", // Optional (uses .env default)
  "transcriptionProvider": "openai"     // Optional: "openai" or "gemini"
}
```

Response:
```json
{
  "success": true,
  "connectionId": "testtest_123456",
  "message": "Bot successfully joined conference",
  "conference": {
    "alias": "test",
    "displayName": "Transcription Bot",
    "node": "test.domain.com",
    "provider": "openai"
  }
}
```

### Hang Up (Leave Conference)
```
POST /api/hang-up
Content-Type: application/json

{
  "connectionId": "test_1234567890"
  // OR
  "conferenceAlias": "test"
}
```

Response:
```json
{
  "success": true,
  "message": "Bot disconnected from conference",
  "connectionId": "test_1234567890",
  "transcriptions": 42,
  "duration": 125000
}
```

### List Active Connections
```
GET /api/connections
```

### Get Connection Details
```
GET /api/connections/:connectionId
```

## Environment Variables

Add to your `.env` file:
```
# API Server
SERVER_PORT=3000  # Optional, defaults to 3000
```

## Integration with Pexip

To integrate with a Pexip conference as a widget:

1. **Create a custom widget** in your Pexip webapp
2. **Add a button** that calls the dial-in endpoint
3. **Pass conference details** from the Pexip context

Example widget code:
```javascript
// Get conference details from Pexip
const conferenceAlias = pexipContext.conferenceAlias;
const displayName = `Bot for ${pexipContext.userName}`;

// Call bot API
fetch('http://your-bot-server:3000/api/dial-in', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    conferenceAlias,
    displayName,
    pin: pexipContext.pin
  })
});
```

## Security Considerations

For production use:
- Add authentication to the API endpoints
- Use HTTPS with proper certificates
- Implement rate limiting
- Validate conference aliases against a whitelist
- Add CORS restrictions for specific domains

## Multiple Conferences

The server supports multiple simultaneous connections to different conferences. Each connection:
- Gets a unique connection ID
- Maintains separate transcription files
- Can be individually controlled
- Has its own audio processing pipeline

## Deployment

For production deployment:
1. Use a process manager like PM2
2. Set up proper logging
3. Configure firewall rules
4. Use environment-specific `.env` files
5. Monitor resource usage (especially for multiple connections)
