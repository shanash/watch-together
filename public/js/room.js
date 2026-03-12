const socket = io();

// --- Client Error Reporting ---
window.addEventListener('error', (e) => {
  socket.emit('client-error', {
    message: e.message,
    stack: e.error?.stack,
    context: 'window.onerror',
  });
});

window.addEventListener('unhandledrejection', (e) => {
  socket.emit('client-error', {
    message: e.reason?.message || String(e.reason),
    stack: e.reason?.stack,
    context: 'unhandledrejection',
  });
});

socket.on('connect_error', (err) => {
  console.error('Socket connect error:', err.message);
});

socket.on('disconnect', (reason) => {
  console.warn('Socket disconnected:', reason);
  if (reason === 'io server disconnect') {
    statusMsg.textContent = '서버에 의해 연결이 끊겼습니다.';
  } else if (reason === 'transport close' || reason === 'transport error') {
    statusMsg.textContent = '네트워크 연결이 끊겼습니다. 재연결 시도 중...';
  }
});

const videoEl = document.getElementById('video-player');
const ytPlayerWrap = document.getElementById('yt-player-wrap');
const roomIdEl = document.getElementById('room-id');
const copyCodeBtn = document.getElementById('copy-code');
const userList = document.getElementById('user-list');
const userCount = document.getElementById('user-count');
const statusMsg = document.getElementById('status-msg');
const syncNotice = document.getElementById('sync-notice');
const subToggle = document.getElementById('sub-toggle');
const playlistEl = document.getElementById('playlist');
const playlistUrlInput = document.getElementById('playlist-url');
const playlistAddUrlBtn = document.getElementById('playlist-add-url');
const playlistFileInput = document.getElementById('playlist-file');
const plUploadProgress = document.getElementById('playlist-upload-progress');
const plProgressBar = document.getElementById('playlist-progress-bar');
const plProgressText = document.getElementById('playlist-progress-text');

let syncCooldown = false;
let syncCooldownTimer = null;
let syncEventsBound = false;
const SYNC_COOLDOWN_MS = 300;
let roomId = sessionStorage.getItem('wt-roomId');
let nickname = sessionStorage.getItem('wt-nickname');
const action = sessionStorage.getItem('wt-action');
let isFirstConnect = true;

// Player abstraction
let player = null;
let pendingSyncState = null;
let ytApiLoaded = false;
let pendingPlay = false;

// When tab becomes visible, retry pending play
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingPlay && player) {
    pendingPlay = false;
    safePlay();
  }
});

function safePlay() {
  if (!player) return;
  try {
    const result = player.play();
    if (result && typeof result.catch === 'function') {
      result.catch(() => { pendingPlay = true; });
    }
  } catch {
    pendingPlay = true;
  }
}

// Playlist state
let playlist = [];
let currentIndex = 0;

// Redirect if no session data
if (!nickname || !action) {
  window.location.href = '/';
}
if (action === 'join' && !roomId) {
  window.location.href = '/';
}

// === YouTube URL Detection ===
function getYouTubeVideoId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([^&?#\/]+)/
  );
  return match ? match[1] : null;
}

// === Player Abstraction ===
function initPlayer(videoUrl, onReady) {
  const ytId = getYouTubeVideoId(videoUrl);
  if (ytId) {
    initYouTubePlayer(ytId, onReady);
  } else {
    initHTML5Player(videoUrl);
    onReady();
  }
}

function destroyCurrentPlayer() {
  // Clean up HTML5 player
  videoEl.removeEventListener('play', syncPlayHandler);
  videoEl.removeEventListener('pause', syncPauseHandler);
  videoEl.removeEventListener('seeked', syncSeekHandler);
  videoEl.removeEventListener('ended', endedHandler);
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();

  // Clean up YouTube player
  if (player && player.isYouTube && player._yt) {
    player._yt.destroy();
    ytPlayerWrap.innerHTML = '<div id="yt-player"></div>';
  }

  syncEventsBound = false;
  player = null;
  pendingSyncState = null;
}

function initHTML5Player(url) {
  destroyCurrentPlayer();
  videoEl.hidden = false;
  ytPlayerWrap.hidden = true;
  videoEl.src = url;
  videoEl.controls = true;

  player = {
    play() { return videoEl.play(); },
    pause() { videoEl.pause(); },
    get currentTime() { return videoEl.currentTime; },
    set currentTime(t) { videoEl.currentTime = t; },
    get paused() { return videoEl.paused; },
    get duration() { return videoEl.duration || Infinity; },
    onPlay(cb) { videoEl.addEventListener('play', cb); },
    onPause(cb) { videoEl.addEventListener('pause', cb); },
    onSeeked(cb) { videoEl.addEventListener('seeked', cb); },
    onEnded(cb) { videoEl.addEventListener('ended', cb); },
    isYouTube: false,
  };
}

