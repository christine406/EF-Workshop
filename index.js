const https = require('https');
const cron = require('node-cron');

const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const REPORT_TO = process.env.REPORT_TO;
const REPORT_HOUR = parseInt(process.env.REPORT_HOUR || '13');
const PORT = process.env.PORT || 8080;

function firebaseGet(path) {
  return new Promise((resolve, reject) => {
    const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
    const url = `${FIREBASE_URL}${path}.json${auth}`;
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'EF-Report/1.0' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Firebase timeout: ' + path)); });
    req.end();
  });
}

async function fetchAllData() {
  console.log('Fetching Firebase data from:', FIREBASE_URL);
  console.log('Using secret:', FIREBASE_SECRET ? 'yes (length ' + FIREBASE_SECRET.length + ')' : 'no');
  const [quotes, inventory, invoices, production, fieldLog] = await Promise.all([
    firebaseGet('/quotes').then(d => { console.log('quotes ok, count:', Array.isArray(d) ? d.length : typeof d); return d; }).catch(e => { console.error('quotes failed:', e.message); return null; }),
    firebaseGet('/inventory').then(d => { console.log('inventory ok'); return d; }).catch(e => { console.error('inventory failed:', e.message); return null; }),
    firebaseGet('/invoices').then(d => { console.log('invoices ok'); return d; }).catch(e => { console.error('invoices failed:', e.message); return null; }),
    firebaseGet('/production').then(d => { console.log('production ok'); return d; }).catch(e => { console.error('production failed:', e.message); return null; }),
    firebaseGet('/fieldLog').then(d => { console.log('fieldLog ok'); return d; }).catch(e => { console.error('fieldLog failed:', e.message); return null; }),
  ]);

  const toArray = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean);
    if (typeof val === 'object') return Object.values(val).filter(Boolean);
    return [];
  };

  return {
    quotes: toArray(quotes),
    inventory: toArray(inventory),
    invoices: toArray(invoices),
    production: toArray(production),
    fieldLog: toArray(fieldLog),
  };
}

function stoneMarkup(cost) {
  if (cost <= 5000) return 2.1;
  if (cost <= 10000) return 1.8;
  if (cost <= 15000) return 1.6;
  if (cost <= 25000) return 1.55;
  return 1.5;
}

function calcExpectedRetail(q) {
  const stoneCost = q.actualStoneCost != null ? q.actualStoneCost : (q.stones || []).reduce((s, st) => s + (st.cost || 0), 0);
  const meleeCost = q.actualMeleeCost != null ? q.actualMeleeCost : (q.meleeCost || 0);
  const metalCost = q.actualMetalCost != null ? q.actualMetalCost : (q.metalEstimate || 0);
  const laborCost = q.actualLabor != null ? q.actualLabor : (q.laborEst || 0);
  const chainCost = q.actualChainCost != null ? q.actualChainCost : (q.chainCost || 0);
  const designFee = q.actualDesignFee != null ? q.actualDesignFee : (q.designFee || 0);
  const stoneRetail = stoneCost * stoneMarkup(stoneCost);
  const meleeRetail = meleeCost * 1.75;
  const laborRetail = laborCost * 1.4;
  const rest = Math.round(metalCost * 1.35) + Math.round(chainCost * 1.35) + Math.round(laborRetail) + Math.round(meleeRetail) + designFee;
  const raw = stoneRetail + rest * 1.13;
  return Math.round(raw / 50) * 50;
}

