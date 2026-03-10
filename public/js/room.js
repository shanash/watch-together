const socket = io();
const video = document.getElementById('video-player');
const roomIdEl = document.getElementById('room-id');
const copyCodeBtn = document.getElementById('copy-code');
const userList = document.getElementById('user-list');
const userCount = document.getElementById('user-count');
const statusMsg = document.getElementById('status-msg');
const syncNotice = document.getElementById('sync-notice');
const subToggle = document.getElementById('sub-toggle');

let syncCooldown = false; // timer-based flag to prevent sync event loops
let syncCooldownTimer = null;
let syncEventsBound = false;
const SYNC_COOLDOWN_MS = 300;
let roomId = sessionStorage.getItem('wt-roomId');
let nickname = sessionStorage.getItem('wt-nickname');
const action = sessionStorage.getItem('wt-action');

// Redirect if no session data
if (!roomId || !nickname || !action) {
  window.location.href = '/';
}

// --- Init ---
socket.on('connect', () => {
  if (action === 'host') {
    const videoUrl = sessionStorage.getItem('wt-videoUrl');
    const subtitleUrl = sessionStorage.getItem('wt-subtitleUrl') || null;
    socket.emit('create-room', { nickname, videoUrl, subtitleUrl });
  } else {
    socket.emit('join-room', { roomId, nickname });
  }
});

// --- Host: Room Created ---
socket.on('room-created', ({ roomId: id }) => {
  roomId = id;
  sessionStorage.setItem('wt-roomId', roomId);

  roomIdEl.textContent = roomId;
  statusMsg.textContent = '방이 생성되었습니다. 영상을 재생하세요.';

  // Set video source
  const videoUrl = sessionStorage.getItem('wt-videoUrl');
  video.src = videoUrl;
  video.controls = true;

  updateUserList([nickname]);
  bindSyncEvents();
  bindKeyboardControls();

  // Load subtitle if available
  const subUrl = sessionStorage.getItem('wt-subtitleUrl');
  if (subUrl) loadSubtitle(subUrl);
});

// --- Guest: Room Joined ---
socket.on('room-joined', ({ room, playbackState }) => {
  roomIdEl.textContent = roomId;
  statusMsg.textContent = '방에 참가했습니다.';

  video.src = room.videoUrl;
  video.controls = true;

  updateUserList(room.users);
  bindSyncEvents();
  bindKeyboardControls();

  // Apply initial sync state
  if (playbackState) {
    applySyncState(playbackState);
  }

  // Load subtitle if available
  if (room.subtitleUrl) loadSubtitle(room.subtitleUrl);
});

// --- Sync Events from Others ---
socket.on('sync-play', ({ currentTime }) => {
  startSyncCooldown();
  video.currentTime = currentTime;
  video.play();
  showSyncNotice();
});

socket.on('sync-pause', ({ currentTime }) => {
  startSyncCooldown();
  video.currentTime = currentTime;
  video.pause();
  showSyncNotice();
});

socket.on('sync-seek', ({ currentTime }) => {
  startSyncCooldown();
  video.currentTime = currentTime;
  showSyncNotice();
});

// --- Sync State (server cached) ---
socket.on('sync-state', (state) => {
  applySyncState(state);
});

// --- User Events ---
socket.on('user-joined', ({ nickname: name }) => {
  addUser(name);
  statusMsg.textContent = `${name}님이 참가했습니다.`;
});

socket.on('user-left', ({ nickname: name }) => {
  removeUser(name);
  statusMsg.textContent = `${name}님이 나갔습니다.`;
});


// --- Error ---
socket.on('error-msg', ({ message }) => {
  statusMsg.textContent = message;
  setTimeout(() => { window.location.href = '/'; }, 2000);
});

// --- Network Status ---
const PING_INTERVAL = 5000;
const SLOW_THRESHOLD = 300; // ms

setInterval(() => {
  const start = Date.now();
  socket.volatile.emit('ping-check', () => {
    const latency = Date.now() - start;
    socket.emit('network-status', { latency });
  });
}, PING_INTERVAL);

socket.on('user-network', ({ nickname: name, latency }) => {
  const li = [...userList.querySelectorAll('li')].find(
    (el) => el.dataset.nickname === name
  );
  if (!li) return;
  const icon = li.querySelector('.net-icon');
  if (latency >= SLOW_THRESHOLD) {
    icon.textContent = '\u{1F7E1}';
    icon.title = `지연: ${latency}ms`;
  } else {
    icon.textContent = '\u{1F7E2}';
    icon.title = `지연: ${latency}ms`;
  }
});