function initYouTubePlayer(videoId, onReady) {
  destroyCurrentPlayer();
  videoEl.hidden = true;
  ytPlayerWrap.hidden = false;

  const callbacks = { play: [], pause: [], ended: [] };
  let ytTimeout = null;

  player = {
    _yt: null,
    play() { if (this._yt) this._yt.playVideo(); },
    pause() { if (this._yt) this._yt.pauseVideo(); },
    get currentTime() { return this._yt ? this._yt.getCurrentTime() : 0; },
    set currentTime(t) { if (this._yt) this._yt.seekTo(t, true); },
    get paused() { return this._yt ? this._yt.getPlayerState() !== 1 : true; },
    get duration() { return this._yt ? this._yt.getDuration() : Infinity; },
    onPlay(cb) { callbacks.play.push(cb); },
    onPause(cb) { callbacks.pause.push(cb); },
    onSeeked(cb) { /* YouTube state changes cover seeking */ },
    onEnded(cb) { callbacks.ended.push(cb); },
    isYouTube: true,
  };

  function createYTPlayer() {
    player._yt = new YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady: () => {
          clearTimeout(ytTimeout);
          onReady();
          if (pendingSyncState) {
            applySyncState(pendingSyncState);
            pendingSyncState = null;
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            callbacks.play.forEach((cb) => cb());
          } else if (e.data === YT.PlayerState.PAUSED) {
            callbacks.pause.forEach((cb) => cb());
          } else if (e.data === YT.PlayerState.ENDED) {
            callbacks.ended.forEach((cb) => cb());
          }
        },
        onError: (e) => {
          const messages = {
            2: '잘못된 YouTube 영상 ID입니다.',
            5: 'YouTube 플레이어 오류가 발생했습니다.',
            100: '해당 영상을 찾을 수 없습니다.',
            101: '이 영상은 외부 재생이 허용되지 않습니다.',
            150: '이 영상은 외부 재생이 허용되지 않습니다.',
          };
          statusMsg.textContent = messages[e.data] || 'YouTube 오류가 발생했습니다.';
        },
      },
    });
  }

  if (ytApiLoaded) {
    createYTPlayer();
  } else {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => {
      statusMsg.textContent = 'YouTube API를 로드할 수 없습니다.';
    };
    document.head.appendChild(tag);

    ytTimeout = setTimeout(() => {
      if (!player._yt) {
        statusMsg.textContent = 'YouTube 로딩 시간이 초과되었습니다.';
      }
    }, 10000);

    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      createYTPlayer();
    };
  }
}

// Named handlers for cleanup
function syncPlayHandler() {
  if (!syncCooldown) socket.emit('sync-play', { currentTime: player.currentTime });
}
function syncPauseHandler() {
  if (!syncCooldown) socket.emit('sync-pause', { currentTime: player.currentTime });
}
function syncSeekHandler() {
  if (!syncCooldown) socket.emit('sync-seek', { currentTime: player.currentTime });
}
function endedHandler() {
  socket.emit('video-ended', { index: currentIndex });
}

function switchVideo(url, onReady) {
  initPlayer(url, () => {
    bindSyncEvents();
    bindEndedEvent();
    onReady();
  });
}

// --- Init ---
socket.on('connect', () => {
  if (isFirstConnect) {
    isFirstConnect = false;
    if (action === 'host') {
      const videoUrl = sessionStorage.getItem('wt-videoUrl');
      const subtitleUrl = sessionStorage.getItem('wt-subtitleUrl') || null;
      socket.emit('create-room', { nickname, videoUrl, subtitleUrl });
    } else {
      socket.emit('join-room', { roomId, nickname });
    }
  } else {
    // Reconnection: always rejoin existing room
    if (roomId) {
      socket.emit('join-room', { roomId, nickname });
    }
  }
});

// --- Room Created ---
socket.on('room-created', ({ roomId: id, playlist: pl, currentIndex: idx }) => {
  roomId = id;
  sessionStorage.setItem('wt-roomId', roomId);

  roomIdEl.textContent = roomId;
  playlist = pl;
  currentIndex = idx;
  renderPlaylist();

  if (player) {
    // Room recreated after server restart - player already exists
    statusMsg.textContent = '방이 재생성되었습니다. 새 코드: ' + roomId;
    updateUserList([nickname]);
    return;
  }

  updateUserList([nickname]);

  if (playlist.length === 0) {
    statusMsg.textContent = '방이 생성되었습니다. 플레이리스트에 영상을 추가하세요.';
    return;
  }

  statusMsg.textContent = '방이 생성되었습니다. 영상을 재생하세요.';

  const videoUrl = playlist[currentIndex].url;

  initPlayer(videoUrl, () => {
    bindSyncEvents();
    bindEndedEvent();
    bindKeyboardControls();
  });

  // Load subtitle if available (HTML5 only)
  const subUrl = sessionStorage.getItem('wt-subtitleUrl');
  if (subUrl && !getYouTubeVideoId(videoUrl)) loadSubtitle(subUrl);
});

