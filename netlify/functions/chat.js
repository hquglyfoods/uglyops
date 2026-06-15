const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPA_URL = 'https://ciufbbdzekqlqdzodnrr.supabase.co';
const SUPA_KEY = 'sb_publishable_26hdkwY53clveH7bDPf21w_JGtrY1NP';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { messages, store } = JSON.parse(event.body);
    const userQuestion = messages[messages.length - 1]?.content || '';

    // Search UglyBot knowledge base in Supabase
    let knowledgeContext = '';
    try {
      const searchRes = await fetch(
        `${SUPA_URL}/rest/v1/knowledge?select=question,answer,category&order=created_at.desc&limit=50`,
        {
          headers: {
            'apikey': SUPA_KEY,
            'Authorization': `Bearer ${SUPA_KEY}`,
          }
        }
      );
      const knowledge = await searchRes.json();

      if (Array.isArray(knowledge) && knowledge.length > 0) {
        // Simple keyword match to find relevant items
        const q = userQuestion.toLowerCase();
        const relevant = knowledge.filter(k => {
          const combined = ((k.question || '') + ' ' + (k.answer || '')).toLowerCase();
          return q.split(' ').some(word => word.length > 3 && combined.includes(word));
        }).slice(0, 8);

        if (relevant.length > 0) {
          knowledgeContext = '\n\nRELEVANT KNOWLEDGE BASE:\n' +
            relevant.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
        }
      }
    } catch (e) {
      console.error('Knowledge fetch error:', e);
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are UglyBot, the AI assistant for Ugly Donuts & Corn Dogs franchisees. You help with daily operations, recipes, quality standards, and procedures.

Key brand facts:
- Fried exclusively in avocado oil
- 98% made-to-order, food waste under 0.5%
- 12 corn dog varieties, 15+ donuts, bubble tea (NYC), refreshers
- Toast POS system
- Supply chain through Giant Food
- $22 average ticket, 41.3% repeat rate

You are helping: ${store || 'an Ugly Donuts & Corn Dogs location'}

If the knowledge base has a relevant answer, use it. If you don't know something specific, say "Please contact HQ for this one."${knowledgeContext}`,
        messages: messages.slice(-20),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ content: data.content?.[0]?.text || 'Sorry, I could not generate a response.' }),
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
