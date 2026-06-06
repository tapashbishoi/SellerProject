const pool = require('./db');

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        category    VARCHAR(100),
        unit        VARCHAR(50) DEFAULT 'piece',
        price       NUMERIC(10,2) NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS inventory (
        id          SERIAL PRIMARY KEY,
        product_id  INT UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity    INT NOT NULL DEFAULT 0,
        low_stock_threshold INT DEFAULT 10,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id            SERIAL PRIMARY KEY,
        buyer_name    VARCHAR(255) NOT NULL,
        buyer_email   VARCHAR(255),
        buyer_phone   VARCHAR(50),
        status        VARCHAR(50) DEFAULT 'pending',
        total_amount  NUMERIC(10,2) DEFAULT 0,
        notes         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id          SERIAL PRIMARY KEY,
        order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id  INT NOT NULL REFERENCES products(id),
        quantity    INT NOT NULL,
        unit_price  NUMERIC(10,2) NOT NULL
      );
    `);
    console.log('Database schema initialised');
  } finally {
    client.release();
  }
}

module.exports = initSchema;
