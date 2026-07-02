// ══════════════════════════════════════════════════════════════
// gopang-proxy Worker — /kakao/appkey 엔드포인트 패치
// 기존 Worker 코드의 라우터에 아래 케이스를 추가하세요.
//
// 환경변수: KAKAO_REST_KEY (이미 Cloudflare Dashboard에 설정됨)
//
// 주의: Kakao Maps JavaScript SDK는 "JavaScript 앱 키"를 사용합니다.
//       Cloudflare에 등록된 KAKAO_REST_KEY가 REST API 키라면,
//       Kakao Developers에서 JavaScript 키를 별도 확인 후
//       KAKAO_JS_KEY 라는 이름으로 추가 등록하는 것을 권장합니다.
//       (REST 키와 JS 키는 동일 앱에서 다른 값입니다.)
// ══════════════════════════════════════════════════════════════

// ── 기존 Worker fetch 핸들러의 라우터에 추가할 케이스 ──
//
// if (url.pathname === '/kakao/appkey') {
//   return handleKakaoAppKey(request, env);
// }

/**
 * GET /kakao/appkey
 * 
 * Kakao Maps JavaScript SDK를 동적으로 로드하기 위한
 * 앱 키를 반환합니다. CORS 포함.
 *
 * 응답 예시:
 * { "appkey": "abcdef1234567890..." }
 */
async function handleKakaoAppKey(request, env) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // GET only
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // KAKAO_REST_KEY 또는 KAKAO_JS_KEY 사용
  // (Kakao Maps JS SDK는 JavaScript 앱 키 필요)
  const appkey = env.KAKAO_JS_KEY || env.KAKAO_REST_KEY;

  if (!appkey) {
    return new Response(JSON.stringify({ error: 'Kakao API key not configured' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return new Response(JSON.stringify({ appkey }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // 5분 캐시 (키는 잘 변경되지 않음)
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ══════════════════════════════════════════════════════════════
// 전체 Worker 예시 구조 (기존 코드에 통합하는 방법)
// ══════════════════════════════════════════════════════════════
/*
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 공통 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── 기존 라우트들 ──
    // if (url.pathname === '/pdv/report') { ... }
    // if (url.pathname === '/auth/...')   { ... }

    // ── 신규: Kakao 앱 키 엔드포인트 ──
    if (url.pathname === '/kakao/appkey') {
      return handleKakaoAppKey(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};
*/


// ══════════════════════════════════════════════════════════════
// /ai/chat 엔드포인트 — DeepSeek V3 Pro + Anthropic 폴백
// 기존 Worker 라우터에 추가:
// if (url.pathname === '/ai/chat') return handleAIChat(request, env);
// ══════════════════════════════════════════════════════════════

async function handleAIChat(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }});
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { provider = 'deepseek', model, system, messages, max_tokens = 2000 } = body;

  const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    if (provider === 'deepseek') {
      // DeepSeek V3 Pro API
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: model || 'deepseek-chat',
          max_tokens,
          messages: [
            { role: 'system', content: system },
            ...messages,
          ],
        }),
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 응답 없음: ' + JSON.stringify(data));
      return new Response(JSON.stringify({ content, provider: 'deepseek' }), { headers: CORS });

    } else {
      // Anthropic Claude 폴백
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY || env.OpenAI,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens,
          system,
          messages,
        }),
      });
      const data = await res.json();
      const content = data.content?.find(c => c.type === 'text')?.text;
      return new Response(JSON.stringify({ content, provider: 'anthropic' }), { headers: CORS });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}


// ══════════════════════════════════════════════════════════════
// CORS 수정 패치
// 문제: Access-Control-Allow-Origin 헤더가 'null'로 반환됨
//
// 원인: 요청 Origin이 없거나 Worker에서 '*' 대신 req Origin을
//       그대로 반영하다가 null이 되는 케이스
//
// 수정: 모든 응답에 아래 corsHeaders를 공통 적용
// ══════════════════════════════════════════════════════════════

// Worker fetch 핸들러 최상단에 추가할 CORS 헬퍼
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  // 허용 도메인 화이트리스트 (필요 시 추가)
  const allowed = [
    'https://traffic.hondi.net',
    'https://health.hondi.net',
    'https://hondi.net',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const allowOrigin = allowed.includes(origin) ? origin : '*';

  return {
    'Access-Control-Allow-Origin':  allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

// 모든 핸들러 함수의 Response 생성 시 이렇게 적용:
//
//   return new Response(JSON.stringify(data), {
//     status: 200,
//     headers: {
//       'Content-Type': 'application/json',
//       ...getCorsHeaders(request),   // ← 이 한 줄 추가
//     },
//   });
//
// OPTIONS preflight는 fetch 핸들러 최상단에서 처리:
//
//   if (request.method === 'OPTIONS') {
//     return new Response(null, {
//       status: 204,
//       headers: getCorsHeaders(request),
//     });
//   }
