// Diagnostic: fire ONE real web-push to the caller's own subscription(s),
// bypassing the Supabase webhook, and report every step as JSON.
// Auth: pass ?key=WEBHOOK_SECRET (same secret as push-notify). POST body may
// include { user_id } to target only that user's devices; otherwise targets
// all HQ subscriptions (bounded).
const { sendPush, checkPrivateKey } = require('./lib/push');

const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const VAPID = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privatePem: process.env.VAPID_PRIVATE_KEY || '',
  subject: 'mailto:do-not-reply@uglydonuts-franchiseportal.com',
};

async function restJson(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return [];
  return res.json();
}

exports.handler = async (event) => {
  // Two ways to authenticate:
  //  (a) ?key=WEBHOOK_SECRET  -> for curl / server testing
  //  (b) Authorization: Bearer <supabase access token> -> for the in-app button
  //      (no secret in the client; we verify the token against Supabase auth)
  const key = ((event.queryStringParameters || {}).key || '').trim().replace(/^[<]+|[>]+$/g, '');
  const secret = (WEBHOOK_SECRET || '').trim();
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  let authed = false;
  let sessionUserId = null;

  if (secret && key === secret) {
    authed = true;
  } else if (authHeader.startsWith('Bearer ')) {
    // Verify the caller's Supabase session and require an HQ role.
    try {
      const token = authHeader.slice(7);
      const ures = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
      });
      if (ures.ok) {
        const u = await ures.json();
        if (u && u.id) {
          const profs = await restJson(`profiles?id=eq.${u.id}&select=role`);
          if (profs[0] && profs[0].role === 'hq') { authed = true; sessionUserId = u.id; }
        }
      }
    } catch (e) { /* fall through to 401 */ }
  }
  if (!authed) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const out = { steps: {} };

  // Step 1: env var presence (never leak values).
  out.steps.env = {
    SUPABASE_SERVICE_KEY: !!SERVICE_KEY,
    WEBHOOK_SECRET: !!WEBHOOK_SECRET,
    VAPID_PUBLIC_KEY: !!VAPID.publicKey,
    VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
  };

  // Step 2: can the private key be loaded as an EC key? (catches PEM format breakage)
  out.steps.vapidKey = checkPrivateKey(process.env.VAPID_PRIVATE_KEY);

  // Step 3: which subscriptions will we target?
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  // In-app button: default to the caller's own devices. Curl with ?key: use body.user_id or all HQ.
  const userId = body.user_id || sessionUserId || null;
  let subs = [];
  if (userId) {
    subs = await restJson(`push_subscriptions?user_id=eq.${userId}&select=endpoint,subscription`);
  } else {
    subs = await restJson(`push_subscriptions?role=eq.hq&select=endpoint,subscription&limit=10`);
  }
  out.steps.subscriptions = { target: userId ? 'user' : 'hq', count: subs.length };

  if (!out.steps.vapidKey.ok) {
    out.ok = false;
    out.summary = 'VAPID private key failed to load. Fix VAPID_PRIVATE_KEY env var (see push-test notes).';
    return { statusCode: 200, body: JSON.stringify(out) };
  }
  if (!subs.length) {
    out.ok = false;
    out.summary = userId ? 'No push subscriptions for this user. Enable notifications on a device first.' : 'No HQ push subscriptions found.';
    return { statusCode: 200, body: JSON.stringify(out) };
  }

  // Step 4: actually send one push per target subscription; report each result.
  const payload = {
    title: 'Test push',
    body: 'If you can see this, web push is working.',
    tag: 'push-test',
    data: { url: '/' },
  };
  const results = [];
  for (const s of subs) {
    const sub = s.subscription; // {endpoint, keys:{p256dh, auth}}
    try {
      const r = await sendPush(sub, payload, VAPID);
      results.push({ endpoint: (s.endpoint || '').slice(0, 40) + '...', ...r });
    } catch (e) {
      results.push({ endpoint: (s.endpoint || '').slice(0, 40) + '...', ok: false, error: String((e && e.message) || e) });
    }
  }
  out.steps.send = results;
  const okCount = results.filter(r => r.ok).length;
  out.ok = okCount > 0;
  out.summary = `${okCount}/${results.length} push(es) accepted by the push service.`;
  return { statusCode: 200, body: JSON.stringify(out) };
};
