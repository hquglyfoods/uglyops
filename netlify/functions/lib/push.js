// Zero-dependency Web Push sender (node crypto only).
// Implements VAPID (RFC 8292, ES256 JWT) + payload encryption (RFC 8291, aes128gcm).
const crypto = require('crypto');

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

// Normalize a VAPID private key from ANY of three env-var formats into a PEM
// string that crypto.createPrivateKey / createSign can read:
//   (1) base64-encoded PEM on a single line (no "BEGIN" visible until decoded)
//   (2) PEM with literal "\n" escape sequences instead of real newlines
//   (3) a real multi-line PEM
// Returns the PEM string. Throws only if the result is empty.
function normalizePrivateKey(raw) {
  let pem = raw || '';
  // (1) If it doesn't contain BEGIN, it may be base64-wrapped PEM. Try to decode.
  if (!pem.includes('BEGIN')) {
    try {
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) pem = decoded;
    } catch (_) { /* leave as-is */ }
  }
  // (2) Turn escaped "\n" into real newlines.
  pem = pem.replace(/\\n/g, '\n').trim();
  return pem;
}

// Validate that a normalized PEM loads as an EC private key. Returns
// {ok:true, type} or {ok:false, error} without throwing.
function checkPrivateKey(raw) {
  try {
    const pem = normalizePrivateKey(raw);
    if (!pem) return { ok: false, error: 'empty' };
    const key = crypto.createPrivateKey(pem);
    return { ok: key.asymmetricKeyType === 'ec', type: key.asymmetricKeyType };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- VAPID ES256 JWT ----
// createSign returns a DER-encoded ECDSA signature; JOSE needs raw r||s (64 bytes).
function derToJose(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad der');
  if (der[i] & 0x80) i += (der[i] & 0x7f) + 1; else i++;
  if (der[i++] !== 0x02) throw new Error('bad der r');
  let rl = der[i++]; let r = der.slice(i, i + rl); i += rl;
  if (der[i++] !== 0x02) throw new Error('bad der s');
  let sl = der[i++]; let s = der.slice(i, i + sl);
  r = Buffer.from(r); s = Buffer.from(s);
  while (r.length > 32) r = r.slice(1);
  while (s.length > 32) s = s.slice(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

function vapidJwt(audience, subject, privatePem, publicB64u) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const signer = crypto.createSign('SHA256');
  signer.update(header + '.' + payload);
  const der = signer.sign(normalizePrivateKey(privatePem));
  return header + '.' + payload + '.' + b64u(derToJose(der));
}

// ---- RFC 8291 aes128gcm encryption ----
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.slice(0, len);
}

function encrypt(payload, p256dhB64, authB64) {
  const uaPub = Buffer.from(p256dhB64, 'base64url');   // 65 bytes
  const authSecret = Buffer.from(authB64, 'base64url'); // 16 bytes

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(); // 65 bytes uncompressed
  const shared = ecdh.computeSecret(uaPub);

  const salt = crypto.randomBytes(16);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" + uaPub + asPub, 32)
  const ikmInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = hkdf(authSecret, shared, ikmInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // plaintext + 0x02 delimiter padding (last record)
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  // body = salt(16) | rs(4, =4096) | idlen(1, =65) | asPub(65) | ciphertext+tag
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPub, ct]);
}

/**
 * Send one push. subscription = {endpoint, keys:{p256dh, auth}}
 * Returns {ok:true} | {gone:true} (unsubscribed device) | {ok:false, status, text}
 */
async function sendPush(subscription, payloadObj, vapid) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return { ok: false, status: 0, text: 'bad subscription' };
  const url = new URL(endpoint);
  const audience = url.origin;
  const jwt = vapidJwt(audience, vapid.subject, vapid.privatePem, vapid.publicKey);
  const body = encrypt(JSON.stringify(payloadObj), keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'TTL': '86400',
      'Urgency': 'high',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, status: res.status, text: await res.text().catch(() => '') };
}

module.exports = { sendPush, normalizePrivateKey, checkPrivateKey };
