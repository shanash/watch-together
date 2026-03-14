// Load .env for local development
try { const { config } = await import('dotenv'); config(); } catch {}

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { generatePresignedUrl } from './r2.js';
import log from './logger.js';

// Build version from git
let BUILD_VERSION = 'unknown';
try {
  BUILD_VERSION = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}
const BUILD_TIME = new Date().toISOString();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  httpCompression: false,
});

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Serve ffmpeg.wasm UMD files from node_modules (same-origin for Worker)
app.use('/ffmpeg', express.static(join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/umd')));
app.use('/ffmpeg-util', express.static(join(__dirname, 'node_modules/@ffmpeg/util/dist/umd')));

// --- Direct join URL (legacy redirect) ---
app.get('/join/:roomId', (req, res) => {
  res.redirect(`/${req.params.roomId}`);
});

// --- Version API ---
app.get('/api/version', (req, res) => {
  res.json({ version: BUILD_VERSION, buildTime: BUILD_TIME });
});

// --- YouTube URL Validation ---
app.post('/api/validate-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ valid: false, error: 'URL이 필요합니다.' });

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) {
      return res.json({ valid: false, error: '유효하지 않은 YouTube 영상입니다.' });
    }
    const data = await resp.json();
    res.json({ valid: true, title: data.title });
  } catch {
    res.json({ valid: false, error: 'YouTube 영상을 확인할 수 없습니다.' });
  }
});

// --- Validate video URL ---
app.post('/api/validate-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ valid: false, error: 'URL이 필요합니다.' });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.json({ valid: false, error: '유효하지 않은 URL입니다.' });
    }

    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      return res.json({ valid: false, error: '접근할 수 없는 URL입니다.' });
    }

    const contentType = resp.headers.get('content-type') || '';
    const ext = parsed.pathname.split('.').pop().toLowerCase();
    const videoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'm3u8'];

    if (contentType.startsWith('video/') || contentType.includes('mpegurl') || videoExts.includes(ext)) {
      return res.json({ valid: true });
    }

    return res.json({ valid: false, error: '영상 파일이 아닌 것 같습니다. (Content-Type: ' + contentType + ')' });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.json({ valid: false, error: 'URL 확인 시간이 초과되었습니다.' });
    }
    return res.json({ valid: false, error: '유효하지 않은 URL입니다.' });
  }
});

// --- Upload: Presigned URL ---
const ALLOWED_EXTS = new Set(['.mp4', '.webm', '.mkv']);
const ALLOWED_SUB_EXTS = new Set(['.smi', '.srt', '.vtt']);

app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: '파일명과 콘텐츠 타입이 필요합니다.' });
    }

    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return res.status(400).json({ error: 'mp4, webm, mkv 파일만 업로드할 수 있습니다.' });
    }

    const key = `${nanoid(10)}${ext}`;
    const result = await generatePresignedUrl(key, contentType);
    res.json(result);
  } catch (err) {
    log.error('upload', 'Presign failed', { error: err.message });
    res.status(500).json({ error: '업로드 URL 생성에 실패했습니다.' });
  }
});

// --- Subtitle: Presigned URL ---
app.post('/api/presign-subtitle', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: '파일명이 필요합니다.' });
    }

    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_SUB_EXTS.has(ext)) {
      return res.status(400).json({ error: 'smi, srt, vtt 파일만 업로드할 수 있습니다.' });
    }

    const key = `subs/${nanoid(10)}${ext}`;
    const result = await generatePresignedUrl(key, 'text/plain');
    res.json(result);
  } catch (err) {
    log.error('upload', 'Subtitle presign failed', { error: err.message });
    res.status(500).json({ error: '자막 업로드 URL 생성에 실패했습니다.' });
  }
});

// --- Subtitle Proxy (avoid CORS issues when fetching from R2) ---
app.get('/api/subtitle-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL이 필요합니다.' });
    }

    const publicBase = process.env.R2_PUBLIC_URL;
    if (!publicBase || !url.startsWith(publicBase)) {
      return res.status(403).json({ error: '허용되지 않는 URL입니다.' });
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: '자막 다운로드 실패' });
    }

    const text = await response.text();
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    log.error('subtitle', 'Proxy fetch failed', { error: err.message });
    res.status(500).json({ error: '자막 프록시 오류' });
  }
});

// --- Log Viewer API ---
import { readFile } from 'fs/promises';

app.get('/api/logs', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const logPath = join(__dirname, 'logs', `${date}.log`);
    const content = await readFile(logPath, 'utf-8');
    const level = req.query.level;
    let lines = content.split('\n').filter(Boolean);
    if (level) {
      lines = lines.filter((l) => l.includes(`[${level.toUpperCase()}]`));
    }
    const last = parseInt(req.query.last) || 200;
    lines = lines.slice(-last);
    res.type('text/plain; charset=utf-8').send(lines.join('\n'));
  } catch {
    res.status(404).send('로그 파일이 없습니다.');
  }
});

