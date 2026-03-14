const socket = io({
  transports: ['polling', 'websocket'],
  upgrade: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 30000,
});

let reconnectAttempts = 0;

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
  reconnectAttempts++;
  console.error(`[WatchTogether] Connect error (attempt ${reconnectAttempts}):`, err.message);
  statusMsg.textContent = `연결 실패 (${reconnectAttempts}번째 시도)... 재연결 중`;
});

socket.io.on('reconnect', (attempt) => {
  console.log(`[WatchTogether] Reconnected after ${attempt} attempts`);
  reconnectAttempts = 0;
  statusMsg.textContent = '재연결되었습니다.';
});

socket.io.on('reconnect_error', (err) => {
  console.error('[WatchTogether] Reconnect error:', err.message);
});

socket.io.on('reconnect_failed', () => {
  console.error('[WatchTogether] Reconnect failed permanently');
  statusMsg.textContent = '서버에 연결할 수 없습니다. 페이지를 새로고침하세요.';
});

socket.on('disconnect', (reason) => {
  console.warn(`[WatchTogether] Disconnected: ${reason}`);
  if (reason === 'io server disconnect') {
    statusMsg.textContent = '서버에 의해 연결이 끊겼습니다.';
    socket.connect(); // manually reconnect
  } else if (reason === 'transport close' || reason === 'transport error') {
    statusMsg.textContent = '네트워크 연결이 끊겼습니다. 재연결 시도 중...';
  } else if (reason === 'ping timeout') {
    statusMsg.textContent = '서버 응답 시간 초과. 재연결 시도 중...';
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
const fullscreenBtn = document.getElementById('fullscreen-btn');
const videoArea = document.querySelector('.video-area');

// Modal elements
const playlistAddBtn = document.getElementById('playlist-add-btn');
const playlistModal = document.getElementById('playlist-modal');
const modalClose = document.getElementById('modal-close');
const modalUrlInput = document.getElementById('modal-url-input');
const modalUrlAddBtn = document.getElementById('modal-url-add');
const modalVideoFile = document.getElementById('modal-video-file');
const modalVideoLabel = document.getElementById('modal-video-label');
const modalSubFile = document.getElementById('modal-sub-file');
const modalSubLabel = document.getElementById('modal-sub-label');
const modalFileTitle = document.getElementById('modal-file-title');
const modalFileAddBtn = document.getElementById('modal-file-add');
const modalUploadProgress = document.getElementById('modal-upload-progress');
const modalProgressBar = document.getElementById('modal-progress-bar');
const modalProgressText = document.getElementById('modal-progress-text');
const modalStatus = document.getElementById('modal-status');
const modalFileRetry = document.getElementById('modal-file-retry');

// Chat elements
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');

// Sidebar toggle (mobile)
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarEl = document.querySelector('.sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

sidebarToggle.addEventListener('click', () => {
  const isOpen = sidebarEl.classList.toggle('sidebar-open');
  sidebarBackdrop.classList.toggle('active', isOpen);
  sidebarToggle.setAttribute('aria-label', isOpen ? '메뉴 닫기' : '메뉴 열기');
  sidebarToggle.textContent = isOpen ? '\u2715' : '\u2630';
});

sidebarBackdrop.addEventListener('click', () => {
  sidebarEl.classList.remove('sidebar-open');
  sidebarBackdrop.classList.remove('active');
  sidebarToggle.setAttribute('aria-label', '메뉴 열기');
  sidebarToggle.textContent = '\u2630';
});

let syncCooldown = false;
let syncCooldownTimer = null;
let syncEventsBound = false;
const SYNC_COOLDOWN_MS = 800;
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
  videoEl.removeEventListener('ratechange', syncRateHandler);
  videoEl.removeEventListener('ended', endedHandler);
  videoEl.removeEventListener('waiting', bufferingStartHandler);
  videoEl.removeEventListener('playing', bufferingEndHandler);
  videoEl.removeEventListener('canplay', bufferingEndHandler);
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();

  // Clean up subtitles
  videoEl.querySelectorAll('track').forEach(t => t.remove());
  subToggle.hidden = true;

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
    get playbackRate() { return videoEl.playbackRate; },
    set playbackRate(r) { videoEl.playbackRate = r; },
    onPlay(cb) { videoEl.addEventListener('play', cb); },
    onPause(cb) { videoEl.addEventListener('pause', cb); },
    onSeeked(cb) { videoEl.addEventListener('seeked', cb); },
    onEnded(cb) { videoEl.addEventListener('ended', cb); },
    onRateChange(cb) { videoEl.addEventListener('ratechange', cb); },
    onBuffering(startCb, endCb) {
      videoEl.addEventListener('waiting', startCb);
      videoEl.addEventListener('playing', endCb);
      videoEl.addEventListener('canplay', endCb);
    },
    isYouTube: false,
  };
}

function initYouTubePlayer(videoId, onReady) {
  destroyCurrentPlayer();
  videoEl.hidden = true;
  ytPlayerWrap.hidden = false;

  const callbacks = { play: [], pause: [], ended: [], ratechange: [], bufferingStart: [], bufferingEnd: [] };
  let ytTimeout = null;

  player = {
    _yt: null,
    _ready: false,
    play() { if (this._ready) this._yt.playVideo(); },
    pause() { if (this._ready) this._yt.pauseVideo(); },
    get currentTime() { return this._ready ? this._yt.getCurrentTime() : 0; },
    set currentTime(t) { if (this._ready) this._yt.seekTo(t, true); },
    get paused() { return this._ready ? this._yt.getPlayerState() !== 1 : true; },
    get duration() { return this._ready ? this._yt.getDuration() : Infinity; },
    get playbackRate() { return this._ready ? this._yt.getPlaybackRate() : 1; },
    set playbackRate(r) { if (this._ready) this._yt.setPlaybackRate(r); },
    onPlay(cb) { callbacks.play.push(cb); },
    onPause(cb) { callbacks.pause.push(cb); },
    onSeeked(cb) { /* YouTube state changes cover seeking */ },
    onEnded(cb) { callbacks.ended.push(cb); },
    onRateChange(cb) { callbacks.ratechange.push(cb); },
    onBuffering(startCb, endCb) { callbacks.bufferingStart.push(startCb); callbacks.bufferingEnd.push(endCb); },
    isYouTube: true,
  };

  function createYTPlayer() {
    player._yt = new YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady: () => {
          clearTimeout(ytTimeout);
          player._ready = true;
          onReady();
          if (pendingSyncState) {
            applySyncState(pendingSyncState);
            pendingSyncState = null;
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            callbacks.play.forEach((cb) => cb());
            callbacks.bufferingEnd.forEach((cb) => cb());
          } else if (e.data === YT.PlayerState.PAUSED) {
            callbacks.pause.forEach((cb) => cb());
          } else if (e.data === YT.PlayerState.ENDED) {
            callbacks.ended.forEach((cb) => cb());
          } else if (e.data === YT.PlayerState.BUFFERING) {
            callbacks.bufferingStart.forEach((cb) => cb());
          }
        },
        onPlaybackRateChange: () => {
          callbacks.ratechange.forEach((cb) => cb());
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
  if (syncCooldown) { extendSyncCooldown(); return; }
  socket.emit('sync-play', { currentTime: player.currentTime });
}
function syncPauseHandler() {
  if (syncCooldown) { extendSyncCooldown(); return; }
  socket.emit('sync-pause', { currentTime: player.currentTime });
}
function syncSeekHandler() {
  if (syncCooldown) { extendSyncCooldown(); return; }
  socket.emit('sync-seek', { currentTime: player.currentTime });
}
function syncRateHandler() {
  if (syncCooldown) { extendSyncCooldown(); return; }
  socket.emit('sync-rate', { rate: player.playbackRate });
}
function endedHandler() {
  socket.emit('video-ended', { index: currentIndex });
}
function bufferingStartHandler() {
  socket.volatile.emit('buffering-status', { buffering: true });
}
function bufferingEndHandler() {
  socket.volatile.emit('buffering-status', { buffering: false });
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
  history.replaceState(null, '', `/${roomId}`);
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
  const subUrl = playlist[currentIndex].subtitleUrl;
  if (subUrl && !getYouTubeVideoId(videoUrl)) loadSubtitle(subUrl);
});

// --- Room Joined ---
socket.on('room-joined', ({ room, playbackState }) => {
  const prevIndex = currentIndex;

  roomIdEl.textContent = roomId;
  history.replaceState(null, '', `/${roomId}`);
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
  const subUrl2 = playlist[currentIndex]?.subtitleUrl;
  if (subUrl2 && !isYT) loadSubtitle(subUrl2);
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
  player.pause();
  player.currentTime = currentTime;
  showSyncNotice();
});

socket.on('sync-seek', ({ currentTime }) => {
  if (!player) return;
  startSyncCooldown();
  player.currentTime = currentTime;
  showSyncNotice();
});

socket.on('sync-rate', ({ rate }) => {
  if (!player) return;
  startSyncCooldown();
  player.playbackRate = rate;
  showSyncNotice();
});

// --- Sync State (server cached) ---
socket.on('sync-state', (state) => {
  applySyncState(state);
});

// --- Playlist Events ---
socket.on('playlist-updated', ({ playlist: pl, currentIndex: idx }) => {
  const wasEmpty = playlist.length === 0;
  const prevSubUrl = playlist[idx]?.subtitleUrl;
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
      const item = playlist[currentIndex];
      if (item?.subtitleUrl && !player.isYouTube) {
        loadSubtitle(item.subtitleUrl);
      }
    });
  } else if (player && !player.isYouTube) {
    // Reload subtitle if it changed for the current video
    const newSubUrl = playlist[idx]?.subtitleUrl;
    if (newSubUrl && newSubUrl !== prevSubUrl) {
      loadSubtitle(newSubUrl);
    }
  }
});

