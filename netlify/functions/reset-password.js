// Sends a password-reset email via Resend (reliable) instead of Supabase's
// built-in mailer (which is rate-limited to a few per hour and often fails).
// Uses the Supabase Admin API to generate a recovery link, then emails it.
const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'do-not-reply@uglydonuts-franchiseportal.com';
const FROM_NAME = 'Ugly Donuts & Corn Dogs HQ';
const REDIRECT_TO = 'https://uglyops.netlify.app';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { email, name } = JSON.parse(event.body || '{}');
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'email required' }) };
    if (!SUPA_SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not set' }) };
    if (!RESEND_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY not set' }) };

    // 1. Generate a recovery link via the Admin API
    const genRes = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        type: 'recovery',
        email,
        options: { redirect_to: REDIRECT_TO },
      }),
    });
    const genData = await genRes.json();
    if (!genRes.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: genData.message || genData.msg || 'Could not generate reset link', detail: genData }) };
    }
    const actionLink = genData.action_link || genData.properties?.action_link;
    if (!actionLink) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No reset link returned by Supabase', detail: genData }) };
    }

    // 2. Send the link via Resend
    const greeting = name ? `Hi ${name},` : 'Hello,';
    const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0E0E0E;color:#F0EDE8;padding:28px;border-radius:12px;">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#14B8A6;margin-bottom:8px;">Franchise Ops · Password Reset</div>
      <h2 style="margin:0 0 12px;font-size:18px;">Reset your password</h2>
      <p style="font-size:14px;line-height:1.6;color:#D8D4CE;">${greeting}</p>
      <p style="font-size:14px;line-height:1.6;color:#D8D4CE;">HQ requested a password reset for your Franchisee Portal account. Click the button below to set a new password. This link expires in 1 hour.</p>
      <a href="${actionLink}" style="display:inline-block;margin-top:16px;background:#14B8A6;color:#04201C;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Set New Password →</a>
      <p style="font-size:12px;line-height:1.6;color:#8A8480;margin-top:20px;">If you didn't expect this, you can ignore this email and your password will stay the same.</p>
    </div>`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [email],
        subject: 'Reset your Franchisee Portal password',
        html,
      }),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: sendData.message || 'Resend send failed', detail: sendData }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
