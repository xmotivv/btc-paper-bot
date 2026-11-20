'use strict';
// Authenticated client for the Polymarket US trading API (api.polymarket.us).
//
// Credentials are an API key pair created at polymarket.us/developer: a Key ID
// and an Ed25519 secret. Every request is signed as
//     base64( ed25519( `${timestampMs}${METHOD}${path}` ) )
// — the same scheme as Polymarket's official SDK, implemented with Node's
// built-in crypto so the secret never passes through third-party code.
//
// This file only talks to the exchange. All decisions about whether an order
// may be sent live in live.js.

const crypto = require('crypto');

const API = 'https://api.polymarket.us';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Turn the base64 secret from the developer portal into a signing key. Throws if it isn't one. */
function loadSecret(secretKey) {
  const raw = Buffer.from(String(secretKey || '').trim(), 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error('That does not look like a Polymarket US secret key (expected a base64 string from the developer portal).');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class UsClient {
  constructor({ keyId, secretKey, fetchImpl = fetch, now = () => Date.now(), baseUrl = API }) {
    this.keyId = String(keyId || '').trim();
    if (!this.keyId) throw new Error('Key ID is required.');
    this._key = loadSecret(secretKey);
    this.fetch = fetchImpl;
    this.now = now;
    this.baseUrl = baseUrl;
  }

  headers(method, path) {
    const timestamp = String(this.now());
    const signature = crypto.sign(null, Buffer.from(`${timestamp}${method}${path}`), this._key).toString('base64');
    return {
      'X-PM-Access-Key': this.keyId,
      'X-PM-Timestamp': timestamp,
      'X-PM-Signature': signature,
      'Content-Type': 'application/json',
      accept: 'application/json',
    };
  }

  /** `path` is signed without its query string, as the exchange expects. */
  async request(method, path, { query, body, timeoutMs = 8000 } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await this.fetch(url.toString(), {
        method,
        headers: this.headers(method, url.pathname),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new ApiError(0, e.name === 'AbortError' ? 'Request timed out' : e.message);
    } finally {
      clearTimeout(timer);
    }
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; }
    }
    if (!res.ok) throw new ApiError(res.status, data.message || data.error || `HTTP ${res.status}`);
    return data;
  }

  balances() { return this.request('GET', '/v1/account/balances'); }
  positions(market) { return this.request('GET', '/v1/portfolio/positions', { query: market ? { market } : undefined }); }
  openOrders() { return this.request('GET', '/v1/orders/open'); }
  order(id) { return this.request('GET', `/v1/order/${encodeURIComponent(id)}`); }
  createOrder(order) { return this.request('POST', '/v1/orders', { body: order, timeoutMs: 12000 }); }
  cancelAll() { return this.request('POST', '/v1/orders/open/cancel', { body: {} }); }
}

module.exports = { UsClient, ApiError, loadSecret, API };
