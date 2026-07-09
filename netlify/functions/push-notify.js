// Receives Supabase Database Webhooks and fans out push notifications.
// Secured by ?key=WEBHOOK_SECRET (set in Netlify env). Uses the service key
// for DB reads (bypasses RLS; this function is server-side only).
const { sendPush } = require('./lib/push');

const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const VAPID = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  // Pass the raw env var; lib/push normalizePrivateKey handles all 3 formats
  // (base64 PEM / escaped \n / real newlines).
  privatePem: process.env.VAPID_PRIVATE_KEY || '',
  subject: 'mailto:do-not-reply@uglydonuts-franchiseportal.com',
};

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'do-not-reply@uglydonuts-franchiseportal.com';
const FROM_NAME = 'Ugly Donuts Franchise Ops';
// HQ notification inbox for resubmission alerts. profiles has no email column,
// so configure HQ recipients via env (comma-separated) or this fallback.
const HQ_EMAILS = (process.env.HQ_NOTIFY_EMAILS || 'hq@uglydonutsncorndogs.com')
  .split(',').map(s => s.trim()).filter(Boolean);

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) return false;
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: list, subject, html }),
    });
    return res.ok;
  } catch (e) { return false; }
}

function emailShell(heading, intro, bodyHtml) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0E0E0E;color:#F0EDE8;padding:32px;border-radius:12px;">`
    + `<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#CC9C3A;margin-bottom:8px;">Ugly Donuts &amp; Corn Dogs</div>`
    + `<h1 style="font-size:22px;margin:0 0 4px;color:#F0EDE8;">${heading}</h1>`
    + `<p style="color:#8A8480;font-size:13px;margin:0 0 24px;">${intro}</p>`
    + (bodyHtml || '')
    + `<a href="https://uglyops.netlify.app/" style="display:inline-block;background:#F26419;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Franchise Ops</a>`
    + `<p style="color:#5A5654;font-size:11px;margin-top:24px;">Ugly Donuts &amp; Corn Dogs Franchising LLC · Belleville, NJ</p></div>`;
}

