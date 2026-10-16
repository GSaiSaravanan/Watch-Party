const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Active room state is kept in server memory (no external database).
// rooms[roomId] = {
//   participants: Map<socketId, username>,
//   hostId: socketId currently holding the host seat (null when vacant),
//   creatorToken: token proving who created the room (persistent host identity)
//   media: { currentVideoId, isPlaying, lastTimestamp, lastUpdated }
//   queue: [{ videoId, title, addedBy }]
//   bookmarks: [{ id, timestamp, videoId, note, createdAt }]
// }
const rooms = {};

const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ';

function getRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) {
    return { roomId, participantCount: 0, participants: [], hostId: null, hostName: null };
  }
  const participants = Array.from(room.participants.values());
  return {
    roomId,
    participantCount: participants.length,
    participants,
    hostId: room.hostId,
    hostName: room.hostId ? room.participants.get(room.hostId) || null : null,
  };
}

function broadcastRoom(roomId) {
  io.to(roomId).emit('room_update', getRoomState(roomId));
}

// Compute the host's *current* playback position from stored media state.
// If isPlaying is true, the playhead has advanced by the elapsed time since
// lastUpdated; otherwise it stays at lastTimestamp. Supports both the new
// { isPlaying, lastTimestamp } shape and the legacy { action, currentTime }
// shape written by older media_action payloads.
function getLiveMedia(room) {
  if (!room || !room.media) return null;
  const m = room.media;
  const isPlaying = typeof m.isPlaying === 'boolean' ? m.isPlaying : m.action === 'play';
  const base = typeof m.lastTimestamp === 'number' ? m.lastTimestamp
    : typeof m.currentTime === 'number' ? m.currentTime : 0;
  const lastUpdated = m.lastUpdated;
  const currentVideoId = m.currentVideoId || DEFAULT_VIDEO_ID;
  let currentTime = base;
  if (isPlaying && typeof lastUpdated === 'number') {
    currentTime = base + (Date.now() - lastUpdated) / 1000;
  }
  return { currentVideoId, isPlaying, currentTime, lastUpdated };
}

// Legacy alias kept for existing call sites during migration.
function getCurrentMedia(room) {
  const live = getLiveMedia(room);
  if (!live) return null;
  return {
    action: live.isPlaying ? 'play' : 'pause',
    currentTime: live.currentTime,
    lastUpdated: live.lastUpdated,
    currentVideoId: live.currentVideoId,
    isPlaying: live.isPlaying,
  };
}

function cleanupRoom(roomId) {
  if (rooms[roomId] && rooms[roomId].participants.size === 0) {
    delete rooms[roomId];
  }
}

