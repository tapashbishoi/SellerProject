require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const initSchema = require('./schema');
const { startConsumer }      = require('./mq/consumer');
const { getMQStatus }        = require('./mq/connection');
const { attachMcpToExpress } = require('./mcp/buyer-server');
const seedDCs                = require('./dc/seed');

const requireApiKey = require('./middleware/apiKey');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

const app = express();
app.use(cors());
app.use(express.json());

// Serve UI (no key needed for dashboard)
app.use(express.static(path.join(__dirname, '../public')));

// Swagger docs — no API key needed to read the docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Seller API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

// MCP server for buyers — mounted BEFORE api key middleware (has its own auth)
attachMcpToExpress(app, '/mcp');

// ── MCP Discovery & Docs ──────────────────────────────────────

// Layer 2: /.well-known/mcp.json — machine-readable discovery
app.get('/.well-known/mcp.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    schema_version: '1.0',
    name:           'Seller Agent MCP Server',
    description:    'Stationery seller — browse catalogue, check inventory, place orders, negotiate prices',
    mcp_endpoint:   `${base}/mcp`,
    docs_url:       `${base}/mcp-docs`,
    tools_count:    12,
    categories:     ['catalogue', 'inventory', 'orders', 'negotiation'],
    auth: {
      type:        'header',
      header_name: 'X-API-Key',
      note:        'Contact seller for a buyer API key',
    },
    contact: process.env.SELLER_EMAIL || '',
  });
});

// Layer 3: /mcp-docs — human-readable tool docs page (served from public/)


// Protect all /api/* routes
app.use('/api', requireApiKey);

// API routes
app.use('/api/products',  require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/buyers',    require('./routes/buyers'));

// Health check — shows DB + MQ status
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await require('./db').query('SELECT 1'); dbOk = true; } catch (_) {}
  const mq = getMQStatus();
  res.json({
    status: dbOk && mq.connected ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'error',
    mq,
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => seedDCs())
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    startConsumer();
  })
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
