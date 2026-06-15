// api/gcal.js
// Handles Google Calendar event creation using service account
// GOOGLE_SERVICE_ACCOUNT_JSON stored in Vercel env vars
// Users never see credentials

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Service account JSON stored in Vercel environment
  const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  // Calendar ID to add events to (set in Vercel env)
  const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

  if (!SA_JSON) {
    return res.status(500).json({
      error: 'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON in Vercel environment variables.'
    });
  }

  try {
    const { events } = req.body; // array of event objects from frontend
    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'No events provided' });
    }

    // Parse service account
    const sa = JSON.parse(SA_JSON);

    // Create JWT for Google API auth
    const accessToken = await getAccessToken(sa);

    // Create each event
    const results = [];
    for (const ev of events) {
      try {
        const evRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=all`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              summary:     ev.title,
              description: ev.description,
              start:       { dateTime: ev.startTime, timeZone: ev.timezone || 'Asia/Kolkata' },
              end:         { dateTime: ev.endTime,   timeZone: ev.timezone || 'Asia/Kolkata' },
              attendees:   ev.emails.map(email => ({ email })),
              reminders: {
                useDefault: false,
                overrides: [
                  { method: 'email', minutes: 60 },
                  { method: 'popup', minutes: 30 }
                ]
              }
            })
          }
        );

        if (evRes.ok) {
          const data = await evRes.json();
          results.push({ date: ev.date, status: 'created', eventId: data.id, link: data.htmlLink });
        } else {
          const err = await evRes.json();
          results.push({ date: ev.date, status: 'failed', error: err.error?.message || 'Unknown error' });
        }
      } catch (evErr) {
        results.push({ date: ev.date, status: 'failed', error: evErr.message });
      }
      // Small delay between events
      await new Promise(r => setTimeout(r, 200));
    }

    return res.status(200).json({ results, total: events.length, created: results.filter(r => r.status === 'created').length });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// Create Google API access token from service account using JWT
async function getAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  };

  // Encode JWT
  const header  = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const payload = btoa(JSON.stringify(claim)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const unsigned = `${header}.${payload}`;

  // Sign with RSA-SHA256 using Web Crypto
  const keyData = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const keyBuf = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${unsigned}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Could not get Google access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}
