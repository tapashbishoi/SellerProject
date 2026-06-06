require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const initSchema = require('./schema');

const requireApiKey = require('./middleware/apiKey');

const app = express();
app.use(cors());
app.use(express.json());

// Serve UI (no key needed for dashboard)
app.use(express.static(path.join(__dirname, '../public')));

// Protect all /api/* routes
app.use('/api', requireApiKey);

// API routes
app.use('/api/products',  require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
