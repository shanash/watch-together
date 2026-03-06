const socket = io();
const video = document.getElementById('video-player');
const roomIdEl = document.getElementById('room-id');
const copyCodeBtn = document.getElementById('copy-code');
const hostBadge = document.getElementById('host-badge');
const userList = document.getElementById('user-list');
const userCount = document.getElementById('user-count');
const statusMsg = document.getElementById('status-msg');
const syncNotice = document.getElementById('sync-notice');
const subToggle = document.getElementById('sub-toggle');

let isHost = false;
let isSyncing = false; // flag to prevent event loops
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
  isHost = true;
  sessionStorage.setItem('wt-roomId', roomId);

  roomIdEl.textContent = roomId;
  hostBadge.hidden = false;
  statusMsg.textContent = '방이 생성되었습니다. 영상을 재생하세요.';

  // Set video source
  const videoUrl = sessionStorage.getItem('wt-videoUrl');
  video.src = videoUrl;
  video.controls = true;

  updateUserList([nickname], nickname);
  bindHostEvents();

  // Load subtitle if available
  const subUrl = sessionStorage.getItem('wt-subtitleUrl');
  if (subUrl) loadSubtitle(subUrl);
});

// --- Guest: Room Joined ---
socket.on('room-joined', ({ room, playbackState }) => {
  isHost = false;
  roomIdEl.textContent = roomId;
  statusMsg.textContent = '방에 참가했습니다.';

  video.src = room.videoUrl;
  video.controls = false; // guests can't control

  updateUserList(room.users, room.hostNickname);

  // Apply initial sync state
  if (playbackState) {
    applySyncState(playbackState);
  }

  // Load subtitle if available
  if (room.subtitleUrl) loadSubtitle(room.subtitleUrl);
});

// --- Sync Events from Host ---
socket.on('sync-play', ({ currentTime }) => {
  isSyncing = true;
  video.currentTime = currentTime;
  video.play().finally(() => { isSyncing = false; });
  showSyncNotice();
});

socket.on('sync-pause', ({ currentTime }) => {
  isSyncing = true;
  video.currentTime = currentTime;
  video.pause();
  isSyncing = false;
  showSyncNotice();
});

socket.on('sync-seek', ({ currentTime }) => {
  isSyncing = true;
  video.currentTime = currentTime;
  isSyncing = false;
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

// --- Host Migration ---
socket.on('host-promoted', () => {
  isHost = true;
  hostBadge.hidden = false;
  video.controls = true;
  statusMsg.textContent = '호스트 권한이 이전되었습니다. 이제 영상을 제어할 수 있습니다.';
  bindHostEvents();
});

socket.on('host-changed', ({ newHostNickname }) => {
  statusMsg.textContent = `${newHostNickname}님이 새 호스트입니다.`;
  // Update host marker in user list
  document.querySelectorAll('#user-list li').forEach((li) => {
    li.classList.toggle('host', li.textContent === newHostNickname);
  });
});

// --- Error ---
socket.on('error-msg', ({ message }) => {
  statusMsg.textContent = message;
  setTimeout(() => { window.location.href = '/'; }, 2000);
});

// --- Copy Room Code ---
copyCodeBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => {
    copyCodeBtn.textContent = '복사됨!';
    setTimeout(() => { copyCodeBtn.textContent = '복사'; }, 1500);
  });
});

// === Helper Functions ===

function bindHostEvents() {
  video.addEventListener('play', () => {
    if (!isSyncing && isHost) {
      socket.emit('sync-play', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('pause', () => {
    if (!isSyncing && isHost) {
      socket.emit('sync-pause', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('seeked', () => {
    if (!isSyncing && isHost) {
      socket.emit('sync-seek', { currentTime: video.currentTime });
    }
  });
}

function applySyncState(state) {
  isSyncing = true;

  // Estimate current time if playing (based on elapsed time since update)
  let targetTime = state.currentTime;
  if (state.isPlaying && state.updatedAt) {
    const elapsed = (Date.now() - state.updatedAt) / 1000;
    targetTime += elapsed;
  }

  video.currentTime = targetTime;

  if (state.isPlaying) {
    video.play().finally(() => { isSyncing = false; });
  } else {
    video.pause();
    isSyncing = false;
  }

  showSyncNotice();
}

function showSyncNotice() {
  syncNotice.hidden = false;
  setTimeout(() => { syncNotice.hidden = true; }, 1200);
}

function updateUserList(users, hostNickname) {
  userList.innerHTML = '';
  users.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    if (name === hostNickname) li.classList.add('host');
    userList.appendChild(li);
  });
  userCount.textContent = users.length;
}

function addUser(name) {
  const li = document.createElement('li');
  li.textContent = name;
  userList.appendChild(li);
  userCount.textContent = userList.children.length;
}

function removeUser(name) {
  const items = userList.querySelectorAll('li');
  items.forEach((li) => {
    if (li.textContent === name || li.textContent === name + ' (HOST)') {
      li.remove();
    }
  });
  userCount.textContent = userList.children.length;
}

// === Subtitle Functions ===

function loadSubtitle(url) {
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error('자막 다운로드 실패');
      return res.text();
    })
    .then((text) => {
      const ext = url.split('/').pop().split('.').pop().split('?')[0];
      const vttText = SubtitleParser.parseSubtitle(text, `sub.${ext}`);
      const blob = new Blob([vttText], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = '한국어';
      track.srclang = 'ko';
      track.src = blobUrl;
      track.default = true;
      video.appendChild(track);

      const textTrack = video.textTracks[video.textTracks.length - 1];
      textTrack.mode = 'showing';

      subToggle.hidden = false;
      subToggle.textContent = '자막 끄기';
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
