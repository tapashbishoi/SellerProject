const VALID_KEYS = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

module.exports = function requireApiKey(req, res, next) {
  // Skip health check (path is relative to /api mount point)
  if (req.path === '/health') return next();

  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing API key. Add header: X-API-Key: <your-key>' });
  if (!VALID_KEYS.includes(key)) return res.status(403).json({ error: 'Invalid API key' });

  next();
};
