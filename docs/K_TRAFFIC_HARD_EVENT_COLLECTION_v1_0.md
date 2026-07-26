# K-Traffic 급가속·급제동 이벤트 수집 설계 v1.0
## `k-traffic.hard_event_freq_monthly` 원천 데이터 확보

> 전제: `PDV_SANDBOX_SCHEMA_v1_0.md` §1.1에서 이 키는 "미수집, 개발 필요"로 표시돼 있었다. 이 문서는 그 구멍을 메운다.
> 현재 K-Traffic이 실제로 하는 것: `navigator.geolocation.watchPosition()`을 `enableHighAccuracy:false`, 25초 스로틀로 돌려 매칭용 위치만 `/match/vehicle/position`에 전송(`desktop.html` 확인됨). 급가속·급제동을 감지할 만한 시간 해상도가 전혀 아니다 — 25초에 한 번 찍는 좌표로는 1~2초짜리 급제동 이벤트를 볼 수 없다.

---

## 0. 설계 원칙 — 이 데이터가 특히 위험한 이유

가속도 데이터는 위치 데이터보다 훨씬 더 "생체스러운" 정보다. 연속된 가속도 스트림을 서버로 그대로 보내면, 운전 습관은 물론 도로의 요철 패턴과 결합해 정확한 경로까지 역추정될 수 있다(가속도 지문, accelerometer fingerprinting). **그래서 이 설계의 핵심은 "원시 센서 스트림은 기기 밖으로 절대 나가지 않는다"는 것이다** — `PDV_SANDBOX_EXECUTION_DESIGN_v1_0.md`가 원본 PDV를 혼디 서버 경계 밖으로 안 보내는 것과 같은 원칙을, 여기서는 한 단계 더 앞당겨 **사용자 기기 경계 밖으로도 원시 데이터가 안 나가게** 만든다.

```
원시 가속도 스트림 (기기 안에서만, 절대 전송 안 함)
        │
        ▼  (기기 내 실시간 이벤트 탐지)
"급제동 이벤트 1건 발생" ── 시각, 대략적 지역(geohash 5자리), 심각도 등급만
        │
        ▼  (전송되는 건 이것뿐)
서버 → PDV 기록(이벤트 단위) → 월간 배치 집계 → k-traffic.hard_event_freq_monthly
```

---

## 1. 별도 동의 스코프 — 매칭 기능과 분리

현재 위치 공유(`_startPositionWatch`)는 **화물 매칭에 필요한 필수 기능**이라 기사 등록 시 자동으로 시작된다. 가속도 기반 운전습관 측정은 **UBI 보험 할인이라는 별도 목적**이므로, 반드시 별도 동의로 분리한다.

```
scope_id: "ins-auto-hard-event-collect-v1"
purpose: "자동차 보험 UBI 할인용 급가속·급제동 이벤트 수집"
opt-in: 기본값 OFF — 매칭 기능 이용에는 전혀 영향 없음
revocable: 즉시 (철회 시 다음 devicemotion 이벤트부터 감지 로직 자체를 비활성화)
```

동의 UI에서 "이 정보로 무엇을 하는지"를 명확히 밝힌다: *"휴대폰의 가속도 센서로 급가속·급제동을 자동 감지합니다. 원시 센서 값은 기기 밖으로 전송되지 않고, '이벤트 발생 여부'만 서버로 전송됩니다."*

---

## 2. 기기 내 이벤트 탐지 로직

### 2.1 센서 소스 — 플랫폼별 분기

| 플랫폼 | API | 비고 |
|---|---|---|
| Android(Chrome 등) | `devicemotion` 이벤트 (`event.acceleration`, 중력 제외 가속도) | 별도 권한 요청 없이 사용 가능 |
| iOS Safari 13+ | `devicemotion` + **명시적 권한 요청 필수** (`DeviceMotionEvent.requestPermission()`) | 사용자 제스처(버튼 클릭) 안에서만 요청 가능 |
| 센서 미지원/거부 | GPS 속도 델타 폴백(§2.3) | 정확도 낮음, 최후 수단 |

```js
// 기존 pdv.js와 같은 파일 스타일로 신설 — ktraffic-hard-event.js
async function requestMotionPermission() {
  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    // iOS — 반드시 사용자 클릭 핸들러 안에서 호출
    const result = await DeviceMotionEvent.requestPermission();
    return result === 'granted';
  }
  return true; // Android 등 권한 요청 불필요 플랫폼
}
```

