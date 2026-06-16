// Creates a franchisee account using Supabase Admin API
// so HQ session is never affected
const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { email, storeName, franchiseeId } = JSON.parse(event.body);
    if (!email || !storeName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'email and storeName required' }) };

    const tempPass = Math.random().toString(36).slice(-8) + 'Aa1!';

    // Create user via Admin API (doesn't affect current session)
    const createRes = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        email,
        password: tempPass,
        email_confirm: true, // skip email confirmation
        user_metadata: { name: storeName },
      }),
    });
    const userData = await createRes.json();
    if (!createRes.ok) return { statusCode: 400, headers, body: JSON.stringify({ error: userData.message || userData.msg || 'User creation failed' }) };

    const userId = userData.id;

    // Insert profile via service key (include franchisee_id if provided)
    await fetch(`${SUPA_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: userId, full_name: storeName, name: storeName, role: 'franchisee', store: storeName, is_active: true, franchisee_id: franchiseeId || null }),
    });

    // Send welcome email via Resend
    let emailSent = false;
    if (RESEND_API_KEY) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Ugly Donuts & Corn Dogs HQ <do-not-reply@uglydonuts-franchiseportal.com>',
          to: [email],
          subject: 'Your Ugly Donuts Franchise Ops Account',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0E0E0E;color:#F0EDE8;padding:32px;border-radius:12px;"><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#CC9C3A;margin-bottom:8px;">Ugly Donuts & Corn Dogs</div><h1 style="font-size:22px;margin:0 0 8px;">Welcome to Franchise Ops</h1><p style="color:#8A8480;font-size:14px;margin:0 0 24px;">Your Franchise Ops account for <strong style="color:#F0EDE8;">${storeName}</strong> has been activated.</p><div style="background:#1E1E1E;border:1px solid #2E2E2E;border-radius:10px;padding:20px;margin-bottom:20px;"><div style="margin-bottom:14px;"><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Login URL</div><div style="font-size:15px;font-weight:700;color:#F26419;">https://uglyops.netlify.app</div></div><div style="margin-bottom:14px;"><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Email</div><div style="font-size:15px;font-weight:700;">${email}</div></div><div><div style="font-size:11px;color:#8A8480;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Temporary Password</div><div style="font-size:22px;font-weight:700;font-family:monospace;letter-spacing:.1em;color:#CC9C3A;">${tempPass}</div></div></div><div style="background:rgba(204,156,58,.08);border:1px solid rgba(204,156,58,.3);border-radius:8px;padding:12px;margin-bottom:20px;"><p style="color:#CC9C3A;font-size:13px;margin:0;">⚠ Please change your password after first login in the Settings menu.</p></div><a href="https://uglyops.netlify.app" style="display:inline-block;background:#F26419;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Login to Franchise Ops →</a><p style="color:#5A5654;font-size:11px;margin-top:24px;">Ugly Donuts & Corn Dogs Franchising LLC · Belleville, NJ</p></div>`,
        }),
      });
      emailSent = emailRes.ok;
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, emailSent: false, tempPass, emailError: errText }) };
      }
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, emailSent: false, tempPass, emailError: 'RESEND_API_KEY not set in Netlify env vars' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, emailSent, tempPass }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