function buildDataSummary(data) {
  const { quotes, inventory, invoices, production, fieldLog } = data;

  const activeProjects = quotes.filter(q =>
    q.status === 'project' && !['abandoned', 'completed', 'archived-project'].includes(q.status)
  );

  const activeQuotes = quotes.filter(q => q.status === 'quote');

  const projectsWithActuals = activeProjects.map(q => {
    const stoneCost = q.actualStoneCost != null ? q.actualStoneCost : (q.stones || []).reduce((s, st) => s + (st.cost || 0), 0);
    const totalCost = (stoneCost || 0) + (q.actualMeleeCost || 0) + (q.actualMetalCost || 0) + (q.actualLabor || 0) + (q.actualChainCost || 0) + (q.actualDesignFee || 0);
    const clientPrice = q.clientPrice || 0;
    const expectedRetail = calcExpectedRetail(q);
    const margin = clientPrice > 0 && totalCost > 0 ? ((clientPrice - totalCost) / clientPrice * 100).toFixed(1) : null;
    const retailDiff = clientPrice > 0 && expectedRetail > 0 ? clientPrice - expectedRetail : null;
    return {
      client: q.client,
      quoteType: q.quoteType,
      date: q.date,
      hasActuals: q.actualStoneCost != null || q.actualMetalCost != null || q.actualLabor != null,
      expectedRetail,
      clientPrice,
      totalCost: Math.round(totalCost),
      margin,
      retailDiff,
      stoneCost: Math.round(stoneCost),
      metalCost: q.actualMetalCost,
      laborCost: q.actualLabor,
      meleeCost: q.actualMeleeCost,
      costPushes: (q.costPushes || []).length,
      openNotes: (q.projectNotes || []).filter(n => !n.done).length,
      pieces: q.isMultiPiece ? (q.pieces || []).length : 1,
    };
  });

  const availableStones = inventory.filter(s => s.status === 'available' || !s.status);
  const inUseStones = inventory.filter(s => s.status === 'in-use');
  const memoStones = inventory.filter(s => s.category === 'memo');
  const totalInvValue = availableStones.filter(s => s.cost > 0).reduce((s, st) => s + (st.cost || 0), 0);
  const cpcts = availableStones.filter(s => s.cost && s.carat).map(s => s.cost / s.carat);
  const avgCpct = cpcts.length ? cpcts.reduce((a, b) => a + b, 0) / cpcts.length : null;

  const cpctOutliers = availableStones.filter(s => {
    if (!s.cost || !s.carat || !avgCpct) return false;
    const cpct = s.cost / s.carat;
    return cpct > avgCpct * 2 || cpct < avgCpct * 0.3;
  }).map(s => ({
    desc: [s.carat ? parseFloat(s.carat).toFixed(2) + 'ct' : '', s.cut, s.color, s.clarity].filter(Boolean).join(' '),
    cpct: Math.round(s.cost / s.carat),
    cost: s.cost,
    dealer: s.dealer,
  }));

  const returnAlerts = memoStones.filter(s => s.returnBy).map(s => ({
    desc: [s.carat ? parseFloat(s.carat).toFixed(2) + 'ct' : '', s.cut, s.color, s.clarity].filter(Boolean).join(' '),
    returnBy: s.returnBy,
    dealer: s.dealer,
  }));

  // Carrera is auto-billed — exclude from unpushed alerts, just tally for info
  const AUTO_BILL_VENDORS = ['carrera', 'carrera casting'];
  const unpushedInvoices = invoices.filter(inv => {
    if (AUTO_BILL_VENDORS.includes((inv.vendor || '').toLowerCase())) return false;
    const items = inv.lineItems || inv.stones || [];
    return items.some(li => !li.pushed);
  }).map(inv => ({
    vendor: inv.vendor,
    number: inv.invoiceNumber,
    date: inv.date,
    unpushedCount: (inv.lineItems || inv.stones || []).filter(li => !li.pushed).length,
  }));

  // Carrera tally — just for awareness, not flagged as urgent
  const carreraPending = invoices.filter(inv =>
    AUTO_BILL_VENDORS.includes((inv.vendor || '').toLowerCase())
  ).reduce((total, inv) => {
    const items = inv.lineItems || inv.stones || [];
    return total + items.filter(li => !li.pushed).reduce((s, li) => s + (li.amount || 0), 0);
  }, 0);

  const prodIssues = production.filter(p => !p.stoneCost && !p.metalCost && !p.laborCost).map(p => p.name);

  const unreconciledLog = (fieldLog || [])
    .filter(e => !e.reconciled && e.amount > 0)
    .slice(0, 10)
    .map(e => ({ desc: e.description, amount: e.amount, type: e.type, date: e.date }));

  const recentCompleted = quotes.filter(q => q.status === 'completed' && q.clientPrice > 0)
    .slice(0, 5).map(q => {
      const tc = (q.actualStoneCost || 0) + (q.actualMeleeCost || 0) + (q.actualMetalCost || 0) + (q.actualLabor || 0) + (q.actualChainCost || 0);
      return {
        client: q.client,
        clientPrice: q.clientPrice,
        margin: tc > 0 ? ((q.clientPrice - tc) / q.clientPrice * 100).toFixed(1) + '%' : 'unknown',
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    activeProjects: projectsWithActuals,
    activeQuotes: activeQuotes.map(q => ({ client: q.client, total: q.total, date: q.date, quoteType: q.quoteType })),
    inventory: {
      available: availableStones.length,
      inUse: inUseStones.length,
      memo: memoStones.length,
      totalValue: Math.round(totalInvValue),
      avgCpct: avgCpct ? Math.round(avgCpct) : null,
      outliers: cpctOutliers,
      returnAlerts,
    },
    invoices: { unpushed: unpushedInvoices, carreraPendingTally: Math.round(carreraPending) },
    production: { specsWithNoData: prodIssues },
    fieldLog: { unreconciled: unreconciledLog },
    recentCompleted,
  };
}

function callClaude(summary) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are a business analyst assistant for Elvie Fine, a custom fine jewelry brand in New York run by Christine.

Christine's business context:
- She designs bespoke and semi-custom fine jewelry, specializing in antique and old mine cut diamonds
- She sources stones herself in the Diamond District
- Markup formulas: stones ≤$5k = ×2.1, ≤$10k = ×1.8, ≤$15k = ×1.6, ≤$25k = ×1.55, over $25k = ×1.5
- Metal: casting bill × 1.05 × 1.35. Labor: ×1.4. Melee: ×1.75. Overhead: 13% on non-stone costs
- Target margin: 50%+ on completed projects
- Carrera Casting is auto-billed — their unpushed invoices are just a running tally of upcoming charges, not an action item. Show the tally as informational only, never flag as urgent

Write a clear, direct daily business report. Be specific about numbers. Flag real problems, not just observations. Lead with what needs attention. Use plain language, not corporate speak. Be concise — Christine is busy.`;

    const userPrompt = `Here is today's EF Workshop data snapshot. Write Christine's daily report.

DATA:
${JSON.stringify(summary, null, 2)}

Structure:
1. NEEDS ATTENTION — urgent items (math errors, missing costs, memo returns due, unpushed invoices)
2. ACTIVE PROJECTS — each project's health: costs, margin, pricing vs expected retail
3. STONE INVENTORY — value, $/ct average, outliers, return deadlines
4. QUOTES PIPELINE — open quotes not yet converted
5. UNRECONCILED COSTS — field log entries not pushed to projects
6. PRODUCTION SPECS — any missing data
7. QUICK WINS — low-effort cleanup tasks for today

Be direct. If something looks off, say why.`;

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content && parsed.content[0] && parsed.content[0].text;
          if (text) resolve(text);
          else reject(new Error('No content from Claude: ' + data));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendReport(reportText) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const payload = JSON.stringify({
    from: 'EF Workshop <onboarding@resend.dev>',
    to: [REPORT_TO],
    subject: `EF Workshop Daily Report — ${today}`,
    text: reportText,
    html: `<pre style="font-family:monospace;font-size:14px;line-height:1.6;max-width:700px;white-space:pre-wrap;">${reportText}</pre>`,
  });
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Report sent to', REPORT_TO);
          resolve();
        } else {
          reject(new Error('Resend error: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runReport() {
  console.log('Running daily report...', new Date().toISOString());
  try {
    const data = await fetchAllData();
    const summary = buildDataSummary(data);
    const report = await callClaude(summary);
    await sendReport(report);
    console.log('Report complete.');
  } catch(e) {
    console.error('Report failed:', e.message);
    console.error('Stack:', e.stack);
  }
}

const cronExpression = `0 ${REPORT_HOUR} * * *`;
console.log(`Daily report scheduled at UTC hour ${REPORT_HOUR}`);
cron.schedule(cronExpression, runReport);

const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/run-report' && req.method === 'POST') {
    runReport();
    res.writeHead(200);
    res.end('Report triggered');
  } else {
    res.writeHead(200);
    res.end('EF Daily Report running');
  }
}).listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
