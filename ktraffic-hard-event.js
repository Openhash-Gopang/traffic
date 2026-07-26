/**
 * ktraffic-hard-event.js — 급가속·급제동 이벤트 기기 내 탐지 모듈 v1.1
 * 설계 문서: docs/K_TRAFFIC_HARD_EVENT_COLLECTION_v1_0.md
 *
 * 핵심 원칙: 원시 가속도 센서 스트림은 이 파일 밖으로(서버는 물론 다른 모듈로도)
 * 절대 넘기지 않는다. 이 파일이 서버로 보내는 건 PDV.writeHardEvent()를 통해
 * 나가는 "이벤트 발생 여부 + 등급"뿐이다. pdv.js보다 뒤에 로드되어야 한다
 * (window.PDV 필요).
 *
 * UI(desktop.html)와의 접점: 사용자가 별도 동의 스위치를 켜면 enableHardEventCollection(),
 * 끄면 disableHardEventCollection()을 호출한다. 매칭용 위치 공유(_startPositionWatch)와는
 * 완전히 독립적으로 켜고 끌 수 있다.
 *
 * v1.1 (2026-07-26) — GPS 폴백 정밀도 보완. §2.3/§5에서 이미 "정확도 낮음"으로
 * 명시돼 있던 문제를 구체적으로 고쳤다. 이전 버전은 desktop.html의 매칭용
 * watchPosition(enableHighAccuracy:false, maximumAge:20000, 25초 스로틀 전송)
 * 콜백에 얹혀 onGpsFix()를 호출했는데, 이 설정은 매칭에는 적절해도 g-force
 * 추정에는 두 가지 실질적 결함이 있었다:
 *   1. maximumAge:20000 때문에 브라우저가 최대 20초 된 캐시 좌표를 그대로
 *      돌려줄 수 있는데, onGpsFix 호출부는 그 좌표의 실제 취득 시각이 아니라
 *      호출된 순간의 Date.now()를 델타 계산에 썼다. 캐시된 좌표라면
 *      "20초 전 속도"와 "지금" 사이의 시간차를 실제보다 훨씬 짧게 계산해
 *      g값이 크게 부풀려질 수 있었다(정지→캐시된 고속 좌표 조합 시 특히).
 *   2. 위치 정확도(coords.accuracy)를 전혀 걸러내지 않아, 저정밀 픽스로
 *      나온 잡음 섞인 speed 값도 그대로 계산에 들어갔다.
 * 이번 버전은 (a) GPS 폴백이 활성화된 경우에 한해 이 모듈이 별도의
 * 고정밀·비캐시 watchPosition을 직접 소유하고, (b) 각 픽스의 실제 취득
 * 시각(pos.timestamp)과 정확도(coords.accuracy)를 함께 받아 정확도가
 * 기준치보다 나쁜 픽스는 계산에서 제외한다. 그래도 GPS 갱신 주기 자체가
 * devicemotion(수십 Hz)보다 훨씬 느려(보통 1Hz 안팎) §2.2의 400ms 지속시간
 * 기준을 그대로 만족시키기 어렵다는 한계는 여전하다 — 이 폴백은 "완전
 * 무데이터보다 낫다" 수준이라는 §2.3의 평가를 뒤집는 게 아니라, 적어도
 * 그 안에서 계산 자체가 틀리지 않도록 고친 것이다.
 */

