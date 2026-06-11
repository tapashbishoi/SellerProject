const pool = require('./db');

async function initSchema() {
  const client = await pool.connect();
  try {
    // ── Phase 1: Create all tables (order matters for FK refs) ──
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

      CREATE TABLE IF NOT EXISTS distribution_centers (
        id          SERIAL PRIMARY KEY,
        dc_code     VARCHAR(20) UNIQUE NOT NULL,
        name        VARCHAR(100) NOT NULL,
        address     VARCHAR(255),
        city        VARCHAR(100),
        state       VARCHAR(10),
        zip         VARCHAR(20),
        country     VARCHAR(50) DEFAULT 'US',
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS inventory (
        id          SERIAL PRIMARY KEY,
        product_id  INT UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity    INT NOT NULL DEFAULT 0,
        low_stock_threshold INT DEFAULT 10,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dc_inventory (
        id                  SERIAL PRIMARY KEY,
        dc_id               INT NOT NULL REFERENCES distribution_centers(id),
        product_id          INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity            INT NOT NULL DEFAULT 0,
        low_stock_threshold INT DEFAULT 10,
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(dc_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS buyer_profiles (
        id               SERIAL PRIMARY KEY,
        buyer_email      VARCHAR(255) UNIQUE NOT NULL,
        buyer_name       VARCHAR(255),
        company_name     VARCHAR(255),
        shipping_street  VARCHAR(255),
        shipping_city    VARCHAR(100),
        shipping_state   VARCHAR(10),
        shipping_zip     VARCHAR(20),
        shipping_country VARCHAR(50) DEFAULT 'US',
        preferred_dc_id  INT REFERENCES distribution_centers(id),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id               SERIAL PRIMARY KEY,
        buyer_name       VARCHAR(255) NOT NULL,
        buyer_email      VARCHAR(255),
        buyer_phone      VARCHAR(50),
        status           VARCHAR(50) DEFAULT 'pending',
        total_amount     NUMERIC(10,2) DEFAULT 0,
        notes            TEXT,
        failure_reason   TEXT,
        mq_message_id    VARCHAR(100),
        channel          VARCHAR(30) DEFAULT 'api',
        shipping_name    VARCHAR(255),
        shipping_street  VARCHAR(255),
        shipping_city    VARCHAR(100),
        shipping_state   VARCHAR(10),
        shipping_zip     VARCHAR(20),
        shipping_country VARCHAR(50),
        assigned_dc_id   INT REFERENCES distribution_centers(id),
        shipping_days    VARCHAR(10),
        shipping_cost    NUMERIC(8,2),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id          SERIAL PRIMARY KEY,
        order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id  INT NOT NULL REFERENCES products(id),
        quantity    INT NOT NULL,
        unit_price  NUMERIC(10,2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS negotiations (
        id            SERIAL PRIMARY KEY,
        product_id    INT NOT NULL REFERENCES products(id),
        buyer_email   VARCHAR(255) NOT NULL,
        buyer_name    VARCHAR(255),
        quantity      INT NOT NULL DEFAULT 1,
        list_price    NUMERIC(10,2) NOT NULL,
        floor_price   NUMERIC(10,2) NOT NULL,
        buyer_offer   NUMERIC(10,2) NOT NULL,
        counter_offer NUMERIC(10,2),
        status        VARCHAR(30) DEFAULT 'open',
        round         INT DEFAULT 1,
        ai_reasoning  TEXT,
        ai_message    TEXT,
        order_id      INT REFERENCES orders(id),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS edi_trading_partners (
        id              SERIAL PRIMARY KEY,
        partner_id      VARCHAR(50) UNIQUE NOT NULL,
        company_name    VARCHAR(255) NOT NULL,
        buyer_email     VARCHAR(255),
        isa_qualifier   VARCHAR(2)   DEFAULT 'ZZ',
        isa_id          VARCHAR(15)  NOT NULL,
        gs_id           VARCHAR(15)  NOT NULL,
        as2_id          VARCHAR(128),
        callback_url    VARCHAR(500),
        edi_version     VARCHAR(10)  DEFAULT '00501',
        is_active       BOOLEAN      DEFAULT true,
        notes           TEXT,
        created_at      TIMESTAMPTZ  DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS edi_messages (
        id              SERIAL PRIMARY KEY,
        direction       VARCHAR(10)  NOT NULL,
        transaction_set VARCHAR(10)  NOT NULL,
        isa_control_no  VARCHAR(20),
        gs_control_no   VARCHAR(10),
        st_control_no   VARCHAR(10),
        partner_id      VARCHAR(50),
        raw_edi         TEXT,
        parsed_json     JSONB,
        status          VARCHAR(30)  DEFAULT 'received',
        error_detail    TEXT,
        order_id        INT          REFERENCES orders(id),
        po_number       VARCHAR(50),
        related_msg_id  INT          REFERENCES edi_messages(id),
        created_at      TIMESTAMPTZ  DEFAULT NOW(),
        processed_at    TIMESTAMPTZ
      );
    `);

    // ── Phase 2: Add columns to existing tables (safe upgrades) ──
    await client.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS failure_reason   TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS mq_message_id   VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel          VARCHAR(30) DEFAULT 'api';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_name    VARCHAR(255);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_street  VARCHAR(255);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_city    VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_state   VARCHAR(10);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_zip     VARCHAR(20);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_country VARCHAR(50);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_dc_id   INT REFERENCES distribution_centers(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_days    VARCHAR(10);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost    NUMERIC(8,2);
      ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS buyer_name    VARCHAR(255);
      ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS ai_reasoning  TEXT;
      ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS order_id      INT REFERENCES orders(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS edi_po_number     VARCHAR(50);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS edi_partner_id    VARCHAR(50);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS edi_message_id    INT REFERENCES edi_messages(id);
    `);

    console.log('Database schema initialised');
  } finally {
    client.release();
  }
}

module.exports = initSchema;
