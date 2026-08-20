const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const webhookRouter = require('./src/webhook');
const { syncAllDatabaseToBigin, clearAllBiginData, pullBiginToDatabase } = require('./src/agents/biginSyncAgent');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount webhook router
app.use('/webhook', webhookRouter);

// Sync Handler Helper
const renderSyncResult = (res, title, subtitle, results, error) => {
  if (error) {
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Zoho Bigin Sync Error</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:system-ui;padding:40px;background:#f8fafc;color:#0f172a;}.card{background:white;max-width:560px;margin:0 auto;padding:32px;border-radius:20px;border:1px solid #fee2e2;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05);}.err{color:#dc2626;font-weight:700;font-size:20px;margin-bottom:8px;}.desc{color:#64748b;font-size:14px;}.btn{display:inline-block;margin-top:20px;background:#2563eb;color:white;padding:10px 20px;border-radius:10px;text-decoration:none;font-weight:600;}</style></head>
      <body><div class="card"><div class="err">❌ Zoho Sync Error</div><div class="desc">${error}</div><a href="/bigin-sync" class="btn">Retry Sync 🔄</a></div></body>
      </html>
    `);
  }
  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 40px 20px; }
        .card { background: white; max-width: 560px; margin: 0 auto; padding: 32px; border-radius: 20px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
        .badge { display: inline-block; background: #dcfce7; color: #15803d; font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
        h2 { font-size: 22px; margin: 0 0 8px 0; color: #0f172a; }
        p { font-size: 14px; color: #64748b; margin: 0 0 24px 0; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .stat { background: #f1f5f9; padding: 16px; border-radius: 14px; text-align: center; }
        .num { font-size: 32px; font-weight: 800; color: #2563eb; }
        .label { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 4px; }
        .actions { display: flex; gap: 12px; }
        .btn { flex: 1; text-align: center; background: #2563eb; color: white; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 20px; border-radius: 12px; transition: all 0.2s; }
        .btn-sec { background: #e2e8f0; color: #334155; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">STATUS: ONLINE 🟢</span>
        <h2>${title}</h2>
        <p>${subtitle}</p>
        
        <div class="grid">
          <div class="stat">
            <div class="num">${results?.contactsSynced || results?.contactsImported || 0}</div>
            <div class="label">Contacts</div>
          </div>
          <div class="stat">
            <div class="num">${results?.dealsSynced || results?.dealsImported || 0}</div>
            <div class="label">Deals</div>
          </div>
        </div>

        <div class="actions">
          <a href="https://bigin.zoho.in/" target="_blank" class="btn">Open Zoho Bigin ↗</a>
          <a href="/" class="btn btn-sec">Dashboard 🏠</a>
        </div>
      </div>
    </body>
    </html>
  `);
};

// Handle bigin-import across all possible URL aliases (GET & POST)
const importRouteHandler = async (req, res) => {
  try {
    const results = await pullBiginToDatabase();
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "📥 Bigin Data Imported to Database!", "Customer contacts and active deals have been pulled from Zoho Bigin into your database.", results);
    }
    return res.json({ success: true, imported: results });
  } catch (err) {
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "", "", null, err.message);
    }
    return res.status(500).json({ error: err.message });
  }
};

// Handle bigin-sync across all possible URL aliases (GET & POST)
const syncRouteHandler = async (req, res) => {
  try {
    const results = await syncAllDatabaseToBigin();
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "✅ Database Synced to Zoho Bigin!", "All customer profiles and active pipeline deals have been synced to Zoho Bigin CRM.", results);
    }
    return res.json({ success: true, synced: results });
  } catch (err) {
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "", "", null, err.message);
    }
    return res.status(500).json({ error: err.message });
  }
};

// Handle bigin-cleanup across all possible URL aliases (GET & POST)
const cleanupRouteHandler = async (req, res) => {
  try {
    const deleteResults = await clearAllBiginData();
    const syncResults = await syncAllDatabaseToBigin();
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "✅ Cleaned & Re-synced to Zoho Bigin!", "Old records cleared and database customers/deals re-synced clean.", syncResults);
    }
    return res.json({ success: true, deleted: deleteResults.deleted, synced: syncResults });
  } catch (err) {
    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return renderSyncResult(res, "", "", null, err.message);
    }
    return res.status(500).json({ error: err.message });
  }
};

// Register all route aliases
['/bigin-import', '/admin/bigin-import', '/webhook/bigin-import', '/webhook/admin/bigin-import'].forEach(p => {
  app.get(p, importRouteHandler);
  app.post(p, importRouteHandler);
});

['/bigin-sync', '/admin/bigin-sync', '/webhook/bigin-sync', '/webhook/admin/bigin-sync'].forEach(p => {
  app.get(p, syncRouteHandler);
  app.post(p, syncRouteHandler);
});

['/bigin-cleanup', '/admin/bigin-cleanup', '/webhook/bigin-cleanup', '/webhook/admin/bigin-cleanup'].forEach(p => {
  app.get(p, cleanupRouteHandler);
  app.post(p, cleanupRouteHandler);
});

// Root landing page with interactive sync buttons
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Enlight Sales Bot & CRM AI Agent</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px 20px; }
        .card { background: #1e293b; max-width: 560px; margin: 0 auto; padding: 32px; border-radius: 20px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3); border: 1px solid #334155; }
        .badge { display: inline-block; background: #064e3b; color: #34d399; font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
        h1 { font-size: 24px; margin: 0 0 8px 0; }
        p { font-size: 14px; color: #94a3b8; margin: 0 0 28px 0; }
        .btn-group { display: flex; flex-direction: column; gap: 12px; }
        .btn { display: block; text-align: center; background: #2563eb; color: white; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 20px; border-radius: 12px; transition: all 0.2s; }
        .btn-sec { background: #334155; color: #f8fafc; }
        .btn-imp { background: #059669; color: white; }
        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">ENLIGHT CRM AI AGENT 🟢</span>
        <h1>Enlight Metals Sales Bot & CRM Agent</h1>
        <p>Bi-Directional Automated Zoho Bigin CRM Agent & WhatsApp Sales Assistant.</p>
        
        <div class="btn-group">
          <a href="/bigin-import" class="btn btn-imp">📥 Import All Data from Bigin → Database</a>
          <a href="/bigin-sync" class="btn">📤 Push All Database Records → Bigin</a>
          <a href="/bigin-cleanup" class="btn btn-sec">🧹 Clean & Re-sync Zoho Bigin</a>
          <a href="https://bigin.zoho.in/" target="_blank" class="btn btn-sec">Open Zoho Bigin CRM ↗</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Health check endpoint for cloud platforms & Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start scheduler safely
const { startScheduler } = require('./src/scheduler');

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server is listening on ${HOST}:${PORT}`);
  try {
    startScheduler();
  } catch (err) {
    console.error('Scheduler startup error (non-fatal):', err.message);
  }
});