### 2.2 실시간 탐지 (기기 내부, 전송 없음)

```js
const HARD_BRAKE_THRESHOLD_G  = -0.35;  // 초기값, §5 실측 후 보정
const HARD_ACCEL_THRESHOLD_G  = 0.35;
const MIN_SPEED_FOR_EVENT_KMH = 20;     // 정지 상태에서의 노이즈(주차 중 흔들림 등) 배제
const SUSTAIN_MS              = 400;    // 순간 튐(방지턱 등) 배제 — 최소 지속시간

let _accelBuffer = [];   // 최근 ~1초 슬라이딩 윈도우, 기기 메모리에만 존재, 저장 안 함
let _lastKnownSpeedKmh = null;

function onDeviceMotion(event) {
  const g = (event.acceleration?.y || 0) / 9.81;  // 진행방향 축 근사치, 실제론 방향 보정 필요
  const now = performance.now();
  _accelBuffer.push({ g, t: now });
  _accelBuffer = _accelBuffer.filter(s => now - s.t < 1000);

  if (_lastKnownSpeedKmh != null && _lastKnownSpeedKmh < MIN_SPEED_FOR_EVENT_KMH) return;

  const sustained = _accelBuffer.filter(s => now - s.t < SUSTAIN_MS);
  const avg = sustained.reduce((a,s) => a + s.g, 0) / (sustained.length || 1);

  if (avg <= HARD_BRAKE_THRESHOLD_G && sustained.length >= 3) {
    emitLocalHardEvent('brake', severityFromMagnitude(avg));
  } else if (avg >= HARD_ACCEL_THRESHOLD_G && sustained.length >= 3) {
    emitLocalHardEvent('accel', severityFromMagnitude(avg));
  }
}

function severityFromMagnitude(g) {
  const abs = Math.abs(g);
  if (abs >= 0.55) return 'high';
  if (abs >= 0.45) return 'mid';
  return 'low';
}
```

**왜 이렇게 설계했나**:
- `MIN_SPEED_FOR_EVENT_KMH` — 정차 중 스마트폰을 만지거나 문을 세게 닫는 등의 노이즈를 배제한다. 속도 정보는 §2.3의 GPS 스트림(기존 매칭용, 25초 간격)과는 별개로, 이 기능이 켜져 있을 때만 짧은 주기로 갱신되는 별도 속도 추정치를 쓴다.
- `SUSTAIN_MS` + 최소 샘플 수 — 방지턱·요철 같은 순간적 스파이크는 급제동이 아니므로 최소 지속시간을 요구해 걸러낸다.
- 이 함수는 **로컬 이벤트만 만들고, 아직 아무것도 전송하지 않는다.**

### 2.3 GPS 속도 델타 폴백 (가속도계 미지원/거부 시)

```js
// 연속된 두 GPS 샘플의 속도 차이로 근사 — 정확도는 낮지만 완전 무데이터보단 낫다
function estimateFromGpsDelta(prevFix, currFix) {
  const dtSec = (currFix.t - prevFix.t) / 1000;
  if (dtSec <= 0 || dtSec > 5) return null;  // 샘플 간격이 너무 벌어지면 신뢰 불가 → 버림
  const dvKmh = currFix.speedKmh - prevFix.speedKmh;
  const gApprox = (dvKmh / 3.6) / dtSec / 9.81;
  return gApprox;
}
```

이 폴백을 쓰는 사용자는 캡슐 API 응답에서 `data_quality: "gps_estimated"` 플래그가 같이 나가도록 해, 보험사(코드) 쪽에서 신뢰도를 낮게 가중할 수 있게 한다 — 정확도가 다른 두 소스를 같은 값처럼 섞지 않는다.

---

## 3. 전송되는 것 — 이벤트 단위, PDV 6하원칙 기록

로컬 탐지가 확정되면, **그 순간에만** 아래 형태로 기존 `pdv.js`의 `_sendToPDV()` 패턴을 그대로 재사용해 전송한다(신규 인프라 없이 기존 PDV 리포트 파이프라인에 얹는다).

```js
async function emitLocalHardEvent(type, severity) {
  const coarseCell = geohashEncode(_lastKnownLat, _lastKnownLng, 5); // 기존 geohashEncode 재사용, 정밀좌표 아님
  await _sendToPDV({
    svc: 'traffic', type: 'hard_driving_event',
    who:   { ipv6: _getUserIpv6(), role: 'driver' },
    when:  { period_start: new Date().toISOString(), period_end: new Date().toISOString() },
    where: { geohash_cell: coarseCell },              // 정밀 좌표 아님 — 대략 4.9km × 4.9km 단위
    what:  { event_type: type, severity },             // 'brake'|'accel', 'low'|'mid'|'high'
    how:   { method: _sensorSource },                  // 'devicemotion' | 'gps_estimated'
    why:   { goal: 'UBI 보험 할인 산정용 운전습관 이벤트 기록(사용자 동의)' },
  });
}
```

