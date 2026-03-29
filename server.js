const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Firebase helper (using REST API — no SDK needed) ───────────────────────
const FIREBASE_DB = 'https://ef-workshop-ff6cf-default-rtdb.firebaseio.com';

function firebaseGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${FIREBASE_DB}${path}.json`);
    const secret = process.env.FIREBASE_SECRET;
    if (secret) url.searchParams.set('auth', secret);
    https.get(url.toString(), (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function firebasePatch(path, body) {
  return new Promise((resolve, reject) => {
    const secret = process.env.FIREBASE_SECRET;
    const authSuffix = secret ? `?auth=${secret}` : '';
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'ef-workshop-ff6cf-default-rtdb.firebaseio.com',
      path: `${path}.json${authSuffix}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function firebasePost(path, body) {
  return new Promise((resolve, reject) => {
    const secret = process.env.FIREBASE_SECRET;
    const authSuffix = secret ? `?auth=${secret}` : '';
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'ef-workshop-ff6cf-default-rtdb.firebaseio.com',
      path: `${path}.json${authSuffix}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── HoneyBook webhook endpoint ─────────────────────────────────────────────
// Zapier sends POST here when HoneyBook events fire
app.post('/api/honeybook', async (req, res) => {
  try {
    const data = req.body;
    console.log('HoneyBook webhook received:', JSON.stringify(data).slice(0, 200));

    // Extract fields — Zapier flattens HoneyBook data
    const clientName = data.client_name || data.contact_name || data.name || 'Unknown client';
    const projectName = data.project_name || data.name || clientName;
    const invoiceTotal = parseFloat(data.invoice_total || data.total || data.amount || 0);
    const eventType = data.event_type || data.type || 'inquiry';
    const honeyBookId = data.project_id || data.id || String(Date.now());

    // Build a project entry
    const project = {
      id: Date.now(),
      honeyBookId,
      client: clientName,
      projectName,
      status: eventType.includes('book') || eventType.includes('sign') ? 'project' : 'quote',
      quoteType: 'client',
      source: 'honeybook',
      total: invoiceTotal || 0,
      clientPrice: invoiceTotal || 0,
      purity: '18k',
      grams: 0,
      stones: [],
      laborEst: 0,
      designFee: 0,
      chainCost: 0,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      notes: `Imported from HoneyBook. Event: ${eventType}`,
      actualLabor: null,
      actualStoneCost: null,
      actualMetalCost: null,
    };

    // Get existing quotes, append new one
    const existing = await firebaseGet('/quotes') || [];
    const quotesArray = Array.isArray(existing) ? existing : Object.values(existing);

    // Check if this HoneyBook project already exists (avoid duplicates)
    const alreadyExists = quotesArray.find(q => q.honeyBookId === honeyBookId);
    if (alreadyExists) {
      console.log('Duplicate HoneyBook project, skipping:', honeyBookId);
      return res.json({ status: 'duplicate', message: 'Project already exists' });
    }

    const updated = [project, ...quotesArray];
    await firebasePatch('/', { quotes: updated });

    console.log('Project created from HoneyBook:', clientName);
    res.json({ status: 'ok', project: clientName });

  } catch (err) {
    console.error('HoneyBook webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Test endpoint ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── GIA photo scan proxy ────────────────────────────────────────────────────
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

// ─── Serve app ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`EF Workshop running on port ${PORT}`));
