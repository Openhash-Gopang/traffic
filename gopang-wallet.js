/**
 * gopang-wallet.js — Gopang 클라이언트 지갑 공통 모듈
 * Version  : 1.0.0
 * Spec     : GDUDA 5-Layer / OpenHash L1
 * Crypto   : Web Crypto API (Ed25519) — 외부 의존 없음
 * Storage  : 개인키 → IndexedDB (AES-GCM 암호화) + localStorage 폴백
 * 사용법   : <script src="gopang-wallet.js"></script>
 *             const wallet = await GopangWallet.load();
 */

'use strict';

(function (global) {

  /* ────────────────────────────────────────────────
   *  상수
   * ──────────────────────────────────────────────── */
  const VERSION        = '1.0.0';
  const IDB_NAME       = 'gopang-wallet';
  const IDB_STORE      = 'keys';
  const IDB_KEY_ID     = 'ed25519-main';
  const LS_PUBKEY      = 'gopang_wallet_pubkey';
  const LS_HANDLE      = 'gopang_wallet_handle';
  const SUPABASE_URL   = 'https://ebbecjfrwaswbdybbgiu.supabase.co';
  const WORKER_URL     = 'https://hondi-proxy.tensor-city.workers.dev';

  /* ────────────────────────────────────────────────
   *  유틸리티
   * ──────────────────────────────────────────────── */

  /** ArrayBuffer → Base64URL */
  function bufToB64u(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /** Base64URL → Uint8Array */
  function b64uToBuf(b64u) {
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  /** Uint8Array → Hex */
  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** 현재 Unix 타임스탬프 (초) */
  function nowSec() { return Math.floor(Date.now() / 1000); }

  /** SHA-256 해시 → ArrayBuffer */
  async function sha256(data) {
    const buf = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data;
    return crypto.subtle.digest('SHA-256', buf);
  }

  /** nickname_hash 생성 — SHA-256("ko:닉네임") → hex */
  async function nicknameHash(nickname, lang = 'ko') {
    const raw = `${lang}:${nickname}`;
    const buf = await sha256(raw);
    return bufToHex(buf);
  }

  /* ────────────────────────────────────────────────
   *  IndexedDB 헬퍼
   * ──────────────────────────────────────────────── */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = e  => reject(e.target.error);
    });
  }

  async function idbDel(db, key) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = e  => reject(e.target.error);
    });
  }

  /* ────────────────────────────────────────────────
   *  AES-GCM 래퍼 — 개인키 암호화 저장용
   *  passphrase 없이 사용 시 기기 고유 entropy로 대체
   * ──────────────────────────────────────────────── */

  async function deriveAesKey(passphrase, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase),
      'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async function encryptPrivKey(privKeyBuf, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const aes  = await deriveAesKey(passphrase, salt);
    const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, privKeyBuf);
    // 저장 포맷: salt(16) + iv(12) + ciphertext
    const out  = new Uint8Array(16 + 12 + enc.byteLength);
    out.set(salt, 0);
    out.set(iv,   16);
    out.set(new Uint8Array(enc), 28);
    return out.buffer;
  }

  async function decryptPrivKey(encBuf, passphrase) {
    const data   = new Uint8Array(encBuf);
    const salt   = data.slice(0, 16);
    const iv     = data.slice(16, 28);
    const cipher = data.slice(28);
    const aes    = await deriveAesKey(passphrase, salt);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, cipher);
  }

  /* ────────────────────────────────────────────────
   *  Ed25519 키페어 생성 및 관리
   * ──────────────────────────────────────────────── */

  /**
   * 새 Ed25519 키페어 생성
   * @returns {{ publicKeyB64u, privateKeyB64u, publicKeyRaw }}
   */
  async function generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,         // extractable
      ['sign', 'verify']
    );

    const pubRaw  = await crypto.subtle.exportKey('raw',  keyPair.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk',  keyPair.privateKey);
    // JWK d 값이 실질적 private scalar
    const privRaw = b64uToBuf(privJwk.d);

    return {
      publicKey    : keyPair.publicKey,
      privateKey   : keyPair.privateKey,
      publicKeyB64u: bufToB64u(pubRaw),
      publicKeyHex : bufToHex(pubRaw),
      privateKeyB64u: privJwk.d,  // JWK d (Base64URL)
    };
  }

  /**
   * Ed25519 서명
   * @param {CryptoKey} privateKey
   * @param {string|ArrayBuffer} payload  — 문자열이면 UTF-8 인코딩
   * @returns {string} Base64URL 서명
   */
  async function sign(privateKey, payload) {
    const data = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload;
    const sig = await crypto.subtle.sign('Ed25519', privateKey, data);
    return bufToB64u(sig);
  }

  /**
   * Ed25519 서명 검증
   * @param {string} publicKeyB64u  — Base64URL 공개키
   * @param {string|ArrayBuffer} payload
   * @param {string} signatureB64u  — Base64URL 서명
   * @returns {boolean}
   */
  async function verify(publicKeyB64u, payload, signatureB64u) {
    const pubKey = await crypto.subtle.importKey(
      'raw', b64uToBuf(publicKeyB64u),
      { name: 'Ed25519' }, false, ['verify']
    );
    const data = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload;
    const sig = b64uToBuf(signatureB64u);
    return crypto.subtle.verify('Ed25519', pubKey, sig, data);
  }

  /* ────────────────────────────────────────────────
   *  TX (Transaction) 빌더
   * ──────────────────────────────────────────────── */

  /**
   * 서명된 TX 객체 생성
   *
   * TX 구조:
   * {
   *   version   : 1,
   *   type      : 'USER_REGISTER' | 'GDC_TRANSFER' | 'BIZ_ORDER' | ...,
   *   from_guid : string (IPv6 형식),
   *   to_guid   : string | null,
   *   amount    : number | null,
   *   payload   : object (자유 형식),
   *   timestamp : number (Unix 초),
   *   nonce     : string (hex-16),
   *   signature : string (Base64URL, Ed25519)
   *   pubkey    : string (Base64URL, 공개키)
   * }
   */
  async function buildTx(privateKey, pubKeyB64u, fromGuid, txType, payload, opts = {}) {
    const nonce = bufToHex(crypto.getRandomValues(new Uint8Array(8)));
    const ts    = nowSec();

    const body = {
      version  : 1,
      type     : txType,
      from_guid: fromGuid,
      to_guid  : opts.toGuid   ?? null,
      amount   : opts.amount   ?? null,
      payload,
      timestamp: ts,
      nonce,
      pubkey   : pubKeyB64u,
    };

    // 서명 대상: JSON 직렬화 (signature 키 제외)
    const sigTarget = JSON.stringify(body);
    const signature = await sign(privateKey, sigTarget);

    return { ...body, signature };
  }

  /* ────────────────────────────────────────────────
   *  GopangWallet 클래스
   * ──────────────────────────────────────────────── */

  class GopangWallet {

    constructor({ publicKey, privateKey, publicKeyB64u, publicKeyHex, handle, guid }) {
      this._pubKey     = publicKey;
      this._privKey    = privateKey;
      this.publicKeyB64u = publicKeyB64u;
      this.publicKeyHex  = publicKeyHex;
      this.handle      = handle ?? null;   // @닉네임#태그
      this.guid        = guid   ?? null;   // user_profiles.current_ipv6
    }

    /* ── 서명 ── */
    async sign(payload) {
      return sign(this._privKey, payload);
    }

    /* ── TX 생성 ── */
    async buildTx(txType, payload, opts = {}) {
      if (!this.guid) throw new Error('wallet: guid(IPv6)가 설정되지 않았습니다.');
      return buildTx(this._privKey, this.publicKeyB64u, this.guid, txType, payload, opts);
    }

    /* ── 공개키로 서명 검증 (정적으로도 호출 가능) ── */
    async verify(payload, signatureB64u) {
      return verify(this.publicKeyB64u, payload, signatureB64u);
    }

    /* ── handle / guid 설정 ── */
    setIdentity({ handle, guid }) {
      if (handle) {
        this.handle = handle;
        localStorage.setItem(LS_HANDLE, handle);
      }
      if (guid) this.guid = guid;
    }

    /* ── Supabase 공개키 등록 (Worker 경유) ── */
    async registerPublicKey(anonKey) {
      if (!this.guid) throw new Error('wallet: guid가 없습니다.');
      const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?current_ipv6=eq.${this.guid}`, {
        method : 'PATCH',
        headers: {
          'Content-Type' : 'application/json',
          'apikey'       : anonKey,
          'Authorization': `Bearer ${anonKey}`,
          'Prefer'       : 'return=minimal',
        },
        body: JSON.stringify({ pubkey_ed25519: this.publicKeyB64u }),
      });
      if (!res.ok) throw new Error(`공개키 등록 실패: ${res.status}`);
      return true;
    }

    /* ── 지갑 정보 요약 ── */
    summary() {
      return {
        version  : VERSION,
        handle   : this.handle,
        guid     : this.guid,
        pubkey   : this.publicKeyB64u,
        pubkeyHex: this.publicKeyHex,
      };
    }

    /* ──────────────────────────────────────────────
     *  정적 메서드: 지갑 생성 / 로드 / 삭제
     * ────────────────────────────────────────────── */

    /**
     * 새 지갑 생성 후 IndexedDB에 저장
     * @param {string} [passphrase='']  — 빈 문자열이면 기기 고유 entropy 사용
     * @returns {GopangWallet}
     */
    static async create(passphrase = '') {
      const kp  = await generateKeyPair();
      const enc = await encryptPrivKey(
        b64uToBuf(kp.privateKeyB64u).buffer,
        passphrase || await GopangWallet._deviceEntropy()
      );

      const record = {
        publicKeyB64u : kp.publicKeyB64u,
        publicKeyHex  : kp.publicKeyHex,
        encPrivKey    : bufToB64u(enc),   // AES-GCM 암호화된 개인키
        createdAt     : nowSec(),
      };

      const db = await openDB();
      await idbPut(db, IDB_KEY_ID, record);
      localStorage.setItem(LS_PUBKEY, kp.publicKeyB64u);

      return new GopangWallet({
        publicKey   : kp.publicKey,
        privateKey  : kp.privateKey,
        publicKeyB64u: kp.publicKeyB64u,
        publicKeyHex : kp.publicKeyHex,
        handle      : localStorage.getItem(LS_HANDLE),
        guid        : null,
      });
    }

    /**
     * 저장된 지갑 로드
     * @param {string} [passphrase='']
     * @returns {GopangWallet|null}  — 지갑 없으면 null
     */
    static async load(passphrase = '') {
      try {
        const db     = await openDB();
        const record = await idbGet(db, IDB_KEY_ID);
        if (!record) return null;

        const encBuf = b64uToBuf(record.encPrivKey).buffer;
        const privRaw = await decryptPrivKey(
          encBuf,
          passphrase || await GopangWallet._deviceEntropy()
        );

        // JWK 형식으로 복원
        const privJwk = {
          kty: 'OKP', crv: 'Ed25519',
          x  : record.publicKeyB64u,
          d  : bufToB64u(privRaw),
          key_ops: ['sign'],
        };
        const privKey = await crypto.subtle.importKey(
          'jwk', privJwk, { name: 'Ed25519' }, false, ['sign']
        );
        const pubRaw  = b64uToBuf(record.publicKeyB64u);
        const pubKey  = await crypto.subtle.importKey(
          'raw', pubRaw, { name: 'Ed25519' }, false, ['verify']
        );

        return new GopangWallet({
          publicKey    : pubKey,
          privateKey   : privKey,
          publicKeyB64u: record.publicKeyB64u,
          publicKeyHex : record.publicKeyHex,
          handle       : localStorage.getItem(LS_HANDLE),
          guid         : null,
        });
      } catch (e) {
        console.error('[GopangWallet] load 실패:', e);
        return null;
      }
    }

    /**
     * 지갑 존재 여부 확인 (복호화 없이)
     */
    static async exists() {
      try {
        const db = await openDB();
        const r  = await idbGet(db, IDB_KEY_ID);
        return !!r;
      } catch { return false; }
    }

    /**
     * 지갑 삭제 (초기화)
     */
    static async destroy() {
      const db = await openDB();
      await idbDel(db, IDB_KEY_ID);
      localStorage.removeItem(LS_PUBKEY);
      localStorage.removeItem(LS_HANDLE);
    }

    /**
     * 백업용 개인키 내보내기 (Base64URL)
     * 사용자가 직접 안전한 곳에 보관해야 함
     */
    async exportPrivateKey() {
      const jwk = await crypto.subtle.exportKey('jwk', this._privKey);
      return jwk.d; // Base64URL
    }

    /**
     * 백업에서 복원 (개인키 Base64URL + 공개키 Base64URL)
     */
    static async importFromBackup(privKeyB64u, pubKeyB64u, passphrase = '') {
      const privJwk = {
        kty: 'OKP', crv: 'Ed25519',
        x  : pubKeyB64u,
        d  : privKeyB64u,
        key_ops: ['sign'],
      };
      const privKey = await crypto.subtle.importKey(
        'jwk', privJwk, { name: 'Ed25519' }, true, ['sign']
      );
      const pubRaw  = b64uToBuf(pubKeyB64u);
      const pubKey  = await crypto.subtle.importKey(
        'raw', pubRaw, { name: 'Ed25519' }, false, ['verify']
      );
      const pubHex  = bufToHex(pubRaw);

      const enc = await encryptPrivKey(
        b64uToBuf(privKeyB64u).buffer,
        passphrase || await GopangWallet._deviceEntropy()
      );
      const record = {
        publicKeyB64u: pubKeyB64u,
        publicKeyHex : pubHex,
        encPrivKey   : bufToB64u(enc),
        createdAt    : nowSec(),
      };
      const db = await openDB();
      await idbPut(db, IDB_KEY_ID, record);
      localStorage.setItem(LS_PUBKEY, pubKeyB64u);

      return new GopangWallet({
        publicKey    : pubKey,
        privateKey   : privKey,
        publicKeyB64u: pubKeyB64u,
        publicKeyHex : pubHex,
        handle       : localStorage.getItem(LS_HANDLE),
        guid         : null,
      });
    }

    /* ── 내부: 기기 고유 entropy (passphrase 미사용 시 대체) ── */
    static async _deviceEntropy() {
      // UserAgent + 고정 salt → SHA-256 → hex
      // 동일 기기+브라우저면 동일값, 완벽한 보안이 아님
      // 프로덕션에서는 사용자 passphrase 권장
      const raw = navigator.userAgent + 'gopang-wallet-v1-entropy';
      const buf = await sha256(raw);
      return bufToHex(buf);
    }

    /* ── 정적 유틸 노출 ── */
    static nicknameHash(nickname, lang) { return nicknameHash(nickname, lang); }
    static verify(publicKeyB64u, payload, signatureB64u) {
      return verify(publicKeyB64u, payload, signatureB64u);
    }
    static bufToB64u(buf)     { return bufToB64u(buf); }
    static b64uToBuf(b64u)    { return b64uToBuf(b64u); }
    static bufToHex(buf)      { return bufToHex(buf); }
  }

  /* ────────────────────────────────────────────────
   *  TX 타입 상수 (전체 Gopang 공통)
   * ──────────────────────────────────────────────── */
  GopangWallet.TX = Object.freeze({
    USER_REGISTER      : 'USER_REGISTER',
    GDC_TRANSFER       : 'GDC_TRANSFER',
    BIZ_ORDER          : 'BIZ_ORDER',
    BIZ_ORDER_CANCEL   : 'BIZ_ORDER_CANCEL',
    BIZ_REVIEW         : 'BIZ_REVIEW',
    BIZ_PRODUCT_UPSERT : 'BIZ_PRODUCT_UPSERT',
    PDV_CONSENT        : 'PDV_CONSENT',
    PDV_REVOKE         : 'PDV_REVOKE',
  });

  GopangWallet.VERSION = VERSION;

  /* ────────────────────────────────────────────────
   *  전역 노출
   * ──────────────────────────────────────────────── */
  global.GopangWallet = GopangWallet;

  // ESM 환경 대응
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GopangWallet;
  }

})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ====================================================
 * 사용 예시 (주석)
 * ====================================================
 *
 * // 1) 최초 지갑 생성
 * const wallet = await GopangWallet.create();          // passphrase 없이
 * const wallet = await GopangWallet.create('비밀번호'); // passphrase 지정
 *
 * // 2) 기존 지갑 로드
 * const wallet = await GopangWallet.load();
 * if (!wallet) { // 지갑 없음 → 생성 필요 }
 *
 * // 3) 신원 연결 (로그인 후)
 * wallet.setIdentity({ handle: '@보영반점#1234', guid: '2001:db8::1' });
 *
 * // 4) 서명된 TX 생성
 * const tx = await wallet.buildTx(GopangWallet.TX.BIZ_ORDER, {
 *   product_id: 'prod-001',
 *   quantity  : 2,
 * }, { toGuid: '2001:db8::seller', amount: 15000 });
 *
 * // 5) Worker에 TX 전송
 * await fetch('https://hondi-proxy.tensor-city.workers.dev/biz/order', {
 *   method : 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body   : JSON.stringify(tx),
 * });
 *
 * // 6) 서명 검증 (Worker / 수신 측)
 * const sigTarget = JSON.stringify({ ...tx, signature: undefined });  // signature 제외
 * const ok = await GopangWallet.verify(tx.pubkey, sigTarget, tx.signature);
 *
 * // 7) nickname_hash 생성
 * const hash = await GopangWallet.nicknameHash('보영반점'); // SHA-256("ko:보영반점")
 *
 * // 8) 개인키 백업 / 복원
 * const privB64u = await wallet.exportPrivateKey();
 * const restored = await GopangWallet.importFromBackup(privB64u, wallet.publicKeyB64u);
 *
 * ==================================================== */
