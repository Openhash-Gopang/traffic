# K-Traffic — AI 기반 교통·물류 통합 플랫폼

> **고팡(Gopang) 생태계** 위에서 동작하는 AI 교통·물류 플랫폼.  
> 이미 이동 중인 차량의 동선에 새로운 수요를 끼워 넣어 최적의 이동·물류 경로를 구성합니다.

🌐 **배포 주소**: [traffic.hondi.net](https://traffic.hondi.net)  
📄 **백서**: [docs/k-traffic-whitepaper.md](docs/k-traffic-whitepaper.md)

---

## 디렉토리 구조

```
traffic/
│
│   ─── 진입점 & GitHub Pages 설정 ───
│   index.html                  고팡 생태계 진입점
│   .nojekyll                   Jekyll 비활성화
│   CNAME                       traffic.hondi.net
│
│   ─── 클라이언트 앱 ───
│   desktop.html                데스크톱 앱 (이동 요청·AI 상담·PDV 기록)
│   webapp.html                 모바일 웹앱 (스마트폰 최적화)
│
│   ─── 대시보드 ───
│   user-dashboard.html         사용자 교통·물류 대시보드
│   national-dashboard.html     국가 교통·물류 대시보드
│   realtime-board.html         실시간 교통 상황판 (Kakao Maps + Openhash)
│
│   ─── 공통 모듈 ───
│   pdv.js                      PDV 기록 모듈 v2.0
│
│   ─── 서버 패치 ───
│   worker-kakao-patch.js       gopang-proxy Worker 패치
│                                (/kakao/appkey · /ai/chat 엔드포인트)
│
├───docs/
│       k-traffic-whitepaper.md  K-Traffic 기술 백서 v1.0
│
└───prompts/
        traffic.md              DeepSeek V3 AI 매칭 엔진 시스템 프롬프트
```

---

## 파일별 역할

### 클라이언트

| 파일 | 대상 | 핵심 기능 |
|------|------|----------|
| `desktop.html` | 운전자·사무 이용자 | AI 채팅 매칭, 이동 요청, PDV 기록, GDC 지갑 |
| `webapp.html` | 스마트폰 이용자 | 터치 UI, 차량 탐색, 탑승 요청 |
| `user-dashboard.html` | 개인 이용자 | 내 이동·물류 이력 (기간별 KPI) |
| `national-dashboard.html` | 관리자·정책 담당자 | 전국 시군구·읍면동 5W1H 실시간 현황 |
| `realtime-board.html` | 관제 센터 | Kakao Maps 차량 위치·경로·수요 큐 |

### 공통 모듈 & 서버

| 파일 | 역할 |
|------|------|
| `pdv.js` | 탑승·화물·평가·긴급 이벤트 → gopang-proxy → Supabase 기록 |
| `worker-kakao-patch.js` | Cloudflare Worker `/kakao/appkey`, `/ai/chat` 엔드포인트 |

### 문서

| 파일 | 내용 |
|------|------|
| `docs/k-traffic-whitepaper.md` | 시스템 아키텍처·동작 메커니즘·보안·로드맵 기술 백서 |
| `prompts/traffic.md` | DeepSeek V3 시스템 프롬프트 |

---

## 핵심 아키텍처

```
클라이언트 (5개 HTML)
        │
        ▼
gopang-proxy (Cloudflare Workers)
        ├─ /pdv/report   → Supabase (거래 기록)
        ├─ /ai/chat      → DeepSeek V3 Pro → Claude 폴백
        └─ /kakao/appkey → Kakao Maps SDK 동적 로드
        │
        ▼
Openhash Network
 L1(읍면동) → L2(시군구) → L3(광역) → L4(국가) → L5(글로벌)
        │
        ▼
고팡 블랙박스 탑재 차량 (1분 단위 위치·동선 전송)
```

---

## 빠른 시작

### 1. Cloudflare Worker 패치

`worker-kakao-patch.js`의 두 함수를 `gopang-proxy`에 추가:

```javascript
if (url.pathname === '/kakao/appkey') return handleKakaoAppKey(request, env);
if (url.pathname === '/ai/chat')      return handleAIChat(request, env);
```

### 2. 환경 변수 확인

| 이름 | 용도 | 상태 |
|------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek V3 AI | ✅ 설정됨 |
| `KAKAO_REST_KEY` | Kakao REST API | ✅ 설정됨 |
| `KAKAO_JS_KEY` | Kakao Maps JS SDK | ⚠️ 추가 필요 |
| `SUPABASE_KEY` | PDV 로그 DB | ✅ 설정됨 |

> `KAKAO_JS_KEY`: [developers.kakao.com](https://developers.kakao.com) → 앱 키 → **JavaScript 키** 등록

### 3. 배포

```bash
# whitepaper 이동 (최초 1회)
mkdir docs
move k-traffic-whitepaper.md docs\k-traffic-whitepaper.md

git add .
git commit -m "chore: 디렉토리 정리 및 README 추가"
git push
```

---

## 연관 고팡 서브시스템

| 시스템 | 도메인 | 상태 |
|--------|--------|------|
| K-Traffic | traffic.hondi.net | ✅ 운영 중 |
| K-Law | klaw.hondi.net | ✅ 운영 중 |
| K-Health | health.hondi.net | ✅ 운영 중 |
| K-School | school.hondi.net | ✅ 운영 중 |
| K-Market | market.hondi.net | ✅ 운영 중 |
| K-Police | police.hondi.net | ✅ 운영 중 |

---

*© 2026 Gopang Ecosystem — K-Traffic Team*
