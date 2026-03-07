const socket = io();

const createForm = document.getElementById('create-form');
const joinForm = document.getElementById('join-form');
const errorMsg = document.getElementById('error-msg');
const createBtn = document.getElementById('create-btn');

// Tab elements
const tabs = document.querySelectorAll('.tab');
const tabUrl = document.getElementById('tab-url');
const tabUpload = document.getElementById('tab-upload');
const videoUrlInput = document.getElementById('video-url');
const videoFileInput = document.getElementById('video-file');
const fileLabel = document.getElementById('file-label');
const uploadProgress = document.getElementById('upload-progress');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const uploadStatus = document.getElementById('upload-status');

// Subtitle elements
const subFileInput = document.getElementById('sub-file');
const subUploadStatus = document.getElementById('sub-upload-status');

let activeTab = 'url';
let uploadedUrl = null;
let subtitleUploadedUrl = null;
let isUploading = false;
let ffmpegLoaded = null;

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
  setTimeout(() => { errorMsg.hidden = true; }, 4000);
}

// --- ffmpeg.wasm MKV → MP4 conversion ---
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function loadFFmpeg() {
  if (ffmpegLoaded) return ffmpegLoaded;

  // Load UMD builds from same-origin (avoids cross-origin Worker error)
  await loadScript('/ffmpeg/ffmpeg.js');
  await loadScript('/ffmpeg-util/index.js');

  const { FFmpeg } = FFmpegWASM;
  const { fetchFile, toBlobURL } = FFmpegUtil;

  const ffmpeg = new FFmpeg();
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegLoaded = { ffmpeg, fetchFile };
  return ffmpegLoaded;
}

async function convertMkvToMp4(file) {
  uploadProgress.hidden = false;
  progressBar.style.width = '0%';
  progressText.textContent = '변환 도구 로딩 중...';

  const { ffmpeg, fetchFile } = await loadFFmpeg();

  progressText.textContent = 'MKV → MP4 변환 중...';

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `변환 중... ${pct}%`;
  });

  await ffmpeg.writeFile('input.mkv', await fetchFile(file));
  await ffmpeg.exec(['-i', 'input.mkv', '-c', 'copy', 'output.mp4']);
  const data = await ffmpeg.readFile('output.mp4');

  await ffmpeg.deleteFile('input.mkv');
  await ffmpeg.deleteFile('output.mp4');

  return new File([data], file.name.replace(/\.mkv$/i, '.mp4'), { type: 'video/mp4' });
}

// --- Tab switching ---
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;

    tabUrl.classList.toggle('active', activeTab === 'url');
    tabUpload.classList.toggle('active', activeTab === 'upload');
  });
});

// --- File selection ---
videoFileInput.addEventListener('change', async () => {
  const file = videoFileInput.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    showError('파일 크기는 500MB 이하여야 합니다.');
    videoFileInput.value = '';
    return;
  }

  fileLabel.querySelector('span').textContent = file.name;
  uploadedUrl = null;
  uploadStatus.hidden = true;

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'mkv') {
    try {
      isUploading = true;
      createBtn.disabled = true;
      const mp4File = await convertMkvToMp4(file);
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      uploadFile(mp4File);
    } catch (err) {
      showError('MKV 변환 실패: ' + err.message);
      isUploading = false;
      createBtn.disabled = false;
      uploadProgress.hidden = true;
    }
  } else {
    uploadFile(file);
  }
});

// --- Upload file via Presigned URL ---
async function uploadFile(file) {
  isUploading = true;
  createBtn.disabled = true;
  uploadProgress.hidden = false;
  uploadStatus.hidden = true;

  try {
    // 1. Get presigned URL from server
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

    // 2. Upload directly to R2
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', presignedUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressText.textContent = `${pct}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`업로드 실패 (HTTP ${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(file);
    });

    // 3. Success
    uploadedUrl = publicUrl;
    uploadStatus.textContent = '업로드 완료!';
    uploadStatus.className = 'upload-status success';
    uploadStatus.hidden = false;
  } catch (err) {
    showError(err.message);
    uploadStatus.textContent = '업로드 실패';
    uploadStatus.className = 'upload-status fail';
    uploadStatus.hidden = false;
    uploadedUrl = null;
  } finally {
    isUploading = false;
    createBtn.disabled = false;
  }
}

// --- Subtitle file selection & upload ---
subFileInput.addEventListener('change', () => {
  const file = subFileInput.files[0];
  if (!file) return;
  uploadSubtitleFile(file);
});

async function uploadSubtitleFile(file) {
  subUploadStatus.hidden = true;
  subtitleUploadedUrl = null;

  try {
    // Read and decode (handle EUC-KR for Korean smi files)
    const buffer = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buffer);
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('euc-kr').decode(buffer); } catch {}
    }

    // Get presigned URL
    const res = await fetch('/api/presign-subtitle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error);
    }

    const { presignedUrl, publicUrl } = await res.json();

    // Upload decoded text as UTF-8
    const putRes = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Blob([text], { type: 'text/plain' }),
    });

    if (!putRes.ok) throw new Error('자막 업로드 실패');

    subtitleUploadedUrl = publicUrl;
    subUploadStatus.textContent = '자막 업로드 완료!';
    subUploadStatus.className = 'upload-status success';
    subUploadStatus.hidden = false;
  } catch (err) {
    showError(err.message);
    subUploadStatus.textContent = '자막 업로드 실패';
    subUploadStatus.className = 'upload-status fail';
    subUploadStatus.hidden = false;
    subtitleUploadedUrl = null;
  }
}

// --- Create Room ---
createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = document.getElementById('create-nickname').value.trim();
  if (!nickname) return;

  let videoUrl;
  if (activeTab === 'url') {
    videoUrl = videoUrlInput.value.trim();
    if (!videoUrl) {
      showError('영상 URL을 입력해주세요.');
      return;
    }
  } else {
    if (isUploading) {
      showError('업로드가 진행 중입니다. 잠시 기다려주세요.');
      return;
    }
    if (!uploadedUrl) {
      showError('영상 파일을 먼저 업로드해주세요.');
      return;
    }
    videoUrl = uploadedUrl;
  }

  socket.emit('create-room', { nickname, videoUrl, subtitleUrl: subtitleUploadedUrl });
});

// --- Join Room ---
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = document.getElementById('join-nickname').value.trim();
  const roomId = document.getElementById('room-code').value.trim();

  if (!nickname || !roomId) return;

  sessionStorage.setItem('wt-action', 'join');
  sessionStorage.setItem('wt-nickname', nickname);
  sessionStorage.setItem('wt-roomId', roomId);
  window.location.href = '/room.html';
});

// --- Room created -> navigate ---
socket.on('room-created', ({ roomId }) => {
  const nickname = document.getElementById('create-nickname').value.trim();
  let videoUrl;
  if (activeTab === 'url') {
    videoUrl = videoUrlInput.value.trim();
  } else {
    videoUrl = uploadedUrl;
  }

  sessionStorage.setItem('wt-action', 'host');
  sessionStorage.setItem('wt-roomId', roomId);
  sessionStorage.setItem('wt-nickname', nickname);
  sessionStorage.setItem('wt-videoUrl', videoUrl);
  sessionStorage.setItem('wt-subtitleUrl', subtitleUploadedUrl || '');
  window.location.href = '/room.html';
});

socket.on('error-msg', ({ message }) => {
  showError(message);
});
