import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

describe('traffic/desktop.html — callAI() 폴백 수정 확인', () => {
  let dom, requests;

  function setup(primaryFails) {
    requests = [];
    dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: 'outside-only', url: 'https://traffic.hondi.net/desktop.html' });
    dom.window.fetch = async (url, opts) => {
      const u = String(url);
      requests.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/ai/chat')) {
        if (primaryFails) return { ok: false, status: 500 };
        return { ok: true, json: async () => ({ content: '1차 경로 정상 응답' }) };
      }
      if (u.includes('/chat/completions')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: '폴백 경로 응답' } }] }) };
      }
      throw new Error('예상치 못한 fetch: ' + u);
    };

    const html = fs.readFileSync(new URL('../desktop.html', import.meta.url), 'utf-8');
    const lines = html.split('\n');
    const proxyLine = lines.findIndex(l => l.startsWith('const PROXY_URL'));
    const start = lines.findIndex(l => l.startsWith('async function callAI'));
    const end   = lines.findIndex((l, i) => i > start && l.trim() === '}' && lines[i+1]?.trim() === '');
    if (proxyLine < 0 || start < 0 || end < 0) throw new Error('desktop.html 구조가 바뀌어 대상 코드를 못 찾음');
    const snippet = [lines[proxyLine], 'const SYS = "테스트 시스템 프롬프트";', ...lines.slice(start, end + 1)].join('\n');
    dom.window.eval(snippet);
  }

  after(() => { dom?.window.close(); });

  test('취약점 수정 확인: api.anthropic.com을 실제로 호출하는 코드가 없다', () => {
    const html = fs.readFileSync(new URL('../desktop.html', import.meta.url), 'utf-8');
    assert.equal(/fetch\(\s*['"]https:\/\/api\.anthropic\.com/.test(html), false);
  });

  test('1차 경로 정상이면 폴백은 아예 호출되지 않는다', async () => {
    setup(false);
    const result = await dom.window.callAI([{ role: 'user', content: '질문' }]);
    assert.equal(result, '1차 경로 정상 응답');
    assert.equal(requests.length, 1);
  });

  test('1차 경로 실패 시 폴백(/chat/completions)이 실제로 응답을 반환한다(이전엔 폴백도 항상 실패)', async () => {
    setup(true);
    const result = await dom.window.callAI([{ role: 'user', content: '질문' }]);
    assert.equal(result, '폴백 경로 응답');
    const fallbackReq = requests.find(r => r.url.includes('/chat/completions'));
    assert.ok(fallbackReq);
    assert.equal(fallbackReq.body.messages[0].role, 'system');
  });
});
