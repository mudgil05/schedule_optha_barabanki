// api/gemini.js — Vercel serverless function
// Proxies Gemini Vision API — key stored in env var, never in browser

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  const { imageBase64, mimeType, pageNumber, totalPages } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image data provided' });

  const MODEL = 'gemini-3.5-flash';   // faster than 2.5-flash-lite for this use case

  const PROMPT = `You are extracting data from a photographed NMC medical college timetable.
The image may be rotated or photographed. Read it carefully in the correct orientation.

Table columns left to right:
1. Date column — date for each row
2. 8 to 9 AM — subject, topic, code
3. 9 to 10 AM — subject, topic, code
4. 10 to 1 PM — "Clinical Posting" — IGNORE THIS COLUMN COMPLETELY
5. 2 to 3 PM — BATCH entries (4 batches: C, D, A, B with dept and code)
6. 3 to 4 PM — usually same batch data as col 5

For 8-9AM and 9-10AM:
- If dept = "Ophthalmology" (or Ophthal): extract {dept, type, topic, code}
- Any other dept (Surgery, ENT, Paediatrics, FMT, Medicine, OBG, Ortho etc): set to null

For 2-3PM and 3-4PM:
- Extract all 4 BATCH entries (C, D, A, B) with dept and code
- "same34":true when 3-4PM uses same batches as 2-3PM (very common)
- "same34":false only when 3-4PM has completely different content

Return ONLY valid JSON. No markdown. No extra text. Example:
{"rows":[
  {"date":"8 June 26","am1":null,"am2":null,"pm1":[{"b":"C","d":"FM","c":"FMX.X","op":false},{"b":"D","d":"EN","c":"ENX.X","op":false},{"b":"A","d":"OP","c":"OPX.X","op":true},{"b":"B","d":"CM","c":"CMX.X","op":false}],"same34":true},
  {"date":"11 June 26","am1":{"dept":"Ophthalmology","type":"SGD","topic":"Retinoblastoma","code":"OF2.7"},"am2":null,"pm1":[{"b":"C","d":"FM","c":"FMX.X","op":false},{"b":"D","d":"EN","c":"ENX.X","op":false},{"b":"A","d":"OP","c":"OPX.X","op":true},{"b":"B","d":"CM","c":"CMX.X","op":false}],"same34":true}
]}`;

  // Abort if Gemini takes longer than 55s (Vercel Pro=60s, free=10s)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
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
          generationConfig: { temperature: 0, maxOutputTokens: 4096 }
        })
      }
    );
    clearTimeout(timeout);

    // Read response as text first — avoids "Unexpected end of JSON" on empty body
    const rawText = await geminiRes.text();

    if (!geminiRes.ok) {
      if (geminiRes.status === 429) {
        return res.status(429).json({ error: 'Gemini quota reached. Wait a few minutes and try again.' });
      }
      if (geminiRes.status === 400 && (rawText.includes('API_KEY') || rawText.includes('API key'))) {
        return res.status(400).json({ error: 'Invalid Gemini API key. Check GEMINI_API_KEY in Vercel env vars.' });
      }
      return res.status(geminiRes.status).json({
        error: `Gemini API error ${geminiRes.status}: ${rawText.slice(0, 300)}`
      });
    }

    if (!rawText || rawText.trim() === '') {
      return res.status(200).json({ rows: [], warning: 'Empty response from Gemini' });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(200).json({ rows: [], warning: 'Gemini returned non-JSON: ' + rawText.slice(0, 200) });
    }

    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

    if (!text) {
      return res.status(200).json({ rows: [], warning: 'No text in Gemini response' });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(200).json({ rows: [], warning: 'JSON parse failed: ' + text.slice(0, 200) });
    }

    const rows = parsed.rows || parsed.days || [];
    return res.status(200).json({ rows, page: pageNumber, total: totalPages });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'Gemini took too long (timeout). Try a smaller or clearer image, or upgrade to Vercel Pro for 60s limit.'
      });
    }
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
