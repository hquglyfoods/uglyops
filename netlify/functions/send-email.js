const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'do-not-reply@uglydonuts-franchiseportal.com';
const FROM_NAME = 'Ugly Donuts & Corn Dogs HQ';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const { to, subject, html, type } = JSON.parse(event.body);

    // to can be a single email string or array of {email, name}
    const recipients = Array.isArray(to) ? to : [{ email: to }];

    // Send to each recipient
    const results = await Promise.all(recipients.map(async (recipient) => {
      const emailAddr = typeof recipient === 'string' ? recipient : recipient.email;
      const name = typeof recipient === 'object' ? recipient.name : '';

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [emailAddr],
          subject,
          html,
        }),
      });
      const data = await res.json();
      return { email: emailAddr, ok: res.ok, data };
    }));

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      console.error('Some emails failed:', failed);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, results }),
    };
  } catch (err) {
    console.error('send-email error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