// --- Room Joined ---
socket.on('room-joined', ({ room, playbackState }) => {
  const prevIndex = currentIndex;

  roomIdEl.textContent = roomId;
  playlist = room.playlist;
  currentIndex = room.currentIndex;
  renderPlaylist();
  updateUserList(room.users);

  // Reconnection: player already initialized
  if (player) {
    if (prevIndex !== currentIndex) {
      // Video changed while disconnected
      statusMsg.textContent = '재연결되었습니다. 영상을 전환합니다.';
      const videoUrl = playlist[currentIndex].url;
      switchVideo(videoUrl, () => {
        if (playbackState) applySyncState(playbackState);
      });
    } else {
      statusMsg.textContent = '재연결되었습니다.';
      if (playbackState) applySyncState(playbackState);
    }
    return;
  }

  // First join: initialize player
  statusMsg.textContent = '방에 참가했습니다.';

  if (playlist.length === 0) return;

  const videoUrl = playlist[currentIndex].url;
  const isYT = !!getYouTubeVideoId(videoUrl);

  // For YouTube, queue sync state since player loads async
  if (isYT && playbackState) {
    pendingSyncState = playbackState;
  }

  initPlayer(videoUrl, () => {
    bindSyncEvents();
    bindEndedEvent();
    bindKeyboardControls();

    // Apply initial sync state (for HTML5, or if YouTube loaded fast)
    if (playbackState && !pendingSyncState) {
      applySyncState(playbackState);
    }
  });

  // Load subtitle if available (HTML5 only)
  if (room.subtitleUrl && !isYT) loadSubtitle(room.subtitleUrl);
});

// --- Sync Events from Others ---
socket.on('sync-play', ({ currentTime }) => {
  if (!player) return;
  startSyncCooldown();
  player.currentTime = currentTime;
  safePlay();
  showSyncNotice();
});

socket.on('sync-pause', ({ currentTime }) => {
  if (!player) return;
  startSyncCooldown();
  player.currentTime = currentTime;
  player.pause();
  showSyncNotice();
});

socket.on('sync-seek', ({ currentTime }) => {
  if (!player) return;
  startSyncCooldown();
  player.currentTime = currentTime;
  showSyncNotice();
});

// --- Sync State (server cached) ---
socket.on('sync-state', (state) => {
  applySyncState(state);
});

// --- Playlist Events ---
socket.on('playlist-updated', ({ playlist: pl, currentIndex: idx }) => {
  const wasEmpty = playlist.length === 0;
  playlist = pl;
  currentIndex = idx;
  renderPlaylist();

  // If player wasn't initialized yet and now we have videos, start the first one
  if (wasEmpty && playlist.length > 0 && !player) {
    const videoUrl = playlist[currentIndex].url;
    statusMsg.textContent = '영상이 추가되었습니다.';
    initPlayer(videoUrl, () => {
      bindSyncEvents();
      bindEndedEvent();
      bindKeyboardControls();
    });
  }
});

socket.on('playlist-switch', ({ url, index }) => {
  currentIndex = index;
  renderPlaylist();
  switchVideo(url, () => {
    safePlay();
  });
});

