const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// GIA photo scan proxy — keeps API key server-side
app.post('/api/scan-gia', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data provided' });

  const payload = JSON.stringify({
    model: 'claude-opus-4-5-20251101',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } },
        { type: 'text', text: 'This is a GIA diamond grading report or parcel label. Extract the following and return ONLY a JSON object with these exact keys (use null if not found): {"gia":"report number","carat":"weight as number","color":"grade e.g. G","clarity":"grade e.g. VS1","cut":"shape e.g. Round Brilliant"}. Return only the JSON, nothing else.' }
      ]
    }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try { res.status(proxyRes.statusCode).json(JSON.parse(data)); }
      catch (e) { res.status(500).json({ error: 'Failed to parse response' }); }
    });
  });

  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.write(payload);
  proxyReq.end();
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`EF Workshop running on port ${PORT}`));
