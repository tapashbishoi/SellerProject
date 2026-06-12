require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const initSchema = require('./schema');
const { startConsumer }      = require('./mq/consumer');
const { getMQStatus }        = require('./mq/connection');
const { attachMcpToExpress }    = require('./mcp/buyer-server');
const { attachEdiMcpToExpress } = require('./mcp/edi-server');
const seedDCs                = require('./dc/seed');
const { startEDIProcessor }  = require('./edi/processor');
const { startEDISender }     = require('./edi/sender');

const requireApiKey = require('./middleware/apiKey');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

const app = express();
app.use(cors());
app.use(express.json());

// Serve UI (no key needed for dashboard)
app.use(express.static(path.join(__dirname, '../public')));

// Swagger docs — no API key needed to read the docs
app.get('/docs/spec.json', (req, res) => res.json(swaggerSpec));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Seller API Docs',
  swaggerOptions: { persistAuthorization: true, url: '/docs/spec.json' },
}));

// MCP server for buyers (catalogue, orders, negotiation) — no auth, has own key check
attachMcpToExpress(app, '/mcp');

// EDI MCP server — strictly for EDI trading partners (850/860/997/855/856/810 only)
attachEdiMcpToExpress(app, '/edi-mcp');

// ── MCP Discovery & Docs ──────────────────────────────────────

// Layer 2: /.well-known/mcp.json — machine-readable discovery
app.get('/.well-known/mcp.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    schema_version: '1.0',
    name:           'Seller Agent MCP Servers',
    description:    'Stationery seller — two MCP endpoints: buyer (catalogue/orders/negotiation) and EDI (X12 850/860/997/855/856/810)',
    servers: [
      {
        name:        'Buyer MCP',
        description: 'Browse catalogue, check inventory, place JSON orders, negotiate prices',
        mcp_endpoint: `${base}/mcp`,
        tools_count:  18,
        categories:   ['catalogue', 'inventory', 'orders', 'negotiation', 'dc-routing'],
      },
      {
        name:        'EDI MCP',
        description: 'EDI trading partners only — send 850/860, receive 997/855/856/810 via X12',
        mcp_endpoint: `${base}/edi-mcp`,
        tools_count:  8,
        categories:   ['edi-850', 'edi-860', 'edi-997', 'edi-855', 'edi-856', 'edi-810'],
      },
    ],
    auth: {
      type:        'header',
      header_name: 'X-API-Key',
      note:        'Contact seller for an API key',
    },
    docs_url: `${base}/mcp-docs`,
    contact:  process.env.SELLER_EMAIL || '',
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
app.use('/api/dc',        require('./routes/dc'));
app.use('/edi',           require('./routes/edi'));

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
    // EDI async processors (loosely coupled via RabbitMQ topics)
    startEDIProcessor().catch(err => console.error('[EDI-Processor] Start error:', err.message));
    startEDISender().catch(err => console.error('[EDI-Sender] Start error:', err.message));
  })
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
