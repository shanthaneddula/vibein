import express from 'express';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// In-memory session and queue storage
const sessions = {};

// WebSocket client tracking: { sessionId: Set of ws clients }
const sessionClients = {};

// Spotify credentials
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;

// Helper: Get Spotify access token (Client Credentials Flow)
async function getSpotifyAccessToken() {
  const now = Date.now();
  if (spotifyAccessToken && now < spotifyTokenExpiresAt) {
    return spotifyAccessToken;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  spotifyAccessToken = data.access_token;
  spotifyTokenExpiresAt = now + (data.expires_in - 60) * 1000; // refresh 1 min early
  return spotifyAccessToken;
}

// REST: Create a new session
app.post('/api/create_session', (req, res) => {
  const sessionId = Math.random().toString(36).substr(2, 9);
  sessions[sessionId] = { queue: [] };
  res.json({ sessionId });
});

// REST: Search Spotify tracks
app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const token = await getSpotifyAccessToken();
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`;
  const spotifyRes = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await spotifyRes.json();
  res.json(data.tracks ? data.tracks.items : []);
});

// REST: Add a song to the session queue
app.post('/api/request_song', (req, res) => {
  const { sessionId, track } = req.body;
  if (!sessionId || !track) return res.status(400).json({ error: 'Missing sessionId or track' });
  if (!sessions[sessionId]) return res.status(404).json({ error: 'Session not found' });
  sessions[sessionId].queue.push(track);
  // Notify WebSocket clients for this session
  if (sessionClients[sessionId]) {
    for (const ws of sessionClients[sessionId]) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'queue_updated', queue: sessions[sessionId].queue }));
      }
    }
  }
  res.json({ success: true });
});

// REST: Get the current queue for a session
app.get('/api/queue', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!sessions[sessionId]) return res.status(404).json({ error: 'Session not found' });
  res.json(sessions[sessionId].queue);
});

// Health check
app.get('/', (req, res) => {
  res.send('VibeIn backend (REST + WebSocket) is running!');
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`VibeIn backend running on port ${PORT}`);
});

// WebSocket server
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  // Expect client to send a message: { type: 'subscribe', sessionId: '...' }
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe' && data.sessionId) {
        ws.sessionId = data.sessionId;
        if (!sessionClients[data.sessionId]) sessionClients[data.sessionId] = new Set();
        sessionClients[data.sessionId].add(ws);
        // Optionally send the current queue immediately
        if (sessions[data.sessionId]) {
          ws.send(JSON.stringify({ type: 'queue_updated', queue: sessions[data.sessionId].queue }));
        }
      }
    } catch (e) {
      // Ignore malformed messages
    }
  });
  ws.on('close', () => {
    if (ws.sessionId && sessionClients[ws.sessionId]) {
      sessionClients[ws.sessionId].delete(ws);
      if (sessionClients[ws.sessionId].size === 0) {
        delete sessionClients[ws.sessionId];
      }
    }
  });
}); 