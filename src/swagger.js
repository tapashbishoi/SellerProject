const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Seller Agent API',
    version: '2.0.0',
    description: `Order management, catalogue, inventory, DC routing, buyer profiles and AI negotiation API.

## Authentication
All \`/api/*\` endpoints require the **X-API-Key** header.
- **Seller key** \`seller-admin-key-2025\` — full access
- **Buyer key** \`buyer-key-001\` — read catalogue/inventory, place & track orders

## Channel Tags
Orders are tagged by source: \`ui\` \`api\` \`mcp\` \`negotiation\`

## Order Flow
\`POST /api/orders\` → RabbitMQ → consumer validates stock → deducts DC inventory → \`confirmed\`

## DC Routing
Shipping state → nearest DC (US East / US West / US Central) → fulfillment`,
    contact: { name: 'Seller Support', email: process.env.SELLER_EMAIL || '' },
  },
  servers: [{ url: '/api', description: 'API base' }],

  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    schemas: {
      // ── Core ──────────────────────────────────────────────────
      Product: {
        type: 'object',
        properties: {
          id:                  { type: 'integer', example: 9 },
          name:                { type: 'string',  example: 'Blue Ball Pen' },
          description:         { type: 'string',  example: 'Smooth writing blue ink ball pen' },
          category:            { type: 'string',  example: 'Pen' },
          unit:                { type: 'string',  example: 'piece' },
          price:               { type: 'number',  example: 10.00 },
          quantity:            { type: 'integer', example: 400 },
          low_stock_threshold: { type: 'integer', example: 50 },
          stock_status:        { type: 'string',  enum: ['in_stock','low_stock','out_of_stock'] },
          created_at:          { type: 'string',  format: 'date-time' },
        },
      },
      InventoryItem: {
        type: 'object',
        properties: {
          product_id:          { type: 'integer', example: 9 },
          name:                { type: 'string',  example: 'Blue Ball Pen' },
          category:            { type: 'string',  example: 'Pen' },
          price:               { type: 'number',  example: 10.00 },
          quantity:            { type: 'integer', example: 400 },
          low_stock_threshold: { type: 'integer', example: 50 },
          stock_status:        { type: 'string',  enum: ['in_stock','low_stock','out_of_stock'] },
          updated_at:          { type: 'string',  format: 'date-time' },
        },
      },
      DCInventoryItem: {
        type: 'object',
        properties: {
          product_id:          { type: 'integer', example: 9 },
          name:                { type: 'string',  example: 'Blue Ball Pen' },
          category:            { type: 'string',  example: 'Pen' },
          unit:                { type: 'string',  example: 'piece' },
          price:               { type: 'number',  example: 10.00 },
          quantity:            { type: 'integer', example: 133 },
          low_stock_threshold: { type: 'integer', example: 50 },
          stock_status:        { type: 'string',  enum: ['in_stock','low_stock','out_of_stock'] },
          updated_at:          { type: 'string',  format: 'date-time' },
        },
      },
      DistributionCenter: {
        type: 'object',
        properties: {
          id:                { type: 'integer', example: 1 },
          dc_code:           { type: 'string',  example: 'US_EAST' },
          name:              { type: 'string',  example: 'US East DC' },
          address:           { type: 'string',  example: '100 Commerce Blvd' },
          city:              { type: 'string',  example: 'New York' },
          state:             { type: 'string',  example: 'NY' },
          zip:               { type: 'string',  example: '10001' },
          country:           { type: 'string',  example: 'US' },
          is_active:         { type: 'boolean', example: true },
          active_orders:     { type: 'integer', example: 12 },
          confirmed_orders:  { type: 'integer', example: 10 },
          total_revenue:     { type: 'number',  example: 4500.00 },
          total_stock_units: { type: 'integer', example: 1125 },
        },
      },
      BuyerProfile: {
        type: 'object',
        properties: {
          id:               { type: 'integer', example: 1 },
          buyer_email:      { type: 'string',  example: 'ravi@company.com' },
          buyer_name:       { type: 'string',  example: 'Ravi Kumar' },
          company_name:     { type: 'string',  example: 'Acme Corp' },
          shipping_street:  { type: 'string',  example: '123 Main St' },
          shipping_city:    { type: 'string',  example: 'New York' },
          shipping_state:   { type: 'string',  example: 'NY' },
          shipping_zip:     { type: 'string',  example: '10001' },
          shipping_country: { type: 'string',  example: 'US' },
          preferred_dc_id:  { type: 'integer', example: 1 },
          preferred_dc_name:{ type: 'string',  example: 'US East DC' },
          dc_code:          { type: 'string',  example: 'US_EAST' },
          created_at:       { type: 'string',  format: 'date-time' },
        },
      },
      OrderItem: {
        type: 'object',
        properties: {
          product_id:   { type: 'integer', example: 9 },
          product_name: { type: 'string',  example: 'Blue Ball Pen' },
          quantity:     { type: 'integer', example: 10 },
          unit_price:   { type: 'number',  example: 8.50 },
          subtotal:     { type: 'number',  example: 85.00 },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id:               { type: 'integer', example: 1 },
          buyer_name:       { type: 'string',  example: 'Ravi Kumar' },
          buyer_email:      { type: 'string',  example: 'ravi@company.com' },
          buyer_phone:      { type: 'string',  example: '9876543210' },
          status:           { type: 'string',  enum: ['queued','pending','confirmed','shipped','delivered','cancelled','rejected','failed'] },
          channel:          { type: 'string',  enum: ['ui','api','mcp','negotiation'] },
          total_amount:     { type: 'number',  example: 85.00 },
          notes:            { type: 'string',  example: 'Negotiated price: $8.50/unit' },
          failure_reason:   { type: 'string',  example: null },
          assigned_dc_id:   { type: 'integer', example: 1 },
          dc_name:          { type: 'string',  example: 'US East DC' },
          dc_code:          { type: 'string',  example: 'US_EAST' },
          dc_city:          { type: 'string',  example: 'New York' },
          shipping_name:    { type: 'string',  example: 'Ravi Kumar' },
          shipping_street:  { type: 'string',  example: '123 Main St' },
          shipping_city:    { type: 'string',  example: 'New York' },
          shipping_state:   { type: 'string',  example: 'NY' },
          shipping_zip:     { type: 'string',  example: '10001' },
          shipping_country: { type: 'string',  example: 'US' },
          shipping_days:    { type: 'string',  example: '1-2' },
          shipping_cost:    { type: 'number',  example: 6.00 },
          items:            { type: 'array',   items: { $ref: '#/components/schemas/OrderItem' } },
          created_at:       { type: 'string',  format: 'date-time' },
          updated_at:       { type: 'string',  format: 'date-time' },
        },
      },
      Negotiation: {
        type: 'object',
        properties: {
          id:                    { type: 'integer', example: 1 },
          product_id:            { type: 'integer', example: 9 },
          product_name:          { type: 'string',  example: 'Blue Ball Pen' },
          buyer_email:           { type: 'string',  example: 'ravi@company.com' },
          buyer_name:            { type: 'string',  example: 'Ravi Kumar' },
          quantity:              { type: 'integer', example: 50 },
          list_price:            { type: 'number',  example: 10.00 },
          floor_price:           { type: 'number',  example: 7.00 },
          buyer_offer:           { type: 'number',  example: 8.50 },
          counter_offer:         { type: 'number',  example: null },
          status:                { type: 'string',  enum: ['open','accepted','countered','rejected'] },
          round:                 { type: 'integer', example: 2 },
          ai_message:            { type: 'string',  example: 'We accept your offer of $8.50 for 50 units.' },
          discount_requested_pct:{ type: 'number',  example: 15.0 },
          order_id:              { type: 'integer', example: 16 },
          created_at:            { type: 'string',  format: 'date-time' },
          updated_at:            { type: 'string',  format: 'date-time' },
        },
      },
      ChannelStats: {
        type: 'object',
        properties: {
          channel:       { type: 'string', example: 'mcp' },
          total_orders:  { type: 'integer', example: 8 },
          confirmed:     { type: 'integer', example: 7 },
          cancelled:     { type: 'integer', example: 1 },
          revenue:       { type: 'number',  example: 680.00 },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string', example: 'Product not found' } },
      },
      QueuedOrderResponse: {
        type: 'object',
        properties: {
          message:    { type: 'string',  example: 'Order queued for processing' },
          order_id:   { type: 'integer', example: 12 },
          status:     { type: 'string',  example: 'queued' },
          message_id: { type: 'string',  example: 'a3f1c2d4-...' },
          created_at: { type: 'string',  format: 'date-time' },
        },
      },
    },
  },

  security: [{ ApiKeyAuth: [] }],

  paths: {

    // ── PRODUCTS ──────────────────────────────────────────────
    '/products': {
      get: {
        tags: ['Catalogue'],
        summary: 'List all products with live stock status',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter: Pen, Pencil, Notebook, Eraser, Ruler, Stapler, File, Other' },
          { name: 'search',   in: 'query', schema: { type: 'string' }, description: 'Search product name (case-insensitive partial match)' },
        ],
        responses: {
          200: { description: 'Product list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } },
          401: { description: 'Missing API key' },
        },
      },
      post: {
        tags: ['Catalogue'],
        summary: 'Add a new product with initial inventory',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['name','price'],
                properties: {
                  name:                { type: 'string',  example: 'Red Gel Pen' },
                  description:         { type: 'string' },
                  category:            { type: 'string',  example: 'Pen' },
                  unit:                { type: 'string',  example: 'piece', default: 'piece' },
                  price:               { type: 'number',  example: 15.00 },
                  initial_quantity:    { type: 'integer', example: 200, default: 0 },
                  low_stock_threshold: { type: 'integer', example: 20,  default: 10 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Product created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          400: { description: 'Validation error' },
        },
      },
    },
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Catalogue'],
        summary: 'Get single product with stock status',
        responses: {
          200: { description: 'Product', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          404: { description: 'Not found' },
        },
      },
      put: {
        tags: ['Catalogue'],
        summary: 'Update product details (name, price, category, unit)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, unit: { type: 'string' }, price: { type: 'number' } } } } },
        },
        responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
      },
      delete: {
        tags: ['Catalogue'],
        summary: 'Delete product',
        responses: { 200: { description: 'Deleted' } },
      },
    },

    // ── INVENTORY ─────────────────────────────────────────────
    '/inventory': {
      get: {
        tags: ['Inventory'],
        summary: 'Global inventory — aggregated across all DCs',
        responses: { 200: { description: 'Inventory list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } } } } } },
      },
    },
    '/inventory/{productId}': {
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer' }, example: 9 }],
      patch: {
        tags: ['Inventory'],
        summary: 'Set global quantity or low-stock threshold',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { quantity: { type: 'integer', example: 200 }, low_stock_threshold: { type: 'integer', example: 30 } } } } } },
        responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
      },
    },
    '/inventory/{productId}/restock': {
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer' } }],
      post: {
        tags: ['Inventory'],
        summary: 'Add stock globally (restock)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['add_quantity'], properties: { add_quantity: { type: 'integer', example: 100 } } } } } },
        responses: { 200: { description: 'Updated' } },
      },
    },

    // ── DISTRIBUTION CENTERS ──────────────────────────────────
    '/dc': {
      get: {
        tags: ['Distribution Centers'],
        summary: 'List all DCs with order counts, revenue and stock totals',
        responses: { 200: { description: 'DC list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DistributionCenter' } } } } } },
      },
    },
    '/dc/{id}/inventory': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'DC ID' }],
      get: {
        tags: ['Distribution Centers'],
        summary: 'Inventory at a specific DC — all products with stock status',
        responses: { 200: { description: 'DC inventory', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DCInventoryItem' } } } } } },
      },
    },
    '/dc/{dcId}/inventory/{productId}': {
      parameters: [
        { name: 'dcId',      in: 'path', required: true, schema: { type: 'integer' } },
        { name: 'productId', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      patch: {
        tags: ['Distribution Centers'],
        summary: 'Update stock quantity at a specific DC',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { quantity: { type: 'integer', example: 150 }, low_stock_threshold: { type: 'integer', example: 20 } } } } } },
        responses: { 200: { description: 'Updated DC inventory record' } },
      },
    },
    '/dc/orders/by-dc': {
      get: {
        tags: ['Distribution Centers'],
        summary: 'All orders that have been assigned to a DC, grouped by DC code',
        responses: { 200: { description: 'Orders with DC info', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } },
      },
    },

    // ── BUYER PROFILES ────────────────────────────────────────
    '/buyers': {
      post: {
        tags: ['Buyer Profiles'],
        summary: 'Create or update buyer profile with office shipping address',
        description: 'Saves the buyer\'s default shipping address and auto-assigns the nearest DC. Subsequent orders auto-load the address — no need to re-enter.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['buyer_email','shipping_city','shipping_state'],
                properties: {
                  buyer_email:     { type: 'string', format: 'email', example: 'ravi@company.com' },
                  buyer_name:      { type: 'string', example: 'Ravi Kumar' },
                  company_name:    { type: 'string', example: 'Acme Corp' },
                  shipping_street: { type: 'string', example: '123 Main St' },
                  shipping_city:   { type: 'string', example: 'New York' },
                  shipping_state:  { type: 'string', example: 'NY', description: '2-letter US state code' },
                  shipping_zip:    { type: 'string', example: '10001' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Profile saved with nearest DC assigned', content: { 'application/json': { schema: { $ref: '#/components/schemas/BuyerProfile' } } } },
        },
      },
    },
    '/buyers/{email}': {
      parameters: [{ name: 'email', in: 'path', required: true, schema: { type: 'string' }, example: 'ravi@company.com' }],
      get: {
        tags: ['Buyer Profiles'],
        summary: 'Get buyer profile including preferred DC',
        responses: {
          200: { description: 'Buyer profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/BuyerProfile' } } } },
          404: { description: 'Profile not found' },
        },
      },
    },

    // ── ORDERS ────────────────────────────────────────────────
    '/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List all orders with DC and shipping info',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued','pending','confirmed','shipped','delivered','cancelled','rejected','failed'] } },
        ],
        responses: { 200: { description: 'Orders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } },
      },
      post: {
        tags: ['Orders'],
        summary: 'Place order via RabbitMQ — auto-assigns nearest DC from buyer profile',
        description: 'Shipping address auto-loaded from buyer profile if registered. DC routing is based on shipping state. Returns immediately with `status: queued` — poll `GET /orders/:id` for `confirmed`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['buyer_name','items'],
                properties: {
                  buyer_name:      { type: 'string',  example: 'Ravi Kumar' },
                  buyer_email:     { type: 'string',  example: 'ravi@company.com' },
                  buyer_phone:     { type: 'string',  example: '9876543210' },
                  notes:           { type: 'string' },
                  shipping_street: { type: 'string',  example: '123 Main St', description: 'Auto-loaded from buyer profile if registered' },
                  shipping_city:   { type: 'string',  example: 'New York' },
                  shipping_state:  { type: 'string',  example: 'NY' },
                  shipping_zip:    { type: 'string',  example: '10001' },
                  items: {
                    type: 'array', minItems: 1,
                    items: { type: 'object', required: ['product_id','quantity'], properties: { product_id: { type: 'integer', example: 9 }, quantity: { type: 'integer', example: 10 } } },
                  },
                },
              },
            },
          },
        },
        responses: {
          202: { description: 'Order queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/QueuedOrderResponse' } } } },
          400: { description: 'Validation error' },
        },
      },
    },
    '/orders/stage': {
      post: {
        tags: ['Orders'],
        summary: 'Stage order (same as POST /orders, explicit channel tagging)',
        description: 'Accepts a `channel` field to tag the order source (mcp, negotiation, etc.)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['buyer_name','items'],
                properties: {
                  buyer_name:  { type: 'string' },
                  buyer_email: { type: 'string' },
                  items:       { type: 'array', items: { type: 'object', properties: { product_id: { type: 'integer' }, quantity: { type: 'integer' } } } },
                  channel:     { type: 'string', enum: ['ui','api','mcp','negotiation'], default: 'api' },
                },
              },
            },
          },
        },
        responses: { 202: { description: 'Queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/QueuedOrderResponse' } } } } },
      },
    },
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Orders'],
        summary: 'Get single order with items, DC and shipping details',
        responses: {
          200: { description: 'Order', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          404: { description: 'Not found' },
        },
      },
    },
    '/orders/{id}/status': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      patch: {
        tags: ['Orders'],
        summary: 'Update order status — cancelling restores DC inventory',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending','confirmed','shipped','delivered','cancelled','rejected'] } } } } },
        },
        responses: { 200: { description: 'Updated order' }, 400: { description: 'Invalid status' } },
      },
    },

    // ── ANALYTICS ─────────────────────────────────────────────
    '/analytics/channels': {
      get: {
        tags: ['Analytics'],
        summary: 'Order & revenue breakdown by channel (ui / api / mcp / negotiation)',
        responses: {
          200: {
            description: 'Channel analytics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    channelStats: { type: 'array', items: { $ref: '#/components/schemas/ChannelStats' } },
                    negStats: {
                      type: 'object',
                      properties: {
                        total_negotiations: { type: 'integer', example: 5 },
                        accepted:           { type: 'integer', example: 3 },
                        countered:          { type: 'integer', example: 1 },
                        rejected:           { type: 'integer', example: 1 },
                        avg_discount_pct:   { type: 'number',  example: 14.5 },
                        negotiated_revenue: { type: 'number',  example: 1250.00 },
                      },
                    },
                    dailyTrend:  { type: 'array', description: 'Last 30 days orders/revenue per channel per day' },
                    topProducts: { type: 'array', description: 'Top products by revenue, grouped by channel' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/analytics/negotiations': {
      get: {
        tags: ['Analytics'],
        summary: 'Full negotiation history — all AI negotiation rounds',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['accepted','countered','rejected','open'] }, description: 'Filter by negotiation status' },
          { name: 'limit',  in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: { description: 'Negotiation list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Negotiation' } } } } },
        },
      },
    },
    '/analytics/orders/{id}/reject': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      patch: {
        tags: ['Analytics'],
        summary: 'Seller rejects an order with reason — restores DC inventory',
        description: 'Use when the seller wants to reject an order (e.g. price too low). Sets status to `rejected`, stores the reason, and restores inventory.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', example: 'Price offered is below our minimum acceptable price.' } } } } },
        },
        responses: {
          200: { description: 'Rejected order', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          400: { description: 'Cannot reject — invalid status or missing reason' },
          404: { description: 'Order not found' },
        },
      },
    },

    // ── HEALTH ────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check — shows DB and RabbitMQ connection status',
        security: [],
        responses: {
          200: {
            description: 'System health',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok','degraded'], example: 'ok' },
                    db:     { type: 'string', example: 'connected' },
                    mq:     {
                      type: 'object',
                      properties: {
                        connected:        { type: 'boolean', example: true },
                        queue:            { type: 'string',  example: 'order_staging' },
                        rabbitmq_url_set: { type: 'boolean', example: true },
                        last_error:       { type: 'string',  nullable: true, example: null },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

module.exports = swaggerSpec;
