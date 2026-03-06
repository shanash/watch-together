# Watch Together 배포 가이드

## 아키텍처

```
사용자 브라우저
  ├─ [방 생성/참가/동기화] ←→ Render (Node.js + Socket.IO)
  └─ [영상 업로드]         ──→ Cloudflare R2 (Presigned URL 직접 업로드)
                                  ↓
                           R2 퍼블릭 URL로 영상 스트리밍
```

## 사전 준비

### 1. Cloudflare R2 (영상 스토리지)

1. [Cloudflare](https://dash.cloudflare.com/sign-up) 가입
2. R2 Object Storage → **Create bucket** (`watch-together-videos`)
3. 버킷 Settings → **Public Access** → Allow Access → r2.dev URL 메모
4. 버킷 Settings → **CORS Policy** 추가:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"]
     }
   ]
   ```
5. R2 메인 → **Manage R2 API Tokens** → Create API token
   - Permissions: Object Read & Write
   - Bucket: `watch-together-videos`
   - Access Key ID, Secret Access Key 메모
6. 대시보드 우측 → **Account ID** 메모

### 2. GitHub 리포지토리

이미 푸시되어 있어야 합니다:
```bash
cd C:\Projects\watch-together
git init
git add .
git commit -m "Initial commit"
gh repo create watch-together --public --push --source=.
```

## 배포 (Render)

### Step 1: 서비스 생성

1. [Render 대시보드](https://dashboard.render.com) 에서 GitHub 계정으로 로그인
2. **New** → **Web Service**
3. GitHub 리포지토리 `watch-together` 연결
4. 설정:

| 항목 | 값 |
|------|-----|
| Name | `watch-together` |
| Region | `Singapore (Southeast Asia)` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | `Free` |

### Step 2: 환경변수 설정

서비스 생성 후 **Environment** 탭에서 추가 (값은 `.env` 파일 참조):

| 변수명 | 설명 |
|--------|------|
| `R2_ACCOUNT_ID` | Cloudflare Account ID (`.env` 참조) |
| `R2_ACCESS_KEY_ID` | R2 API Access Key (`.env` 참조) |
| `R2_SECRET_ACCESS_KEY` | R2 API Secret Key (`.env` 참조) |
| `R2_BUCKET_NAME` | `watch-together-videos` |
| `R2_PUBLIC_URL` | R2 퍼블릭 URL (`.env` 참조) |

> `.env` 파일에 실제 값이 저장되어 있습니다. 이 파일은 `.gitignore`로 Git에서 제외됩니다.

### Step 3: 배포 확인

- Render가 자동으로 빌드 + 배포
- 완료 후 `https://watch-together-xxxx.onrender.com` 으로 접속

## 로컬 개발

```bash
cp .env.example .env   # 환경변수 설정
npm install
npm start              # http://localhost:3000
```

## 참고 사항

- **슬립**: Render 무료 티어는 15분 비활성 시 슬립. 접속하면 30~60초 후 자동 깨어남
- **WebSocket**: Render는 WebSocket을 네이티브 지원. 추가 설정 불필요
- **자동 배포**: GitHub에 push하면 Render가 자동으로 재배포