socket.on('playlist-switch', ({ url, index }) => {
  currentIndex = index;
  renderPlaylist();
  addSystemMessage(`재생 전환: ${playlist[index]?.title || '다음 영상'}`);
  switchVideo(url, () => {
    safePlay();
    // Load subtitle for the new video (HTML5 only)
    const item = playlist[index];
    if (item?.subtitleUrl && player && !player.isYouTube) {
      loadSubtitle(item.subtitleUrl);
    }
  });
});

socket.on('playlist-ended', () => {
  statusMsg.textContent = '재생목록이 끝났습니다.';
  addSystemMessage('재생목록이 끝났습니다.');
});

// --- User Events ---
socket.on('user-joined', ({ nickname: name }) => {
  addUser(name);
  statusMsg.textContent = `${name}님이 참가했습니다.`;
  addSystemMessage(`${name}님이 참가했습니다.`);
});

socket.on('user-left', ({ nickname: name }) => {
  removeUser(name);
  statusMsg.textContent = `${name}님이 나갔습니다.`;
  addSystemMessage(`${name}님이 나갔습니다.`);
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

socket.on('user-buffering', ({ nickname: name, buffering }) => {
  const li = [...userList.querySelectorAll('li')].find(
    (el) => el.dataset.nickname === name
  );
  if (!li) return;
  const bufIcon = li.querySelector('.buf-icon');
  if (buffering) {
    if (!bufIcon) {
      const span = document.createElement('span');
      span.className = 'buf-icon';
      span.textContent = '⏳';
      span.title = '버퍼링 중';
      li.querySelector('.net-icon').before(span);
    }
  } else {
    if (bufIcon) bufIcon.remove();
  }
});

// --- Copy Room Code ---
copyCodeBtn.addEventListener('click', () => {
  const joinUrl = `${window.location.origin}/${roomId}`;
  navigator.clipboard.writeText(joinUrl).then(() => {
    copyCodeBtn.textContent = '링크 복사됨!';
    setTimeout(() => { copyCodeBtn.textContent = '복사'; }, 1500);
  });
});

// === Fullscreen ===
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoArea.requestFullscreen().catch(() => {});
  }
});