// --- Copy Room Code ---
copyCodeBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => {
    copyCodeBtn.textContent = '복사됨!';
    setTimeout(() => { copyCodeBtn.textContent = '복사'; }, 1500);
  });
});

// === Helper Functions ===

function startSyncCooldown() {
  syncCooldown = true;
  clearTimeout(syncCooldownTimer);
  syncCooldownTimer = setTimeout(() => { syncCooldown = false; }, SYNC_COOLDOWN_MS);
}

function bindSyncEvents() {
  if (syncEventsBound) return;
  syncEventsBound = true;

  video.addEventListener('play', () => {
    if (!syncCooldown) {
      socket.emit('sync-play', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('pause', () => {
    if (!syncCooldown) {
      socket.emit('sync-pause', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('seeked', () => {
    if (!syncCooldown) {
      socket.emit('sync-seek', { currentTime: video.currentTime });
    }
  });
}

// --- Keyboard Controls ---
let keyboardBound = false;
function bindKeyboardControls() {
  if (keyboardBound) return;
  keyboardBound = true;

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
    }
  });
}

function applySyncState(state) {
  startSyncCooldown();

  // Estimate current time if playing (based on elapsed time since update)
  let targetTime = state.currentTime;
  if (state.isPlaying && state.updatedAt) {
    const elapsed = (Date.now() - state.updatedAt) / 1000;
    targetTime += elapsed;
  }

  video.currentTime = targetTime;

  if (state.isPlaying) {
    video.play();
  } else {
    video.pause();
  }

  showSyncNotice();
}

function showSyncNotice() {
  syncNotice.hidden = false;
  setTimeout(() => { syncNotice.hidden = true; }, 1200);
}

function createUserLi(name) {
  const li = document.createElement('li');
  li.dataset.nickname = name;
  const span = document.createElement('span');
  span.textContent = name;
  const icon = document.createElement('span');
  icon.className = 'net-icon';
  li.appendChild(span);
  li.appendChild(icon);
  return li;
}

function updateUserList(users) {
  userList.innerHTML = '';
  users.forEach((name) => userList.appendChild(createUserLi(name)));
  userCount.textContent = users.length;
}

function addUser(name) {
  userList.appendChild(createUserLi(name));
  userCount.textContent = userList.children.length;
}

function removeUser(name) {
  const items = userList.querySelectorAll('li');
  items.forEach((li) => {
    if (li.dataset.nickname === name) li.remove();
  });
  userCount.textContent = userList.children.length;
}

// === Subtitle Functions ===

function loadSubtitle(url) {
  // Proxy through our server to avoid CORS issues with R2
  const proxyUrl = `/api/subtitle-proxy?url=${encodeURIComponent(url)}`;

  fetch(proxyUrl)
    .then((res) => {
      if (!res.ok) throw new Error('자막 다운로드 실패');
      return res.text();
    })
    .then((text) => {
      const ext = url.split('/').pop().split('.').pop().split('?')[0];
      const vttText = SubtitleParser.parseSubtitle(text, `sub.${ext}`);
      const blob = new Blob([vttText], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);

      function addTrack() {
        // Remove existing tracks
        const oldTracks = video.querySelectorAll('track');
        oldTracks.forEach((t) => t.remove());

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = '한국어';
        track.srclang = 'ko';
        track.src = blobUrl;
        track.default = true;
        video.appendChild(track);

        // Ensure track mode is set after a brief delay for browser to register
        setTimeout(() => {
          if (video.textTracks.length > 0) {
            video.textTracks[0].mode = 'showing';
          }
        }, 100);

        subToggle.hidden = false;
        subToggle.textContent = '자막 끄기';
      }

      // Add track after video has metadata, or immediately if already loaded
      if (video.readyState >= 1) {
        addTrack();
      } else {
        video.addEventListener('loadedmetadata', addTrack, { once: true });
      }
    })
    .catch((err) => {
      console.error('Subtitle error:', err);
      statusMsg.textContent = '자막 로드에 실패했습니다.';
    });
}

subToggle.addEventListener('click', () => {
  if (video.textTracks.length > 0) {
    const track = video.textTracks[0];
    if (track.mode === 'showing') {
      track.mode = 'hidden';
      subToggle.textContent = '자막 켜기';
    } else {
      track.mode = 'showing';
      subToggle.textContent = '자막 끄기';
    }
  }
});
