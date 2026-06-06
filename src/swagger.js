const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Seller Agent API',
    version: '1.0.0',
    description: 'Order management, catalogue & inventory API for stationery seller. All endpoints require the `X-API-Key` header.',
  },
  servers: [{ url: '/api', description: 'API base' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    schemas: {
      Product: {
        type: 'object',
        properties: {
          id:                  { type: 'integer', example: 1 },
          name:                { type: 'string',  example: 'Blue Ball Pen' },
          description:         { type: 'string',  example: 'Smooth writing blue ink ball pen' },
          category:            { type: 'string',  example: 'Pen' },
          unit:                { type: 'string',  example: 'piece' },
          price:               { type: 'number',  example: 10.00 },
          quantity:            { type: 'integer', example: 500 },
          low_stock_threshold: { type: 'integer', example: 50 },
          stock_status:        { type: 'string',  enum: ['in_stock','low_stock','out_of_stock'] },
          created_at:          { type: 'string',  format: 'date-time' },
        },
      },
      InventoryItem: {
        type: 'object',
        properties: {
          product_id:          { type: 'integer', example: 1 },
          name:                { type: 'string',  example: 'Blue Ball Pen' },
          category:            { type: 'string',  example: 'Pen' },
          price:               { type: 'number',  example: 10.00 },
          quantity:            { type: 'integer', example: 500 },
          low_stock_threshold: { type: 'integer', example: 50 },
          stock_status:        { type: 'string',  enum: ['in_stock','low_stock','out_of_stock'] },
          updated_at:          { type: 'string',  format: 'date-time' },
        },
      },
      OrderItem: {
        type: 'object',
        properties: {
          product_id:   { type: 'integer', example: 1 },
          product_name: { type: 'string',  example: 'Blue Ball Pen' },
          quantity:     { type: 'integer', example: 10 },
          unit_price:   { type: 'number',  example: 10.00 },
          subtotal:     { type: 'number',  example: 100.00 },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id:           { type: 'integer', example: 1 },
          buyer_name:   { type: 'string',  example: 'Ravi Kumar' },
          buyer_email:  { type: 'string',  example: 'ravi@example.com' },
          buyer_phone:  { type: 'string',  example: '9876543210' },
          status:       { type: 'string',  enum: ['pending','confirmed','shipped','delivered','cancelled'] },
          total_amount: { type: 'number',  example: 250.00 },
          notes:        { type: 'string',  example: 'Urgent delivery' },
          items:        { type: 'array',   items: { $ref: '#/components/schemas/OrderItem' } },
          created_at:   { type: 'string',  format: 'date-time' },
          updated_at:   { type: 'string',  format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string', example: 'Product not found' } },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/products': {
      get: {
        tags: ['Catalogue'],
        summary: 'List all products',
        description: 'Returns the full catalogue with live stock status. Buyers use this to browse.',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' }, example: 'Pen', description: 'Filter by category' },
          { name: 'search',   in: 'query', schema: { type: 'string' }, example: 'blue', description: 'Search by product name (case-insensitive)' },
        ],
        responses: {
          200: { description: 'List of products', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } },
          401: { description: 'Missing API key',  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Invalid API key',  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Catalogue'],
        summary: 'Add a new product',
        description: 'Creates a product and its inventory record in one step.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'price'],
                properties: {
                  name:                { type: 'string',  example: 'Blue Ball Pen' },
                  description:         { type: 'string',  example: 'Smooth writing ball pen' },
                  category:            { type: 'string',  example: 'Pen' },
                  unit:                { type: 'string',  example: 'piece', default: 'piece' },
                  price:               { type: 'number',  example: 10.00 },
                  initial_quantity:    { type: 'integer', example: 500,     default: 0 },
                  low_stock_threshold: { type: 'integer', example: 50,      default: 10 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Product created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      get: {
        tags: ['Catalogue'],
        summary: 'Get a single product',
        responses: {
          200: { description: 'Product detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Catalogue'],
        summary: 'Update product details',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, description: { type: 'string' },
                  category: { type: 'string' }, unit: { type: 'string' }, price: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated product', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Catalogue'],
        summary: 'Delete a product',
        responses: {
          200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/inventory': {
      get: {
        tags: ['Inventory'],
        summary: 'List full inventory',
        description: 'Returns all products with current stock quantities and status.',
        responses: {
          200: { description: 'Inventory list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } } } } },
        },
      },
    },
    '/inventory/{productId}': {
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      patch: {
        tags: ['Inventory'],
        summary: 'Set stock quantity or threshold',
        description: 'Directly set the quantity and/or low-stock threshold for a product.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  quantity:            { type: 'integer', example: 200 },
                  low_stock_threshold: { type: 'integer', example: 30 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated inventory record' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/inventory/{productId}/restock': {
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      post: {
        tags: ['Inventory'],
        summary: 'Add stock (restock)',
        description: 'Adds the given quantity on top of existing stock.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['add_quantity'],
                properties: { add_quantity: { type: 'integer', example: 100 } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated inventory record' },
          400: { description: 'Invalid quantity', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List all orders',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending','confirmed','shipped','delivered','cancelled'] }, description: 'Filter by status' },
        ],
        responses: {
          200: { description: 'Order list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } },
        },
      },
      post: {
        tags: ['Orders'],
        summary: 'Place a new order',
        description: 'Creates an order and **automatically deducts inventory**. Returns 409 if any item is out of stock.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['buyer_name', 'items'],
                properties: {
                  buyer_name:  { type: 'string',  example: 'Ravi Kumar' },
                  buyer_email: { type: 'string',  example: 'ravi@example.com' },
                  buyer_phone: { type: 'string',  example: '9876543210' },
                  notes:       { type: 'string',  example: 'Urgent delivery' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['product_id', 'quantity'],
                      properties: {
                        product_id: { type: 'integer', example: 9 },
                        quantity:   { type: 'integer', example: 10 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Order placed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Insufficient stock', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      get: {
        tags: ['Orders'],
        summary: 'Get a single order with items',
        responses: {
          200: { description: 'Order detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/orders/{id}/status': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      patch: {
        tags: ['Orders'],
        summary: 'Update order status',
        description: 'Cancelling an order **restores inventory** automatically.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['pending','confirmed','shipped','delivered','cancelled'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated order', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          400: { description: 'Invalid status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check (no key required)',
        security: [],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } } } },
      },
    },
  },
};

module.exports = swaggerSpec;
