const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Firebase REST helpers ───────────────────────────────────────────────────
const FIREBASE_HOST = 'ef-workshop-ff6cf-default-rtdb.firebaseio.com';

function firebaseGet(fbPath) {
  return new Promise((resolve, reject) => {
    const secret = process.env.FIREBASE_SECRET;
    const authSuffix = secret ? `?auth=${secret}` : '';
    https.get(`https://${FIREBASE_HOST}${fbPath}.json${authSuffix}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function firebasePut(fbPath, body) {
  return new Promise((resolve, reject) => {
    const secret = process.env.FIREBASE_SECRET;
    const authSuffix = secret ? `?auth=${secret}` : '';
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: FIREBASE_HOST,
      path: `${fbPath}.json${authSuffix}`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── HoneyBook webhook ───────────────────────────────────────────────────────
app.post('/api/honeybook', async (req, res) => {
  try {
    const data = req.body;
    console.log('HoneyBook webhook:', JSON.stringify(data).slice(0, 300));

    const clientName  = data.client_name || data.contact_name || data.name || 'Unknown client';
    const projectName = data.project_name || clientName;
    const amount      = parseFloat(data.invoice_total || data.total || data.amount || 0);
    const eventType   = (data.event_type || 'inquiry').toLowerCase();
    const honeyBookId = String(data.project_id || data.id || '');

    // Get existing quotes
    const existing = await firebaseGet('/quotes');
    const quotesArray = Array.isArray(existing) ? existing
      : existing && typeof existing === 'object' ? Object.values(existing)
      : [];

    // ── INVOICE PAID: find existing project and update client price ──────────
    if (eventType === 'invoice_paid') {
      let matched = false;
      const updated = quotesArray.map(q => {
        if (honeyBookId && q.honeyBookId === honeyBookId) {
          matched = true;
          return { ...q, clientPrice: amount };
        }
        // Fuzzy match by client name if no ID match
        if (!matched && q.client && q.client.toLowerCase().includes(clientName.toLowerCase().split(' ')[0].toLowerCase())) {
          matched = true;
          return { ...q, clientPrice: amount };
        }
        return q;
      });
      await firebasePut('/quotes', updated);
      return res.json({ status: 'ok', action: matched ? 'updated_client_price' : 'no_match', client: clientName });
    }

    // ── NEW INQUIRY or BOOKING: create new entry ─────────────────────────────

    // Check for duplicate
    if (honeyBookId && quotesArray.find(q => q.honeyBookId === honeyBookId)) {
      return res.json({ status: 'duplicate', message: 'Already exists' });
    }

    const isBooking = eventType.includes('book') || eventType.includes('sign');

    const entry = {
      id: Date.now(),
      honeyBookId,
      client: clientName,
      projectName,
      status: isBooking ? 'project' : 'quote',
      quoteType: 'client',
      source: 'honeybook',
      total: amount,
      clientPrice: isBooking ? amount : 0,
      purity: '18k',
      grams: 0,
      stones: [],
      laborEst: 0,
      designFee: 0,
      chainCost: 0,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      notes: `From HoneyBook — ${eventType}`,
      actualLabor: null,
      actualStoneCost: null,
      actualMetalCost: null,
    };

    const updated = [entry, ...quotesArray];
    await firebasePut('/quotes', updated);

    console.log(`Created ${entry.status} for: ${clientName}`);
    res.json({ status: 'ok', action: 'created', type: entry.status, client: clientName });

  } catch (err) {
    console.error('HoneyBook webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── GIA photo scan proxy ────────────────────────────────────────────────────
app.post('/api/scan-gia', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

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
