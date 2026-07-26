/**
 * ktraffic-hard-event.js — 급가속·급제동 이벤트 기기 내 탐지 모듈 v1.0
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
 */

(function () {
  const CONSENT_KEY = 'ktraffic_hard_event_consent';

  // 2026-07-26 초안 — 업계에서 흔히 인용되는 근사치일 뿐, 이 서비스의 실측치가
  // 아니다. 제주 필드테스트 배터리·오탐률 실측 후 반드시 보정할 것
  // (K_TRAFFIC_HARD_EVENT_COLLECTION_v1_0.md §5).
  const HARD_BRAKE_THRESHOLD_G  = -0.35;
  const HARD_ACCEL_THRESHOLD_G  = 0.35;
  const MIN_SPEED_FOR_EVENT_KMH = 20;   // 정차 중 노이즈(주차 중 흔들림 등) 배제
  const SUSTAIN_MS              = 400;  // 방지턱 등 순간 튐 배제 — 최소 지속시간
  const MIN_SAMPLES             = 3;
  const EVENT_COOLDOWN_MS       = 5000; // 같은 이벤트가 연쇄 발화되는 것 방지

  let _active = false;
  let _accelBuffer = [];          // 최근 ~1초, 메모리에만 존재 — 저장·전송 안 함
  let _lastKnownSpeedKmh = null;
  let _lastKnownLat = null, _lastKnownLng = null;
  let _lastEventAt = 0;
  let _sensorSource = null;       // 'devicemotion' | 'gps_estimated'
  let _lastGpsFix = null;         // devicemotion 미지원 시 폴백용

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

  // ── GPS 속도 델타 폴백 (가속도계 미지원/거부 시) ──────────────
  function onGpsFix(lat, lng, speedKmh, tMs) {
    _lastKnownLat = lat; _lastKnownLng = lng; _lastKnownSpeedKmh = speedKmh;
    if (_sensorSource !== 'gps_estimated') return; // devicemotion 쓸 수 있으면 이 경로 안 씀

    const curr = { speedKmh, t: tMs };
    if (_lastGpsFix) {
      const dtSec = (curr.t - _lastGpsFix.t) / 1000;
      if (dtSec > 0 && dtSec <= 5) { // 샘플 간격이 너무 벌어지면 신뢰 불가 → 버림
        const dvKmh = curr.speedKmh - _lastGpsFix.speedKmh;
        const gApprox = (dvKmh / 3.6) / dtSec / 9.81;
        const now = performance.now();
        if (speedKmh >= MIN_SPEED_FOR_EVENT_KMH && now - _lastEventAt >= EVENT_COOLDOWN_MS) {
          if (gApprox <= HARD_BRAKE_THRESHOLD_G) {
            _lastEventAt = now; emitLocalHardEvent('brake', severityFromMagnitude(gApprox));
          } else if (gApprox >= HARD_ACCEL_THRESHOLD_G) {
            _lastEventAt = now; emitLocalHardEvent('accel', severityFromMagnitude(gApprox));
          }
        }
      }
    }
    _lastGpsFix = curr;
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
    }
    return _sensorSource;
  }

  function disableHardEventCollection() {
    setConsent(false);
    _active = false;
    _accelBuffer = [];
    window.removeEventListener('devicemotion', onDeviceMotion);
  }

  function isHardEventCollectionEnabled() {
    return hasConsent();
  }

  // desktop.html/webapp.html에서 GPS 픽스를 받을 때마다 이것도 같이 호출해 주어야
  // gps_estimated 폴백 경로가 동작한다(_sendPosition 안에서 호출).
  window.KTrafficHardEvent = {
    enable: enableHardEventCollection,
    disable: disableHardEventCollection,
    isEnabled: isHardEventCollectionEnabled,
    onGpsFix,
  };

  // 새로고침 후에도 이전에 동의했었다면 자동으로 재시작(단, 위치 공유가 시작될 때
  // desktop.html 쪽에서 명시적으로 enable()을 다시 호출하는 편이 더 안전 —
  // 여기서는 상태만 노출하고 자동 재개는 하지 않는다).
})();