async function rest(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return res;
}
async function restJson(path) {
  const r = await rest(path);
  if (!r.ok) return [];
  return r.json();
}
async function restCount(path) {
  const r = await rest(path, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
  const cr = r.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(n) ? n : 0;
}

// ---- badge counts (mirror the in-app definitions) ----
async function hqBadge() {
  const [a, m, w] = await Promise.all([
    restCount('ops_assignments?status=eq.submitted&select=id'),
    restCount('ops_messages?is_read=eq.false&select=id'),
    restCount('ops_warnings?status=eq.submitted&select=id'),
  ]);
  return a + m + w;
}
async function frBadge(frId) {
  const [t, hq, anns, receipts] = await Promise.all([
    restCount(`ops_assignments?franchisee_id=eq.${frId}&status=in.(pending,in_progress,rejected)&select=id`),
    restCount(`ops_messages?franchisee_id=eq.${frId}&last_sender_role=eq.hq&select=id`),
    restJson('ops_announcements?status=eq.active&select=id'),
    restJson(`ops_announcement_receipts?franchisee_id=eq.${frId}&confirmed=eq.true&select=announcement_id`),
  ]);
  const confirmed = new Set(receipts.map(r => r.announcement_id));
  const unconfirmed = anns.filter(a => !confirmed.has(a.id)).length;
  return t + hq + unconfirmed;
}

// ---- recipient selection ----
async function subsForHQ() {
  return restJson(`push_subscriptions?role=eq.hq&select=endpoint,subscription`);
}
async function subsForFranchisee(frId) {
  if (!frId) return [];
  return restJson(`push_subscriptions?franchisee_id=eq.${frId}&select=endpoint,subscription`);
}
async function subsForAllFranchisees() {
  return restJson(`push_subscriptions?role=neq.hq&select=endpoint,subscription,franchisee_id`);
}
// HQ subscriptions whose owning profile has one of the given C-level titles (CEO/COO/...).
// push_subscriptions has user_id; profiles has title. We join in two cheap queries.
async function subsForHQTitles(titles) {
  if (!titles || !titles.length) return [];
  // 1) HQ profiles matching those titles
  const inList = titles.map(t => encodeURIComponent(t)).join(',');
  const profs = await restJson(`profiles?role=eq.hq&title=in.(${inList})&select=id,title`);
  if (!profs.length) return [];
  const idInList = profs.map(p => p.id).join(',');
  // 2) their push subscriptions
  const subs = await restJson(`push_subscriptions?role=eq.hq&user_id=in.(${idInList})&select=endpoint,subscription,user_id`);
  return subs;
}
// Distinct task owners (titles) configured for a phase.
async function ownersForPhase(phaseId) {
  if (!phaseId) return [];
  const rows = await restJson(`phase_tasks?phase_id=eq.${phaseId}&select=owner`);
  const set = new Set();
  for (const r of rows) {
    const o = (r.owner || '').trim();
    if (o && o.toUpperCase() !== 'HQ' && o.toUpperCase() !== 'FRANCHISEE') set.add(o);
  }
  return Array.from(set);
}

async function fanout(subs, payloadFor) {
  const results = await Promise.allSettled(subs.map(async s => {
    const payload = await payloadFor(s);
    const r = await sendPush(s.subscription, payload, VAPID);
    if (r.gone) await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' });
    return r;
  }));
  return results.filter(x => x.status === 'fulfilled' && x.value && x.value.ok).length;
}

// Persist a notification so the in-app bell can show a history.
// audience: { role:'hq' } for all HQ, { franchisee_id } for one store,
//           { titles:[...] } for specific C-levels (stored as a comma list).
async function logNotif(audience, n) {
  try {
    const row = {
      title: (n.title || '').slice(0, 160),
      body: (n.body || '').slice(0, 400),
      url: (n.data && n.data.url) || null,
      tag: n.tag || null,
      audience_role: audience.role || (audience.franchisee_id ? 'franchisee' : 'hq'),
      franchisee_id: audience.franchisee_id || null,
      titles: audience.titles && audience.titles.length ? audience.titles.join(',') : null,
    };
    await rest('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  } catch (e) { /* logging must never break push */ }
}

exports.handler = async (event) => {
  // Defensive key parse: strip surrounding angle brackets (leftover placeholder
  // "<SECRET>") and whitespace so a mis-pasted webhook URL still authenticates.
  const key = ((event.queryStringParameters || {}).key || '').trim().replace(/^[<]+|[>]+$/g, '');
  const secret = (WEBHOOK_SECRET || '').trim();
  if (!secret || key !== secret) {
    console.log('WEBHOOK AUTH FAIL', { hasSecret: !!secret, keyLen: key.length });
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let hook = {};
  try { hook = JSON.parse(event.body || '{}'); } catch (e) {}
  const { type, table, record, old_record } = hook;
  console.log('WEBHOOK IN', { table, type, keys: record ? Object.keys(record) : [] });
  if (!table || !record) return { statusCode: 400, body: JSON.stringify({ error: 'bad payload' }) };

  let sent = 0;
  let matched = null;   // which branch handled this event (for diagnostics)

  try {
    // 1) New task assigned -> that franchisee
    if (table === 'ops_assignments' && type === 'INSERT') {
      matched = 'task_assigned';
      const subs = await subsForFranchisee(record.franchisee_id);
      const badge = await frBadge(record.franchisee_id);
      const tasks = await restJson(`ops_tasks?id=eq.${record.ops_task_id}&select=title`);
      const title = tasks[0] ? tasks[0].title : 'a new task';
      sent = await fanout(subs, async () => ({
        title: 'New task assigned', body: title, tag: 'task-' + record.id, badge, data: { url: '/#open=tasks' },
      }));
      await logNotif({ franchisee_id: record.franchisee_id }, { title: 'New task assigned', body: title, tag: 'task-' + record.id, data: { url: '/#open=tasks' } });
    }

    // 6) Proof submitted (status changed to submitted) -> all HQ
    else if (table === 'ops_assignments' && type === 'UPDATE'
             && record.status === 'submitted' && (!old_record || old_record.status !== 'submitted')) {
      matched = 'task_submitted';
      const subs = await subsForHQ();
      const badge = await hqBadge();
      const [frs, tasks] = await Promise.all([
        restJson(`franchisees?id=eq.${record.franchisee_id}&select=store_name,name`),
        restJson(`ops_tasks?id=eq.${record.ops_task_id}&select=title`),
      ]);
      const store = frs[0] ? (frs[0].store_name || frs[0].name) : 'A store';
      const title = tasks[0] ? tasks[0].title : 'a task';
      sent = await fanout(subs, async () => ({
        title: 'Submitted for review', body: `${store}: ${title}`, tag: 'review-' + record.id, badge, data: { url: '/#open=review&id=' + record.id },
      }));
      await logNotif({ role: 'hq' }, { title: 'Submitted for review', body: `${store}: ${title}`, tag: 'review-' + record.id, data: { url: '/#open=review&id=' + record.id } });
      // Resubmission (was rejected) -> email HQ so they know to re-review.
      if (old_record && old_record.status === 'rejected' && HQ_EMAILS.length) {
        try {
          await sendEmail(HQ_EMAILS, `Resubmitted: ${title}`, emailShell('Task Resubmitted',
            `${store} has made changes and resubmitted a task for your review.`,
            `<div style="background:#1E1E1E;border:1px solid #2E2E2E;border-radius:10px;padding:20px;margin-bottom:20px;"><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Store</div><div style="font-size:16px;font-weight:700;margin-bottom:10px;">${store}</div><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Task</div><div style="font-size:18px;font-weight:700;">${title}</div></div>`));
        } catch (e) { /* email must never break the webhook */ }
      }
    }

    // 1b) HQ rejects a submission -> notify that franchisee's devices
    else if (table === 'ops_assignments' && type === 'UPDATE'
             && record.status === 'rejected' && (!old_record || old_record.status !== 'rejected')) {
      matched = 'task_rejected';
      const subs = await subsForFranchisee(record.franchisee_id);
      const badge = await frBadge(record.franchisee_id);
      const tasks = await restJson(`ops_tasks?id=eq.${record.ops_task_id}&select=title`);
      const title = tasks[0] ? tasks[0].title : 'a task';
      const note = record.hq_notes ? String(record.hq_notes).slice(0, 120) : 'Please review HQ feedback and resubmit.';
      sent = await fanout(subs, async () => ({
        title: 'Changes requested', body: `${title}: ${note}`, tag: 'reject-' + record.id, badge, data: { url: '/#open=tasks&id=' + record.id },
      }));
      await logNotif({ role: 'franchisee', franchisee_id: record.franchisee_id }, { title: 'Changes requested', body: `${title}: ${note}`, tag: 'reject-' + record.id, data: { url: '/#open=tasks&id=' + record.id } });
      // Email the franchisee (covers every reject path, since this fires on the DB update).
      try {
        const frs = await restJson(`franchisees?id=eq.${record.franchisee_id}&select=email,store_name,name`);
        const fr = frs[0];
        if (fr && fr.email) {
          const who = fr.store_name || fr.name || 'there';
          await sendEmail(fr.email, `Changes requested: ${title}`, emailShell('Changes Requested',
            `Hi ${who}, HQ reviewed your submission and asked for some changes.`,
            `<div style="background:#1E1E1E;border:1px solid #2E2E2E;border-radius:10px;padding:20px;margin-bottom:20px;"><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Task</div><div style="font-size:20px;font-weight:700;margin-bottom:12px;">${title}</div>${record.hq_notes ? `<div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">HQ Feedback</div><div style="font-size:14px;color:#E05252;">${record.hq_notes}</div>` : ''}</div><p style="color:#8A8480;font-size:13px;margin:0 0 20px;">Please make the changes and resubmit. Your original submission is kept on record.</p>`));
        }
      } catch (e) { /* email must never break the webhook */ }
    }

    // 2) New announcement published -> all franchisee devices
    else if (table === 'ops_announcements' && type === 'INSERT' && record.status === 'active') {
      matched = 'announcement';
      const subs = await subsForAllFranchisees();
      sent = await fanout(subs, async (s) => ({
        title: 'New announcement', body: record.title || '', tag: 'ann-' + record.id, data: { url: '/#open=announce' },
        badge: s.franchisee_id ? await frBadge(s.franchisee_id) : undefined,
      }));
      await logNotif({ role: 'franchisee' }, { title: 'New announcement', body: record.title || '', tag: 'ann-' + record.id, data: { url: '/#open=announce' } });
    }

    // 5) Franchisee sends a new message -> all HQ
    else if (table === 'ops_messages' && type === 'INSERT') {
      matched = 'message';
      const subs = await subsForHQ();
      const badge = await hqBadge();
      sent = await fanout(subs, async () => ({
        title: `Message from ${record.store_name || 'a store'}`,
        body: record.subject || record.topic || '', tag: 'msg-' + record.id, badge, data: { url: '/#open=messages' },
      }));
      await logNotif({ role: 'hq' }, { title: `Message from ${record.store_name || 'a store'}`, body: record.subject || record.topic || '', tag: 'msg-' + record.id, data: { url: '/#open=messages' } });
    }

    // 3) Reply on a message thread -> the other side
    else if (table === 'ops_message_replies' && type === 'INSERT') {
      matched = 'message_reply';
      const msgs = await restJson(`ops_messages?id=eq.${record.message_id}&select=franchisee_id,subject,store_name`);
      const msg = msgs[0];
      if (msg) {
        if (record.sender_role === 'hq') {
          const subs = await subsForFranchisee(msg.franchisee_id);
          const badge = await frBadge(msg.franchisee_id);
          sent = await fanout(subs, async () => ({
            title: 'HQ replied', body: msg.subject || '', tag: 'reply-' + record.message_id, badge, data: { url: '/#open=contact' },
          }));
          await logNotif({ franchisee_id: msg.franchisee_id }, { title: 'HQ replied', body: msg.subject || '', tag: 'reply-' + record.message_id, data: { url: '/#open=contact' } });
        } else {
          const subs = await subsForHQ();
          const badge = await hqBadge();
          sent = await fanout(subs, async () => ({
            title: `Reply from ${msg.store_name || 'a store'}`, body: msg.subject || '', tag: 'reply-' + record.message_id, badge, data: { url: '/#open=messages' },
          }));
          await logNotif({ role: 'hq' }, { title: `Reply from ${msg.store_name || 'a store'}`, body: msg.subject || '', tag: 'reply-' + record.message_id, data: { url: '/#open=messages' } });
        }
      }
    }

    // 4) Warning issued -> that franchisee
    else if (table === 'ops_warnings' && type === 'INSERT') {
      matched = 'warning';
      const subs = await subsForFranchisee(record.franchisee_id);
      const badge = await frBadge(record.franchisee_id);
      const reason = (record.reason || '').slice(0, 90);
      sent = await fanout(subs, async () => ({
        title: 'Warning issued by HQ',
        body: [record.category, reason].filter(Boolean).join(': ') || 'Please review and respond in the portal.',
        tag: 'warn-' + record.id, badge, data: { url: '/#open=warnings' },
      }));
      await logNotif({ franchisee_id: record.franchisee_id }, { title: 'Warning issued by HQ', body: [record.category, reason].filter(Boolean).join(': ') || 'Please review and respond in the portal.', tag: 'warn-' + record.id, data: { url: '/#open=warnings' } });
    }
    // High-severity error report -> notify HQ so silent failures surface fast.
    else if (table === 'error_reports' && type === 'INSERT' && record.severity === 'high') {
      matched = 'error_report';
      const subs = await subsForHQ();
      const who = record.store_name ? `${record.store_name}` : (record.role || 'a user');
      sent = await fanout(subs, async () => ({
        title: 'App error reported',
        body: `${record.context || 'error'}: ${(record.message || '').slice(0, 80)} (${who})`,
        tag: 'err-' + record.id, data: { url: '/#open=password' },
      }));
      await logNotif({ role: 'hq' }, { title: 'App error reported', body: `${record.context || 'error'} (${who})`, tag: 'err-' + record.id, data: { url: '/#open=password' } });
    }
    // Franchisee advanced into a new phase → notify the C-levels who own tasks in that phase.
    else if (table === 'franchisees' && type === 'UPDATE'
             && record.current_phase_id
             && (!old_record || old_record.current_phase_id !== record.current_phase_id)) {
      const owners = await ownersForPhase(record.current_phase_id);
      const subs = await subsForHQTitles(owners);
      matched = 'phase_change';
      if (subs.length) {
        const [phaseRows, frName] = [
          await restJson(`phases?id=eq.${record.current_phase_id}&select=name`),
          record.store_name || record.name || 'A franchisee',
        ];
        const phaseName = (phaseRows[0] && phaseRows[0].name) || 'a new phase';
        sent = await fanout(subs, async () => ({
          title: `Now in ${phaseName}`,
          body: `${frName} entered ${phaseName}. Your team owns tasks in this phase.`,
          tag: 'phase-' + record.id + '-' + record.current_phase_id,
          data: { url: '/os.html#open=board' },
        }));
        await logNotif({ role: 'hq', titles: owners }, { title: `Now in ${phaseName}`, body: `${frName} entered ${phaseName}. Your team owns tasks in this phase.`, tag: 'phase-' + record.id + '-' + record.current_phase_id, data: { url: '/os.html#open=board' } });
      }
    }
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }

  if (!matched) {
    console.log('WEBHOOK NO MATCH', { table, type });
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, matched: null, reason: 'no handler for this table/type/condition', table, type }) };
  }
  console.log('WEBHOOK HANDLED', { matched, sent });
  return { statusCode: 200, body: JSON.stringify({ ok: true, sent, matched }) };
};
