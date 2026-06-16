// ============================================
// Scheduled reminder: runs daily at 9am ET
// Emails franchisees about tasks/announcements due in ~1 day
// that they haven't completed/confirmed yet.
// Sends each reminder only once (tracked in ops_reminders_sent).
// ============================================
const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'do-not-reply@uglydonuts-franchiseportal.com';
const FROM_NAME = 'Ugly Donuts & Corn Dogs HQ';
const PORTAL_URL = 'https://uglyops.netlify.app';

// Supabase REST helper
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${path}: ${res.status} ${t}`);
  }
  // DELETE/empty may have no body
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
    }),
  });
  return res.ok;
}

// "tomorrow" in ET as YYYY-MM-DD
function tomorrowET() {
  const now = new Date();
  // Convert to ET
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  etNow.setDate(etNow.getDate() + 1);
  const y = etNow.getFullYear();
  const m = String(etNow.getMonth() + 1).padStart(2, '0');
  const d = String(etNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function reminderHtml(kind, itemTitle, storeName, dueDate) {
  const verb = kind === 'task' ? 'complete' : 'confirm receipt of';
  const label = kind === 'task' ? 'Task' : 'Announcement';
  const accent = '#14B8A6';
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0E0E0E;color:#F0EDE8;padding:28px;border-radius:12px;">
    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Franchise Ops · Reminder</div>
    <h2 style="margin:0 0 12px;font-size:18px;">⏰ 24 Hours Remaining</h2>
    <p style="font-size:14px;line-height:1.6;color:#F0EDE8;margin:0 0 16px;">Hi <strong>${storeName}</strong>,</p>
    <p style="font-size:14px;line-height:1.6;color:#8A8480;margin:0 0 16px;">This is a reminder that you have <strong style="color:#F0EDE8;">24 hours</strong> to ${verb} the following ${label.toLowerCase()}:</p>
    <div style="background:#1A2A28;border:1px solid #243634;border-left:3px solid ${accent};border-radius:10px;padding:16px;margin-bottom:18px;">
      <div style="font-size:11px;color:${accent};text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;font-weight:700;">${label}${dueDate ? ` · Due ${dueDate}` : ''}</div>
      <div style="font-size:15px;font-weight:700;">${(itemTitle || '').replace(/</g, '&lt;')}</div>
    </div>
    <a href="${PORTAL_URL}" style="display:inline-block;background:${accent};color:#04201C;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Franchisee Portal →</a>
    <p style="color:#5A5654;font-size:11px;margin-top:24px;">Ugly Donuts & Corn Dogs · This is an automated reminder.</p>
  </div>`;
}

exports.handler = async () => {
  const due = tomorrowET();
  let taskEmails = 0, annEmails = 0, skipped = 0;
  const log = [];

  try {
    // Already-sent reminders (to avoid duplicates)
    const sentRows = await sb(`ops_reminders_sent?select=franchisee_id,item_type,item_id`);
    const sentKey = new Set(sentRows.map(r => `${r.franchisee_id}|${r.item_type}|${r.item_id}`));

    // Open franchisees with email
    const franchisees = await sb(`franchisees?status=eq.open&select=id,name,store_name,email`);
    const frById = {};
    franchisees.forEach(f => { frById[f.id] = f; });

    // ---------- TASKS due tomorrow ----------
    // tasks with due_date = tomorrow, not archived
    const tasks = await sb(`ops_tasks?due_date=eq.${due}&status=neq.archived&select=id,title,due_date`);
    for (const task of tasks) {
      // assignments for this task that aren't approved yet
      const assigns = await sb(`ops_assignments?ops_task_id=eq.${task.id}&status=neq.approved&select=id,franchisee_id,status`);
      for (const a of assigns) {
        const fr = frById[a.franchisee_id];
        if (!fr || !fr.email) { skipped++; continue; }
        const key = `${fr.id}|task|${task.id}`;
        if (sentKey.has(key)) { skipped++; continue; }
        const ok = await sendEmail(
          fr.email,
          `⏰ 24 hours left: ${task.title}`,
          reminderHtml('task', task.title, fr.store_name || fr.name, task.due_date)
        );
        if (ok) {
          await sb(`ops_reminders_sent`, {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ franchisee_id: fr.id, item_type: 'task', item_id: task.id, due_date: task.due_date }),
          });
          taskEmails++;
          log.push(`task→${fr.store_name}`);
        }
      }
    }

    // ---------- ANNOUNCEMENTS due tomorrow ----------
    const anns = await sb(`ops_announcements?due_date=eq.${due}&status=eq.active&select=id,title,due_date`);
    for (const ann of anns) {
      // receipts for this announcement that are NOT confirmed
      const receipts = await sb(`ops_announcement_receipts?announcement_id=eq.${ann.id}&confirmed=eq.false&select=franchisee_id,confirmed`);
      for (const r of receipts) {
        const fr = frById[r.franchisee_id];
        if (!fr || !fr.email) { skipped++; continue; }
        const key = `${fr.id}|announcement|${ann.id}`;
        if (sentKey.has(key)) { skipped++; continue; }
        const ok = await sendEmail(
          fr.email,
          `⏰ 24 hours left to confirm: ${ann.title}`,
          reminderHtml('announcement', ann.title, fr.store_name || fr.name, ann.due_date)
        );
        if (ok) {
          await sb(`ops_reminders_sent`, {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ franchisee_id: fr.id, item_type: 'announcement', item_id: ann.id, due_date: ann.due_date }),
          });
          annEmails++;
          log.push(`ann→${fr.store_name}`);
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, due, taskEmails, annEmails, skipped, log }),
    };
  } catch (err) {
    console.error('reminder error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Netlify scheduled config: 9am ET.
// ET is UTC-5 (EST) / UTC-4 (EDT). We use 13:00 UTC ≈ 9am EDT (summer) / 8am EST (winter).
// Cron runs in UTC. 13:00 UTC chosen as a stable single daily run.
exports.config = {
  schedule: '0 13 * * *',
};