document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶';
  fullscreenBtn.title = document.fullscreenElement ? '전체화면 종료' : '전체화면';
});

// === Playlist Add Modal ===
let modalActiveTab = 'modal-url';
let modalTriggerEl = null;

function openModal() {
  modalTriggerEl = document.activeElement;
  playlistModal.hidden = false;
  const firstFocusable = playlistModal.querySelector('button, input:not([hidden])');
  if (firstFocusable) firstFocusable.focus();
}

function closeModal() {
  playlistModal.hidden = true;
  if (modalTriggerEl) {
    modalTriggerEl.focus();
    modalTriggerEl = null;
  }
}

playlistAddBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
playlistModal.addEventListener('click', (e) => {
  if (e.target === playlistModal) closeModal();
});

// ESC to close modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !playlistModal.hidden) {
    e.preventDefault();
    closeModal();
  }
});

// Tab trapping within modal
playlistModal.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusableEls = [...playlistModal.querySelectorAll(
    'button:not([disabled]), input:not([hidden])'
  )].filter(el => {
    const tabContent = el.closest('.modal-tab-content');
    if (tabContent && !tabContent.classList.contains('active')) return false;
    return el.offsetParent !== null;
  });
  if (focusableEls.length === 0) return;
  const firstEl = focusableEls[0];
  const lastEl = focusableEls[focusableEls.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    }
  } else {
    if (document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }
});

