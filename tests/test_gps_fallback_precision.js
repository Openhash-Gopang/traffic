/**
 * tests/test_gps_fallback_precision.js — ktraffic-hard-event.js v1.1 검증
 * GPS 폴백 정밀도 보완(정확도 게이팅, 실제 취득 시각 사용) 확인.
 * 실행: node tests/test_gps_fallback_precision.js
 */
const { estimateGForceFromDelta, isFixUsable } = require('../ktraffic-hard-event.js');

let failures = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
  else console.log(`OK: ${label}`);
}
function assertTrue(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failures++; }
  else console.log(`OK: ${label}`);
}
function assertNull(actual, label) {
  if (actual !== null) { console.error(`FAIL: ${label}\n  actual: ${JSON.stringify(actual)} (null 기대)`); failures++; }
  else console.log(`OK: ${label}`);
}
function assertClose(actual, expected, tolerance, label) {
  if (actual == null || Math.abs(actual - expected) > tolerance) {
    console.error(`FAIL: ${label}\n  actual: ${actual}\n  expected≈: ${expected} (±${tolerance})`); failures++;
  } else console.log(`OK: ${label}`);
}

/* ── isFixUsable — 정확도 게이팅 ── */
assertTrue(isFixUsable(10), '정확도 10m(양호) → 사용 가능');
assertTrue(isFixUsable(25), '정확도 25m(경계값) → 사용 가능');
assertTrue(!isFixUsable(30), '정확도 30m(기준 초과) → 사용 불가');
assertTrue(!isFixUsable(150), '정확도 150m(저정밀 도시 픽스) → 사용 불가');
assertTrue(isFixUsable(null), '정확도 정보 없음(구형 브라우저) → 보수적으로 사용 가능 처리');
assertTrue(isFixUsable(undefined), '정확도 undefined → 사용 가능 처리');

/* ── estimateGForceFromDelta — 기본 동작 ── */
const prev = { speedKmh: 60, t: 1000, accuracyM: 10 };
const curr = { speedKmh: 30, t: 2000, accuracyM: 10 }; // 1초간 30km/h 감속
const g1 = estimateGForceFromDelta(prev, curr);
// dv = -30km/h = -8.333m/s, dt=1s → a = -8.333 m/s^2 → g ≈ -0.85
assertClose(g1, -0.85, 0.05, '1초간 30km/h 감속 → 약 -0.85g');

/* ── estimateGForceFromDelta — 실제 취득 시각 사용이 왜 중요한가 (v1.1 핵심 회귀 테스트) ──
   구버전 버그: 캐시된(20초 전) 픽스인데도 호출 시각(Date.now())을 델타에 썼다.
   → 실제로는 20초에 걸친 완만한 감속인데 "1초 만에" 벌어진 것처럼 계산해
   g값이 20배 부풀려졌다. v1.1은 반드시 pos.timestamp(실제 취득 시각)를
   받으므로, 같은 20초짜리 변화가 완만한 g로 정확히 계산되어야 한다. */
const prevReal = { speedKmh: 60, t: 0, accuracyM: 10 };
const currRealSlow = { speedKmh: 50, t: 4000, accuracyM: 10 }; // 실제로는 4초에 걸친 완만한 감속
const gSlow = estimateGForceFromDelta(prevReal, currRealSlow);
// dv=-10km/h=-2.78m/s, dt=4s → a≈-0.69m/s² → g≈-0.071 — 급제동(≤-0.35g)과는 거리가 멀다.
// v1.0 버그였다면 캐시된 픽스에 Date.now()를 썼을 때 dt가 훨씬 짧게(예: 0.1초) 잡혀
// 같은 dv가 g≈-2.8처럼 극단적으로 부풀려질 수 있었다 — v1.1은 실제 취득 시각(t)을
// 그대로 받으므로 이런 왜곡 없이 완만한 값 그대로 계산된다.
assertClose(gSlow, -0.071, 0.01, '실제 취득 시각(4초 간격) 사용 시 완만한 감속이 왜곡 없이 계산됨(급제동 아님)');
assertTrue(gSlow > HARD_BRAKE_THRESHOLD_G_FOR_TEST(), '4초에 걸친 완만한 감속은 급제동 임계치를 넘지 않아야 함');

/* ── estimateGForceFromDelta — 정확도 게이팅이 계산 자체를 막는지 ── */
const badPrev = { speedKmh: 60, t: 1000, accuracyM: 200 }; // 저정밀 픽스
assertNull(estimateGForceFromDelta(badPrev, curr), '이전 픽스가 저정밀(200m)이면 계산하지 않고 null');
const badCurr = { speedKmh: 30, t: 2000, accuracyM: 200 };
assertNull(estimateGForceFromDelta(prev, badCurr), '현재 픽스가 저정밀(200m)이면 계산하지 않고 null');

/* ── estimateGForceFromDelta — 간격/역행 방어 ── */
assertNull(estimateGForceFromDelta(prev, { speedKmh: 30, t: 500, accuracyM: 10 }), 'currFix가 prevFix보다 과거 시각(역행) → null');
assertNull(estimateGForceFromDelta(prev, { speedKmh: 30, t: 7000, accuracyM: 10 }), '간격이 5초 초과(6초) → 신뢰 불가로 null');
assertNull(estimateGForceFromDelta(null, curr), 'prevFix가 없으면(첫 픽스) null');

console.log(failures === 0 ? '\n✅ 전체 통과' : `\n❌ ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);

// 테스트 파일 내부 헬퍼 — 모듈이 HARD_BRAKE_THRESHOLD_G를 export하지 않으므로
// (내부 상수 유지 원칙, §5 재조정 예정) 테스트에서만 같은 값을 하드코딩해 비교한다.
function HARD_BRAKE_THRESHOLD_G_FOR_TEST() { return -0.35; }
