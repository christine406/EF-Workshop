const express = require('express');
const path = require('path');
const https = require('https');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ─── Web Push (home screen badge) ─────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:christine@elviefine.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('Web Push configured');
} else {
  console.warn('Web Push NOT configured — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT env vars');
}

// Expose public key so the client can subscribe
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Save a push subscription to Firebase
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
    // Use a sanitized version of the endpoint as the Firebase key
    const key = Buffer.from(sub.endpoint).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(-40);
    await firebasePut('/pushSubscriptions/' + key, sub);
    console.log('Push subscription saved:', key);
    res.json({ ok: true, key });
  } catch (e) {
    console.error('Push subscribe error:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Remove a subscription (when user disables notifications)
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
    const key = Buffer.from(endpoint).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(-40);
    await firebasePut('/pushSubscriptions/' + key, null);
    res.json({ ok: true });
  } catch (e) {
    console.error('Push unsubscribe error:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Count unread (new) inquiries from Firebase
async function getUnreadInquiryCount() {
  try {
    const inquiries = await firebaseGet('/inquiries');
    if (!inquiries || typeof inquiries !== 'object') return 0;
    const list = Array.isArray(inquiries) ? inquiries : Object.values(inquiries);
    return list.filter(i => i && i.status === 'new').length;
  } catch (e) {
    console.error('Unread count error:', e);
    return 0;
  }
}

// Push to every subscribed device — delivers a badge update + minimal banner
async function pushBadgeToAll(title, body) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log('Skipping push — VAPID not configured');
    return;
  }
  try {
    const subs = await firebaseGet('/pushSubscriptions');
    if (!subs || typeof subs !== 'object') return;
    const count = await getUnreadInquiryCount();
    const payload = JSON.stringify({
      title: title || 'EF Workshop',
      body: body || 'New inquiry',
      badge: count
    });
    const entries = Object.entries(subs);
    console.log(`Pushing to ${entries.length} device(s), badge=${count}`);
    for (const [key, sub] of entries) {
      if (!sub || !sub.endpoint) continue;
      try {
        await webpush.sendNotification(sub, payload);
      } catch (e) {
        // 410 Gone = subscription expired; 404 = not found. Clean those up.
        if (e.statusCode === 410 || e.statusCode === 404) {
          await firebasePut('/pushSubscriptions/' + key, null);
          console.log('Removed expired subscription:', key);
        } else {
          console.error('Push send error:', e.statusCode, e.body || e.message);
        }
      }
    }
  } catch (e) {
    console.error('pushBadgeToAll error:', e);
  }
}

// Endpoint for the app to refresh the badge when inquiries are marked read
app.post('/api/push/refresh-badge', async (req, res) => {
  try {
    await pushBadgeToAll('EF Workshop', 'Badge updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});


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
app.post('/api/jotform-webhook', (req, res) => {
  let chunks = [];
  req.on('data', chunk => { chunks.push(chunk); });
  req.on('end', () => {
    try {
      const formType = req.query.form || 'unknown';
      const contentType = req.headers['content-type'] || '';
      const body = Buffer.concat(chunks).toString('utf8');

      // Parse multipart/form-data manually — extract name=value pairs
      let raw = {};
      if (contentType.includes('multipart/form-data')) {
        // Extract boundary
        const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
        if (boundaryMatch) {
          const boundary = '--' + boundaryMatch[1];
          const parts = body.split(boundary);
          parts.forEach(part => {
            const nameMatch = part.match(/Content-Disposition:[^\n]*name="([^"]+)"/i);
            if (!nameMatch) return;
            const fieldName = nameMatch[1];
            // Value is after the double newline
            const valueStart = part.indexOf('\r\n\r\n');
            if (valueStart === -1) return;
            const value = part.slice(valueStart + 4).replace(/\r\n--$/, '').replace(/--$/, '').trim();
            if (value) raw[fieldName] = value;
          });
        }
      } else if (contentType.includes('application/json')) {
        try { raw = JSON.parse(body); } catch(e) {}
      } else {
        try {
          const params = new URLSearchParams(body);
          params.forEach((v, k) => { raw[k] = v; });
        } catch(e) {}
      }

      console.log('JotForm parsed keys:', Object.keys(raw).slice(0, 20));

      // JotForm wraps submission JSON in rawRequest or customBody
      let data = raw;
      const jsonSource = raw.rawRequest || raw.customBody;
      if (jsonSource) {
        try {
          const inner = JSON.parse(jsonSource);
          data = Object.assign({}, raw, inner);
        } catch(e) {}
      }

      console.log('JotForm data keys:', Object.keys(data).slice(0, 30));
      
      // Log ALL fields for antique diamond form so we can map them
      if (formType === 'antique-diamond') {
        console.log('=== ANTIQUE DIAMOND FORM - ALL FIELDS ===');
        Object.keys(data).forEach(k => {
          const v = data[k];
          if (typeof v === 'string' && v.length < 200) {
            console.log(`${k}: ${v}`);
          } else if (typeof v === 'object') {
            console.log(`${k}:`, JSON.stringify(v));
          }
        });
        console.log('=== END FIELDS ===');
      }
      
      // Log ALL fields for semi-custom form so we can map them
      if (formType === 'semi-custom') {
        console.log('=== SEMI-CUSTOM FORM - ALL FIELDS ===');
        Object.keys(data).forEach(k => {
          const v = data[k];
          if (typeof v === 'string' && v.length < 200) {
            console.log(`${k}: ${v}`);
          } else if (typeof v === 'object') {
            console.log(`${k}:`, JSON.stringify(v));
          }
        });
        console.log('=== END FIELDS ===');
      }

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

    // Helper: get a value by exact key, skip if value is too long (junk fields)
    const dget = (key) => {
      const v = data[key];
      if (v === undefined || v === null || v === '') return '';
      if (typeof v === 'object' && !Array.isArray(v)) return Object.values(v).filter(Boolean).join(' ');
      if (Array.isArray(v)) return v.filter(Boolean).join(', ');
      const s = String(v);
      return s.length < 500 ? s : ''; // skip junk like jsExecutionTracker
    };

    // Format JotForm datetime field ({month, day, year}) into "April 9, 2026"
    const formatDate = (key) => {
      const v = data[key];
      if (!v || typeof v !== 'object') return dget(key);
      const { month, day, year } = v;
      if (!month || !day || !year) return Object.values(v).filter(Boolean).join('/');
      const months = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
      const monthName = months[parseInt(month, 10) - 1] || month;
      return `${monthName} ${parseInt(day, 10)}, ${year}`;
    };

    // Name (shared field q2 on both forms)
    const nameField = data['q2_q2_fullname0'] || '';
    const fullName = typeof nameField === 'object'
      ? Object.values(nameField).filter(Boolean).join(' ')
      : String(nameField || '');

    // Email (shared q3)
    const email = dget('q3_q3_email1');

    // Form-specific field mapping (confirmed from JotForm submissions)
    let pieceType, sourcingStone, stoneType, budget, processStage, howLearnProcess,
        designNotes, wearerInvolved, ringSize, needByYesNo, needBy, howFound, stoneView, occasion, notes;
    let inspirationImages = [];
    let antiqueFields = null;

    if (formType === 'antique-diamond') {
      // ANTIQUE DIAMOND SOURCING FORM - all fields mapped separately
      const phone         = dget('q31_phone');          // Phone
      howFound            = dget('q32_howDid');         // How did you find Elvie Fine?
      budget              = dget('q34_whatIs');         // What is your stone budget?
      stoneType           = dget('q35_whatDiamond');    // What diamond shapes are you most interested in?
      const caratRange    = dget('q37_whatIs37');       // What is your preferred carat range?
      const colorPref     = dget('q38_whatIs38');       // What is your preferred color range?
      const clarityPref   = dget('q41_whatIs41');       // What is your preferred clarity?
      const stoneIdeal    = dget('q43_howWould');       // How would you describe your ideal stone?
      occasion            = dget('q45_isThis');         // Is this diamond for a specific occasion?
      needBy              = dget('q46_isThere');        // Is there a hard need-by date?
      const designWith    = dget('q48_doYou');          // Do you intend to work with us on designing the piece as well?
      processStage        = dget('q50_areYou');         // Are you ready to place the sourcing deposit and begin the search?
      stoneView           = dget('q52_howWill');        // How will you prefer to view stone options?
      const inspiration   = dget('pleaseUpload');       // Uploaded inspiration images
      
      // Set standard fields
      pieceType = 'Antique Diamond Sourcing';
      sourcingStone = 'Yes';
      howLearnProcess = stoneView;
      designNotes = designWith || '';
      wearerInvolved = '';
      ringSize = '';
      needByYesNo = needBy ? 'Yes' : '';
      notes = phone || '';
      
      // Store antique-specific fields directly (not in nested object)
      antiqueFields = {
        caratRange,
        colorPref,
        clarityPref,
        stoneIdeal,
      };
      
      // Inspiration images
      if (inspiration) {
        try {
          const urls = Array.isArray(inspiration) ? inspiration : JSON.parse(inspiration);
          inspirationImages = urls.filter(Boolean);
        } catch(e) {
          if (typeof inspiration === 'string' && inspiration.startsWith('http')) {
            inspirationImages = [inspiration];
          }
        }
      }
    } else if (formType === 'bespoke') {
      // BESPOKE FORM — confirmed field IDs
      pieceType       = dget('q31_whatType');       // "What type of piece..."
      sourcingStone   = dget('q32_willWe');         // "Will we be sourcing a stone..."
      budget          = dget('q27_isThere');        // "Is there a budget range..."
      stoneType       = dget('q35_ifWere');         // "If we're sourcing a stone, type or cut..."
      ringSize        = dget('q36_ifWe');           // "If we would be designing a ring, ring size..."
      processStage    = dget('q12_q12_radio10');    // "Where are you in the process..."
      howLearnProcess = dget('q21_howWould');       // "How would you prefer to learn more..."
      designNotes     = dget('q37_whatDesign');     // "What design elements or styles..."
      wearerInvolved  = dget('q17_willThe');        // "Will the wearer..."
      needByYesNo     = dget('q30_doYou');          // "Do you have a need-by date..."
      needBy          = formatDate('q7_q7_datetime5'); // "By what date..."
      howFound        = dget('q9_q9_radio7');       // "How did you find Elvie..."
      stoneView       = dget('q10_q10_radio8');     // "How would you prefer to view stone options..."
      notes           = dget('q11_q11_textarea9');  // "Anything you'd like me to know..."
      occasion        = '';
    } else {
      // SEMI-CUSTOM FORM — confirmed field IDs
      pieceType       = dget('q4_q4_checkbox2');    // "Which of our signature designs..."
      budget          = dget('q27_whatBudget');     // "What budget range..."
      processStage    = dget('q12_q12_radio10');    // "Where are you in the process..."
      howLearnProcess = dget('q21_howWould');       // "How would you prefer to learn more..."
      occasion        = dget('q5_q5_textarea3');    // "Is this piece for a particular milestone..."
      wearerInvolved  = dget('q17_willThe');        // "Will the wearer..."
      needByYesNo     = dget('q30_doYou');          // "Do you have a need-by date..."
      needBy          = formatDate('q7_q7_datetime5'); // "By what date..."
      ringSize        = dget('q8_q8_textbox6');     // "Ring size"
      howFound        = dget('q9_q9_radio7');       // "How did you find Elvie..."
      stoneView       = dget('q10_q10_radio8');     // "How would you prefer to view stone options..."
      notes           = dget('q11_q11_textarea9');  // "Anything you'd like me to know..."
      sourcingStone   = '';
      stoneType       = '';
      designNotes     = '';
    }
    const needByFull = [needByYesNo, needBy].filter(Boolean).join(' — ');
    const design      = designNotes;
    const submissionId = raw.submissionID || Date.now().toString();

    // Inspiration images (bespoke and antique-diamond forms — from the file upload field)
    // JotForm sends these as a stringified JSON array of URLs
    // For antique-diamond, already handled above, so only process if not set
    if (formType !== 'antique-diamond' && inspirationImages.length === 0) {
      const uploadRaw = data['pleaseUpload'] || data['q41_pleaseUpload'];
      if (uploadRaw) {
        if (Array.isArray(uploadRaw)) {
          inspirationImages = uploadRaw.filter(u => typeof u === 'string' && u.startsWith('http'));
        } else if (typeof uploadRaw === 'string') {
          try {
            const parsed = JSON.parse(uploadRaw);
            if (Array.isArray(parsed)) {
              inspirationImages = parsed.filter(u => typeof u === 'string' && u.startsWith('http'));
            } else if (typeof parsed === 'string' && parsed.startsWith('http')) {
              inspirationImages = [parsed];
            }
          } catch(e) {
            // If it's not JSON but is a URL, keep it
            if (uploadRaw.startsWith('http')) inspirationImages = [uploadRaw];
          }
        }
      }
    }

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
      needBy: needByFull,
      howFound,
      stoneView,
      processStage,
      howLearnProcess,
      designNotes,
      wearerInvolved,
      notes,
      inspirationImages,
      // Antique diamond specific fields
      ...(formType === 'antique-diamond' && antiqueFields ? {
        caratRange: antiqueFields.caratRange,
        colorPref: antiqueFields.colorPref,
        clarityPref: antiqueFields.clarityPref,
        stoneIdeal: antiqueFields.stoneIdeal,
      } : {}),
    };

    // Save to Firebase via authenticated helper. The client's security rules
    // reject unauthenticated writes, so we MUST include ?auth=FIREBASE_SECRET.
    // Only push the badge notification after the write is confirmed.
    firebasePost('/inquiries', inquiry)
      .then(result => {
        console.log('JotForm inquiry saved to Firebase:', inquiry.name, formType, 'key=', result && result.name);
        return pushBadgeToAll('💌 New inquiry', inquiry.name ? 'From ' + inquiry.name : 'New inquiry');
      })
      .catch(e => console.error('Firebase inquiry write or push failed:', e.message || e));

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('JotForm webhook error:', e);
      res.status(200).json({ ok: true });
    }
  });
});

// ─── HoneyBook Invoice Payment Webhook ────────────────────────────────────────
app.post('/api/honeybook-invoice', async (req, res) => {
  try {
    const { clientName, invoiceNumber, amountPaid, netAmount, datePaid, manuallyMarked } = req.body;
    
    console.log('HoneyBook payment received:', {
      client: clientName,
      invoice: invoiceNumber,
      amount: amountPaid,
      date: datePaid,
      manual: manuallyMarked
    });

    // Try to find matching project by client name
    let matchedProjectId = null;
    let matchConfidence = 'none'; // 'exact', 'partial', 'multiple', 'none'
    let suggestedMatches = [];

    if (clientName) {
      try {
        const quotes = await firebaseGet('/quotes');
        if (quotes) {
          const quoteList = Array.isArray(quotes) ? quotes : Object.values(quotes);
          const normalizedPaymentName = clientName.toLowerCase().trim();
          
          // First try exact match
          const exactMatch = quoteList.find(q => 
            q && q.client && q.client.toLowerCase().trim() === normalizedPaymentName
          );
          
          if (exactMatch) {
            matchedProjectId = exactMatch.id;
            matchConfidence = 'exact';
            console.log('Exact project match found:', exactMatch.client);
          } else {
            // Try partial match (payment name contains project name OR project name contains payment name)
            const partialMatches = quoteList.filter(q => {
              if (!q || !q.client) return false;
              const projectName = q.client.toLowerCase().trim();
              // Check if either name contains the other
              return normalizedPaymentName.includes(projectName) || projectName.includes(normalizedPaymentName);
            });
            
            if (partialMatches.length === 1) {
              // Single partial match - suggest it
              matchedProjectId = null; // Don't auto-link, require confirmation
              matchConfidence = 'partial';
              suggestedMatches = [{ id: partialMatches[0].id, client: partialMatches[0].client }];
              console.log('Partial project match found:', partialMatches[0].client);
            } else if (partialMatches.length > 1) {
              // Multiple matches - show all for user to choose
              matchConfidence = 'multiple';
              suggestedMatches = partialMatches.map(p => ({ id: p.id, client: p.client }));
              console.log('Multiple project matches found:', suggestedMatches.length);
            }
          }
        }
      } catch (e) {
        console.error('Project matching error:', e);
      }
    }

    // Save to Firebase under /invoicePayments
    const payment = {
      clientName: clientName || '',
      invoiceNumber: invoiceNumber || '',
      amountPaid: parseFloat(amountPaid) || 0,
      netAmount: parseFloat(netAmount) || 0,
      datePaid: datePaid || new Date().toISOString(),
      manuallyMarked: manuallyMarked === true || manuallyMarked === 'true',
      receivedAt: Date.now(),
      // Matching data
      projectId: matchedProjectId, // Only set for exact matches
      matchConfidence: matchConfidence,
      suggestedMatches: suggestedMatches, // For partial/multiple matches
      linked: matchedProjectId ? true : false, // True if auto-linked
    };

    const paymentId = Date.now();
    await firebasePut('/invoicePayments/' + paymentId, payment);
    console.log('Payment saved to Firebase:', paymentId, 'match:', matchConfidence);

    // Send push notification
    const paymentType = payment.manuallyMarked ? '✓ Marked Paid' : '💰 Payment Received';
    const matchNote = matchConfidence === 'exact' ? ' (linked to project)' : 
                      matchConfidence === 'partial' || matchConfidence === 'multiple' ? ' (needs confirmation)' : '';
    await pushBadgeToAll(
      paymentType,
      `${clientName || 'Client'} paid ${invoiceNumber ? 'invoice #' + invoiceNumber : 'invoice'}${matchNote}`
    );

    res.status(200).json({ ok: true, id: paymentId, matched: matchConfidence });
  } catch (e) {
    console.error('HoneyBook webhook error:', e);
    res.status(200).json({ ok: true }); // Always return 200 so Zapier doesn't retry
  }
});

// Auth middleware
// Railway password gate — DISABLED. Google Sign-In (in the client) now handles auth.
// The old cookie-based password is no longer used. Webhook and push endpoints were always public.
app.use((req, res, next) => next());

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

// POST appends a child under fbPath using Firebase's auto-generated key.
// Includes auth secret so Firebase security rules accept the write.
// Resolves to { name: '-NxyzKey' } on success; rejects on non-2xx or transport error.
function firebasePost(fbPath, body) {
  return new Promise((resolve, reject) => {
    const secret = process.env.FIREBASE_SECRET;
    const authSuffix = secret ? `?auth=${secret}` : '';
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: FIREBASE_HOST,
      path: `${fbPath}.json${authSuffix}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
        } else {
          reject(new Error(`Firebase POST ${fbPath} failed: ${res.statusCode} ${data}`));
        }
      });
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
