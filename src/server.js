require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const initSchema = require('./schema');
const { startConsumer }    = require('./mq/consumer');
const { getMQStatus }      = require('./mq/connection');
const { attachMcpToExpress } = require('./mcp/buyer-server');

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

// Protect all /api/* routes
app.use('/api', requireApiKey);

// API routes
app.use('/api/products',  require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/analytics', require('./routes/analytics'));

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
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    // Start MQ consumer in the same process (works on Render free tier)
    startConsumer();
  })
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
