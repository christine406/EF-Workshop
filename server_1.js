const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/scan-gia', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });
  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image' });
  const payload = JSON.stringify({
    model: 'claude-opus-4-5-20251101', max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } },
      { type: 'text', text: 'Extract from this GIA report and return ONLY JSON: {"gia":"report number","carat":"weight","color":"grade","clarity":"grade","cut":"shape"}' }
    ]}]
  });
  const opts = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
  };
  const r = https.request(opts, (pr) => {
    let d = ''; pr.on('data', c => d += c);
    pr.on('end', () => { try { res.status(pr.statusCode).json(JSON.parse(d)); } catch(e) { res.status(500).json({error:'parse error'}); } });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.write(payload); r.end();
});

app.post('/api/honeybook', async (req, res) => {
  res.json({ status: 'ok' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log('EF Workshop on port ' + PORT));