// Remove a socket from a room. The host seat is intentionally NOT handed to a
// random participant: it stays reserved for the creator, who reclaims it via
// their creator token on reconnect (e.g. after a tab refresh). Returns true
// if anything changed (so the caller knows whether to broadcast).
function removeParticipant(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return false;
  if (!room.participants.delete(socketId)) return false;
  if (room.hostId === socketId) {
    // Keep the creator token so the original host can reclaim the seat;
    // leave hostId vacant rather than promoting someone else.
    room.hostId = null;
  }
  cleanupRoom(roomId);
  return true;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, username, isCreator, creatorToken }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase();
    const name = username && String(username).trim()
      ? String(username).trim().slice(0, 32)
      : `Guest-${socket.id.slice(0, 4)}`;

    if (!rooms[roomId]) {
      rooms[roomId] = { participants: new Map(), hostId: null, creatorToken: null, media: null, queue: [], bookmarks: [] };
    }
    const room = rooms[roomId];
    if (!Array.isArray(room.queue)) room.queue = [];
    if (!Array.isArray(room.bookmarks)) room.bookmarks = [];

    // Establish the creator token the first time a real creator arrives.
    // A joiner claiming to be the creator is only trusted if the room has no
    // creator yet OR their token matches the stored one (refresh/reconnect).
    if (isCreator && typeof creatorToken === 'string' && creatorToken) {
      if (!room.creatorToken) {
        room.creatorToken = creatorToken;
      }
      if (room.creatorToken === creatorToken) {
        room.hostId = socket.id; // creator owns the host seat
      }
    }

    room.participants.set(socket.id, name);
    socket.join(roomId);

    console.log(`${name} joined room ${roomId} (${room.participants.size} in room, host=${room.hostId ? 'yes' : 'no'})`);
    broadcastRoom(roomId);

    // Send the host's live (elapsed-adjusted) player state directly to the
    // newly joined socket so it jumps to the current spot and state.
    // 'sync_init' is the Step 5 packet; 'media_action' is kept for compat.
    // Also send the current queue + bookmarks so late-joiners see the same lists.
    const liveMedia = getLiveMedia(room);
    socket.emit('queue_updated', room.queue);
    // Late-joining guests immediately receive the authoritative bookmark list.
    socket.emit('bookmarks_updated', room.bookmarks || []);
    if (liveMedia) {
      const legacyAction = liveMedia.isPlaying ? 'play' : 'pause';
      socket.emit('sync_init', {
        currentVideoId: liveMedia.currentVideoId,
        isPlaying: liveMedia.isPlaying,
        currentTime: liveMedia.currentTime,
        action: legacyAction,
        queue: room.queue,
        bookmarks: room.bookmarks,
      });
      socket.emit('media_action', {
        action: legacyAction,
        currentTime: liveMedia.currentTime,
        currentVideoId: liveMedia.currentVideoId,
        isPlaying: liveMedia.isPlaying,
      });
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase();
    socket.leave(roomId);
    if (removeParticipant(roomId, socket.id)) {
      broadcastRoom(roomId);
    }
  });

  // Playback control from the host: persist the latest state in the unified
  // { currentVideoId, isPlaying, lastTimestamp, lastUpdated } shape and relay
  // it to everyone else in the room. The sender is excluded via
  // socket.to(roomId). Accepts legacy { action, currentTime } payloads too.
  socket.on('media_action', ({ roomId, action, currentTime, currentVideoId, videoId }) => {
    if (!roomId || !action) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const ts = typeof currentTime === 'number' ? currentTime : 0;
    const prevMedia = room.media;
    const prevVideoId = (prevMedia && prevMedia.currentVideoId) || DEFAULT_VIDEO_ID;
    // change_video carries the target in videoId (bookmark jumps) or
    // currentVideoId (queue/legacy) — accept either.
    const targetVideoId = typeof videoId === 'string' && videoId
      ? videoId
      : typeof currentVideoId === 'string' && currentVideoId
        ? currentVideoId
        : prevVideoId;
    const media = {
      currentVideoId: targetVideoId,
      isPlaying: action === 'change_video' ? true : action === 'play',
      lastTimestamp: ts,
      lastUpdated: Date.now(),
      // Legacy fields kept so older clients keep working.
      action: action === 'change_video' ? 'play' : action,
      currentTime: ts,
    };
    room.media = media;

    socket.to(roomId).emit('media_action', {
      action,
      currentTime: ts,
      currentVideoId: media.currentVideoId,
      videoId: media.currentVideoId,
      isPlaying: media.isPlaying,
    });
  });

  // A guest (or anyone) can request the host's accurate current time AND
  // video, e.g. to snap back after drifting or recovering from a pause. We
  // reply on the same 'media_action' channel (only to the requester) so the
  // client's existing, isRemoteUpdate-guarded handling applies it without
  // echoing.
  socket.on('sync_request', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    const liveMedia = getLiveMedia(room);
    if (liveMedia) {
      socket.emit('media_action', {
        action: liveMedia.isPlaying ? 'play' : 'pause',
        currentTime: liveMedia.currentTime,
        currentVideoId: liveMedia.currentVideoId,
        videoId: liveMedia.currentVideoId,
        isPlaying: liveMedia.isPlaying,
      });
    }
  });

  // Host heartbeat (~every 2s from the host client): refresh the server's
  // stored playhead and forward the host time to the rest of the room so
  // guests can drift-correct. Sender excluded; no echo possible.
  socket.on('heartbeat', ({ roomId, currentTime }) => {
    if (!roomId || typeof currentTime !== 'number') return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room || !room.media) return;

    room.media.lastTimestamp = currentTime;
    room.media.currentTime = currentTime; // legacy mirror
    room.media.lastUpdated = Date.now();

    socket.to(roomId).emit('heartbeat', { currentTime });
  });

  // Step 6 — live chat: broadcast a message to everyone in the room
  // (including the sender, so all clients render the same list).
  socket.on('chat_message', ({ roomId, sender, text, timestamp }) => {
    if (!roomId || typeof text !== 'string' || !text.trim()) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    // Prefer the sender's server-known username (stored at join_room) so
    // names stay consistent; fall back to the provided sender label.
    const knownName = room.participants.get(socket.id);
    io.to(roomId).emit('chat_message', {
      sender: knownName || (typeof sender === 'string' && sender ? sender.slice(0, 32) : 'Guest'),
      text: text.slice(0, 500),
      timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    });
  });

  // Step 6 — emoji reactions: relay a floating reaction to the whole room,
  // including the sender's username so clients can show a name tag.
  socket.on('send_reaction', ({ roomId, emoji, sender }) => {
    if (!roomId || typeof emoji !== 'string' || !emoji) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    const knownName = room.participants.get(socket.id);
    const senderName = knownName
      || (typeof sender === 'string' && sender.trim() ? sender.trim().slice(0, 32) : 'Guest');
    io.to(roomId).emit('reaction', { emoji: emoji.slice(0, 8), sender: senderName });
  });

  const broadcastQueue = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!Array.isArray(room.queue)) room.queue = [];
    io.to(roomId).emit('queue_updated', room.queue);
  };

  // Functional, synchronized Movie Queue (in-memory per room).
  socket.on('add_to_queue', ({ roomId, videoId, title, addedBy }) => {
    if (!roomId || typeof videoId !== 'string' || !videoId.trim()) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (!Array.isArray(room.queue)) room.queue = [];
    const cleanId = videoId.trim().slice(0, 32);
    const knownName = room.participants.get(socket.id);
    const who = knownName
      || (typeof addedBy === 'string' && addedBy.trim() ? addedBy.trim().slice(0, 32) : 'Guest');
    room.queue.push({
      videoId: cleanId,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : cleanId,
      addedBy: who,
    });
    broadcastQueue(roomId);
  });

  socket.on('remove_from_queue', ({ roomId, index }) => {
    if (!roomId || typeof index !== 'number') return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room || !Array.isArray(room.queue)) return;
    if (index < 0 || index >= room.queue.length) return;
    room.queue.splice(index, 1);
    broadcastQueue(roomId);
  });

  const broadcastBookmarks = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!Array.isArray(room.bookmarks)) room.bookmarks = [];
    io.to(roomId).emit('bookmarks_updated', room.bookmarks);
  };

  // Host Bookmarking (in-memory per room). No authorization checks — the
  // server array is the single source of truth, broadcast room-wide.
  socket.on('add_bookmark', (payload) => {
    console.log('[SERVER] add_bookmark payload:', payload);
    const roomId = payload?.roomId;
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { participants: new Map(), hostId: null, creatorToken: null, media: null, queue: [], bookmarks: [] }; // Force init if somehow missing
    if (!Array.isArray(rooms[roomId].bookmarks)) {
      rooms[roomId].bookmarks = [];
    }
    const rawTime = Number(payload.timestamp);
    const safeTime = !isNaN(rawTime) && rawTime >= 0 ? rawTime : 0;
    const mins = Math.floor(safeTime / 60);
    const secs = String(Math.floor(safeTime % 60)).padStart(2, '0');
    const newBm = {
      id: 'bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: safeTime,
      videoId: payload.videoId || rooms[roomId].media?.currentVideoId || 'dQw4w9WgXcQ',
      note: payload.note || ('Bookmark at ' + mins + ':' + secs),
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    rooms[roomId].bookmarks.push(newBm);
    rooms[roomId].bookmarks.sort((a, b) => a.timestamp - b.timestamp);
    console.log('[SERVER] Broadcasting bookmarks_updated to room', roomId, 'count:', rooms[roomId].bookmarks.length);
    io.in(roomId).emit('bookmarks_updated', rooms[roomId].bookmarks);
  });

  socket.on('delete_bookmark', ({ roomId, bookmarkId, creatorToken }) => {
    if (!roomId || bookmarkId == null) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room || !Array.isArray(room.bookmarks)) return;
    if (room.hostId !== socket.id) {
      if (typeof creatorToken === 'string' && creatorToken && room.creatorToken && creatorToken === room.creatorToken) {
        room.hostId = socket.id; // verified creator reclaims the host seat
        broadcastRoom(roomId);
      } else if (room.hostId) {
        return; // another socket holds the host seat — guest write rejected
      }
      // else: host seat vacant — allow the write (prevents silent loss)
    }
    room.bookmarks = room.bookmarks.filter((b) => b.id !== bookmarkId);
    broadcastBookmarks(roomId);
  });

  // Step 6 — latency ping-pong: echo the client's sendTime straight back so
  // the client can compute RTT = Date.now() - sendTime.
  socket.on('ping_check', ({ roomId, sendTime } = {}) => {
    socket.emit('pong_check', { sendTime });
    void roomId;
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Remove the socket from every room it was part of and notify those rooms.
    for (const roomId of Object.keys(rooms)) {
      if (removeParticipant(roomId, socket.id)) {
        broadcastRoom(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, server, io, rooms };
