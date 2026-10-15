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
// }
const rooms = {};

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
// If the last action was 'play', the playhead has advanced by the elapsed time
// since lastUpdated; if it was 'pause'/'seek', it stays where it was.
function getCurrentMedia(room) {
  if (!room || !room.media) return null;
  const { action, currentTime, lastUpdated } = room.media;
  let time = currentTime;
  if (action === 'play' && typeof lastUpdated === 'number') {
    time = currentTime + (Date.now() - lastUpdated) / 1000;
  }
  return { action, currentTime: time, lastUpdated };
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
      rooms[roomId] = { participants: new Map(), hostId: null, creatorToken: null, media: null };
    }
    const room = rooms[roomId];

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

    // Send the host's current (elapsed-adjusted) player state directly to the
    // newly joined socket so it syncs to the right position immediately.
    const currentMedia = getCurrentMedia(room);
    if (currentMedia) {
      socket.emit('media_action', {
        action: currentMedia.action,
        currentTime: currentMedia.currentTime,
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

  // Playback control from the host: persist the latest state and relay it to
  // everyone else in the room. The sender is excluded via socket.to(roomId).
  socket.on('media_action', ({ roomId, action, currentTime }) => {
    if (!roomId || !action) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const media = {
      action,
      currentTime: typeof currentTime === 'number' ? currentTime : 0,
      lastUpdated: Date.now(),
    };
    room.media = media;

    socket.to(roomId).emit('media_action', { action, currentTime });
  });

  // A guest (or anyone) can request the host's accurate current time, e.g. to
  // snap back after drifting or recovering from a pause. We reply on the same
  // 'media_action' channel (only to the requester) so the client's existing,
  // isRemoteUpdate-guarded handling applies it without echoing.
  socket.on('sync_request', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase();
    const room = rooms[roomId];
    const currentMedia = getCurrentMedia(room);
    if (currentMedia) {
      socket.emit('media_action', {
        action: currentMedia.action,
        currentTime: currentMedia.currentTime,
      });
    }
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