// Modal tabs
document.querySelectorAll('[data-modal-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-modal-tab]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    modalActiveTab = tab.dataset.modalTab;
    document.querySelectorAll('.modal-tab-content').forEach((c) => c.classList.remove('active'));
    document.getElementById(modalActiveTab).classList.add('active');
  });
});

function showModalStatus(msg, type) {
  modalStatus.textContent = msg;
  modalStatus.className = `upload-status ${type}`;
  modalStatus.hidden = false;
  if (type === 'success') setTimeout(() => { modalStatus.hidden = true; }, 2000);
}

// Modal: URL add
modalUrlAddBtn.addEventListener('click', async () => {
  const url = modalUrlInput.value.trim();
  if (!url) return;
  const ytId = getYouTubeVideoId(url);

  modalUrlAddBtn.disabled = true;
  modalUrlAddBtn.textContent = '확인 중...';
  try {
    const endpoint = ytId ? '/api/validate-youtube' : '/api/validate-url';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const result = await res.json();
    if (!result.valid) {
      showModalStatus(result.error, 'fail');
      return;
    }
  } catch {
    showModalStatus('URL을 확인할 수 없습니다.', 'fail');
    return;
  } finally {
    modalUrlAddBtn.disabled = false;
    modalUrlAddBtn.textContent = '추가';
  }
  socket.emit('playlist-add', { url });
  modalUrlInput.value = '';
  showModalStatus('추가되었습니다!', 'success');
});

modalUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalUrlAddBtn.click();
});

// Modal: file labels
let lastUploadVideoFile = null;
let lastUploadSubFile = null;

modalVideoFile.addEventListener('change', () => {
  const file = modalVideoFile.files[0];
  if (file) {
    modalVideoLabel.querySelector('span').textContent = file.name;
    lastUploadVideoFile = null;
    lastUploadSubFile = null;
    modalFileRetry.hidden = true;
  }
});

modalSubFile.addEventListener('change', () => {
  const file = modalSubFile.files[0];
  if (file) modalSubLabel.querySelector('span').textContent = file.name;
});

// Modal: file upload
async function performFileUpload(videoFile, subFile, title) {
  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
  if (videoFile.size > MAX_FILE_SIZE) {
    showModalStatus('파일 크기는 2GB 이하여야 합니다.', 'fail');
    return;
  }

  modalFileAddBtn.disabled = true;
  modalFileRetry.hidden = true;
  modalUploadProgress.hidden = false;
  modalProgressBar.style.width = '0%';
  modalProgressText.textContent = '0%';
  modalStatus.hidden = true;

  try {
    // Upload video
    const res = await fetch('/api/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: videoFile.name, contentType: videoFile.type || 'video/mp4' }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '업로드 URL 생성 실패');
    const { presignedUrl, publicUrl } = await res.json();

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', presignedUrl);
      xhr.setRequestHeader('Content-Type', videoFile.type || 'video/mp4');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          modalProgressBar.style.width = `${pct}%`;
          modalProgressText.textContent = `${pct}%`;
        }
      };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(videoFile);
    });

    // Upload subtitle if selected
    let subPublicUrl = null;
    if (subFile) {
      const buffer = await subFile.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buffer);
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('euc-kr').decode(buffer); } catch {}
      }
      const subRes = await fetch('/api/presign-subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: subFile.name }),
      });
      if (subRes.ok) {
        const { presignedUrl: subPresign, publicUrl: subPubUrl } = await subRes.json();
        await fetch(subPresign, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: new Blob([text], { type: 'text/plain' }),
        });
        subPublicUrl = subPubUrl;
      }
    }

    const finalTitle = title || videoFile.name.replace(/\.[^.]+$/, '');
    socket.emit('playlist-add', { url: publicUrl, subtitleUrl: subPublicUrl, title: finalTitle });

    showModalStatus('추가 완료!', 'success');
    lastUploadVideoFile = null;
    lastUploadSubFile = null;
    modalFileRetry.hidden = true;
    modalVideoFile.value = '';
    modalSubFile.value = '';
    modalFileTitle.value = '';
    modalVideoLabel.querySelector('span').textContent = '영상 파일 선택 (.mp4, .webm, .mkv)';
    modalSubLabel.querySelector('span').textContent = '자막 파일 선택 (.smi, .srt, .vtt) - 선택사항';
  } catch (err) {
    showModalStatus(err.message, 'fail');
    lastUploadVideoFile = videoFile;
    lastUploadSubFile = subFile;
    modalFileRetry.hidden = false;
  } finally {
    modalFileAddBtn.disabled = false;
    modalUploadProgress.hidden = true;
  }
}