socket.on('playlist-ended', () => {
  statusMsg.textContent = '재생목록이 끝났습니다.';
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
socket.on('error-msg', ({ message, fatal }) => {
  statusMsg.textContent = message;
  if (fatal) {
    // If host reconnects but room was deleted, recreate it
    if (action === 'host' && !isFirstConnect) {
      const videoUrl = sessionStorage.getItem('wt-videoUrl');
      const subtitleUrl = sessionStorage.getItem('wt-subtitleUrl') || null;
      socket.emit('create-room', { nickname, videoUrl, subtitleUrl, requestedRoomId: roomId });
      return;
    }
    setTimeout(() => { window.location.href = '/'; }, 2000);
  }
});

// --- Network Status ---
const PING_INTERVAL = 5000;
const SLOW_THRESHOLD = 300;

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

// --- Playlist Add (URL) ---
playlistAddUrlBtn.addEventListener('click', async () => {
  const url = playlistUrlInput.value.trim();
  if (!url) return;
  const ytId = getYouTubeVideoId(url);

  if (ytId) {
    playlistAddUrlBtn.disabled = true;
    playlistAddUrlBtn.textContent = '확인 중...';
    try {
      const res = await fetch('/api/validate-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const result = await res.json();
      if (!result.valid) {
        statusMsg.textContent = result.error;
        return;
      }
      socket.emit('playlist-add', { url, title: result.title });
    } catch {
      statusMsg.textContent = 'YouTube 영상을 확인할 수 없습니다.';
      return;
    } finally {
      playlistAddUrlBtn.disabled = false;
      playlistAddUrlBtn.textContent = '추가';
    }
  } else {
    const title = url.split('/').pop().split('?')[0] || 'Video';
    socket.emit('playlist-add', { url, title });
  }
  playlistUrlInput.value = '';
});

playlistUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playlistAddUrlBtn.click();
});

// --- Playlist Add (File Upload) ---
playlistFileInput.addEventListener('change', async () => {
  const file = playlistFileInput.files[0];
  if (!file) return;

  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    statusMsg.textContent = '파일 크기는 2GB 이하여야 합니다.';
    playlistFileInput.value = '';
    return;
  }

  plUploadProgress.hidden = false;
  plProgressBar.style.width = '0%';
  plProgressText.textContent = '0%';

  try {
    const res = await fetch('/api/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'video/mp4' }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '업로드 URL 생성 실패');
    }

    const { presignedUrl, publicUrl } = await res.json();

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', presignedUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          plProgressBar.style.width = `${pct}%`;
          plProgressText.textContent = `${pct}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`업로드 실패 (HTTP ${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(file);
    });

    socket.emit('playlist-add', { url: publicUrl, title: file.name });
  } catch (err) {
    statusMsg.textContent = err.message;
  } finally {
    plUploadProgress.hidden = true;
    playlistFileInput.value = '';
  }
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

  player.onPlay(syncPlayHandler);
  player.onPause(syncPauseHandler);
  player.onSeeked(syncSeekHandler);
}

function bindEndedEvent() {
  player.onEnded(endedHandler);
}

// --- Keyboard Controls ---
let keyboardBound = false;
function bindKeyboardControls() {
  if (keyboardBound) return;
  keyboardBound = true;

  document.addEventListener('keydown', (e) => {
    if (!player) return;
    // Don't handle if typing in input
    if (e.target.tagName === 'INPUT') return;
    // Don't handle if YouTube iframe has focus
    if (player.isYouTube && document.activeElement?.tagName === 'IFRAME') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (player.paused) {
        safePlay();
      } else {
        player.pause();
      }
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      player.currentTime = Math.min(player.duration, player.currentTime + 5);
    }
  });
}

function applySyncState(state) {
  if (!player || (player.isYouTube && !player._yt)) {
    pendingSyncState = state;
    return;
  }

  startSyncCooldown();

  let targetTime = state.currentTime;
  if (state.isPlaying && state.updatedAt) {
    const elapsed = (Date.now() - state.updatedAt) / 1000;
    targetTime += elapsed;
  }

  player.currentTime = targetTime;

  if (state.isPlaying) {
    safePlay();
  } else {
    player.pause();
  }

  showSyncNotice();
}

function showSyncNotice() {
  syncNotice.hidden = false;
  setTimeout(() => { syncNotice.hidden = true; }, 1200);
}

// === Playlist UI ===

function renderPlaylist() {
  playlistEl.innerHTML = '';
  playlist.forEach((item, i) => {
    const li = document.createElement('li');
    li.textContent = item.title;
    li.title = `${item.title} (${item.addedBy})`;
    if (i === currentIndex) li.classList.add('active');
    li.addEventListener('click', () => {
      if (i !== currentIndex) {
        socket.emit('playlist-play', { index: i });
      }
    });
    playlistEl.appendChild(li);
  });
  // Scroll active into view
  const activeLi = playlistEl.querySelector('.active');
  if (activeLi) activeLi.scrollIntoView({ block: 'nearest' });
}

// === User List ===

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

// === Subtitle Functions (HTML5 only) ===

function loadSubtitle(url) {
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
        const oldTracks = videoEl.querySelectorAll('track');
        oldTracks.forEach((t) => t.remove());

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = '한국어';
        track.srclang = 'ko';
        track.src = blobUrl;
        track.default = true;
        videoEl.appendChild(track);

        setTimeout(() => {
          if (videoEl.textTracks.length > 0) {
            videoEl.textTracks[0].mode = 'showing';
          }
        }, 100);

        subToggle.hidden = false;
        subToggle.textContent = '자막 끄기';
      }

      if (videoEl.readyState >= 1) {
        addTrack();
      } else {
        videoEl.addEventListener('loadedmetadata', addTrack, { once: true });
      }
    })
    .catch((err) => {
      console.error('Subtitle error:', err);
      statusMsg.textContent = '자막 로드에 실패했습니다.';
    });
}

subToggle.addEventListener('click', () => {
  if (videoEl.textTracks.length > 0) {
    const track = videoEl.textTracks[0];
    if (track.mode === 'showing') {
      track.mode = 'hidden';
      subToggle.textContent = '자막 켜기';
    } else {
      track.mode = 'showing';
      subToggle.textContent = '자막 끄기';
    }
  }
});