(function () {
  const CONSENT_KEY = 'ktraffic_hard_event_consent';

  // 2026-07-26 초안 — 업계에서 흔히 인용되는 근사치일 뿐, 이 서비스의 실측치가
  // 아니다. 제주 필드테스트 배터리·오탐률 실측 후 반드시 보정할 것
  // (K_TRAFFIC_HARD_EVENT_COLLECTION_v1_0.md §5).
  const HARD_BRAKE_THRESHOLD_G  = -0.35;
  const HARD_ACCEL_THRESHOLD_G  = 0.35;
  const MIN_SPEED_FOR_EVENT_KMH = 20;   // 정차 중 노이즈(주차 중 흔들림 등) 배제
  const SUSTAIN_MS              = 400;  // 방지턱 등 순간 튐 배제 — 최소 지속시간(devicemotion 경로)
  const MIN_SAMPLES             = 3;
  const EVENT_COOLDOWN_MS       = 5000; // 같은 이벤트가 연쇄 발화되는 것 방지

  // v1.1 신설 — GPS 폴백 전용 정밀도 기준
  const MAX_FIX_ACCURACY_M   = 25;   // coords.accuracy가 이보다 나쁘면(값이 크면) 픽스 폐기
  const MAX_FIX_INTERVAL_SEC = 5;    // 두 픽스 간격이 이보다 벌어지면 델타 신뢰 불가
  const GPS_FALLBACK_WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };

  let _active = false;
  let _accelBuffer = [];          // 최근 ~1초, 메모리에만 존재 — 저장·전송 안 함
  let _lastKnownSpeedKmh = null;
  let _lastKnownLat = null, _lastKnownLng = null;
  let _lastEventAt = 0;
  let _sensorSource = null;       // 'devicemotion' | 'gps_estimated'
  let _lastGpsFix = null;         // devicemotion 미지원 시 폴백용 — { speedKmh, t, accuracyM }
  let _gpsWatchId = null;         // v1.1 — 이 모듈이 직접 소유하는 고정밀 워치(폴백 전용)

  // ── 동의 상태 ──────────────────────────────────────────────
  function hasConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
  }
  function setConsent(on) {
    try { localStorage.setItem(CONSENT_KEY, on ? '1' : '0'); } catch {}
  }

  // ── 최소 geohash 인코더 (desktop.html의 전역 함수에 의존하지 않도록 자체 포함) ──
  function geohashEncode(lat, lng, precision = 5) {
    const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    let latRange = [-90, 90], lngRange = [-180, 180];
    let hash = '', bit = 0, ch = 0, evenBit = true;
    while (hash.length < precision) {
      if (evenBit) {
        const mid = (lngRange[0] + lngRange[1]) / 2;
        if (lng >= mid) { ch |= (1 << (4 - bit)); lngRange[0] = mid; } else { lngRange[1] = mid; }
      } else {
        const mid = (latRange[0] + latRange[1]) / 2;
        if (lat >= mid) { ch |= (1 << (4 - bit)); latRange[0] = mid; } else { latRange[1] = mid; }
      }
      evenBit = !evenBit;
      if (bit < 4) { bit++; } else { hash += BASE32[ch]; bit = 0; ch = 0; }
    }
    return hash;
  }

  // ── iOS 권한 요청 (반드시 사용자 클릭 핸들러 안에서 호출되어야 함) ──
  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        return result === 'granted';
      } catch (e) {
        console.warn('[K-Traffic HardEvent] iOS 센서 권한 요청 실패:', e.message);
        return false;
      }
    }
    return true; // Android 등 권한 요청 불필요 플랫폼
  }

  function severityFromMagnitude(g) {
    const abs = Math.abs(g);
    if (abs >= 0.55) return 'high';
    if (abs >= 0.45) return 'mid';
    return 'low';
  }

  // ── devicemotion 실시간 탐지 ──────────────────────────────
  function onDeviceMotion(event) {
    if (!_active) return;
    // 진행방향 축 근사치 — 실제로는 자이로스코프 결합한 방향 보정이 필요하다
    // (K_TRAFFIC_HARD_EVENT_COLLECTION_v1_0.md §5, 이 파일은 단순화된 근사만 구현).
    const acc = event.acceleration;
    if (!acc) return;
    const g = (acc.y || 0) / 9.81;
    const now = performance.now();

    _accelBuffer.push({ g, t: now });
    _accelBuffer = _accelBuffer.filter(s => now - s.t < 1000);

    if (_lastKnownSpeedKmh != null && _lastKnownSpeedKmh < MIN_SPEED_FOR_EVENT_KMH) return;
    if (now - _lastEventAt < EVENT_COOLDOWN_MS) return;

    const sustained = _accelBuffer.filter(s => now - s.t < SUSTAIN_MS);
    if (sustained.length < MIN_SAMPLES) return;
    const avg = sustained.reduce((a, s) => a + s.g, 0) / sustained.length;

    if (avg <= HARD_BRAKE_THRESHOLD_G) {
      _lastEventAt = now;
      emitLocalHardEvent('brake', severityFromMagnitude(avg));
    } else if (avg >= HARD_ACCEL_THRESHOLD_G) {
      _lastEventAt = now;
      emitLocalHardEvent('accel', severityFromMagnitude(avg));
    }
  }

  /* ════════════════════════════════════════════════════════════
     GPS 속도 델타 폴백 — v1.1: 순수 함수로 분리(테스트 가능하게)
     ════════════════════════════════════════════════════════════ */

  // 픽스 하나가 계산에 쓸 만큼 정확한지 — 정확도(accuracyM)만으로 판단하는
  // 순수 함수. accuracyM이 null/undefined면(구형 브라우저 등 정확도 미제공)
  // 판단할 근거가 없으므로 보수적으로 "사용 가능"으로 둔다 — 없는 값을
  // 있는 것처럼 억지로 나쁘게 취급하지 않는다.
  function isFixUsable(accuracyM) {
    if (accuracyM == null || Number.isNaN(accuracyM)) return true;
    return accuracyM <= MAX_FIX_ACCURACY_M;
  }

  // 두 GPS 픽스의 속도 차이로 g값을 근사하는 순수 함수. 각 픽스는
  // { speedKmh, t, accuracyM? } 형태이며 t는 반드시 실제 취득 시각
  // (pos.timestamp)이어야 한다 — 호출 시각(Date.now())을 넣으면 캐시된
  // 픽스가 섞였을 때 델타가 왜곡된다(v1.0의 버그).
  function estimateGForceFromDelta(prevFix, currFix) {
    if (!prevFix || !currFix) return null;
    if (!isFixUsable(prevFix.accuracyM) || !isFixUsable(currFix.accuracyM)) return null;
    const dtSec = (currFix.t - prevFix.t) / 1000;
    if (!(dtSec > 0) || dtSec > MAX_FIX_INTERVAL_SEC) return null; // 역행/과다간격 → 신뢰 불가
    const dvKmh = currFix.speedKmh - prevFix.speedKmh;
    return (dvKmh / 3.6) / dtSec / 9.81;
  }

  // onGpsFix — 실제 사이드이펙트(이벤트 발화)를 갖는 얇은 래퍼.
  // accuracyM은 v1.1에서 추가된 4번째 인자로, 없으면(구버전 호출부) undefined로
  // 들어와도 isFixUsable()이 관대하게 처리한다.
  function onGpsFix(lat, lng, speedKmh, tMs, accuracyM) {
    _lastKnownLat = lat; _lastKnownLng = lng; _lastKnownSpeedKmh = speedKmh;
    if (_sensorSource !== 'gps_estimated') return; // devicemotion 쓸 수 있으면 이 경로 안 씀

    const curr = { speedKmh, t: tMs, accuracyM };
    const gApprox = estimateGForceFromDelta(_lastGpsFix, curr);
    _lastGpsFix = curr;
    if (gApprox == null) return;

    const now = performance.now();
    if (speedKmh < MIN_SPEED_FOR_EVENT_KMH) return;
    if (now - _lastEventAt < EVENT_COOLDOWN_MS) return;
    if (gApprox <= HARD_BRAKE_THRESHOLD_G) {
      _lastEventAt = now; emitLocalHardEvent('brake', severityFromMagnitude(gApprox));
    } else if (gApprox >= HARD_ACCEL_THRESHOLD_G) {
      _lastEventAt = now; emitLocalHardEvent('accel', severityFromMagnitude(gApprox));
    }
  }

  // v1.1 신설 — GPS 폴백이 활성화된 경우, 매칭용 워치(desktop.html,
  // enableHighAccuracy:false/maximumAge:20000)에 얹지 않고 이 모듈이 직접
  // 고정밀·비캐시 워치를 하나 더 띄운다. 매칭용 위치 전송(25초 스로틀)과는
  // 완전히 독립적으로 동작하며, 이 워치의 픽스는 오직 g-force 추정에만
  // 쓰이고 서버로 좌표 자체가 나가지 않는다(emitLocalHardEvent가 geohash
  // 5자리로만 축약해서 보낸다 — 기존 원칙 그대로).
  function _startDedicatedGpsWatch() {
    if (!navigator.geolocation || _gpsWatchId != null) return;
    _gpsWatchId = navigator.geolocation.watchPosition((pos) => {
      onGpsFix(
        pos.coords.latitude, pos.coords.longitude,
        pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
        pos.timestamp,           // 캐시가 아닌 실제 취득 시각 — v1.1 핵심 수정
        pos.coords.accuracy
      );
    }, (e) => {
      console.warn('[K-Traffic HardEvent] 고정밀 GPS 워치 실패 — 폴백을 계속 시도합니다:', e.message);
    }, GPS_FALLBACK_WATCH_OPTS);
  }

  function _stopDedicatedGpsWatch() {
    if (_gpsWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(_gpsWatchId);
    }
    _gpsWatchId = null;
    _lastGpsFix = null;
  }

  // ── 확정된 이벤트만 PDV로 전송 (등급형 데이터만, 원시값 없음) ──
  async function emitLocalHardEvent(eventType, severity) {
    if (!hasConsent()) return; // 이중 안전장치 — 동의 없으면 절대 전송하지 않음
    const cell = (_lastKnownLat != null && _lastKnownLng != null)
      ? geohashEncode(_lastKnownLat, _lastKnownLng, 5)
      : '';
    try {
      await window.PDV.writeHardEvent({
        eventType, severity, geohashCell: cell, dataQuality: _sensorSource || 'devicemotion',
      });
    } catch (e) {
      console.warn('[K-Traffic HardEvent] PDV 기록 실패:', e.message);
    }
  }

  // ── 공개 API — desktop.html의 옵트인 UI에서 호출 ──────────────
  async function enableHardEventCollection() {
    const granted = await requestMotionPermission();
    if (!granted) {
      _sensorSource = 'gps_estimated'; // 권한 거부 시 GPS 폴백으로 강등
    } else if (typeof window.DeviceMotionEvent === 'undefined') {
      _sensorSource = 'gps_estimated'; // 센서 자체 미지원
    } else {
      _sensorSource = 'devicemotion';
    }
    setConsent(true);
    _active = true;
    if (_sensorSource === 'devicemotion') {
      window.addEventListener('devicemotion', onDeviceMotion);
    } else {
      _startDedicatedGpsWatch(); // v1.1 — 폴백 경로는 이제 자체 고정밀 워치를 씀
    }
    return _sensorSource;
  }

  function disableHardEventCollection() {
    setConsent(false);
    _active = false;
    _accelBuffer = [];
    window.removeEventListener('devicemotion', onDeviceMotion);
    _stopDedicatedGpsWatch();
  }

  function isHardEventCollectionEnabled() {
    return hasConsent();
  }

  const KTrafficHardEvent = {
    enable: enableHardEventCollection,
    disable: disableHardEventCollection,
    isEnabled: isHardEventCollectionEnabled,
    onGpsFix,
    // v1.1 — 순수 함수 재노출(테스트 및 다른 모듈 재사용용)
    estimateGForceFromDelta,
    isFixUsable,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KTrafficHardEvent;
  }
  if (typeof window !== 'undefined') {
    window.KTrafficHardEvent = KTrafficHardEvent;
  }

  // 새로고침 후에도 이전에 동의했었다면 자동으로 재시작(단, 위치 공유가 시작될 때
  // desktop.html 쪽에서 명시적으로 enable()을 다시 호출하는 편이 더 안전 —
  // 여기서는 상태만 노출하고 자동 재개는 하지 않는다).
})();
