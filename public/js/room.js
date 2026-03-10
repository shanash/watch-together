const socket = io();
const videoEl = document.getElementById('video-player');
const ytPlayerWrap = document.getElementById('yt-player-wrap');
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

// Player abstraction
let player = null;
let pendingSyncState = null;

// Redirect if no session data
if (!roomId || !nickname || !action) {
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

function initHTML5Player(url) {
  videoEl.hidden = false;
  ytPlayerWrap.hidden = true;
  videoEl.src = url;
  videoEl.controls = true;

  player = {
    play() { videoEl.play(); },
    pause() { videoEl.pause(); },
    get currentTime() { return videoEl.currentTime; },
    set currentTime(t) { videoEl.currentTime = t; },
    get paused() { return videoEl.paused; },
    get duration() { return videoEl.duration || Infinity; },
    onPlay(cb) { videoEl.addEventListener('play', cb); },
    onPause(cb) { videoEl.addEventListener('pause', cb); },
    onSeeked(cb) { videoEl.addEventListener('seeked', cb); },
    isYouTube: false,
  };
}

function initYouTubePlayer(videoId, onReady) {
  videoEl.hidden = true;
  ytPlayerWrap.hidden = false;

  const callbacks = { play: [], pause: [] };
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
    isYouTube: true,
  };

  // Load YT IFrame API
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => {
    statusMsg.textContent = 'YouTube API를 로드할 수 없습니다.';
  };
  document.head.appendChild(tag);

  // Timeout for API load
  ytTimeout = setTimeout(() => {
    if (!player._yt) {
      statusMsg.textContent = 'YouTube 로딩 시간이 초과되었습니다.';
    }
  }, 10000);

  window.onYouTubeIframeAPIReady = () => {
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
  };
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

// --- Room Created ---
socket.on('room-created', ({ roomId: id }) => {
  roomId = id;
  sessionStorage.setItem('wt-roomId', roomId);

  roomIdEl.textContent = roomId;
  statusMsg.textContent = '방이 생성되었습니다. 영상을 재생하세요.';

  const videoUrl = sessionStorage.getItem('wt-videoUrl');

  initPlayer(videoUrl, () => {
    bindSyncEvents();
    bindKeyboardControls();
  });

  updateUserList([nickname]);

  // Load subtitle if available (HTML5 only)
  const subUrl = sessionStorage.getItem('wt-subtitleUrl');
  if (subUrl && !getYouTubeVideoId(videoUrl)) loadSubtitle(subUrl);
});

// --- Room Joined ---
socket.on('room-joined', ({ room, playbackState }) => {
  roomIdEl.textContent = roomId;
  statusMsg.textContent = '방에 참가했습니다.';

  const isYT = !!getYouTubeVideoId(room.videoUrl);

  // For YouTube, queue sync state since player loads async
  if (isYT && playbackState) {
    pendingSyncState = playbackState;
  }

  initPlayer(room.videoUrl, () => {
    bindSyncEvents();
    bindKeyboardControls();

    // Apply initial sync state (for HTML5, or if YouTube loaded fast)
    if (playbackState && !pendingSyncState) {
      applySyncState(playbackState);
    }
  });

  updateUserList(room.users);

  // Load subtitle if available (HTML5 only)
  if (room.subtitleUrl && !isYT) loadSubtitle(room.subtitleUrl);
});

// --- Sync Events from Others ---
socket.on('sync-play', ({ currentTime }) => {
  if (!player) return;
  startSyncCooldown();
  player.currentTime = currentTime;
  player.play();
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

  player.onPlay(() => {
    if (!syncCooldown) {
      socket.emit('sync-play', { currentTime: player.currentTime });
    }
  });

  player.onPause(() => {
    if (!syncCooldown) {
      socket.emit('sync-pause', { currentTime: player.currentTime });
    }
  });

  player.onSeeked(() => {
    if (!syncCooldown) {
      socket.emit('sync-seek', { currentTime: player.currentTime });
    }
  });
}

// --- Keyboard Controls ---
let keyboardBound = false;
function bindKeyboardControls() {
  if (keyboardBound) return;
  keyboardBound = true;

  document.addEventListener('keydown', (e) => {
    // Don't handle if YouTube iframe has focus
    if (player.isYouTube && document.activeElement?.tagName === 'IFRAME') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (player.paused) {
        player.play();
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

  // Estimate current time if playing (based on elapsed time since update)
  let targetTime = state.currentTime;
  if (state.isPlaying && state.updatedAt) {
    const elapsed = (Date.now() - state.updatedAt) / 1000;
    targetTime += elapsed;
  }

  player.currentTime = targetTime;

  if (state.isPlaying) {
    player.play();
  } else {
    player.pause();
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

// === Subtitle Functions (HTML5 only) ===

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
        const oldTracks = videoEl.querySelectorAll('track');
        oldTracks.forEach((t) => t.remove());

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = '한국어';
        track.srclang = 'ko';
        track.src = blobUrl;
        track.default = true;
        videoEl.appendChild(track);

        // Ensure track mode is set after a brief delay for browser to register
        setTimeout(() => {
          if (videoEl.textTracks.length > 0) {
            videoEl.textTracks[0].mode = 'showing';
          }
        }, 100);

        subToggle.hidden = false;
        subToggle.textContent = '자막 끄기';
      }

      // Add track after video has metadata, or immediately if already loaded
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
