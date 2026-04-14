const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ─── Cookie-based password protection ────────────────────────────────────────
const COOKIE_NAME = 'ef_auth';

function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    list[name.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return list;
}

// Login page
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EF Workshop</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1a1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: monospace; }
    .card { background: #242424; border: 1px solid #333; border-radius: 8px; padding: 32px; width: 100%; max-width: 340px; margin: 20px; }
    .logo { font-size: 13px; letter-spacing: 0.15em; text-transform: uppercase; color: #ccc07a; margin-bottom: 24px; text-align: center; }
    input { width: 100%; background: #1a1a1a; border: 1px solid #333; color: #fafaf7; font-family: monospace; font-size: 16px; padding: 12px; border-radius: 4px; outline: none; margin-bottom: 12px; }
    button { width: 100%; background: #ccc07a; color: #1a1a1a; border: none; font-family: monospace; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; padding: 13px; border-radius: 4px; cursor: pointer; }
    .error { color: #e07070; font-size: 13px; margin-bottom: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">EF Workshop</div>
    ${req.query.error ? '<div class="error">Incorrect password</div>' : ''}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`);
});

// Login handler
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (!password || req.body.password === password) {
    // Set cookie for 30 days
    res.set('Set-Cookie', COOKIE_NAME + '=' + Buffer.from(req.body.password || '').toString('base64') + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict');
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// ─── JotForm Webhook ──────────────────────────────────────────────────────────
app.post('/api/jotform-webhook', express.urlencoded({ extended: true }), express.json(), (req, res) => {
  try {
    const formType = req.query.form || 'unknown';
    // JotForm sends a rawRequest field containing the actual JSON submission
    let raw = req.body || {};
    console.log('JotForm raw keys:', Object.keys(raw));
    console.log('JotForm raw body:', JSON.stringify(raw).slice(0, 2000));

    // JotForm often sends everything inside a rawRequest JSON string
    let parsedReq = {};
    if (raw.rawRequest) {
      try { parsedReq = JSON.parse(raw.rawRequest); } catch(e) {}
    }
    // Merge: use parsedReq if available, fall back to raw
    const data = Object.keys(parsedReq).length > 0 ? parsedReq : raw;
    console.log('JotForm parsed keys:', Object.keys(data));

    const get = (keys) => {
      for (const k of keys) {
        const fullKey = Object.keys(data).find(rk => rk.toLowerCase().includes(k.toLowerCase()));
        if (fullKey && data[fullKey]) {
          const val = data[fullKey];
          if (typeof val === 'object' && !Array.isArray(val)) return Object.values(val).filter(Boolean).join(' ');
          if (Array.isArray(val)) return val.filter(Boolean).join(', ');
          return String(val);
        }
      }
      return '';
    };

    const firstName = get(['first', 'firstName']);
    const lastName  = get(['last', 'lastName']);
    const fullName  = (firstName + ' ' + lastName).trim() || get(['fullName', 'name']);
    const email     = get(['email']);
    const pieceType = formType === 'bespoke'
      ? get(['whatType', 'piece', 'interested'])
      : get(['signature', 'design', 'interested']);
    const budget    = get(['budget', 'range', 'spending']);
    const sourcingStone = get(['sourcing', 'stone']);
    const stoneType = get(['cut', 'stone', 'type']) || get(['stoneType']);
    const ringSize  = get(['ring', 'size', 'ringSize']);
    const occasion  = get(['milestone', 'occasion']);
    const needBy    = get(['needBy', 'date', 'need']);
    const howFound  = get(['find', 'found', 'elvie', 'how']);
    const stoneView = get(['view', 'stone', 'prefer']);
    const processStage = get(['process', 'where']);
    const design    = get(['design', 'style', 'drawn', 'elements']);
    const wearerInvolved = get(['wearer', 'involved']);
    const notes     = get(['anything', 'know', 'notes', 'additional']);
    const submissionId = raw.submissionID || Date.now().toString();

    const inquiry = {
      id: Date.now(),
      submissionId,
      formType,
      receivedAt: new Date().toISOString(),
      status: 'new',
      name: fullName,
      email,
      pieceType,
      budget,
      sourcingStone,
      stoneType,
      ringSize,
      occasion,
      needBy,
      howFound,
      stoneView,
      processStage,
      designNotes: design,
      wearerInvolved,
      notes,
    };

    // Save to Firebase REST API
    const fbUrl = 'https://ef-workshop-ff6cf-default-rtdb.firebaseio.com';
    const https = require('https');
    const payload = JSON.stringify(inquiry);
    const url = new URL(`${fbUrl}/inquiries.json`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const fireReq = https.request(options, (fireRes) => {
      console.log('JotForm inquiry saved to Firebase:', inquiry.name, formType);
    });
    fireReq.on('error', (e) => console.error('Firebase write error:', e));
    fireReq.write(payload);
    fireReq.end();

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('JotForm webhook error:', e);
    res.status(200).json({ ok: true }); // always 200 to JotForm
  }
});

// Auth middleware
app.use((req, res, next) => {
  const skipPaths = ['/login', '/manifest.json', '/icon.png', '/icon-192.png', '/api/jotform-webhook'];
  if (skipPaths.includes(req.path)) return next();

  const password = process.env.APP_PASSWORD;
  if (!password) return next();

  const cookies = parseCookies(req);
  const cookieVal = cookies[COOKIE_NAME];
  const decoded = cookieVal ? Buffer.from(cookieVal, 'base64').toString() : '';

  if (decoded === password) return next();

  res.redirect('/login');
});

// Serve static files

// PWA icon and manifest
app.get('/icon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icon.png'));
});

app.get('/icon-192.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'EF Workshop',
    short_name: 'EF Workshop',
    start_url: '/',
    display: 'standalone',
    background_color: '#ccc07a',
    theme_color: '#ccc07a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});

// Disable caching for HTML files so updates deploy immediately
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
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
    const clientName  = data.client_name || data.contact_name || data.name || 'Unknown client';
    const projectName = data.project_name || clientName;
    const amount      = parseFloat(data.invoice_total || data.total || data.amount || 0);
    const eventType   = (data.event_type || 'inquiry').toLowerCase();
    const honeyBookId = String(data.project_id || data.id || '');

    const existing = await firebaseGet('/quotes');
    const quotesArray = Array.isArray(existing) ? existing
      : existing && typeof existing === 'object' ? Object.values(existing) : [];

    if (eventType === 'invoice_paid') {
      let matched = false;
      const updated = quotesArray.map(q => {
        if (honeyBookId && q.honeyBookId === honeyBookId) { matched = true; return { ...q, clientPrice: amount }; }
        if (!matched && q.client && q.client.toLowerCase().includes(clientName.toLowerCase().split(' ')[0])) { matched = true; return { ...q, clientPrice: amount }; }
        return q;
      });
      await firebasePut('/quotes', updated);
      return res.json({ status: 'ok', action: matched ? 'updated' : 'no_match' });
    }

    if (honeyBookId && quotesArray.find(q => q.honeyBookId === honeyBookId)) {
      return res.json({ status: 'duplicate' });
    }

    const isBooking = eventType.includes('book') || eventType.includes('sign');
    const entry = {
      id: Date.now(), honeyBookId, client: clientName, projectName,
      status: isBooking ? 'project' : 'quote', quoteType: 'client', source: 'honeybook',
      total: amount, clientPrice: isBooking ? amount : 0, purity: '18k',
      grams: 0, stones: [], laborEst: 0, designFee: 0, chainCost: 0,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      notes: `From HoneyBook — ${eventType}`,
    };

    await firebasePut('/quotes', [entry, ...quotesArray]);
    res.json({ status: 'ok', action: 'created', client: clientName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Gold price proxy ─────────────────────────────────────────────────────────
let cachedGoldPrice = null;
let cacheTime = 0;

app.get('/api/gold-price', async (req, res) => {
  // Cache for 5 minutes
  if (cachedGoldPrice && Date.now() - cacheTime < 5 * 60 * 1000) {
    return res.json({ price: cachedGoldPrice, cached: true });
  }

  const sources = [
    // Metals.live — free, no key
    { host: 'metals.live', path: '/api/spot/gold', parse: d => Array.isArray(d) && d[0] && d[0].price ? d[0].price : (d.price || null) },
    // Frankfurter (XAU/USD via ECB rates — inverted)
    { host: 'api.frankfurter.app', path: '/latest?from=XAU&to=USD', parse: d => d.rates && d.rates.USD ? d.rates.USD : null },
    // Gold-api fallback
    { host: 'api.gold-api.com', path: '/price/XAU', parse: d => d.price },
  ];

  for (const source of sources) {
    try {
      const price = await new Promise((resolve, reject) => {
        const options = {
          hostname: source.host,
          path: source.path,
          method: 'GET',
          headers: { 'User-Agent': 'EFWorkshop/1.0' },
          timeout: 5000
        };
        const req2 = https.request(options, (r) => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const price = source.parse(parsed);
              if (price && price > 1000 && price < 10000) resolve(price);
              else reject(new Error('Invalid price: ' + price));
            } catch(e) { reject(e); }
          });
        });
        req2.on('error', reject);
        req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
        req2.end();
      });

      cachedGoldPrice = price;
      cacheTime = Date.now();
      return res.json({ price, source: source.host });
    } catch(e) {
      console.log('Gold source failed:', source.host, e.message);
    }
  }

  // Fallback to cached if we have it
  if (cachedGoldPrice) return res.json({ price: cachedGoldPrice, cached: true, stale: true });
  res.status(503).json({ error: 'Could not fetch gold price' });
});


// ─── GIA report lookup by number ─────────────────────────────────────────────
app.get('/api/gia-lookup', async (req, res) => {
  const reportNo = req.query.report;
  if (!reportNo) return res.status(400).json({ error: 'No report number' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Fetch the GIA report page
    const giaHtml = await new Promise((resolve, reject) => {
      const r2 = https.request({
        hostname: 'www.gia.edu',
        path: '/report-check?reportno=' + encodeURIComponent(reportNo),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 10000
      }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve(data));
      });
      r2.on('error', reject);
      r2.on('timeout', () => { r2.destroy(); reject(new Error('timeout')); });
      r2.end();
    });

    const prompt = 'Extract diamond grading from this GIA report page. The page may be JS-rendered and mostly empty. Return ONLY JSON with these keys (null if not found): carat (number string), color (letter grade), clarity (grade), cut (shape name), found (boolean). Page content: ' + giaHtml.substring(0, 6000);

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const claudeRes = await new Promise((resolve, reject) => {
      const cr = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve(JSON.parse(data)));
      });
      cr.on('error', reject);
      cr.write(payload);
      cr.end();
    });

    const text = claudeRes.content && claudeRes.content[0] && claudeRes.content[0].text || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return res.json({ found: false });
    const parsed = JSON.parse(match[0]);
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── GIA scan proxy ───────────────────────────────────────────────────────────
app.post('/api/scan-gia', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });
  const payload = JSON.stringify({
    model: 'claude-opus-4-5-20251101', max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } },
      { type: 'text', text: 'This is a GIA diamond grading report or parcel label. Extract the following and return ONLY a JSON object with these exact keys (use null if not found): {"gia":"report number","carat":"weight as number e.g. 2.06","color":"grade e.g. K","clarity":"grade e.g. VS2","cut":"map the shape to one of these exact values: Old Mine Cut, Old European Cut, Round Brilliant, Oval, Emerald Cut, Cushion, Pear, Marquise, Asscher, Princess, Other — e.g. Round Brilliant or Old Mine Cut","fluorescence":"e.g. None or Strong Blue","dimensions":"measurements e.g. 8.20 x 7.95 x 5.10 mm"}. For cut/shape: Round=Round Brilliant, Oval Modified Brilliant or Oval Brilliant=Oval, Emerald=Emerald Cut, Cushion Modified Brilliant=Cushion, Pear Modified Brilliant=Pear, Antique Cushion or Mine Cut=Old Mine Cut, European Cut=Old European Cut. Return only the JSON, nothing else.' }
    ]}]
  });
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
  };
  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => { try { res.status(proxyRes.statusCode).json(JSON.parse(data)); } catch (e) { res.status(500).json({ error: 'Parse error' }); } });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.write(payload);
  proxyReq.end();
});

// ─── Serve app for ALL routes ─────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`EF Workshop running on port ${PORT}`));
