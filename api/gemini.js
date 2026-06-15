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

  // gemini-2.5-flash-lite: stable, free tier, vision capable, fast
  // DO NOT use gemini-2.0-flash — shut down June 1 2026
  // DO NOT use gemini-1.5-flash — being deprecated
  const MODEL = 'gemini-2.5-flash-lite';

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
          generationConfig: { temperature: 0, maxOutputTokens: 8192 }
        })
      }
    );
    clearTimeout(timeout);

    const rawText = await geminiRes.text();

    if (!geminiRes.ok) {
      // Return the FULL error so we can diagnose — not a generic rate limit message
      const errorBody = rawText.slice(0, 500);
      console.error(`Gemini error ${geminiRes.status}:`, errorBody);

      if (geminiRes.status === 429) {
        return res.status(429).json({
          error: 'Gemini rate limit (429). Free tier: 15 requests/min, 1500/day.\n\nWait 1 minute and try again, or enable billing at console.cloud.google.com'
        });
      }
      if (geminiRes.status === 404) {
        return res.status(500).json({
          error: `Model "${MODEL}" not found (404). The model may have been updated.\n\nFull error: ${errorBody}`
        });
      }
      if (geminiRes.status === 400) {
        if (rawText.includes('API_KEY') || rawText.includes('API key')) {
          return res.status(400).json({
            error: 'Invalid API key. Check GEMINI_API_KEY in Vercel → Settings → Environment Variables.'
          });
        }
        return res.status(400).json({
          error: `Gemini 400 error: ${errorBody}`
        });
      }
      if (geminiRes.status === 503) {
        return res.status(503).json({
          error: 'Gemini service unavailable (503). Try again in a moment.'
        });
      }
      return res.status(geminiRes.status).json({
        error: `Gemini API error ${geminiRes.status}: ${errorBody}`
      });
    }

    if (!rawText || rawText.trim() === '') {
      return res.status(200).json({ rows: [], warning: 'Empty response from Gemini' });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(200).json({ rows: [], warning: 'Gemini returned non-JSON response: ' + rawText.slice(0, 200) });
    }

    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      return res.status(200).json({ rows: [], warning: 'Response cut off — image too complex. It will be retried with splitting.' });
    }

    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

    if (!text) {
      return res.status(200).json({ rows: [], warning: 'No text content in Gemini response. Raw: ' + rawText.slice(0, 300) });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(200).json({ rows: [], warning: 'JSON parse failed. Text was: ' + text.slice(0, 300) });
    }

    const rows = parsed.rows || parsed.days || [];
    return res.status(200).json({ rows, page: pageNumber, total: totalPages });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'Request timed out after 55s. The image is too large or Gemini is slow.\n\nThe page will be automatically split and retried.'
      });
    }
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
