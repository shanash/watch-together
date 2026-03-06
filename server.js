// Load .env for local development
try { const { config } = await import('dotenv'); config(); } catch {}

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { generatePresignedUrl } from './r2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Upload: Presigned URL ---
const ALLOWED_EXTS = new Set(['.mp4', '.webm']);

app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: '파일명과 콘텐츠 타입이 필요합니다.' });
    }

    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return res.status(400).json({ error: 'mp4, webm 파일만 업로드할 수 있습니다.' });
    }

    const key = `${nanoid(10)}${ext}`;
    const result = await generatePresignedUrl(key, contentType);
    res.json(result);
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: '업로드 URL 생성에 실패했습니다.' });
  }
});

// In-memory room storage
const rooms = new Map();

function generateRoomId() {
  return nanoid(6);
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // --- Create Room ---
  socket.on('create-room', ({ nickname, videoUrl }) => {
    const roomId = generateRoomId();
    const room = {
      hostId: socket.id,
      videoUrl,
      users: [{ id: socket.id, nickname }],
      playbackState: {
        currentTime: 0,
        isPlaying: false,
        updatedAt: Date.now(),
      },
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    socket.emit('room-created', { roomId });
    console.log(`Room ${roomId} created by ${nickname}`);
  });

  // --- Join Room ---
  socket.on('join-room', ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', { message: '존재하지 않는 방입니다.' });
      return;
    }

    room.users.push({ id: socket.id, nickname });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    socket.emit('room-joined', {
      room: {
        videoUrl: room.videoUrl,
        users: room.users.map((u) => u.nickname),
        hostNickname: room.users.find((u) => u.id === room.hostId)?.nickname,
        isHost: false,
      },
      playbackState: room.playbackState,
    });

    socket.to(roomId).emit('user-joined', { nickname });
    console.log(`${nickname} joined room ${roomId}`);
  });

  // --- Sync Events (Host only) ---
  socket.on('sync-play', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playbackState = {
      currentTime,
      isPlaying: true,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-play', { currentTime });
  });

  socket.on('sync-pause', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playbackState = {
      currentTime,
      isPlaying: false,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-pause', { currentTime });
  });

  socket.on('sync-seek', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    room.playbackState = {
      ...room.playbackState,
      currentTime,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-seek', { currentTime });
  });

  // --- Request Sync (server responds directly) ---
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    socket.emit('sync-state', room.playbackState);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const nickname = socket.data.nickname;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Remove user
    room.users = room.users.filter((u) => u.id !== socket.id);

    // If no users left, delete room
    if (room.users.length === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (empty)`);
      return;
    }

    // If host left, promote next user
    if (room.hostId === socket.id) {
      const newHost = room.users[0];
      room.hostId = newHost.id;

      io.to(newHost.id).emit('host-promoted', { roomId });
      socket.to(roomId).emit('host-changed', { newHostNickname: newHost.nickname });
      console.log(`Host migrated to ${newHost.nickname} in room ${roomId}`);
    }

    socket.to(roomId).emit('user-left', { nickname });
    console.log(`${nickname} left room ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