// --- Room Persistence ---
const ROOMS_FILE = join(__dirname, 'data', 'rooms.json');
const ROOM_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours empty → delete
const rooms = new Map();

function saveRooms() {
  const data = {};
  for (const [id, room] of rooms) {
    data[id] = {
      playlist: room.playlist,
      currentIndex: room.currentIndex,
      playbackState: room.playbackState,
      emptyAt: room.users.length === 0 ? (room.emptyAt || Date.now()) : null,
    };
  }
  try {
    mkdirSync(join(__dirname, 'data'), { recursive: true });
    writeFileSync(ROOMS_FILE, JSON.stringify(data));
  } catch (err) {
    log.error('persist', 'Failed to save rooms', { error: err.message });
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveRooms();
  }, 2000);
}

function loadRooms() {
  try {
    const raw = readFileSync(ROOMS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [id, saved] of Object.entries(data)) {
      // Skip rooms that have been empty longer than ROOM_EXPIRY
      if (saved.emptyAt && now - saved.emptyAt >= ROOM_EXPIRY) {
        log.info('persist', 'Skipped expired room', { roomId: id });
        continue;
      }
      const room = {
        playlist: saved.playlist || [],
        currentIndex: saved.currentIndex || 0,
        users: [],
        playbackState: saved.playbackState || { currentTime: 0, isPlaying: false, updatedAt: now },
        emptyAt: saved.emptyAt || null,
        deleteTimeout: null,
      };
      rooms.set(id, room);
      // Schedule cleanup for rooms that were already empty
      if (room.emptyAt) {
        const remaining = ROOM_EXPIRY - (now - room.emptyAt);
        room.deleteTimeout = setTimeout(() => {
          if (room.users.length === 0) {
            rooms.delete(id);
            scheduleSave();
            log.info('room', 'Room deleted (expired after restart)', { roomId: id });
          }
        }, remaining);
      }
    }
    log.info('persist', `Loaded ${rooms.size} rooms from disk`);
  } catch {
    // No saved data or parse error — start fresh
  }
}

loadRooms();

function generateRoomId() {
  return nanoid(6);
}

function getYouTubeVideoId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([^&?#/]+)/
  );
  return match ? match[1] : null;
}

async function fetchVideoTitle(url) {
  if (getYouTubeVideoId(url)) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const resp = await fetch(oembedUrl);
      if (resp.ok) {
        const data = await resp.json();
        return data.title;
      }
    } catch {}
  }
  // Fallback: decode URL filename without extension
  try {
    const filename = decodeURIComponent(url.split('/').pop().split('?')[0]);
    return filename.replace(/\.[^.]+$/, '') || 'Video';
  } catch {
    return 'Video';
  }
}

