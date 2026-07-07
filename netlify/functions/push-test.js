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

// PATCH a row and return the updated representation.
async function restPatch(path, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const ok = res.ok;
  let data = [];
  try { data = await res.json(); } catch (e) {}
  return { ok, status: res.status, data };
}

// Fire a real webhook by briefly changing an existing row, then restore it.
// Returns what was toggled so the UI can show it. Restoration is guaranteed
// via finally, even if the intermediate step throws.
async function simulateEvent(kind) {
  if (kind === 'task_submitted') {
    // Pick any existing assignment; flip status to 'submitted' then restore.
    const rows = await restJson(`ops_assignments?select=id,status&limit=1`);
    if (!rows.length) return { ok: false, reason: 'No ops_assignments rows exist to test with.' };
    const row = rows[0];
    const original = row.status;
    if (original === 'submitted') {
      // Already submitted: toggle to 'active' first so the change is real.
      try {
        await restPatch(`ops_assignments?id=eq.${row.id}`, { status: 'active' });
        await new Promise(r => setTimeout(r, 400));
        const up = await restPatch(`ops_assignments?id=eq.${row.id}`, { status: 'submitted' });
        return { ok: up.ok, fired: 'ops_assignments UPDATE -> submitted', rowId: row.id, restored: true };
      } finally {
        await restPatch(`ops_assignments?id=eq.${row.id}`, { status: original });
      }
    }
    try {
      const up = await restPatch(`ops_assignments?id=eq.${row.id}`, { status: 'submitted' });
      return { ok: up.ok, fired: 'ops_assignments UPDATE -> submitted', rowId: row.id, restoredTo: original };
    } finally {
      await restPatch(`ops_assignments?id=eq.${row.id}`, { status: original });
    }
  }

  if (kind === 'phase_change') {
    // Pick a franchisee with a phase; bump current_phase_id to another phase then restore.
    const frs = await restJson(`franchisees?select=id,store_name,name,current_phase_id&current_phase_id=not.is.null&limit=1`);
    if (!frs.length) return { ok: false, reason: 'No franchisee with a current phase to test with.' };
    const fr = frs[0];
    const phases = await restJson(`phases?select=id&limit=5`);
    const other = (phases.find(p => p.id !== fr.current_phase_id) || {}).id;
    if (!other) return { ok: false, reason: 'Need at least two phases to simulate a phase change.' };
    const original = fr.current_phase_id;
    try {
      const up = await restPatch(`franchisees?id=eq.${fr.id}`, { current_phase_id: other });
      return { ok: up.ok, fired: 'franchisees UPDATE -> phase change', store: fr.store_name || fr.name, restoredTo: original };
    } finally {
      await restPatch(`franchisees?id=eq.${fr.id}`, { current_phase_id: original });
    }
  }

  return { ok: false, reason: 'Unknown simulate kind: ' + kind };
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

  // ── Optional: simulate a real webhook event by briefly toggling an existing
  // row and restoring it. This fires the actual Supabase webhook end to end.
  // Only UPDATE-based events are simulated (safely reversible); INSERT events
  // would leave real rows behind, so we never fake those.
  let sim = null;
  try { sim = (JSON.parse(event.body || '{}')).simulate || null; } catch (e) {}
  if (sim) {
    const r = await simulateEvent(sim);
    return { statusCode: 200, body: JSON.stringify({ simulate: sim, ...r }) };
  }

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