- **정밀 GPS 좌표 대신 geohash 5자리(약 4.9km 격자)만 기록한다** — "어느 동네였는지"는 남지만 "정확히 어느 지점이었는지"는 남지 않는다. 이벤트의 위치가 사고 다발 구간 통계 등에 쓰일 순 있어도, 특정 개인의 정밀 동선 재구성에는 못 쓰이게 하는 절충이다.
- 원시 가속도 값(`g` 수치)은 절대 전송하지 않는다 — `severity` 등급(low/mid/high) 3단계만 나간다. `PDV_SANDBOX_EXECUTION_DESIGN_v1_0.md` §7.1의 "출력은 등급형만"이라는 규칙을, 원천 데이터 수집 단계에서부터 미리 지킨다.

---

## 4. 서버 측 — 월간 집계 배치

이벤트는 PDV에 개별 레코드로 쌓이고, `pdv.query("k-traffic.hard_event_freq_monthly")`가 호출될 때 원본을 다시 훑는 게 아니라, **매월 1회 배치**로 미리 집계해둔 값을 캡슐 API가 그대로 서빙한다(요청마다 원본을 재계산하지 않는 것도 §7.2 재실행 제한 철학과 일치).

```
Cron Trigger(매월 1일 00:00 KST) → aggregateHardEvents()
  1. 지난 30일 hard_driving_event 레코드를 user_guid별로 그룹화
  2. count(severity=high)*3 + count(severity=mid)*2 + count(severity=low)*1 로 가중 점수 산출
  3. 전체 사용자 분포에서 3분위 컷오프 계산 → {low, mid, high} 중 하나로 등급화
  4. k-traffic.hard_event_freq_monthly 값을 pdv_capsule_key_registry 응답 캐시에 갱신
  5. 원본 개별 이벤트 레코드는 정책에 따라 예: 13개월 뒤 파기(개인정보 보관기간 최소화)
```

3분위(모집단 상대 등급)로 하는 이유: 절대 임계치(예: "월 5회 이상이면 high")를 처음부터 하드코딩하면 실측 데이터 없이 정한 숫자라 왜곡될 위험이 크다. 상대 등급으로 시작하고, §5의 실측이 쌓이면 절대 기준으로 전환할지 재검토한다.

---

## 5. 배터리·정확도 실측 계획 (배포 전 필수)

- **배터리 소모**: `devicemotion` 상시 리스닝은 배터리 소모가 크다. 반드시 (a) 기사가 "운행 중" 상태일 때만 리스너를 붙이고, (b) 샘플링 주기를 다운샘플링(원시 이벤트를 다 처리하지 않고 예: 20Hz로 스로틀)해 실측 배터리 영향을 제주 필드테스트에서 먼저 재야 한다.
- **오탐률**: 방지턱, 정차 중 승하차, 통화 중 흔들림 등으로 인한 오탐을 실제 주행 로그로 검증 후 §2.2의 임계치(`HARD_BRAKE_THRESHOLD_G` 등)를 조정해야 한다 — 지금 값은 UBI 업계에서 흔히 인용되는 근사치(약 0.3~0.4g)일 뿐 이 서비스 실측치가 아니다.
- **기기 방향 보정**: `event.acceleration.y`를 그대로 쓰면 스마트폰 거치 방향에 따라 축이 달라진다 — 실제로는 자이로스코프와 결합해 차량 진행방향 축을 추정하는 보정이 필요하다(이 문서는 단순화된 근사만 제시했다).

---

## 6. 다음 단계

- [ ] `ktraffic-hard-event.js` 실제 파일 작성 및 `desktop.html`/`webapp.html`에 옵트인 UI(별도 동의 스위치) 추가
- [ ] 기기 방향 보정(자이로 결합) 로직 구체화
- [ ] `aggregateHardEvents()` Cron Worker 실제 구현
- [ ] 제주 필드테스트에서 배터리·오탐률 실측 후 임계치 재조정
- [ ] 원본 이벤트 레코드 보관기간 정책(현재 초안: 13개월) 개인정보보호팀 검토