io.engine.on('connection_error', (err) => {
  log.error('engine', 'Connection error', {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

io.on('connection', (socket) => {
  const transport = socket.conn.transport.name;
  const addr = socket.handshake.address;
  const ua = socket.handshake.headers['user-agent'] || 'unknown';
  socket.data.connectedAt = Date.now();
  log.info('socket', 'Client connected', {
    socketId: socket.id,
    transport,
    address: addr,
    userAgent: ua,
  });

  // Log transport upgrades (polling -> websocket)
  socket.conn.on('upgrade', (transport) => {
    log.info('socket', 'Transport upgraded', {
      socketId: socket.id,
      nickname: socket.data.nickname,
      transport: transport.name,
    });
  });

  socket.conn.on('close', (reason, description) => {
    log.warn('socket', 'Transport closed', {
      socketId: socket.id,
      nickname: socket.data.nickname,
      roomId: socket.data.roomId,
      reason,
      description: description?.message || description,
    });
  });

  socket.on('error', (err) => {
    log.error('socket', 'Socket error', {
      socketId: socket.id,
      nickname: socket.data.nickname,
      roomId: socket.data.roomId,
      error: err.message,
    });
  });

  // --- Create Room ---
  socket.on('create-room', async ({ nickname, videoUrl, subtitleUrl, requestedRoomId }) => {
    // If the requested room already exists (e.g. persisted after restart), rejoin it
    if (requestedRoomId && rooms.has(requestedRoomId)) {
      const room = rooms.get(requestedRoomId);
      if (room.deleteTimeout) {
        clearTimeout(room.deleteTimeout);
        room.deleteTimeout = null;
      }
      room.emptyAt = null;
      const existing = room.users.find((u) => u.nickname === nickname);
      if (existing) {
        existing.id = socket.id;
      } else {
        room.users.push({ id: socket.id, nickname });
      }
      socket.join(requestedRoomId);
      socket.data.roomId = requestedRoomId;
      socket.data.nickname = nickname;
      socket.emit('room-created', { roomId: requestedRoomId, playlist: room.playlist, currentIndex: room.currentIndex });
      log.info('room', 'Host rejoined persisted room', { roomId: requestedRoomId, nickname });
      scheduleSave();
      return;
    }

    const roomId = requestedRoomId || generateRoomId();
    const playlist = [];
    if (videoUrl) {
      const title = await fetchVideoTitle(videoUrl);
      playlist.push({ url: videoUrl, title, addedBy: nickname, subtitleUrl: subtitleUrl || null });
    }
    const room = {
      playlist,
      currentIndex: 0,
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

    socket.emit('room-created', { roomId, playlist: room.playlist, currentIndex: 0 });
    log.info('room', 'Room created', { roomId, nickname, videoUrl });
    scheduleSave();
  });

  // --- Join Room ---
  socket.on('join-room', ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', { message: '존재하지 않는 방입니다.', fatal: true });
      return;
    }

    // Clear deletion grace period if room was scheduled for cleanup
    if (room.deleteTimeout) {
      clearTimeout(room.deleteTimeout);
      room.deleteTimeout = null;
      log.info('room', 'Room deletion cancelled (user rejoined)', { roomId, nickname });
    }
    room.emptyAt = null;

    // Handle reconnection: update socket id if same nickname already exists
    const existing = room.users.find((u) => u.nickname === nickname);
    if (existing) {
      existing.id = socket.id;
    } else {
      room.users.push({ id: socket.id, nickname });
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    socket.emit('room-joined', {
      room: {
        playlist: room.playlist,
        currentIndex: room.currentIndex,
        users: room.users.map((u) => u.nickname),
      },
      playbackState: room.playbackState,
    });

    if (!existing) {
      socket.to(roomId).emit('user-joined', { nickname });
    }
    log.info('room', 'User joined', { roomId, nickname, userCount: room.users.length, reconnect: !!existing });
    scheduleSave();
  });

  // --- Sync Events (All participants) ---
  socket.on('sync-play', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.playbackState = {
      currentTime,
      isPlaying: true,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-play', { currentTime });
    scheduleSave();
  });

  socket.on('sync-pause', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.playbackState = {
      currentTime,
      isPlaying: false,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-pause', { currentTime });
    scheduleSave();
  });

  socket.on('sync-seek', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.playbackState = {
      ...room.playbackState,
      currentTime,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit('sync-seek', { currentTime });
    scheduleSave();
  });

  socket.on('sync-rate', ({ rate }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    socket.to(roomId).emit('sync-rate', { rate });
  });

  // --- Chat ---
  socket.on('chat-message', ({ message }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !message || !message.trim()) return;
    const msg = message.trim().slice(0, 200);
    io.in(roomId).emit('chat-message', {
      nickname: socket.data.nickname,
      message: msg,
      timestamp: Date.now(),
    });
  });

  // --- Playlist Subtitle ---
  socket.on('playlist-subtitle', ({ index, subtitleUrl }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || index < 0 || index >= room.playlist.length) return;
    room.playlist[index].subtitleUrl = subtitleUrl;
    io.in(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
    log.info('room', 'Playlist subtitle updated', { roomId, nickname: socket.data.nickname, index, subtitleUrl });
    scheduleSave();
  });

  // --- Playlist Events ---
  socket.on('playlist-add', async ({ url, subtitleUrl, title: clientTitle }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.playlist.length >= 100) {
      socket.emit('error-msg', { message: '재생목록은 최대 100개까지 추가할 수 있습니다.' });
      return;
    }
    const title = clientTitle || await fetchVideoTitle(url);
    room.playlist.push({ url, title, addedBy: socket.data.nickname, subtitleUrl: subtitleUrl || null });
    io.in(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
    scheduleSave();
  });

  socket.on('playlist-remove', ({ index }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || index < 0 || index >= room.playlist.length) return;
    // Don't allow removing the currently playing item
    if (index === room.currentIndex) {
      socket.emit('error-msg', { message: '현재 재생 중인 영상은 삭제할 수 없습니다.' });
      return;
    }
    room.playlist.splice(index, 1);
    // Adjust currentIndex if a preceding item was removed
    if (index < room.currentIndex) {
      room.currentIndex--;
    }
    io.in(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
    scheduleSave();
  });

  socket.on('playlist-reorder', ({ fromIndex, toIndex }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (fromIndex < 0 || fromIndex >= room.playlist.length) return;
    if (toIndex < 0 || toIndex >= room.playlist.length) return;
    if (fromIndex === toIndex) return;

    const [item] = room.playlist.splice(fromIndex, 1);
    room.playlist.splice(toIndex, 0, item);

    // Adjust currentIndex to follow the currently playing item
    if (room.currentIndex === fromIndex) {
      room.currentIndex = toIndex;
    } else if (fromIndex < room.currentIndex && toIndex >= room.currentIndex) {
      room.currentIndex--;
    } else if (fromIndex > room.currentIndex && toIndex <= room.currentIndex) {
      room.currentIndex++;
    }

    io.in(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
    scheduleSave();
  });

  socket.on('playlist-play', ({ index }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || index < 0 || index >= room.playlist.length) return;
    if (index === room.currentIndex) return;
    room.currentIndex = index;
    room.playbackState = { currentTime: 0, isPlaying: true, updatedAt: Date.now() };
    io.in(roomId).emit('playlist-switch', { url: room.playlist[index].url, index });
    scheduleSave();
  });

  socket.on('video-ended', ({ index }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.currentIndex !== index) return;
    const nextIndex = index + 1;
    if (nextIndex >= room.playlist.length) {
      room.playbackState = { currentTime: 0, isPlaying: false, updatedAt: Date.now() };
      io.in(roomId).emit('playlist-ended');
      return;
    }
    room.currentIndex = nextIndex;
    room.playbackState = { currentTime: 0, isPlaying: true, updatedAt: Date.now() };
    io.in(roomId).emit('playlist-switch', { url: room.playlist[nextIndex].url, index: nextIndex });
    scheduleSave();
  });

  // --- Network Status ---
  socket.on('ping-check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('network-status', ({ latency }) => {
    const roomId = socket.data.roomId;
    const nickname = socket.data.nickname;
    if (!roomId) return;
    if (latency > 1000) {
      log.warn('network', 'High latency detected', {
        socketId: socket.id,
        nickname,
        roomId,
        latency,
      });
    }
    socket.to(roomId).emit('user-network', { nickname, latency });
  });

  // --- Buffering Status ---
  socket.on('buffering-status', ({ buffering }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('user-buffering', { nickname: socket.data.nickname, buffering });
  });

  // --- Request Sync (server responds directly) ---
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    socket.emit('sync-state', room.playbackState);
  });

  // --- Client Error Reporting ---
  socket.on('client-error', ({ message, stack, context }) => {
    log.error('client', message, {
      socketId: socket.id,
      nickname: socket.data.nickname,
      roomId: socket.data.roomId,
      context,
      stack,
    });
  });

  // --- Socket Error ---
  socket.on('error', (err) => {
    log.error('socket', 'Socket error', {
      socketId: socket.id,
      nickname: socket.data.nickname,
      roomId: socket.data.roomId,
      error: err.message,
    });
  });

  // --- Disconnect ---
  socket.on('disconnect', (reason) => {
    log.warn('socket', 'Client disconnected', {
      socketId: socket.id,
      nickname: socket.data.nickname,
      roomId: socket.data.roomId,
      reason,
      transport: socket.conn?.transport?.name || 'unknown',
      connectedDuration: socket.data.connectedAt
        ? `${Math.round((Date.now() - socket.data.connectedAt) / 1000)}s`
        : 'unknown',
    });

    const roomId = socket.data.roomId;
    const nickname = socket.data.nickname;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Remove user
    room.users = room.users.filter((u) => u.id !== socket.id);

    // If no users left, schedule room deletion with grace period
    if (room.users.length === 0) {
      room.emptyAt = Date.now();
      log.info('room', 'Room empty, scheduled for deletion', { roomId, graceMs: ROOM_EXPIRY });
      room.deleteTimeout = setTimeout(() => {
        if (room.users.length === 0) {
          rooms.delete(roomId);
          scheduleSave();
          log.info('room', 'Room deleted (expired)', { roomId });
        }
      }, ROOM_EXPIRY);
      scheduleSave();
      return;
    }

    socket.to(roomId).emit('user-left', { nickname });
    log.info('room', 'User left', { roomId, nickname, remainingUsers: room.users.length });
  });
});

// --- Short join URL (must be last route) ---
app.get('/:roomId([A-Za-z0-9_-]{6,})', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'join.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log.info('server', `Server started on port ${PORT}`);

  // Prevent Render free tier sleep (pings every 14 minutes)
  const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000;
  setInterval(() => {
    fetch(`http://localhost:${PORT}/api/version`).catch(() => {});
  }, KEEP_ALIVE_INTERVAL);
});
