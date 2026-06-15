// api/gemini.js
// Serverless function — runs on Vercel, never in browser
// Gemini API key is stored as GEMINI_API_KEY in Vercel environment variables
// Users never see the key — they just call /api/gemini

module.exports = async function handler(req, res) {
  // CORS — allow requests from your own domain only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get key from Vercel environment (set once in Vercel dashboard, never in code)
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({
      error: 'Gemini API key not configured on server. Ask the administrator to set GEMINI_API_KEY in Vercel environment variables.'
    });
  }

  try {
    const { imageBase64, mimeType, pageNumber, totalPages } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    const MODEL = 'gemini-2.5-flash-lite';
    const PROMPT = `You are a data extraction assistant reading a medical college NMC timetable image.
The image may be rotated or photographed. Read it carefully in the correct orientation.

Table columns left to right:
1. Date column — contains the date for each row
2. 8 to 9 AM — subject, topic, code, VI code
3. 9 to 10 AM — same format
4. 10 to 1 PM — says "Clinical Posting" — IGNORE THIS COLUMN
5. 2 to 3 PM — BATCH entries (4 batches: C, D, A, B with dept and code)
6. 3 to 4 PM — same batch data as col 5 most days, or different content

For columns 8-9AM and 9-10AM:
- If dept = "Ophthalmology": extract {dept, type, topic, code}
- If any other dept: set to null

For 2-3PM and 3-4PM:
- Extract all 4 BATCH entries with their dept and code
- "same34":true when 3-4PM uses same batches as 2-3PM (most days)

Return ONLY valid JSON, no markdown, no explanation:
{"rows":[
  {"date":"<DATE>","am1":null,"am2":null,"pm1":[{"b":"C","d":"FM","c":"FM3.X","op":false},{"b":"D","d":"EN","c":"EN3.X","op":false},{"b":"A","d":"OP","c":"OPX.X","op":true},{"b":"B","d":"CM","c":"CMX.X","op":false}],"same34":true},
  {"date":"<DATE>","am1":{"dept":"Ophthalmology","type":"SGD","topic":"<TOPIC>","code":"<CODE>"},"am2":null,"pm1":[{"b":"C","d":"FM","c":"FMX.X","op":false},{"b":"D","d":"EN","c":"ENX.X","op":false},{"b":"A","d":"OP","c":"OPX.X","op":true},{"b":"B","d":"CM","c":"CMX.X","op":false}],"same34":true}
]}

Rules:
- date: exactly as written in image
- op: true only if dept is OP or OF
- Write codes exactly as in image
- Read ALL rows visible in the image`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_KEY
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { text: PROMPT }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      if (geminiRes.status === 429) {
        return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
      }
      return res.status(geminiRes.status).json({ error: `Gemini API error: ${errText.slice(0, 200)}` });
    }

    const data = await geminiRes.json();
    const raw  = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

    if (!raw || raw.length < 5) {
      return res.status(200).json({ rows: [], warning: 'Empty response from Gemini' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(200).json({ rows: [], warning: 'Could not parse Gemini response', raw: raw.slice(0, 300) });
    }

    const rows = parsed.rows || parsed.days || [];
    return res.status(200).json({ rows, page: pageNumber, total: totalPages });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
