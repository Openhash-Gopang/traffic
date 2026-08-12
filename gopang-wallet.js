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
  const VERSION          = '2.0.0';
  const IDB_NAME         = 'gopang-wallet';
  const IDB_VER          = 3;               // v3.0: hash_chain → anchor_chain (OpenHash 통합)
  const IDB_STORE        = 'keys';           // 개인키·재무상태 저장
  const IDB_STORE_CHAIN  = 'anchor_chain';   // OpenHash 통합 앵커 체인 (v3.0)
  const IDB_KEY_ID       = 'ed25519-main';
  const IDB_X25519_ID    = 'x25519-enc-main';  // 암호화 전용 키페어 (Ed25519와 별도)
  const IDB_FS_KEY       = 'financial_state'; // 로컬 재무제표 키
  const LS_PUBKEY        = 'gopang_wallet_pubkey';
  const LS_X25519_PUBKEY = 'gopang_wallet_x25519_pubkey';
  const LS_HANDLE        = 'gopang_wallet_handle';
  const LS_WEBAUTHN_CRED = 'gopang_wallet_webauthn_cred_id';
  // 2026-07-20 신설 — 고액 거래 재인증(step-up) 전용 credential.
  // LS_WEBAUTHN_CRED(위)는 PRF 확장이 필수인 "로컬 저장소 재암호화"
  // 목적과 강하게 결합돼 있는데, PRF는 기기·브라우저에 따라 미지원인
  // 경우가 실사로 확인됐다(지문 인증 자체는 성공해도 PRF_UNSUPPORTED로
  // enrollWebAuthn()이 실패). 고액 거래 재인증은 서버가 직접 서명을
  // 검증하는 방식이라 PRF가 애초에 필요 없다 — 완전히 독립된 credential
  // 로 분리해, PRF 미지원 기기에서도 재인증만큼은 등록되게 한다.
  const LS_STEPUP_CRED = 'gopang_wallet_stepup_cred_id';
  // 2026-07-28 신설 — _deviceEntropy()가 navigator.userAgent 대신 쓰는
  // 영구 랜덤 비밀값의 저장 키. 자세한 사유는 _deviceEntropy() 주석 참고.
  const LS_DEVICE_SECRET = 'gopang_wallet_device_secret_v2';
  const WEBAUTHN_RP_ID   = 'hondi.net';  // 전체 hondi.net 서브도메인에서 credential 공유
  // PRF는 결정론적 — 동일 salt + 동일 authenticator = 항상 동일 32바이트.
  // 서버에 아무것도 저장할 필요 없음.
  const WEBAUTHN_PRF_SALT = new TextEncoder().encode('gopang-wallet-v1-prf-salt');
  const WORKER_URL       = 'https://hondi-proxy.tensor-city.workers.dev';

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
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const db      = e.target.result;
        const oldVer  = e.oldVersion;
        // v1: keys store
        if (oldVer < 1) db.createObjectStore(IDB_STORE);
        // v2: hash_chain store (구버전 — v3에서 교체)
        if (oldVer < 2) db.createObjectStore('hash_chain', { keyPath: 'height' });
        // v3: anchor_chain (OpenHash 통합 — keyPath: entryHash)
        if (oldVer < 3) {
          if (db.objectStoreNames.contains('hash_chain')) db.deleteObjectStore('hash_chain');
          db.createObjectStore(IDB_STORE_CHAIN, { keyPath: 'entryHash' });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  // hash_chain store 전용 헬퍼
  async function idbChainPut(db, record) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE_CHAIN, 'readwrite');
      const req = tx.objectStore(IDB_STORE_CHAIN).put(record);
      req.onsuccess = () => resolve();
      req.onerror   = e  => reject(e.target.error);
    });
  }

  async function idbChainGetLast(db) {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE_CHAIN, 'readonly');
      const store = tx.objectStore(IDB_STORE_CHAIN);
      // keyPath='entryHash' → getAll 후 recorded_at 기준 최신 조회
      const req   = store.getAll();
      req.onsuccess = e => {
        const all = e.target.result || [];
        if (!all.length) { resolve(null); return; }
        all.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
        resolve(all[0]);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function idbChainGetAll(db) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE_CHAIN, 'readonly');
      const req = tx.objectStore(IDB_STORE_CHAIN).getAll();
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
   *  X25519 암호화 전용 키페어 (Ed25519와 별도)
   *  용도: PC가 입력한 민감정보(API Key 등)를 이 공개키로
   *        봉투 암호화 → Supabase에는 암호문만 저장
   *        복호화는 이 키페어를 보관한 기기(휴대폰)에서만 가능
   * ──────────────────────────────────────────────── */

  /**
   * 새 X25519 키페어 생성 (암호화 전용 — 서명 불가)
   * @returns {{ publicKey, privateKey, publicKeyB64u, privateKeyB64u }}
   */
  async function generateX25519KeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const pubRaw  = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

    return {
      publicKey     : keyPair.publicKey,
      privateKey    : keyPair.privateKey,
      publicKeyB64u : bufToB64u(pubRaw),
      privateKeyB64u: privJwk.d,
    };
  }

  /**
   * ECDH(X25519) 공유키 유도 → AES-GCM 256 CryptoKey
   * @param {CryptoKey} privateKey  — 내 X25519 개인키
   * @param {CryptoKey} peerPublicKey — 상대 X25519 공개키
   */
  async function _deriveSharedAesKey(privateKey, peerPublicKey) {
    return crypto.subtle.deriveKey(
      { name: 'X25519', public: peerPublicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  /**
   * 봉투 암호화 — PC가 휴대폰의 X25519 공개키로 평문을 암호화
   * 송신자(PC)는 매번 임시(ephemeral) 키페어를 새로 생성하므로
   * 송신자 쪽에 개인키를 보관할 필요가 없음 (PC는 거울일 뿐)
   *
   * @param {string} recipientPubKeyB64u — 수신자(휴대폰)의 X25519 공개키
   * @param {string} plaintext
   * @returns {{ ephemeralPubKey, iv, ciphertext }} 전부 Base64URL
   */
  async function sealForRecipient(recipientPubKeyB64u, plaintext) {
    const recipientPubKey = await crypto.subtle.importKey(
      'raw', b64uToBuf(recipientPubKeyB64u),
      { name: 'X25519' }, false, []
    );

    // 송신자(PC) 측 1회용 임시 키페어 — PC에는 절대 저장하지 않음
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'X25519' }, true, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'X25519', public: recipientPubKey },
      ephemeral.privateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt']
    );

    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aesKey,
      new TextEncoder().encode(plaintext)
    );
    const ephemeralPubRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);

    return {
      ephemeralPubKey: bufToB64u(ephemeralPubRaw),
      iv             : bufToB64u(iv),
      ciphertext     : bufToB64u(enc),
    };
  }

  /**
   * 봉투 복호화 — 휴대폰이 자신의 X25519 개인키로 PC가 보낸 암호문을 해독
   * @param {CryptoKey} myPrivateKey
   * @param {{ ephemeralPubKey, iv, ciphertext }} sealed
   * @returns {string} plaintext
   */
  async function openSealed(myPrivateKey, sealed) {
    const ephemeralPubKey = await crypto.subtle.importKey(
      'raw', b64uToBuf(sealed.ephemeralPubKey),
      { name: 'X25519' }, false, []
    );
    const aesKey = await _deriveSharedAesKey(myPrivateKey, ephemeralPubKey);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uToBuf(sealed.iv) },
      aesKey, b64uToBuf(sealed.ciphertext)
    );
    return new TextDecoder().decode(dec);
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
   *  결정적 직렬화 (prev_settle_hash 계산용)
   *  JSON.stringify는 key 순서 비결정적 → 반드시 sortedStringify 사용
   * ──────────────────────────────────────────────── */

  function sortedStringify(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return JSON.stringify(obj);
    }
    const sorted = {};
    Object.keys(obj).sort().forEach(k => {
      sorted[k] = obj[k];
    });
    // 재귀적으로 중첩 객체도 정렬
    return '{' + Object.keys(sorted).map(k =>
      JSON.stringify(k) + ':' + sortedStringify(sorted[k])
    ).join(',') + '}';
  }

  /**
   * 재무 상태 객체 → prev_settle_hash 계산
   * @param {Object} financialState  — { 'bs-cash': 숫자, 'pl-purchase': 숫자, ... }
   * @returns {string} hex SHA-256
   */
  async function computePrevSettleHash(financialState) {
    const canonical = sortedStringify(financialState || {});
    const buf = await sha256(canonical);
    return bufToHex(buf);
  }

  /**
   * UTXO 방식 TX 빌더 — L1 /api/tx 형식
   * gopang-app.js _gwpSignExecute()에서 wallet.buildTxWithPrevHash() 호출
   *
   * @param {Object} opts
   *   opts.buyerGuid       — 구매자 primary_guid
   *   opts.sellerGuid      — 판매자 primary_guid
   *   opts.total           — 합계 (구매자 지불)
   *   opts.sellerNet       — 판매자 순수입 (플랫폼 수수료 제외)
   *   opts.platformFee     — 플랫폼 수수료
   *   opts.financialState  — 현재 재무 상태 객체 (prev_settle_hash 계산용)
   *   opts.items           — 품목 배열
   * @returns {Object} UTXO tx (buyer_sig 제외)
   */
  async function buildTxWithPrevHash({
    buyerGuid, sellerGuid, total, sellerNet, platformFee,
    financialState, items, prevSettleHash,
  }) {
    // prevSettleHash는 호출자(sign → buildPrevSettleHash)가 주입
    // L1 검증 기준: prev_settle_hash === 직전 블록의 content_hash
    const nonce     = bufToHex(crypto.getRandomValues(new Uint8Array(8)));
    const timestamp = nowSec();

    const tx = {
      version: 1,
      input: {
        owner_guid:      buyerGuid,
        prev_settle_hash: prevSettleHash,
        balance_claimed: (financialState?.['bs-cash'] ?? 0),
      },
      outputs: [
        { recipient_guid: sellerGuid,       amount: sellerNet   },
        { recipient_guid: 'gopang-platform', amount: platformFee },
      ],
      items:     items || [],
      nonce,
      timestamp,
    };

    return { tx, prevSettleHash };
  }

  /**
   * tx_hash 계산 후 Ed25519 서명 → buyer_sig 반환
   * @param {CryptoKey} privateKey
   * @param {Object} tx  — buildTxWithPrevHash() 반환값의 tx
   * @returns {{ tx_hash: string, buyer_sig: string }}
   */
  async function signTx(privateKey, tx) {
    const txHash   = bufToHex(await sha256(sortedStringify(tx)));
    const sigBuf   = await crypto.subtle.sign(
      'Ed25519', privateKey, new TextEncoder().encode(txHash)
    );
    const buyerSig = bufToB64u(sigBuf);
    return { tx_hash: txHash, buyer_sig: buyerSig };
  }

  /* ────────────────────────────────────────────────
   *  Hash Chain 관리
   *  h_i = SHA-256(h_{i-1} ∥ tx_hash ∥ block_hash ∥ height)
   * ──────────────────────────────────────────────── */

  /**
   * Hash Chain에 새 항목 추가 (거래 완료 후 호출)
   * @param {IDBDatabase} db
   * @param {Object} opts
   *   opts.prevSettleHash  — 거래 출발 재무 상태 해시
   *   opts.newSettleHash   — 거래 완료 후 재무 상태 해시
   *   opts.txHash          — tx_hash (SHA-256(sortedStringify(tx)))
   *   opts.blockHash       — L1 block_hash
   *   opts.blockId         — L1 block_id
   * @returns {Object} 새 chain record
   */
  async function appendHashChain(db, {
    txHash,
    blockHash,
    blockId      = null,
    pdvSessionId = null,
    pdvType      = null,
  }) {
    // ── v3.0: OpenHash anchor() 위임 (단일 체인 통합) ──────────────────
    // hashChain.js의 anchor()를 통해 단일 앵커 체인에 기록
    // contentHash = SHA-256(txHash + blockHash) — 거래 식별자
    // signatures  = [] → guid fallback (wallet 컨텍스트에서 서명)
    try {
      const { anchor } = await import('./src/openhash/hashChain.js');
      const contentInput = txHash + (blockHash || '');
      const buf         = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contentInput));
      const contentHash = bufToHex(buf);

      // wallet 서명 (this 컨텍스트 없으므로 window.gopangWallet 사용)
      let sig = contentHash;  // fallback
      try {
        if (window.gopangWallet?._privKey) {
          const sigBuf = await crypto.subtle.sign('Ed25519', window.gopangWallet._privKey, new TextEncoder().encode(contentHash));
          sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
        }
      } catch(e) { /* fallback 유지 */ }

      const result = await anchor(contentHash, [sig], pdvSessionId || txHash);

      // anchor_chain store에 저장 (OpenHash 통합 레코드)
      const record = {
        entryHash:     result.entryHash,
        contentHash,
        prevHash:      result.prevHash,
        tx_hash:       txHash,
        block_hash:    blockHash,
        block_id:      blockId,
        layer:         result.layer,
        recorded_at:   new Date().toISOString(),
        pdv_session_id: pdvSessionId,
        pdv_type:      pdvType,
      };
      await idbChainPut(db, record);
      return record;
    } catch(e) {
      console.warn('[Wallet] appendHashChain anchor() 실패, 로컬 기록만:', e.message);
      // fallback: anchor() 실패 시 로컬만 기록
      const contentInput = txHash + (blockHash || '');
      const buf         = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contentInput));
      const contentHash = bufToHex(buf);
      const record = {
        entryHash:     contentHash,
        contentHash,
        prevHash:      '0'.repeat(64),
        tx_hash:       txHash,
        block_hash:    blockHash,
        block_id:      blockId,
        layer:         'local',
        recorded_at:   new Date().toISOString(),
        pdv_session_id: pdvSessionId,
        pdv_type:      pdvType,
      };
      await idbChainPut(db, record);
      return record;
    }
  }

  /* ────────────────────────────────────────────────
   *  GopangWallet 클래스
   * ──────────────────────────────────────────────── */

  class GopangWallet {

    constructor({ publicKey, privateKey, publicKeyB64u, publicKeyHex, handle, guid, x25519PublicKey, x25519PrivateKey, x25519PublicKeyB64u }) {
      this._pubKey     = publicKey;
      this._privKey    = privateKey;
      this.publicKeyB64u = publicKeyB64u;
      this.publicKeyHex  = publicKeyHex;
      this.handle      = handle ?? null;   // @닉네임#태그
      this.guid        = guid   ?? null;   // user_profiles.current_ipv6
      // X25519 암호화 전용 키페어 (Ed25519와 별도 — PC→휴대폰 봉투암호화 수신용)
      this._x25519PrivKey   = x25519PrivateKey ?? null;
      this._x25519PubKey    = x25519PublicKey  ?? null;
      this.x25519PublicKeyB64u = x25519PublicKeyB64u ?? null;
    }

    /* ── 서명 (단순 문자열/바이트 페이로드 — TX 빌드와 무관) ── */
    async signPayload(payload) {
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

    /* ── X25519: 이 지갑(휴대폰)이 PC로부터 받은 봉투를 해독 ── */
    async openSealed(sealed) {
      if (!this._x25519PrivKey)
        throw new Error('wallet: X25519 키페어가 아직 등록되지 않았습니다. ensureX25519Key()를 먼저 호출하세요.');
      return openSealed(this._x25519PrivKey, sealed);
    }

    /* ── X25519 공개키 보유 여부 ── */
    hasX25519Key() {
      return !!this._x25519PubKey;
    }

    /* ── handle / guid 설정 ── */
    setIdentity({ handle, guid }) {
      if (handle) {
        this.handle = handle;
        localStorage.setItem(LS_HANDLE, handle);
      }
      if (guid) this.guid = guid;
    }

    // (2026-07-15 삭제 — registerPublicKey. Supabase user_profiles에
    //  직접 PATCH하던 옛날 방식이고, 지금은 handleProfilePost/
    //  _l1UpsertProfile(L1 기반)이 공개키 등록을 대신한다. gopang·gdc
    //  두 저장소 어디서도 이 메서드를 호출하는 곳이 없었다 — Supabase
    //  완전 폐기의 마지막 잔재라 정리한다.)

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

    /* ────────────────────────────────────────────────
     *  v2.0 인스턴스 메서드
     * ──────────────────────────────────────────────── */

    /**
     * 현재 로컬 재무 상태 조회 (IndexedDB keys store)
     * @returns {Object}  { 'bs-cash': 숫자, ... }
     */
    async getFinancialState() {
      try {
        const db  = await openDB();
        const rec = await idbGet(db, IDB_FS_KEY);
        return rec?.state || {};
      } catch { return {}; }
    }

    /**
     * bs-cash 잔액 조회
     * @returns {number}
     */
    async getBalance() {
      const fs = await this.getFinancialState();
      return parseFloat(fs['bs-cash'] ?? '0') || 0;
    }

    /**
     * prev_settle_hash 반환 — L1 main.pb.js 3단계 검증 기준
     * L1은 prev_settle_hash === 직전 블록의 content_hash 를 검증함.
     * block_hash null = 최초 거래 (L1 블록 없음) → L1이 자체 처리.
     * @returns {{ prevSettleHash: string|null, financialState: Object }}
     */
    async buildPrevSettleHash() {
      const db  = await openDB();
      const rec = await idbGet(db, IDB_FS_KEY);
      const financialState = rec?.state || {};
      const prevSettleHash = rec?.block_hash || null;
      // null = 최초 거래 → L1이 latestBlock 없을 때 검증 건너뜀
      return { prevSettleHash, financialState };
    }

    /**
     * UTXO tx 빌드 + Ed25519 서명 — gopang-app.js _gwpSignExecute()에서 호출
     * GWP_SIGN_REQUEST의 tx 객체를 받아 prev_settle_hash 주입 후 서명
     *
     * @param {Object} rawTx  — GWP_SIGN_REQUEST에서 수신한 tx
     *   rawTx.outputs        — [{ recipient_guid, amount }]
     *   rawTx.items          — 품목 배열
     * @returns {Object} signedTx  — Worker /biz/order POST 본문
     */
    async sign(rawTx) {
      if (!this.guid) throw new Error('[Wallet] guid(IPv6)가 설정되지 않았습니다.');

      const { financialState, prevSettleHash } = await this.buildPrevSettleHash();

      // outputs에서 판매자·플랫폼 분리
      const sellerOut   = rawTx.outputs?.find(o => o.recipient_guid !== 'gopang-platform');
      const platformOut = rawTx.outputs?.find(o => o.recipient_guid === 'gopang-platform');
      const sellerNet   = sellerOut?.amount   || 0;
      const platformFee = platformOut?.amount || 0;

      // UTXO tx 구성 (prev_settle_hash 주입)
      const { tx } = await buildTxWithPrevHash({
        buyerGuid:      this.guid,
        sellerGuid:     sellerOut?.recipient_guid || rawTx.seller_guid || '',
        total:          rawTx.total || sellerNet + platformFee,
        sellerNet,
        platformFee,
        financialState,
        items:          rawTx.items || [],
        prevSettleHash,   // ← block_hash 기반 값 주입
      });

      // tx_hash 계산 + Ed25519 서명
      const { tx_hash, buyer_sig } = await signTx(this._privKey, tx);

      return {
        tx,
        tx_hash,
        buyer_sig,
        buyer_public_key: this.publicKeyB64u,
        prev_settle_hash: prevSettleHash,      // L1 검증용
      };
    }

    /**
     * 2026-07-18 신설 — GDC P2P 이체 (혼디 코드 스캔 → 프로필 → 이체)
     * 새 tx 빌더를 만들지 않고 위의 sign()을 그대로 재사용한다 — outputs에
     * 'gopang-platform' 항목을 안 넣으면 sign() 내부에서 platformFee=0으로
     * 계산돼(sellerOut/platformOut 분리 로직) 결과적으로 수수료 없는 이체가
     * 된다. buildTxWithPrevHash가 항상 2번째 output을 만드는 구조라 금액
     * 0짜리 'gopang-platform' output이 하나 더 붙긴 하지만(원장이 약간
     * 지저분해지는 정도), 검증된 sign() 경로를 그대로 타는 게 새 tx 빌더를
     * 만드는 것보다 안전하다 — 설계문서 §3의 "다음에 개선" 항목으로 남김.
     *
     * @param {Object} opts
     *   opts.toGuid  — 수신자 GUID (스캔된 프로필에서 확보)
     *   opts.amount  — 이체 금액(₮)
     *   opts.memo    — purpose='purchase'면 필수(품목명), 'transfer'면 선택
     *   opts.purpose — 'transfer'(단순송금, 기본값) | 'purchase'(재화·용역 대금)
     *                  — 2026-07-18 GDC 상거래 완성 계획서 Phase 1. 서버가
     *                  최종 강제하지만(worker.js handleGdcTransfer), 클라도
     *                  먼저 걸러서 불필요한 왕복을 줄인다.
     * @returns {Object} L1 응답 (block_hash, height, seller_claim 등)
     */
    async sendGdc({ toGuid, amount, memo = '', purpose = 'transfer' }) {
      if (!this.guid) throw new Error('[Wallet] guid(IPv6)가 설정되지 않았습니다.');
      if (!toGuid) throw new Error('[Wallet] 수신자 GUID가 없습니다.');
      if (toGuid === this.guid) throw new Error('[Wallet] 본인에게는 이체할 수 없습니다.');
      if (!(amount > 0)) throw new Error('[Wallet] 이체 금액이 올바르지 않습니다.');
      if (amount < 1) throw new Error('[Wallet] 최소 이체액은 ₮1입니다.');
      if (purpose !== 'transfer' && purpose !== 'purchase') {
        throw new Error("[Wallet] purpose는 'transfer' 또는 'purchase'여야 합니다.");
      }
      if (purpose === 'purchase' && !memo.trim()) {
        throw new Error('[Wallet] 재화·용역 대금 결제는 품목명(memo)을 입력해야 합니다.');
      }

      // ── 고액 거래 재인증 사전 점검(2026-07-20) — 문턱 조회 및 미등록
      // 시 조기 실패만 여기서 한다. 실제 생체인증(서버 챌린지 결박)은
      // sign() 이후, tx_hash가 나온 다음에 한다(WYSIWYS — 이 거래에만
      // 유효한 챌린지를 받기 위함, 사고실험에서 지적된 미비점 수정).
      let stepUpThreshold = null;
      try {
        const thRes = await fetch(`${CFG.endpoint}/account/step-up-threshold?guid=${encodeURIComponent(this.guid)}`);
        const thData = await thRes.json().catch(() => null);
        stepUpThreshold = (thRes.ok && thData?.ok) ? thData.threshold : null;
      } catch (e) {
        // 조회 자체가 네트워크 오류로 실패하면 이 시점엔 판단을 유보한다
        // (아래서 다시 시도) — 서버가 handleGdcTransfer에서 어차피
        // 독립적으로 재확인하므로, 여기서 못 정해도 최종 안전성은
        // 유지된다(사고실험 이후 서버측 강제로 바뀐 부분).
        console.warn('[Wallet] 재인증 문턱 사전 조회 실패(서버가 최종 강제):', e.message);
      }
      const needsStepUp = stepUpThreshold !== null && amount >= stepUpThreshold;
      if (needsStepUp && !GopangWallet.isStepUpEnrolled()) {
        throw new Error(
          `[Wallet] ₮${stepUpThreshold.toLocaleString()} 이상 거래는 생체인증 등록이 필요합니다. ` +
          `설정 → 생체인증에서 먼저 등록해 주세요.`
        );
      }

      // 1) 로컬 잔액 사전 확인(UX용 — 최종 검증은 L1이 재생 계산으로 함)
      const db = await openDB();
      const fsRec = await idbGet(db, IDB_FS_KEY);
      const localBalance = parseFloat(fsRec?.state?.['bs-cash'] ?? '0') || 0;
      if (localBalance < amount) {
        throw new Error(`[Wallet] 잔액이 부족합니다(로컬 확인, 잔액 ₮${localBalance}).`);
      }

      // 2) tx 빌드 + 서명 (검증된 sign() 그대로 재사용, output 1개만 지정)
      const signed = await this.sign({
        outputs: [{ recipient_guid: toGuid, amount }],
        total: amount,
        seller_guid: toGuid,
        items: [],
      });

      // 2-1) 고액 거래면 이제 이 tx_hash에 결박된 생체 재인증을 실제로
      // 수행한다 — 서버가 챌린지를 발급하고, 서버가 서명을 직접
      // 검증하고, 서버가 step_up_token을 발급한다(전 과정 서버 확인 —
      // 사고실험에서 지적된 치명적 결함의 실제 수정 지점).
      let stepUpToken = null;
      if (needsStepUp) {
        const bio = await GopangWallet.requireStepUpBiometric(this.guid, signed.tx_hash);
        if (!bio.ok) {
          throw new Error(`[Wallet] 생체인증에 실패해 거래를 중단합니다(${bio.reason}).`);
        }
        stepUpToken = bio.step_up_token;
      }

      // 3) 서버 호출 — /biz/order가 아니라 전용 엔드포인트로
      const res = await fetch(`${CFG.endpoint}/wallet/gdc-transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx: signed.tx, tx_hash: signed.tx_hash,
          sender_sig: signed.buyer_sig, sender_public_key: signed.buyer_public_key,
          from_guid: this.guid, to_guid: toGuid, amount, memo, purpose,
          prev_settle_hash: signed.prev_settle_hash, balance_claimed: localBalance,
          step_up_token: stepUpToken,
        }),
      });
      const result = await res.json().catch(() => ({ ok: false, error: 'PARSE_FAILED' }));
      if (!result.ok) {
        throw new Error(`[Wallet] 이체 실패: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
      }

      // 4) redeemClaim 재사용 — 로컬 재무상태 갱신(송신자 측 차감)
      if (result.buyer_claim) {
        await this.redeemClaim({
          block_hash: result.block_hash, block_id: result.block_id,
          claims: [result.buyer_claim], tx_hash: result.tx_hash || signed.tx_hash,
        });
      }

      return result;
    }

    /**
     * L1 청구권 수신 → 재무 상태 자기갱신 + Hash Chain 기록
     * gopang-app.js GWP_DONE 핸들러에서 호출 (STEP 24)
     *
     * @param {Object} opts
     *   opts.block_hash   — L1 block_hash
     *   opts.block_id     — L1 block_id
     *   opts.claims       — [{ direction, amount, fs_account, expires_at, ... }]
     *   opts.tx_hash      — tx_hash (없으면 block_hash로 대체)
     */
    async redeemClaim({
      block_hash,
      block_id       = null,
      claims         = [],
      tx_hash,
      pdv_session_id = null,
      pdv_type       = null,
    }) {
      if (!block_hash) throw new Error('[Wallet] block_hash 없음');

      const db = await openDB();

      // 현재 재무 상태 로드
      const fsRec = await idbGet(db, IDB_FS_KEY);
      const fs    = fsRec?.state || {};

      // 만료 확인 + 청구권 적용
      const now = Date.now();
      let applied = 0;
      for (const claim of claims) {
        // 2026-07-07 수정(실제 이중 계상 버그): 이 필터가 없었다 — GWP_DONE
        // 메시지에는 buyer_claim/seller_claim이 함께 실려 오는데(profile.html
        // _submitOrder 참고), 그동안 이 함수가 claimant 확인 없이 배열의
        // 모든 claim을 그대로 적용해서, 구매자의 로컬 재무제표에 판매자
        // 몫(seller_claim)까지 잘못 반영되고 있었다. claimant가 없는 옛날
        // claim(하위호환)은 그대로 허용한다.
        if (claim.claimant && this.guid && claim.claimant !== this.guid) {
          console.warn('[Wallet] 내 claim 아님, 건너뜀:', claim.claimant?.slice(0, 20));
          continue;
        }
        if (claim.expires_at && new Date(claim.expires_at).getTime() < now) {
          console.warn('[Wallet] 만료된 청구권 무시:', claim);
          continue;
        }
        const acc = claim.fs_account || 'bs-cash';
        const cur = parseFloat(fs[acc] ?? '0') || 0;
        // 2026-07-13 신설 — pl-cogs(매출원가)는 실제 현금 흐름이 아니라,
        // 이미 매입 시점(pl-purchase)에 지출된 현금을 사후적으로 매출과
        // 대응시키는 정보성 재분류일 뿐이다. bs-cash를 또 건드리면 같은
        // 지출을 두 번 차감하는 이중계상이 된다 — 반드시 제외해야 한다.
        const NON_CASH_ACCOUNTS = new Set(['pl-cogs']);
        if (claim.direction === 'credit') {
          fs[acc] = cur + (claim.amount || 0);
        } else if (claim.direction === 'debit') {
          // pl-purchase·pl-cogs: 누적 비용(양수) — cur + amount
          // bs-cash: 잔액 감소 — 별도 처리
          if (acc === 'pl-purchase' || acc === 'pl-cogs') {
            fs[acc] = cur + (claim.amount || 0);
          } else {
            fs[acc] = cur - (claim.amount || 0);
          }
        }
        // bs-cash 동기화 (pl 계정 변동 시) — 비현금 계정은 제외
        if (acc !== 'bs-cash' && !NON_CASH_ACCOUNTS.has(acc)) {
          const bsCash = parseFloat(fs['bs-cash'] ?? '0') || 0;
          if (claim.direction === 'credit') fs['bs-cash'] = bsCash + (claim.amount || 0);
          else                              fs['bs-cash'] = bsCash - (claim.amount || 0);
        }
        applied++;
      }

      // 갱신된 재무 상태 저장
      await idbPut(db, IDB_FS_KEY, {
        state:     fs,
        updatedAt: new Date().toISOString(),
        block_hash,
      });

      // Hash Chain 기록 (v3.0: pdv_session_id 연동)
      const chainRec = await appendHashChain(db, {
        txHash:       tx_hash || block_hash,
        blockHash:    block_hash,
        blockId:      block_id,
        pdvSessionId: pdv_session_id,
        pdvType:      pdv_type,
      });

      console.info('[Wallet] redeemClaim 완료',
        '| height:', chainRec.height,
        '| applied:', applied,
        '| bs-cash:', fs['bs-cash'],
        '| pdv_session_id:', pdv_session_id?.slice(0, 8) || 'none');

      return { fs, chainRec, applied };
    }

    /**
     * 2026-07-07 신설 — 재대사(reconcile). 로컬 IndexedDB(financial_state)가
     * 서버(L1) 실제 원장과 어긋났을 때(새 기기, 스토리지 초기화, 앱 재설치
     * 등) 서버 값으로 교정한다. 지금까지는 이 복구 경로가 아예 없었다 —
     * 로컬이 틀리면 영영 못 고치고, prev_settle_hash도 계속 틀려서 다음
     * 거래가 STALE_STATE로 막혔다.
     *
     * bs-cash(실잔액)와 block_hash(다음 prev_settle_hash 기준)만 서버 값
     *으로 덮어쓴다 — pl-purchase/pl-revenue(누적 통계)는 서버가 더 이상
     * 추적하지 않으므로(2026-07-07 L1 이관 이후) 로컬 이력을 그대로 둔다.
     *
     * 호출 시점 권장: 앱/지갑 초기화 직후(로그인 직후), 그리고 STALE_STATE
     * 오류를 받았을 때 재시도 전.
     *
     * @returns {{ drift: boolean, localBalance: number, serverBalance: number, blockHash: string|null }}
     */
    async hydrateFromServer() {
      if (!this.guid) throw new Error('[Wallet] guid(IPv6)가 설정되지 않았습니다.');

      const res  = await fetch(`${WORKER_URL}/biz/balance?guid=${encodeURIComponent(this.guid)}`);
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        throw new Error('[Wallet] 서버 잔액 조회 실패: ' + (data?.error || res.status));
      }

      const db  = await openDB();
      const rec = await idbGet(db, IDB_FS_KEY);
      const localFs = rec?.state || {};
      const localBsCash = parseFloat(localFs['bs-cash'] ?? '0') || 0;

      const drift = Math.abs(localBsCash - data.balance) > 0.01;
      if (drift) {
        console.warn('[Wallet] 로컬-서버 잔액 불일치 감지 — 서버 값으로 교정',
          '| local:', localBsCash, '| server:', data.balance);
      }

      const newFs = { ...localFs, 'bs-cash': data.balance };
      await idbPut(db, IDB_FS_KEY, {
        state:     newFs,
        updatedAt: new Date().toISOString(),
        // latest_block_hash가 없으면(지불 이력 없음) 기존 값 유지 —
        // main.pb.js 3단계는 prev_settle_hash:null을 "첫 거래"로 처리한다.
        block_hash: data.latest_block_hash || rec?.block_hash || null,
      });

      console.info('[Wallet] hydrateFromServer 완료',
        '| drift:', drift, '| balance:', data.balance);

      return {
        drift,
        localBalance:  localBsCash,
        serverBalance: data.balance,
        blockHash:     data.latest_block_hash || null,
      };
    }

    /**
     * Hash Chain 전체 조회
     * @returns {Array} chain 이력 배열 (height 오름차순)
     */
    async getHashChain() {
      const db = await openDB();
      const records = await idbChainGetAll(db);
      return records.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    }

    /**
     * Hash Chain 연속성 검증
     * @returns {{ valid: boolean, broken_at: number|null }}
     */
    async verifyChain() {
      // v3.0: OpenHash anchor_chain — hashChain.js verifyChainIntegrity() 위임
      try {
        const { verifyChainIntegrity } = await import('./src/openhash/hashChain.js');
        return await verifyChainIntegrity();
      } catch(e) {
        console.warn('[Wallet] verifyChain 실패:', e.message);
        return { valid: false, broken_at: null, reason: e.message };
      }
    }

    /**
     * 로컬 재무 상태 직접 갱신 (초기화 또는 서버 동기화용)
     * @param {Object} newState  — { 'bs-cash': 숫자, ... }
     */
    async setFinancialState(newState) {
      const db = await openDB();
      await idbPut(db, IDB_FS_KEY, {
        state:     newState,
        updatedAt: new Date().toISOString(),
        block_hash: null,
      });
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
        passphrase || await GopangWallet._webauthnEntropy()
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
    // 신규 entropy(_deviceEntropy, 고정 비밀값)로 먼저 시도하고, 실패하면
    // — PRF 미등록 상태(=원래도 device-entropy 경로였을 조건)에서만 —
    // 구버전(UA 기반) entropy로 재시도한다. 그걸로 열리면 지갑이 예전
    // 방식으로 암호화된 채 남아있던 것이 확인된 것이므로, 그 자리에서
    // 새 entropy로 조용히 재암호화해 이후로는 UA 변동과 무관하게 열리도록
    // 만든다(enrollWebAuthn()의 재암호화 패턴과 동일 원칙).
    static async _decryptWithMigration(db, idbKeyName, record, passphrase) {
      const encBuf = b64uToBuf(record.encPrivKey).buffer;
      try {
        return await decryptPrivKey(encBuf, passphrase || await GopangWallet._webauthnEntropy());
      } catch (e) {
        const usingDeviceEntropy = !passphrase && !localStorage.getItem(LS_WEBAUTHN_CRED);
        if (!usingDeviceEntropy) throw e;
        const privRaw = await decryptPrivKey(encBuf, await GopangWallet._legacyDeviceEntropy()); // 실패 시 그대로 throw
        try {
          const reEnc = await encryptPrivKey(privRaw, await GopangWallet._deviceEntropy());
          await idbPut(db, idbKeyName, { ...record, encPrivKey: bufToB64u(reEnc) });
          console.info('[GopangWallet] 구버전(UA 기반) 암호화 감지 — 고정 비밀값 방식으로 자동 이전 완료:', idbKeyName);
        } catch (migrateErr) {
          console.warn('[GopangWallet] 마이그레이션 재암호화 실패(다음 세션에 재시도됨):', migrateErr.message);
        }
        return privRaw;
      }
    }

    static async load(passphrase = '') {
      const db     = await openDB();
      const record = await idbGet(db, IDB_KEY_ID).catch(() => null);
      if (!record) return null; // 진짜 최초 실행 — 이 경우에만 null을 반환한다

      // ★ 2026-07-21 근본 수정 — 이전에는 아래 블록 전체가 하나의 try/catch에
      // 묶여 있어서, "레코드가 아예 없음"과 "레코드는 있는데 이번 세션에서
      // 못 엶(엔트로피 불일치·WebAuthn 실패 등)"이 똑같이 null로 뭉개졌다.
      // 그 결과 싱글턴 초기화 쪽이 "최초 실행"으로 오판해 기존 계정과 무관한
      // 새 키를 조용히 자동 생성하는 사고로 이어졌다(2026-07-21 실사로 확인).
      // 지금은 "레코드가 있다"는 사실 자체가 이미 이 기기에 지갑이 존재한다는
      // 증거이므로, 그 이후 단계(복호화·키 임포트)에서 실패하면 null이 아니라
      // 구분 가능한 에러를 던진다 — 호출부가 "새로 만들어도 되는 상황"과
      // "복구가 필요한 상황"을 반드시 구별하도록 강제한다.
      try {
        const privRaw = await GopangWallet._decryptWithMigration(db, IDB_KEY_ID, record, passphrase);

        // JWK 형식으로 복원
        // v6.0: extractable을 true로 — exportPrivateKey()(백업 키 내보내기)가
        // 첫 생성 직후뿐 아니라 재방문 세션(load() 경로)에서도 동작해야 한다.
        // 개인키 자체는 여전히 IndexedDB에 AES-GCM 암호화되어 있으므로, 이 변경이
        // 새로 노출시키는 것은 "이미 메모리에 로드된 이 세션의 키"뿐이다.
        const privJwk = {
          kty: 'OKP', crv: 'Ed25519',
          x  : record.publicKeyB64u,
          d  : bufToB64u(privRaw),
          key_ops: ['sign'],
        };
        const privKey = await crypto.subtle.importKey(
          'jwk', privJwk, { name: 'Ed25519' }, true, ['sign']
        );
        const pubRaw  = b64uToBuf(record.publicKeyB64u);
        const pubKey  = await crypto.subtle.importKey(
          'raw', pubRaw, { name: 'Ed25519' }, false, ['verify']
        );

        // X25519 암호화 키페어 — 없으면 null (ensureX25519Key()로 추후 생성)
        let x25519PrivKey = null, x25519PubKey = null, x25519PubKeyB64u = null;
        const xRecord = await idbGet(db, IDB_X25519_ID).catch(() => null);
        if (xRecord) {
          const xPrivRaw = await GopangWallet._decryptWithMigration(db, IDB_X25519_ID, xRecord, passphrase);
          const xPrivJwk = {
            kty: 'OKP', crv: 'X25519',
            x  : xRecord.publicKeyB64u,
            d  : bufToB64u(xPrivRaw),
            key_ops: ['deriveKey', 'deriveBits'],
          };
          x25519PrivKey = await crypto.subtle.importKey(
            'jwk', xPrivJwk, { name: 'X25519' }, false, ['deriveKey']
          );
          x25519PubKey = await crypto.subtle.importKey(
            'raw', b64uToBuf(xRecord.publicKeyB64u), { name: 'X25519' }, false, []
          );
          x25519PubKeyB64u = xRecord.publicKeyB64u;
        }

        return new GopangWallet({
          publicKey    : pubKey,
          privateKey   : privKey,
          publicKeyB64u: record.publicKeyB64u,
          publicKeyHex : record.publicKeyHex,
          handle       : localStorage.getItem(LS_HANDLE),
          guid         : null,
          x25519PrivateKey   : x25519PrivKey,
          x25519PublicKey    : x25519PubKey,
          x25519PublicKeyB64u: x25519PubKeyB64u,
        });
      } catch (e) {
        console.error('[GopangWallet] 기존 지갑 복호화 실패(레코드는 존재함) — 원인 불명확한 채로 새 지갑을 자동 생성하지 않습니다:', e);
        const err = new Error('WALLET_DECRYPT_FAILED');
        err.cause = e;
        err.code = 'WALLET_DECRYPT_FAILED';
        throw err;
      }
    }

    /**
     * X25519 암호화 키페어 보장 — 없으면 생성 후 IndexedDB에 저장
     * "공장 초기화 후 첫 접속 시 자동 개시"용 진입점
     * 휴대폰(설정 창)에서만 호출할 것 — PC는 이 키를 생성하지 않음
     * @param {string} [passphrase='']
     * @returns {{ publicKeyB64u }} 등록할 공개키
     */
    async ensureX25519Key(passphrase = '') {
      if (this._x25519PrivKey && this.x25519PublicKeyB64u) {
        return { publicKeyB64u: this.x25519PublicKeyB64u, created: false };
      }

      const kp  = await generateX25519KeyPair();
      const enc = await encryptPrivKey(
        b64uToBuf(kp.privateKeyB64u).buffer,
        passphrase || await GopangWallet._webauthnEntropy()
      );

      const record = {
        publicKeyB64u: kp.publicKeyB64u,
        encPrivKey   : bufToB64u(enc),
        createdAt    : nowSec(),
      };
      const db = await openDB();
      await idbPut(db, IDB_X25519_ID, record);
      localStorage.setItem(LS_X25519_PUBKEY, kp.publicKeyB64u);

      this._x25519PrivKey      = kp.privateKey;
      this._x25519PubKey       = kp.publicKey;
      this.x25519PublicKeyB64u = kp.publicKeyB64u;

      return { publicKeyB64u: kp.publicKeyB64u, created: true };
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
      await idbDel(db, IDB_X25519_ID).catch(() => {});
      localStorage.removeItem(LS_PUBKEY);
      localStorage.removeItem(LS_X25519_PUBKEY);
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
        passphrase || await GopangWallet._webauthnEntropy()
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

    /**
     * v6.0 — 백업 키 복구: 개인키(Base64URL) 한 줄만으로 지갑 전체 복원.
     * 공개키는 별도로 저장/입력받지 않고 개인키로부터 결정적으로 유도한다.
     *
     * 원리: Ed25519 개인키는 32바이트 시드 그 자체이며(JWK의 `d` 값과 동일),
     * PKCS8 DER 포맷은 Ed25519에 한해 알고리즘 파라미터가 없어 앞 16바이트
     * 헤더가 항상 고정값이다 — `302e020100300506032b657004220420`(hex).
     * 이 고정 헤더 + 32바이트 시드로 PKCS8 버퍼를 직접 구성해 importKey하면,
     * WebCrypto 구현이 공개키를 내부적으로 계산해 jwk export 시 `x`로 돌려준다
     * (실제 브라우저/Node WebCrypto에서 라운드트립 서명·검증으로 검증된 방식).
     *
     * "백업 키를 다시 입력하면 정확히 같은 계정이 복원된다"가 보장되는 이유는
     * 이 유도가 결정적(deterministic)이기 때문 — 같은 32바이트는 항상 같은
     * 공개키(=같은 guid 검증 결과)를 낸다.
     *
     * @param {string} privKeyB64u — exportPrivateKey()가 내보낸 그 문자열
     * @param {string} [passphrase='']
     * @returns {GopangWallet}
     * @throws {Error} 형식이 32바이트가 아니면 (잘못 붙여넣은 경우)
     */
    static async restoreFromPrivateKey(privKeyB64u, passphrase = '') {
      const seed = b64uToBuf(privKeyB64u.trim());
      if (seed.length !== 32) {
        throw new Error('백업 키 형식이 올바르지 않습니다 (32바이트가 아님).');
      }
      const PKCS8_ED25519_HEADER = Uint8Array.from(
        '302e020100300506032b657004220420'.match(/.{2}/g).map(h => parseInt(h, 16))
      );
      const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + seed.length);
      pkcs8.set(PKCS8_ED25519_HEADER, 0);
      pkcs8.set(seed, PKCS8_ED25519_HEADER.length);

      let imported;
      try {
        imported = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
      } catch (e) {
        throw new Error('백업 키를 읽을 수 없습니다: ' + e.message);
      }
      const jwk = await crypto.subtle.exportKey('jwk', imported);
      const pubKeyB64u = jwk.x; // 결정적으로 유도된 공개키

      return GopangWallet.importFromBackup(privKeyB64u.trim(), pubKeyB64u, passphrase);
    }

    /* ── 내부: 기기 고유 entropy (passphrase 미사용 시 대체) ── */
    // 2026-07-28 근본 수정 — navigator.userAgent는 "동일 기기·동일
    // 브라우저"에서도 결정론적이지 않다: Chrome DevTools 기기 에뮬레이션이
    // Responsive↔기기 프리셋 사이를 오가면 UA 문자열 자체가 바뀌고,
    // 실사용 환경에서도 브라우저 자동 업데이트(버전 번호 변경)나 최근
    // Chrome의 User-Agent Reduction 정책으로 UA가 언제든 달라질 수
    // 있다. 그 결과 "지갑을 스스로 만든 직후, 같은 세션 안에서도 못 여는"
    // 사고가 실사로 재현됐다 — 다른 기기가 아니라 이 함수 자체의 결함.
    // UA 대신, 최초 1회 랜덤 발급해 localStorage에 영구 저장하는 고정
    // 비밀값을 쓴다. push.js의 getOrCreateDeviceId()와 동일 패턴.
    static async _deviceSecret() {
      let secret = localStorage.getItem(LS_DEVICE_SECRET);
      if (!secret) {
        secret = bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
        localStorage.setItem(LS_DEVICE_SECRET, secret);
      }
      return secret;
    }

    static async _deviceEntropy() {
      const secret = await GopangWallet._deviceSecret();
      const buf = await sha256(secret + 'gopang-wallet-v1-entropy');
      return bufToHex(buf);
    }

    // 구버전(UA 기반) entropy — 위 수정 이전에 이미 이 방식으로 암호화된
    // 지갑을 열기 위한 마이그레이션 전용 경로. load()에서만 폴백으로
    // 쓰이고, 새로 만드는 지갑은 전부 _deviceEntropy()(고정 비밀값)를
    // 쓴다 — 이 함수로 새로 암호화하지 않는다.
    static async _legacyDeviceEntropy() {
      const raw = navigator.userAgent + 'gopang-wallet-v1-entropy';
      const buf = await sha256(raw);
      return bufToHex(buf);
    }

    /* ── WebAuthn PRF 기반 entropy ──────────────────────────
     * enroll 안 됐으면 기존 _deviceEntropy()로 그대로 폴백 (하위호환).
     * enroll 됐는데 생체인증 실패/취소 시엔 여기서 예외가 나며,
     * 이는 decryptPrivKey()에서 AES-GCM auth tag 불일치로 안전하게 실패한다
     * (평문 노출 없이 load() 쪽 catch로 흡수됨).
     * ──────────────────────────────────────────────────── */
    static async _webauthnEntropy() {
      const credIdB64u = localStorage.getItem(LS_WEBAUTHN_CRED);
      if (!credIdB64u) return GopangWallet._deviceEntropy();

      const prfBytes = await GopangWallet._prfEval(b64uToBuf(credIdB64u).buffer);
      return bufToHex(prfBytes.buffer);
    }

    /** 등록된 credential로 PRF 값을 재도출 (매번 동일 salt → 동일 결과) */
    static async _prfEval(credentialIdBuf) {
      const assertion = await navigator.credentials.get({
        publicKey: {
          rpId: WEBAUTHN_RP_ID,
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: credentialIdBuf, type: 'public-key' }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: WEBAUTHN_PRF_SALT } } },
        },
      });
      const results = assertion.getClientExtensionResults();
      const first = results && results.prf && results.prf.results && results.prf.results.first;
      if (!first) throw new Error('WEBAUTHN_PRF_EVAL_FAILED');
      return new Uint8Array(first);
    }

    /**
     * 플랫폼 인증기(지문/얼굴)를 새로 등록하고, 현재 지갑의 개인키를
     * _deviceEntropy() 암호화 → PRF entropy 암호화로 전환한다.
     * @returns {{ ok: boolean, reason?: string }}
     *   reason 'PRF_UNSUPPORTED' — 이 브라우저/인증기는 PRF 미지원 → 폴백 유지, UI에서 안내할 것
     *   reason 'NO_WALLET' — 아직 지갑이 없음 (create() 먼저 호출)
     */
    /**
     * @param {string|null} [guid] — 2026-07-20 신설: 서버에 공개키를
     *   등록하려면 guid가 필요하다(고액 거래 재인증을 서버가 실제로
     *   검증하게 하려면 필수 — 없으면 로컬 재암호화만 하고 서버 등록은
     *   건너뛴다, 하위호환).
     */
    static async enrollWebAuthn() {
      if (!window.PublicKeyCredential) return { ok: false, reason: 'PRF_UNSUPPORTED' };

      const db = await openDB();
      const record = await idbGet(db, IDB_KEY_ID);
      if (!record) return { ok: false, reason: 'NO_WALLET' };

      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { id: WEBAUTHN_RP_ID, name: 'Hondi Wallet' },
          user: {
            id: b64uToBuf(record.publicKeyB64u),
            name: localStorage.getItem(LS_HANDLE) || 'gopang-wallet',
            displayName: 'Gopang Wallet',
          },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'required',
          },
          extensions: { prf: {} },
        },
      });

      const prfEnabled = cred.getClientExtensionResults() && cred.getClientExtensionResults().prf
        && cred.getClientExtensionResults().prf.enabled;
      if (!prfEnabled) return { ok: false, reason: 'PRF_UNSUPPORTED' };

      // (2026-07-20: 여기서 서버에 공개키를 등록하던 코드를 제거했다 —
      // 고액 거래 재인증은 PRF와 무관한 별도 credential(enrollStepUpBiometric,
      // LS_STEPUP_CRED)로 완전히 분리했다. 이 함수는 원래 목적인
      // "로컬 저장소 재암호화"에만 집중한다 — 하나의 credential이
      // 두 가지 다른 목적을 겸하면서 생긴 PRF_UNSUPPORTED 연쇄 실패
      // 문제가 재발하지 않게 하기 위함.)

      // 기존 device-entropy로 복호화 → 새 PRF-entropy로 재암호화 (Ed25519 + X25519 둘 다)
      const oldEntropy = await GopangWallet._deviceEntropy();
      const newEntropyBytes = await GopangWallet._prfEval(cred.rawId);
      const newEntropy = bufToHex(newEntropyBytes.buffer);

      const privRaw = await decryptPrivKey(b64uToBuf(record.encPrivKey).buffer, oldEntropy);
      const reEnc = await encryptPrivKey(privRaw, newEntropy);
      await idbPut(db, IDB_KEY_ID, { ...record, encPrivKey: bufToB64u(reEnc) });

      const xRecord = await idbGet(db, IDB_X25519_ID).catch(() => null);
      if (xRecord) {
        const xPrivRaw = await decryptPrivKey(b64uToBuf(xRecord.encPrivKey).buffer, oldEntropy);
        const xReEnc = await encryptPrivKey(xPrivRaw, newEntropy);
        await idbPut(db, IDB_X25519_ID, { ...xRecord, encPrivKey: bufToB64u(xReEnc) });
      }

      localStorage.setItem(LS_WEBAUTHN_CRED, bufToB64u(cred.rawId));
      return { ok: true };
    }

    static isWebAuthnEnrolled() {
      return !!localStorage.getItem(LS_WEBAUTHN_CRED);
    }

    /**
     * 2026-07-20 신설 — 고액 거래 재인증 전용 생체인증 등록.
     * enrollWebAuthn()과 달리 PRF 확장을 전혀 요구하지 않는다 —
     * 서버가 assertion 서명을 직접 검증하는 방식이라(handleStepUpVerify)
     * 로컬 키 유도(PRF)가 필요 없다. 실사로 확인된 문제: PRF는 기기·
     * 브라우저에 따라 미지원인 경우가 흔해(지문 인증 자체는 성공해도
     * enrollWebAuthn()이 PRF_UNSUPPORTED로 실패), 재인증 기능 전체가
     * PRF 지원 기기로만 제한될 뻔했다 — 완전히 독립시켜 이 문제를
     * 근본적으로 없앤다.
     * @param {string} guid — 서버에 공개키를 등록하려면 필수
     * @returns {{ ok: boolean, reason?: string }}
     */
    static async enrollStepUpBiometric(guid) {
      if (!window.PublicKeyCredential) return { ok: false, reason: 'UNSUPPORTED' };
      if (!guid) return { ok: false, reason: 'GUID_REQUIRED' };

      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { id: WEBAUTHN_RP_ID, name: 'Hondi Wallet' },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: localStorage.getItem(LS_HANDLE) || 'gopang-wallet',
            displayName: 'Gopang Wallet (재인증 전용)',
          },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred', // required 아님 — PRF와 달리 없어도 재인증 흐름엔 지장 없음
          },
          // extensions: prf 없음 — 의도적. 이 기능엔 필요 없다(위 설명 참고).
        },
      });

      if (!cred.response.getPublicKey) {
        return { ok: false, reason: 'GETPUBLICKEY_UNSUPPORTED(브라우저가 너무 오래됨)' };
      }
      const spki = cred.response.getPublicKey();

      try {
        const res = await fetch(`${WORKER_URL}/auth/webauthn/register-key`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guid, credentialId: bufToB64u(cred.rawId),
            publicKeySpkiB64u: bufToB64u(spki),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) return { ok: false, reason: data.detail || 'SERVER_REGISTER_FAILED' };
      } catch (e) {
        return { ok: false, reason: '서버 등록 실패: ' + e.message };
      }

      localStorage.setItem(LS_STEPUP_CRED, bufToB64u(cred.rawId));
      return { ok: true };
    }

    static isStepUpEnrolled() {
      return !!localStorage.getItem(LS_STEPUP_CRED);
    }

    /** 로컬 등록만 해제한다 — 분실 기기 등으로 서버 쪽도 지워야 하면
     *  별도 관리자 조치나 추후 revoke 엔드포인트가 필요하다(현재 없음). */
    static disableStepUpBiometric() {
      localStorage.removeItem(LS_STEPUP_CRED);
      return { ok: true };
    }

    /**
     * 2026-07-20 개정 — 고액 거래 재인증(step-up), 서버 검증판.
     * 예전엔 _prfEval()만 로컬에서 통과하면 끝이었다(사고실험에서 발견된
     * 치명적 결함 — 서버가 이 결과를 전혀 몰라 우회가 자명했음). 이제
     * ①서버에 tx_hash 결박 챌린지 요청 → ②그 챌린지로 실제 WebAuthn
     * assertion(navigator.credentials.get) → ③서버가 저장된 공개키로
     * 직접 서명 검증 → ④통과 시 서버가 발급하는 짧은 수명 step_up_token
     * 을 돌려받는 흐름이다. 이 토큰이 있어야 handleGdcTransfer가 문턱
     * 이상 거래를 받아준다 — 클라이언트 판단을 서버가 신뢰하지 않는다.
     * ★ 2026-07-20 2차 수정: LS_WEBAUTHN_CRED(PRF용) 대신 독립된
     * LS_STEPUP_CRED를 쓰도록 변경 — 위 enrollStepUpBiometric() 참고.
     * @param {string} guid
     * @param {string} txHash — 방금 sign()으로 만든 거래의 tx_hash(이
     *   거래에만 유효한 챌린지를 받기 위해 필수 — WYSIWYS 원칙)
     * @returns {{ ok: boolean, reason?: string, step_up_token?: string }}
     */
    static async requireStepUpBiometric(guid, txHash) {
      if (!GopangWallet.isStepUpEnrolled()) return { ok: false, reason: 'NOT_ENROLLED' };
      const credIdB64u = localStorage.getItem(LS_STEPUP_CRED);

      let challengeData;
      try {
        const res = await fetch(`${WORKER_URL}/account/step-up-challenge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guid, tx_hash: txHash }),
        });
        challengeData = await res.json();
        if (!res.ok || !challengeData.ok) return { ok: false, reason: challengeData.detail || 'CHALLENGE_REQUEST_FAILED' };
      } catch (e) {
        return { ok: false, reason: '챌린지 요청 실패: ' + e.message };
      }

      let assertion;
      try {
        assertion = await navigator.credentials.get({
          publicKey: {
            challenge: b64uToBuf(challengeData.challengeB64u),
            rpId: challengeData.rpId || WEBAUTHN_RP_ID,
            allowCredentials: [{ id: b64uToBuf(credIdB64u), type: 'public-key' }],
            userVerification: 'required',
          },
        });
      } catch (e) {
        return { ok: false, reason: e.message || 'ASSERTION_FAILED' };
      }

      try {
        const res = await fetch(`${WORKER_URL}/account/step-up-verify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guid, sessionId: challengeData.sessionId,
            credentialId: bufToB64u(assertion.rawId),
            authenticatorDataB64u: bufToB64u(assertion.response.authenticatorData),
            clientDataJSONB64u: bufToB64u(assertion.response.clientDataJSON),
            signatureB64u: bufToB64u(assertion.response.signature),
          }),
        });
        const verifyData = await res.json();
        if (!res.ok || !verifyData.ok) return { ok: false, reason: verifyData.detail || 'SERVER_VERIFY_FAILED' };
        return { ok: true, step_up_token: verifyData.step_up_token };
      } catch (e) {
        return { ok: false, reason: '서버 검증 요청 실패: ' + e.message };
      }
    }

    /**
     * WebAuthn 잠금 해제 — 다시 device-entropy 암호화로 되돌린다.
     * (기기 분실이 아니라 '지문 인식기가 자꾸 실패한다' 류의 사용자 요청 대응용)
     */
    static async disableWebAuthn() {
      if (!GopangWallet.isWebAuthnEnrolled()) return { ok: true, already: true };

      const db = await openDB();
      const record = await idbGet(db, IDB_KEY_ID);
      if (!record) return { ok: false, reason: 'NO_WALLET' };

      const credIdB64u = localStorage.getItem(LS_WEBAUTHN_CRED);
      const oldEntropyBytes = await GopangWallet._prfEval(b64uToBuf(credIdB64u).buffer);
      const oldEntropy = bufToHex(oldEntropyBytes.buffer);
      const newEntropy = await GopangWallet._deviceEntropy();

      const privRaw = await decryptPrivKey(b64uToBuf(record.encPrivKey).buffer, oldEntropy);
      const reEnc = await encryptPrivKey(privRaw, newEntropy);
      await idbPut(db, IDB_KEY_ID, { ...record, encPrivKey: bufToB64u(reEnc) });

      const xRecord = await idbGet(db, IDB_X25519_ID).catch(() => null);
      if (xRecord) {
        const xPrivRaw = await decryptPrivKey(b64uToBuf(xRecord.encPrivKey).buffer, oldEntropy);
        const xReEnc = await encryptPrivKey(xPrivRaw, newEntropy);
        await idbPut(db, IDB_X25519_ID, { ...xRecord, encPrivKey: bufToB64u(xReEnc) });
      }

      localStorage.removeItem(LS_WEBAUTHN_CRED);
      return { ok: true };
    }

    /* ── 정적 유틸 노출 ── */
    static nicknameHash(nickname, lang) { return nicknameHash(nickname, lang); }
    static verify(publicKeyB64u, payload, signatureB64u) {
      return verify(publicKeyB64u, payload, signatureB64u);
    }
    /**
     * PC(거울)에서 호출 — 지갑 인스턴스 없이, 휴대폰의 X25519 공개키만으로 봉투 암호화
     * @param {string} recipientPubKeyB64u — 휴대폰의 X25519 공개키
     * @param {string} plaintext
     */
    static async sealForRecipient(recipientPubKeyB64u, plaintext) {
      return sealForRecipient(recipientPubKeyB64u, plaintext);
    }
    /**
     * 2026-07-20 신설 — 기기 간 지갑 이전(device-link) 전용.
     * PC가 이 페어링 세션에서만 쓸 1회용 X25519 키페어를 생성한다.
     * 공개키는 서버로 보내 폰이 sealForRecipient()로 암호화하는 데 쓰고,
     * 개인키(CryptoKey)는 PC 메모리에만 들고 있다가 openSealedWithKey()로
     * 복호화한 뒤 버린다 — 어디에도 저장하지 않는다(1회용, 순방향 비밀성).
     */
    static async generateX25519KeyPair() {
      return generateX25519KeyPair();
    }
    /**
     * 2026-07-20 신설 — 아직 지갑 인스턴스가 없는 새 기기(PC)에서,
     * generateX25519KeyPair()로 만든 임의의 개인키로 sealForRecipient()
     * 봉투를 복호화한다. 복호화 로직 자체는 openSealed()를 그대로
     * 쓴다(이미 CryptoKey를 인자로 받으므로 재구현 불필요) — 지갑 인스턴스
     * 메서드(wallet.openSealed)와 달리 this._x25519PrivKey에 묶이지 않고
     * 호출자가 넘긴 키를 그대로 쓰는 버전만 static으로 노출한다.
     */
    static async openSealedWithKey(privateKey, sealed) {
      return openSealed(privateKey, sealed);
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
   *  정적 유틸 추가 노출 (v2.0)
   * ──────────────────────────────────────────────── */
  GopangWallet.sortedStringify       = sortedStringify;
  GopangWallet.computePrevSettleHash = computePrevSettleHash;
  GopangWallet.buildTxWithPrevHash   = buildTxWithPrevHash;
  GopangWallet.signTx                = signTx;
  GopangWallet.appendHashChain       = appendHashChain;

  /* ────────────────────────────────────────────────
   *  4단계(2026-07-23) — 공용 PC 1회성 서명 위임
   *  개인키를 이 PC로 옮기지 않고, 서명이 필요할 때마다 device-link.html을
   *  팝업(purpose=sign_request)으로 열어 폰의 승인을 받고 서명 '결과'만
   *  돌려받는다. 결과는 postMessage로 전달되며, 서명 자체는 검증 가능한
   *  공개 정보라 봉투 암호화가 필요 없다(개인키만 절대 노출 안 되면 됨).
   * ──────────────────────────────────────────────── */
  function _openSignRequestPopup(sigMsg) {
    return new Promise((resolve, reject) => {
      const popup = window.open(
        '/auth/device-link.html?purpose=sign_request&sigMsg=' + encodeURIComponent(sigMsg),
        'gopang_sign_request', 'width=420,height=560,menubar=no,toolbar=no'
      );
      if (!popup) {
        reject(new Error('팝업이 차단되었습니다 — 브라우저 설정에서 이 사이트의 팝업을 허용해 주세요.'));
        return;
      }
      let settled = false;
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(closedPoll);
      };
      function onMessage(ev) {
        if (ev.origin !== location.origin) return;
        if (ev.data?.type !== 'GOPANG_SIGN_RESULT') return;
        if (settled) return;
        settled = true;
        cleanup();
        if (ev.data.ok) resolve({ signature: ev.data.signature, publicKeyB64u: ev.data.publicKeyB64u, guid: ev.data.guid });
        else reject(new Error(ev.data.error === 'expired' ? '승인 시간이 초과됐습니다.' : (ev.data.error || '서명 요청이 실패했습니다.')));
      }
      // 팝업을 사용자가 직접 닫아버린 경우(승인도 거부도 안 하고 그냥
      // 닫음) — postMessage가 영영 안 오므로, 별도로 감지해서 reject
      // 해야 sign()을 호출한 쪽의 Promise가 무기한 대기하지 않는다.
      const closedPoll = setInterval(() => {
        if (popup.closed && !settled) {
          settled = true;
          cleanup();
          reject(new Error('사용자가 창을 닫았습니다.'));
        }
      }, 500);
      window.addEventListener('message', onMessage);
    });
  }

  // window.gopangWallet 자리에 들어가는 대체 객체 — 진짜 지갑(GopangWallet
  // 인스턴스)과 달리 개인키를 전혀 갖지 않는다. 외부 호출부들은 전부
  // window.gopangWallet?.method 형태(옵셔널 체이닝)로 접근하므로, 여기
  // 정의 안 된 메서드(getBalance 등)는 자동으로 각 호출부의 기존
  // guid-fallback 경로로 떨어진다 — 별도 스텁이 필요 없다.
  class SessionSignProxy {
    constructor() {
      this.guid = null;
      this.handle = null;
      this._isSessionProxy = true;
      // 2026-07-23 추가 — 사고실험 E11에서 발견: 거의 동시에 두 서명이
      // 필요해지면 둘 다 같은 이름('gopang_sign_request')의 팝업을 열려고
      // 해서, 두 번째 호출이 첫 번째가 아직 열어둔 팝업을 가로채(같은
      // 이름의 창은 새로 열지 않고 기존 창을 재사용/네비게이트하는
      // window.open() 표준 동작) 첫 번째 요청의 Promise가 응답을 영영
      // 못 받고 멈출 수 있었다. 팝업을 여러 개 동시에 띄우는 대신, 모든
      // .sign() 호출을 하나의 큐로 직렬화한다 — 한 번에 팝업은 항상
      // 하나만 뜨고, 먼저 요청한 게 항상 먼저 처리된다.
      this._queue = Promise.resolve();
    }
    setIdentity({ guid, handle } = {}) { this.guid = guid || null; this.handle = handle || null; }
    sign(payload) {
      const run = () => this._signOne(payload);
      // 이전 서명이 성공했든 실패했든(예: 사용자가 팝업을 닫아 reject)
      // 다음 서명 요청은 항상 이어서 실행돼야 하므로, 큐 자체는 끊기지
      // 않게 별도로 이어붙인다. run()의 반환(성공/실패)은 그대로
      // 호출자에게 전달한다.
      const result = this._queue.then(run, run);
      this._queue = result.then(() => {}, () => {});
      return result;
    }
    async _signOne(payload) {
      const { signature, guid } = await _openSignRequestPopup(String(payload));
      // 첫 서명 성공 시점에야 서버(전화번호 조회 결과)로부터 실제 guid를
      // 처음 알게 된다 — 공용 PC는 사전에 어떤 계정인지 전혀 모르는
      // 상태에서 시작하기 때문. sessionStorage에만 남긴다(localStorage
      // 아님 — 탭/브라우저를 닫으면 다음 사람에게 아무 흔적도 안 남아야
      // 하는 공용 PC 원칙 유지).
      if (guid && !this.guid) {
        this.guid = guid;
        try {
          if (!sessionStorage.getItem('gopang_user_v4')) {
            sessionStorage.setItem('gopang_user_v4', JSON.stringify({ ipv6: guid }));
          }
        } catch (e) { /* sessionStorage 접근 불가 환경 — 서명 자체엔 영향 없음 */ }
      }
      return signature;
    }
  }
  GopangWallet.createSessionSignProxy = () => new SessionSignProxy();

  /* ────────────────────────────────────────────────
   *  5단계(2026-07-23) — 공용 PC PDV 원문 릴레이 (PC → 폰, B안)
   *  공용 PC 세션에서 생긴 원문(채팅 등)을 이 PC에 남기지 않고, 폰의
   *  이미 등록된 X25519 공개키로 암호화해 즉시 전달한다. 폰이 그 안에
   *  안 켜지면(TTL 10분) 서버가 알아서 지운다 — 유실을 감수하는 대신
   *  큐가 무한정 쌓이지 않는다(B안, 주피터 지시).
   * ──────────────────────────────────────────────── */
  GopangWallet.relayContentToPhone = async function(guid, plaintext) {
    if (!guid) throw new Error('relayContentToPhone: guid가 필요합니다.');
    const res = await fetch(`${WORKER_URL}/wallet/x25519?guid=${encodeURIComponent(guid)}`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !data.registered || !data.x25519_pubkey) {
      throw new Error(data.message || '수신자(폰)의 암호화 키를 찾을 수 없습니다.');
    }
    const sealed = await sealForRecipient(data.x25519_pubkey, plaintext);
    const pushRes = await fetch(`${WORKER_URL}/pdv/relay/push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid, sealed }),
    });
    const pushData = await pushRes.json().catch(() => ({}));
    if (!pushRes.ok || !pushData.ok) throw new Error(pushData.detail || pushData.error || '전달에 실패했습니다.');
    return pushData;
  };

  // 폰 쪽 — 대기 중인 릴레이 항목을 가져와 이 지갑의 개인키로 복호화한다.
  // wallet은 이 폰의 진짜 GopangWallet 인스턴스(X25519 키 등록 완료 —
  // ensureX25519Key() 먼저 호출된 상태)여야 한다. 복호화는 지갑이 이미
  // 갖고 있는 wallet.openSealed()를 그대로 쓴다(X25519 개인키는 Ed25519
  // 서명키와 별개 필드라 재구현하지 않고 기존 메서드를 재사용).
  GopangWallet.pullRelayedContent = async function(wallet, guid) {
    if (!wallet || typeof wallet.openSealed !== 'function') {
      throw new Error('pullRelayedContent: 유효한 지갑 인스턴스가 필요합니다.');
    }
    const res = await fetch(`${WORKER_URL}/pdv/relay/pull?guid=${encodeURIComponent(guid)}`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.detail || data.error || '조회에 실패했습니다.');
    const items = [];
    for (const sealed of (data.items || [])) {
      try {
        items.push(await wallet.openSealed(sealed));
      } catch (e) {
        console.warn('[GopangWallet] 릴레이 항목 복호화 실패(건너뜀):', e.message);
      }
    }
    return items;
  };

  /* ────────────────────────────────────────────────
   *  전역 노출
   * ──────────────────────────────────────────────── */
  global.GopangWallet = GopangWallet;

  // ESM 환경 대응
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GopangWallet;
  }

  /* ────────────────────────────────────────────────
   *  window.gopangWallet 싱글턴 자동 초기화
   *  gopang-app.js에서 window.gopangWallet.sign() 등으로 접근
   *  2026-07-23 — 모바일 기기는 최초 실행 시 즉시 자동 생성(1기기 1사용자
   *  전제). PC/미확인 기기는 자동 생성을 보류하고 gopangWalletNeedsSetup
   *  플래그만 세운다 — window.gopangWallet은 null로 남고, 실제 서명이
   *  필요해지는 순간 호출부가 계정 연결 흐름으로 안내한다(부록 A-1: PC가
   *  먼저 키를 만들어 진짜 계정 키와 어긋나는 사고 방지).
   * ──────────────────────────────────────────────── */
  (async () => {
    try {
      let wallet;
      try {
        wallet = await GopangWallet.load();
      } catch (e) {
        if (e?.code === 'WALLET_DECRYPT_FAILED') {
          // ★ 2026-07-21 근본 수정 — 예전에는 load()가 이 경우도 그냥 null을
          // 반환해서, 바로 아래 "최초 실행"과 구분이 안 됐고 결국 기존 계정과
          // 무관한 새 키를 조용히 만들어버렸다(실사로 확인된 사고). 지금은
          // 진짜로 이 기기에 지갑이 있었다는 게 확정된 상태이므로, 대체 지갑을
          // 만들지 않고 잠금 상태로 멈춘다 — 사용자가 설정 화면에서 백업 키로
          // 복구하거나, 다른 정상 기기에서 새로 device-link를 받아야 한다.
          console.error('[GopangWallet] 기존 지갑을 열 수 없습니다(엔트로피/인증 불일치로 추정) — 백업 키 복구가 필요합니다. 새 지갑을 자동 생성하지 않습니다.');
          global.gopangWallet = null;
          global.gopangWalletLocked = true; // UI가 "복구 필요" 배너를 띄울 수 있도록 하는 신호
          // 2026-07-23 신설 — 위 플래그를 실제로 구독하는 코드가 어디에도
          // 없어서(실사로 확인), 지갑이 잠겨도 사용자에게는 아무 것도 안
          // 보이고 이후 모든 서명 필요 기능이 콘솔 에러만 남긴 채 조용히
          // 실패했다. 폴링으로 플래그를 확인하지 않아도 되도록, 페이지가
          // 뜬 시점이 언제든 즉시 받을 수 있게 이벤트를 던진다.
          try {
            global.dispatchEvent?.(new CustomEvent('gopang:wallet-locked'));
          } catch (e) { /* CustomEvent 미지원 환경 — 조용히 무시 */ }
          return;
        }
        throw e; // 그 외 예상 못한 에러는 기존과 동일하게 바깥 catch로
      }
      if (!wallet) {
        // ★ 2026-07-23 근본 수정 — auth.js의 _isMobileDevice() 게이트("암호키
        // 생성은 휴대폰에서만 — 부록 A-1")는 회원가입 *폼* 제출 시점만
        // 지켜왔다. 그런데 이 부트스트랩은 그 폼과 무관하게 gopang-wallet.js가
        // 로드되는 모든 페이지에서 무조건 실행돼서, 같은 사고(PC가 먼저 키를
        // 만들어 나중에 진짜 계정의 키와 어긋남 — PUBKEY_MISMATCH)를 이
        // 경로로는 계속 낼 수 있었다(실사로 재현됨). auth.js를 import하지
        // 않는 독립 스크립트라 같은 판별 로직을 여기 그대로 복제한다(기준을
        // 두 곳에서 다르게 두지 않기 위해 문구까지 동일하게 유지).
        //
        // 모바일: 기존과 동일하게 즉시 자동 생성(1기기 1사용자가 전제이므로
        // 안전 — 폰이 진짜 신규가입 흐름에서 만드는 키와 지금 이 키가 같은
        // 물리적 기기 위에서 만들어짐).
        // PC/판별불가: 자동 생성을 보류한다. window.gopangWallet은 null로
        // 남고, gopangWalletNeedsSetup=true만 세운다 — 배너를 여기서 바로
        // 띄우지 않는다(둘러보기만 하는 방문자에게 불필요한 질문을 먼저
        // 던지지 않기 위해). 실제로 서명이 필요한 순간에 그 호출부가 이
        // 플래그를 보고 "이미 계정이 있나요?" 흐름으로 안내한다(다음 단계).
        const _isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
        if (_isMobile) {
          wallet = await GopangWallet.create();
          console.info('[GopangWallet] 새 지갑 자동 생성 완료 (모바일 기기 확인됨)');
        } else {
          console.info('[GopangWallet] PC/미확인 기기 — 자동 생성 보류. 서명이 필요한 시점에 계정 연결 흐름으로 안내됩니다.');
          global.gopangWallet = null;
          global.gopangWalletNeedsSetup = true;
          try {
            global.dispatchEvent?.(new CustomEvent('gopang:wallet-setup-needed'));
          } catch (e) { /* CustomEvent 미지원 환경 — 조용히 무시 */ }
          return;
        }
      }

      // gopang_user_v4에서 guid 연결
      const stored = (() => {
        try { return JSON.parse(localStorage.getItem('gopang_user_v4') || 'null'); }
        catch { return null; }
      })();
      if (stored?.ipv6) {
        wallet.setIdentity({ guid: stored.ipv6, handle: stored.handle || null });
      }

      // 2026-07-07 재수정: "fs가 비어있으면 동기화"였던 조건을 없앤다.
      // 오늘 가입 시점에 fs를 명시적으로 {bs-cash:0,...}로 초기화하도록
      // 바꿨는데(_initGdcWalletAndFs), 그 결과 fs가 가입 직후부터 절대
      // "비어있지" 않게 돼서 — 이 hydrateFromServer() 호출이 가입 이후
      // 평생 단 한 번도 다시 실행되지 않는 상태가 됐다(사고실험으로 발견).
      // 판매자처럼 거래에 실시간으로 참여하지 않는 기기는 이게 사실상
      // 유일한 재대사 경로인데, 그게 막혀 있었다는 뜻이다. 이제 guid가
      // 있으면 매 앱 실행마다 무조건 서버 값으로 재대사한다 — 실패해도
      // (오프라인 등) 로컬 값을 그대로 쓰면 되므로 앱 시작을 막지 않는다.
      if (stored?.ipv6) {
        try {
          await wallet.hydrateFromServer();
        } catch(e) {
          console.warn('[GopangWallet] 서버 동기화 실패 (무시):', e.message);
        }

        // 5단계(2026-07-23) — 공용 PC 세션에서 이 계정 앞으로 릴레이된
        // 원문이 있으면 가져와 복호화한다. 화면에 어떻게 보여줄지는 이
        // 파일(모듈 아님, ui/bubble.js 등을 import 못 함)의 책임이 아니라
        // 이벤트를 구독하는 쪽(추후 UI 작업)에 맡긴다 — 여기서는 인프라만
        // 완성해둔다. 실패해도(오프라인 등) 앱 시작을 막지 않는다.
        if (typeof wallet.openSealed === 'function' && GopangWallet.pullRelayedContent) {
          try {
            const items = await GopangWallet.pullRelayedContent(wallet, stored.ipv6);
            if (items.length) {
              console.info(`[GopangWallet] 공용 PC 릴레이 항목 ${items.length}건 수신`);
              try {
                global.dispatchEvent?.(new CustomEvent('gopang:relayed-content-received', { detail: { items } }));
              } catch (e) { /* CustomEvent 미지원 환경 — 조용히 무시 */ }
            }
          } catch (e) {
            console.warn('[GopangWallet] 릴레이 조회 실패 (무시):', e.message);
          }
        }
      }

      global.gopangWallet = wallet;
      console.info('[GopangWallet] 싱글턴 초기화 완료 | v' + VERSION
                   + ' | guid:', wallet.guid || '미연결');

      // ── 같은 오리진 탭 간 SSO 서명 릴레이 (2026-07-21 신설) ──────────
      // 오픈해시/고팡 원칙: "서명이 곧 증명, 서버는 검증만 한다" — 그런데
      // 하위 서비스(klaw 등)가 SSO 확인용으로 만드는 보이지 않는 iframe은
      // 사용자 제스처가 없어 WebAuthn(지문)을 새로 못 띄운다(실사로 확인).
      // 이 문제를 서버 세션/쿠키로 우회하면 원칙이 깨지므로, 대신 "이미
      // 이 오리진(hondi.net)에 지갑이 풀려 있는 다른 탭"에게 대신 서명해
      // 달라고 부탁한다.
      //
      // ★ 2026-07-21 같은 날 재설계 — BroadcastChannel만으로는 실사에서
      // 실패가 재현됐다. 최신 Chrome은 BroadcastChannel도 최상위 사이트
      // (top-level site)별로 격리한다(스토리지 파티셔닝) — klaw.hondi.net
      // 안의 숨은 iframe이 여는 채널과 이 탭(webapp.html, 최상위 사이트가
      // hondi.net)이 여는 같은 이름의 채널은 최상위 사이트가 달라 서로
      // 완전히 격리된다. postMessage는 스토리지가 아니라 "실제로 쥐고
      // 있는 창 참조"로 통신하므로 이 제약을 받지 않는다 — 그 iframe은
      // window.parent.opener(=klaw를 연 이 탭)로 직접 도달할 수 있다.
      // 그래서 window 메시지 리스너를 주력으로 쓰고, BroadcastChannel은
      // (같은 최상위 사이트 안의 다른 탭처럼 파티션이 같은 극히 일부
      // 상황에 도움 될 수 있어) 보조로 남겨둔다.
      const _handleSignRequest = async (msg) => {
        // 서명 대상을 "auth-issue:" SSO 신원 증명 챌린지로만 엄격히
        // 제한한다 — 임의 페이로드(거래 등)를 원격에서 서명시키는
        // 통로가 되지 않도록 막는 안전장치다.
        if (typeof msg?.sigMsg !== 'string' || !msg.sigMsg.startsWith('auth-issue:')) return null;
        const parts = msg.sigMsg.split(':');
        const msgTs = parseInt(parts[parts.length - 1], 10);
        if (!msgTs || Math.abs(Date.now() - msgTs) > 30000) return null; // 재생 공격 방지
        try {
          const signature = await wallet.signPayload(msg.sigMsg);
          return { signature, publicKeyB64u: wallet.publicKeyB64u, guid: wallet.guid };
        } catch (e) { return null; }
      };

      // 주력 경로 — window postMessage (opener 체인, 파티셔닝 영향 없음)
      // 두 메시지 종류를 함께 처리한다:
      //  - GOPANG_SIGN_REQUEST: hondi.net 자신의 iframe(silent-auth.html)이
      //    보내는 "이 챌린지에 서명만 해달라" 요청 — 보낸 쪽이 hondi.net
      //    오리진 그 자체이므로 정확히 그 오리진만 신뢰한다.
      //  - GOPANG_ISSUE_TOKEN_REQUEST (2026-07-21 신설) — klaw.hondi.net
      //    등 하위 서비스의 최상위 창이 iframe도 안 거치고 window.opener로
      //    직접 보내는 "나 대신 /auth/issue까지 전부 해서 완성된 토큰을
      //    달라" 요청이다. 이 경우 보낸 쪽은 hondi.net이 아니라
      //    klaw.hondi.net처럼 *.hondi.net 서브도메인이므로, 오리진 검사도
      //    그에 맞게 서브도메인 전체를 허용한다 — 오픈해시 서비스가 아닌
      //    임의 외부 사이트가 opener 참조를 얻어 악용하는 걸 막는 선이다.
      const _isHondiOrigin = (origin) => /^https:\/\/([a-z0-9-]+\.)?hondi\.net$/.test(origin);

      window.addEventListener('message', async (ev) => {
        const msg = ev.data;
        if (!msg) return;

        if (msg.type === 'GOPANG_SIGN_REQUEST') {
          if (ev.origin !== 'https://hondi.net') return; // hondi.net 오리진 프레임만 신뢰
          const result = await _handleSignRequest(msg);
          if (!result) return; // 실패 시 응답 안 함 — 요청 측은 자체 타임아웃으로 로컬 폴백
          ev.source?.postMessage(
            { type: 'GOPANG_SIGN_RESPONSE', requestId: msg.requestId, ...result },
            ev.origin
          );
          return;
        }

        if (msg.type === 'GOPANG_ISSUE_TOKEN_REQUEST') {
          if (!_isHondiOrigin(ev.origin)) return; // *.hondi.net 서비스만 신뢰
          if (!wallet.guid) {
            ev.source?.postMessage({ type: 'GOPANG_ISSUE_TOKEN_RESPONSE', requestId: msg.requestId, ok: false, reason: 'NOT_REGISTERED' }, ev.origin);
            return;
          }
          const svc = typeof msg.svc === 'string' ? msg.svc : 'unknown';
          const level = typeof msg.level === 'string' ? msg.level : 'L0';
          const ts = Date.now();
          const sigMsg = `auth-issue:${wallet.guid}:${wallet.publicKeyB64u}:${svc}:${ts}`;
          try {
            const signature = await wallet.signPayload(sigMsg);
            const res = await fetch('https://hondi-proxy.tensor-city.workers.dev/auth/issue', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guid: wallet.guid, pubkey: wallet.publicKeyB64u, signature, ts, level, svc }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.token) {
              ev.source?.postMessage({ type: 'GOPANG_ISSUE_TOKEN_RESPONSE', requestId: msg.requestId, ok: false, reason: data?.code || `http_${res.status}` }, ev.origin);
              return;
            }
            ev.source?.postMessage({
              type: 'GOPANG_ISSUE_TOKEN_RESPONSE', requestId: msg.requestId, ok: true,
              ipv6: wallet.guid, level: data.level || level,
              exp: Math.floor(ts / 1000) + 3600, token: data.token,
            }, ev.origin);
          } catch (e) {
            ev.source?.postMessage({ type: 'GOPANG_ISSUE_TOKEN_RESPONSE', requestId: msg.requestId, ok: false, reason: 'NETWORK' }, ev.origin);
          }
        }
      });

      // 보조 경로 — BroadcastChannel (같은 최상위 사이트 내 다른 탭 등
      // 파티션이 우연히 같은 경우를 위해 유지, 미지원 브라우저는 무시)
      try {
        const _relayChan = new BroadcastChannel('gopang-wallet-sso-relay');
        _relayChan.onmessage = async (ev) => {
          const result = await _handleSignRequest(ev.data);
          if (!result) return;
          _relayChan.postMessage({ type: 'GOPANG_SIGN_RESPONSE', requestId: ev.data.requestId, ...result });
        };
      } catch (e) {
        // BroadcastChannel 미지원 브라우저 — 조용히 무시(주력 경로는 그대로 동작)
      }
    } catch(e) {
      console.error('[GopangWallet] 초기화 실패:', e.message);
      global.gopangWallet = null;
    }
  })();

})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ====================================================
 * gopang-wallet.js v2.0 사용 예시 (주석)
 * ====================================================
 *
 * // ── 기본 사용 ──────────────────────────────────────
 *
 * // 1) 최초 지갑 생성 (또는 자동 — window.gopangWallet 싱글턴 참조)
 * const wallet = await GopangWallet.create();           // passphrase 없이
 * const wallet = await GopangWallet.create('비밀번호'); // passphrase 지정
 *
 * // 2) 기존 지갑 로드
 * const wallet = await GopangWallet.load();
 * if (!wallet) { // 지갑 없음 → create() }
 *
 * // 3) 신원 연결 (로그인 후)
 * wallet.setIdentity({ handle: '@보영반점#BOY1', guid: '2001:db8::1' });
 *
 * // ── v2.0: UTXO 서명 흐름 ───────────────────────────
 *
 * // 4) GWP_SIGN_REQUEST 수신 시 (gopang-app.js _gwpSignExecute 내부)
 * const signedTx = await window.gopangWallet.sign(rawTx);
 * // signedTx = { tx, tx_hash, buyer_sig, buyer_public_key, prev_settle_hash }
 *
 * // 5) 직접 UTXO tx 빌드 + 서명
 * const { tx, prevSettleHash } = await GopangWallet.buildTxWithPrevHash({
 *   buyerGuid:     '2001:db8::buyer',
 *   sellerGuid:    'pguid-BOYOUNG',
 *   total:         24000,
 *   sellerNet:     23280,
 *   platformFee:   720,
 *   financialState: { 'bs-cash': 100000, 'pl-purchase': 0 },
 *   items: [{ id:'menu-001', name:'짜장면', price:12000, quantity:2 }],
 * });
 * const { tx_hash, buyer_sig } = await GopangWallet.signTx(privateKey, tx);
 *
 * // ── v2.0: 잔액 · 재무 상태 ──────────────────────────
 *
 * // 6) 잔액 조회
 * const balance = await wallet.getBalance();   // bs-cash
 *
 * // 7) 재무 상태 전체 조회
 * const fs = await wallet.getFinancialState();
 * // { 'bs-cash': 76000, 'pl-purchase': 24000, ... }
 *
 * // 8) prev_settle_hash 계산
 * const { prevSettleHash } = await wallet.buildPrevSettleHash();
 *
 * // ── v2.0: 청구권 자기갱신 + Hash Chain ──────────────
 *
 * // 9) L1 청구권 수신 → 재무 상태 갱신 + Hash Chain 기록
 * await wallet.redeemClaim({
 *   block_hash: 'abc123...',
 *   block_id:   'pb-block-id',
 *   tx_hash:    'def456...',
 *   claims: [
 *     { direction:'debit', amount:24000, fs_account:'pl-purchase',
 *       expires_at:'2026-06-13T00:00:00Z' },
 *   ],
 * });
 *
 * // 10) Hash Chain 조회 및 검증
 * const chain  = await wallet.getHashChain();
 * const result = await wallet.verifyChain();
 * // result = { valid: true, broken_at: null }
 *
 * // ── 기타 ────────────────────────────────────────────
 *
 * // 11) nickname_hash 생성
 * const hash = await GopangWallet.nicknameHash('보영반점');
 *
 * // 12) 개인키 백업 / 복원
 * const privB64u = await wallet.exportPrivateKey();
 * const restored = await GopangWallet.importFromBackup(privB64u, wallet.publicKeyB64u);
 *
 * // 13) 서명 검증
 * const ok = await GopangWallet.verify(pubKeyB64u, payload, sig);
 *
 * ==================================================== */


