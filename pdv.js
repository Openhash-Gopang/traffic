/**
 * pdv.js — K-Traffic PDV 기록 모듈 v2.0
 * gopang-proxy /pdv/report 엔드포인트 연동
 * school/report.js 의 sendToPDV() 패턴 준수
 */

const PROXY   = 'https://gopang-proxy.tensor-city.workers.dev';
const SVC_ID  = 'traffic'; // K-Health는 'health'로 변경
const PDV_VER = '1.0';

function _getUserIpv6() {
  try {
    const s = JSON.parse(sessionStorage.getItem('gopang_sso_token') || 'null');
    return s?.ipv6 || 'anonymous';
  } catch { return 'anonymous'; }
}

async function _hashReport(obj) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify(obj))
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

async function _sendToPDV(reportPayload) {
  try {
    const res = await fetch(`${PROXY}/pdv/report`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ report: reportPayload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `PDV HTTP ${res.status}`);
    }
    const ack = await res.json();
    console.info('[K-Traffic PDV] 기록 완료:', ack.pdv_entry);
    return ack;
  } catch(e) {
    console.warn('[K-Traffic PDV] 전송 실패 (로컬 백업):', e.message);
    _localBackup(reportPayload);
    return null;
  }
}

function _localBackup(payload) {
  try {
    const key  = 'ktraffic_pdv_pending';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push({ payload, failedAt: new Date().toISOString() });
    if (list.length > 200) list.splice(0, list.length - 200);
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

async function _flushPending() {
  try {
    const key  = 'ktraffic_pdv_pending';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (!list.length) return;
    const failed = [];
    for (const item of list) {
      const ack = await _sendToPDV(item.payload);
      if (!ack) failed.push(item);
    }
    localStorage.setItem(key, JSON.stringify(failed));
  } catch {}
}

// ═══════════════════════════════════════════════════════════
const PDV = {

  /**
   * 이동 요청 기록
   * @param {object} opts — { from, to, passengers, vehicleType, estimatedGdc }
   */
  async writeRideRequest({ from = '', to = '', passengers = 1, vehicleType = '', estimatedGdc = 0 } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-req-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_ride_request',
      id,
      content_hash: await _hashReport({ id, from, to, now }),
      who:  { ipv6, role: 'passenger', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: from },
      what: {
        summary:       `이동 요청: ${from} → ${to}`,
        from, to, passengers,
        vehicle_type:  vehicleType,
        estimated_gdc: estimatedGdc,
      },
      how:  { method: 'K-Traffic AI 동선 겹침 매칭' },
      why:  { goal: '최적 교통 수단 연결', triggered: 'traffic_ride_request' },
    });
  },

  /**
   * 탑승 시작 기록 (신원 상호 확인 후)
   * @param {object} opts — { from, to, driverIpv6, vehicleNo, confirmedGdc }
   */
  async writeRideStart({ from = '', to = '', driverIpv6 = '', vehicleNo = '', confirmedGdc = 0 } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-start-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_ride_start',
      id,
      content_hash: await _hashReport({ id, from, to, driverIpv6, vehicleNo, now }),
      who: {
        ipv6,
        role:         'passenger',
        counterparty: driverIpv6,  // 운전자 신원 상호 기록
        recipients:   ['gopang-pdv'],
      },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: from },
      what: {
        summary:       `탑승 시작: ${from} → ${to} | 차량 ${vehicleNo}`,
        from, to,
        vehicle_no:    vehicleNo,
        driver_ipv6:   driverIpv6,
        confirmed_gdc: confirmedGdc,
      },
      how:  { method: 'PDV 신원 상호 확인 후 탑승 + 실시간 경로 기록' },
      why:  { goal: '이동 기록 보관 및 범죄·분쟁 예방', triggered: 'traffic_ride_start' },
    });
  },

  /**
   * 탑승 완료 + GDC 결제 기록
   * @param {object} opts — { from, to, driverIpv6, vehicleNo, gdc, rideId, durationMin }
   */
  async writeRideEnd({ from = '', to = '', driverIpv6 = '', vehicleNo = '', gdc = 0, rideId = '', durationMin = 0 } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-end-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_ride_end',
      id,
      content_hash: await _hashReport({ id, rideId, gdc, now }),
      who: {
        ipv6,
        role:         'passenger',
        counterparty: driverIpv6,
        recipients:   ['gopang-pdv'],
      },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: to },
      what: {
        summary:      `탑승 완료: ${from} → ${to} | ${gdc} GDC 결제`,
        from, to,
        vehicle_no:   vehicleNo,
        driver_ipv6:  driverIpv6,
        gdc_paid:     gdc,
        ride_id:      rideId,
        duration_min: durationMin,
      },
      how:  { method: '목적지 도착 확인 → GDC 자동 이체 → PDV 양측 기록' },
      why:  { goal: 'GDC 결제 증거 보관 및 분쟁 사전 예방', triggered: 'traffic_ride_end' },
    });
  },

  /**
   * 물류·배송 기록
   * @param {object} opts — { pickupAddr, deliveryAddr, cargoDesc, gdc, deliveryId }
   */
  async writeDelivery({ pickupAddr = '', deliveryAddr = '', cargoDesc = '', gdc = 0, deliveryId = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-delivery-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_delivery',
      id,
      content_hash: await _hashReport({ id, deliveryId, gdc, now }),
      who:  { ipv6, role: 'shipper', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: pickupAddr },
      what: {
        summary:       `배송: ${pickupAddr} → ${deliveryAddr} | ${cargoDesc}`,
        pickup:        pickupAddr,
        delivery:      deliveryAddr,
        cargo:         cargoDesc,
        gdc_paid:      gdc,
        delivery_id:   deliveryId,
      },
      how:  { method: 'K-Traffic AI 화물 차량 매칭 + GDC 자동 결제' },
      why:  { goal: '물류 기록 보관', triggered: 'traffic_delivery' },
    });
  },

  /**
   * 상호 평가 기록
   * @param {object} opts — { targetIpv6, targetRole, score, comment, rideId }
   */
  async writeRating({ targetIpv6 = '', targetRole = 'driver', score = 5, comment = '', rideId = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-rating-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_rating',
      id,
      content_hash: await _hashReport({ id, targetIpv6, score, rideId, now }),
      who: {
        ipv6,
        role:         'rater',
        counterparty: targetIpv6,
        recipients:   ['gopang-pdv'],
      },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: 'K-Traffic 평가' },
      what: {
        summary:     `${targetRole} 평가: ${score}점 — ${comment.slice(0,50)}`,
        target_ipv6: targetIpv6,
        target_role: targetRole,
        score, comment,
        ride_id:     rideId,
      },
      how:  { method: 'PDV 기반 위변조 불가 상호 평가' },
      why:  { goal: '신뢰 점수 구축 및 서비스 품질 향상', triggered: 'traffic_rating' },
    });
  },

  /** 긴급 신고 기록 */
  async writeEmergency({ from = '', description = '', vehicleNo = '', driverIpv6 = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-traffic-sos-${Date.now()}`;

    return _sendToPDV({
      svc:          SVC_ID,
      type:         'traffic_emergency',
      id,
      content_hash: await _hashReport({ id, from, vehicleNo, now }),
      who: {
        ipv6,
        role:         'passenger',
        counterparty: driverIpv6,
        recipients:   ['gopang-pdv', '112'],
      },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://traffic.gopang.net', label: from },
      what: {
        summary:     `긴급 신고: ${description}`,
        location:    from,
        vehicle_no:  vehicleNo,
        driver_ipv6: driverIpv6,
        description,
      },
      how:  { method: '긴급 버튼 → 112 자동 연결 + PDV 즉시 기록' },
      why:  { goal: '범죄·사고 증거 보존 및 즉각 대응', triggered: 'traffic_emergency' },
      analysis: { risk_level: 'critical' },
    });
  },


  /**
   * AI 상담 기록 (traffic·health 공통)
   * @param {object} opts — { userMsg, aiMsg, category, svc }
   */
  async writeConsult({ userMsg = '', aiMsg = '', category = 'consult', svc = SVC_ID } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-${svc}-consult-${Date.now()}`;

    return _sendToPDV({
      svc,
      type:         `${svc}_consult`,
      id,
      content_hash: await _hashReport({ id, userMsg, now }),
      who:  { ipv6, role: 'user', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: `https://${svc}.gopang.net`, label: 'AI 상담' },
      what: {
        summary:   `AI 상담 (${category}): ${userMsg.slice(0, 60)}`,
        user_msg:  userMsg,
        ai_msg:    aiMsg,
        category,
      },
      how:  { method: `${svc} AI 채팅` },
      why:  { goal: 'AI 상담 기록 보관', triggered: `${svc}_consult` },
    });
  },

  flushPending: _flushPending,
};

window.addEventListener('load', () => setTimeout(_flushPending, 3000));
window.PDV = PDV;
// window.PDV 로 전역 노출됨 (export 불필요 — 일반 <script> 태그 호환)
