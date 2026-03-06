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

let activeTab = 'url';
let uploadedUrl = null;
let isUploading = false;

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
  setTimeout(() => { errorMsg.hidden = true; }, 4000);
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
videoFileInput.addEventListener('change', () => {
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

  // Start upload immediately
  uploadFile(file);
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

  socket.emit('create-room', { nickname, videoUrl });
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
  window.location.href = '/room.html';
});

socket.on('error-msg', ({ message }) => {
  showError(message);
});