modalFileAddBtn.addEventListener('click', async () => {
  const videoFile = modalVideoFile.files[0];
  if (!videoFile) {
    showModalStatus('영상 파일을 선택하세요.', 'fail');
    return;
  }
  const title = modalFileTitle.value.trim();
  await performFileUpload(videoFile, modalSubFile.files[0] || null, title);
});

modalFileRetry.addEventListener('click', async () => {
  if (!lastUploadVideoFile) return;
  const title = modalFileTitle.value.trim();
  await performFileUpload(lastUploadVideoFile, lastUploadSubFile, title);
});

// === Chat ===
chatSendBtn.addEventListener('click', () => {
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit('chat-message', { message });
  chatInput.value = '';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) chatSendBtn.click();
});

socket.on('chat-message', ({ nickname: name, message, timestamp }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg';

  const time = new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const isMe = name === nickname;
  div.classList.toggle('chat-msg-mine', isMe);

  const safeName = (isMe ? '나' : name).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeMsg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  div.innerHTML = `<span class="chat-nick">${safeName}</span> <span class="chat-time">${time}</span><div class="chat-text">${safeMsg}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// === Helper Functions ===

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function startSyncCooldown() {
  syncCooldown = true;
  clearTimeout(syncCooldownTimer);
  syncCooldownTimer = setTimeout(() => { syncCooldown = false; }, SYNC_COOLDOWN_MS);
}

// Extend cooldown — call this when a player event fires during cooldown
// to prevent the event from leaking out after cooldown expires
function extendSyncCooldown() {
  if (syncCooldown) {
    clearTimeout(syncCooldownTimer);
    syncCooldownTimer = setTimeout(() => { syncCooldown = false; }, SYNC_COOLDOWN_MS);
  }
}

function bindSyncEvents() {
  if (syncEventsBound) return;
  syncEventsBound = true;

  player.onPlay(syncPlayHandler);
  player.onPause(syncPauseHandler);
  player.onSeeked(syncSeekHandler);
  player.onRateChange(syncRateHandler);
  player.onBuffering(bufferingStartHandler, bufferingEndHandler);
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
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      fullscreenBtn.click();
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

let dragFromIndex = null;

function renderPlaylist() {
  playlistEl.innerHTML = '';
  playlist.forEach((item, i) => {
    const li = document.createElement('li');
    li.title = `${item.title} (${item.addedBy})`;
    li.dataset.index = i;
    if (i === currentIndex) li.classList.add('active');

    // Drag handle
    const handle = document.createElement('span');
    handle.className = 'playlist-drag-handle';
    handle.textContent = '⠿';
    handle.title = '드래그하여 순서 변경';
    li.appendChild(handle);

    // Drag events
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      dragFromIndex = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragFromIndex = null;
      playlistEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      playlistEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      if (dragFromIndex !== null && dragFromIndex !== i) {
        li.classList.add('drag-over');
      }
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragFromIndex !== null && dragFromIndex !== i) {
        socket.emit('playlist-reorder', { fromIndex: dragFromIndex, toIndex: i });
        dragFromIndex = null;
      }
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'playlist-title';
    titleSpan.textContent = item.title;
    titleSpan.addEventListener('click', () => {
      if (i !== currentIndex) {
        socket.emit('playlist-play', { index: i });
      }
    });
    li.appendChild(titleSpan);

    if (i !== currentIndex) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'playlist-remove';
      removeBtn.textContent = '×';
      removeBtn.title = '삭제';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('playlist-remove', { index: i });
      });
      li.appendChild(removeBtn);
    }

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

