// Receives Supabase Database Webhooks and fans out push notifications.
// Secured by ?key=WEBHOOK_SECRET (set in Netlify env). Uses the service key
// for DB reads (bypasses RLS; this function is server-side only).
const { sendPush } = require('./lib/push');

const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const VAPID = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privatePem: (process.env.VAPID_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  subject: 'mailto:do-not-reply@uglydonuts-franchiseportal.com',
};

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
  const key = (event.queryStringParameters || {}).key;
  if (!WEBHOOK_SECRET || key !== WEBHOOK_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let hook = {};
  try { hook = JSON.parse(event.body || '{}'); } catch (e) {}
  const { type, table, record, old_record } = hook;
  if (!table || !record) return { statusCode: 400, body: JSON.stringify({ error: 'bad payload' }) };

  let sent = 0;

  try {
    // 1) New task assigned -> that franchisee
    if (table === 'ops_assignments' && type === 'INSERT') {
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
    }

    // 2) New announcement published -> all franchisee devices
    else if (table === 'ops_announcements' && type === 'INSERT' && record.status === 'active') {
      const subs = await subsForAllFranchisees();
      sent = await fanout(subs, async (s) => ({
        title: 'New announcement', body: record.title || '', tag: 'ann-' + record.id, data: { url: '/#open=announce' },
        badge: s.franchisee_id ? await frBadge(s.franchisee_id) : undefined,
      }));
      await logNotif({ role: 'franchisee' }, { title: 'New announcement', body: record.title || '', tag: 'ann-' + record.id, data: { url: '/#open=announce' } });
    }

    // 5) Franchisee sends a new message -> all HQ
    else if (table === 'ops_messages' && type === 'INSERT') {
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
    // Franchisee advanced into a new phase → notify the C-levels who own tasks in that phase.
    else if (table === 'franchisees' && type === 'UPDATE'
             && record.current_phase_id
             && (!old_record || old_record.current_phase_id !== record.current_phase_id)) {
      const owners = await ownersForPhase(record.current_phase_id);
      const subs = await subsForHQTitles(owners);
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

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
