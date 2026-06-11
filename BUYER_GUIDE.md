# Buyer Integration Guide
**Seller Agent — Stationery B2B Platform**

> This guide covers everything a buyer needs to integrate with our seller platform:
> place orders via EDI or AI agent, receive EDI documents, check inventory and catalogue,
> negotiate pricing, and build a fully autonomous AI purchasing agent.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Connect via MCP (AI Agent)](#2-connect-via-mcp-ai-agent)
3. [Browse Catalogue & Check Inventory](#3-browse-catalogue--check-inventory)
4. [Place Orders](#4-place-orders)
5. [EDI Integration — Send 850, Receive 997/855/856/810](#5-edi-integration)
6. [Price Negotiation with AI](#6-price-negotiation-with-ai)
7. [Track Orders & Shipments](#7-track-orders--shipments)
8. [Build an Autonomous AI Buying Agent](#8-build-an-autonomous-ai-buying-agent)
9. [Reference: All MCP Tools](#9-reference-all-mcp-tools)
10. [Reference: API Endpoints](#10-reference-api-endpoints)

---

## 1. Quick Start

### What you need

| Item | Value |
|---|---|
| **API Key** | Contact seller — you'll receive a `buyer-key-001` style key |
| **MCP Endpoint** | `https://sellerpos.onrender.com/mcp` |
| **REST API Base** | `https://sellerpos.onrender.com/api` |
| **EDI Endpoint (HTTPS)** | `https://sellerpos.onrender.com/edi/receive` |
| **EDI Endpoint (AS2)** | `https://sellerpos.onrender.com/edi/as2` |
| **Our ISA ID** | `SELLERAGENT` |
| **Our AS2 ID** | `SELLERAGENT-AS2` |
| **EDI Version** | X12 005010 (00501) |
| **Swagger Docs** | `https://sellerpos.onrender.com/docs` |
| **MCP Tool Docs** | `https://sellerpos.onrender.com/mcp-docs.html` |

### 3-minute test — confirm connection

```bash
# Check API is live
curl https://sellerpos.onrender.com/api/health

# Browse catalogue (REST)
curl https://sellerpos.onrender.com/api/products \
  -H "X-API-Key: YOUR_KEY"

# Get EDI setup details
curl https://sellerpos.onrender.com/edi/info
```

---

## 2. Connect via MCP (AI Agent)

Our platform exposes a full **MCP (Model Context Protocol) server** — connect any
MCP-compatible AI agent (Claude, GPT, custom) and interact in plain English.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "seller": {
      "url": "https://sellerpos.onrender.com/mcp",
      "headers": {
        "X-API-Key": "YOUR_BUYER_API_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. You can now say:
> *"Show me all pens available"*
> *"Order 50 blue ball pens for our Chicago office"*
> *"Negotiate $8 per unit for 100 gel pens"*

### Claude Code (terminal)

```bash
claude mcp add seller \
  --url https://sellerpos.onrender.com/mcp \
  --header "X-API-Key: YOUR_BUYER_API_KEY"

# Verify
claude mcp list
```

### Any MCP client (programmatic)

```bash
# Initialize session
curl -X POST https://sellerpos.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "1.0" }
    }
  }'
```

---

## 3. Browse Catalogue & Check Inventory

### Via MCP (natural language)

```
browse_catalogue(category="Pen")
browse_catalogue(search="blue")
check_inventory()                    ← all products
check_inventory(product_id=9)        ← single product
```

### Via REST API

```bash
# All products with stock status
GET /api/products
GET /api/products?category=Pen
GET /api/products?search=blue

# Single product
GET /api/products/9

# Full inventory
GET /api/inventory
GET /api/inventory/9

# Response includes:
# stock_status: "in_stock" | "low_stock" | "out_of_stock"
# quantity: current units available
```

### Via EDI 846 (coming in future release)

We will proactively push EDI 846 (Inventory Inquiry/Advice) to your callback URL
when stock levels change significantly. Register your trading partner profile to opt in.

### Getting catalogue before placing an EDI order

Always call `GET /api/products` first to get our **product IDs** — you'll need them
in the `PO107` element of your EDI 850 (`PO106=VP` qualifier).

```bash
# Get product list — use the "id" field as your vendor part number in PO107
curl https://sellerpos.onrender.com/api/products \
  -H "X-API-Key: YOUR_KEY" | jq '.[] | {id, name, price, stock_status}'
```

---

## 4. Place Orders

### Option A — MCP tool (simplest for AI agents)

**Step 1: Register your profile once**

```
register_buyer(
  buyer_email:      "procurement@yourco.com",
  buyer_name:       "Jane Smith",
  company_name:     "Your Company Inc",
  shipping_street:  "456 Corporate Blvd",
  shipping_city:    "Chicago",
  shipping_state:   "IL",
  shipping_zip:     "60601"
)
```

This saves your shipping address and auto-assigns your nearest DC
(US East / US West / US Central) for future orders.

**Step 2: Check delivery before committing**

```
check_delivery_options(
  buyer_email: "procurement@yourco.com",
  items: [{ product_id: 9, quantity: 50 }]
)
```

Returns: fulfilling DC, estimated delivery days, shipping cost.

**Step 3: Place order**

```
place_order(
  buyer_name:  "Jane Smith",
  buyer_email: "procurement@yourco.com",
  items: [
    { product_id: 9,  quantity: 50 },
    { product_id: 12, quantity: 20 }
  ]
)
```

Shipping address is loaded from your profile automatically.
Returns `order_id` with status `queued`.

**Step 4: Poll for confirmation**

```
track_order(order_id: 42)
```

Status changes: `queued` → `confirmed` (usually within 5 seconds) → `shipped` → `delivered`

### Option B — REST API

```bash
POST /api/orders
Content-Type: application/json
X-API-Key: YOUR_KEY
X-Source: api

{
  "buyer_name": "Jane Smith",
  "buyer_email": "procurement@yourco.com",
  "shipping_city": "Chicago",
  "shipping_state": "IL",
  "shipping_zip": "60601",
  "items": [
    { "product_id": 9,  "quantity": 50 },
    { "product_id": 12, "quantity": 20 }
  ]
}

# Returns 202 with order_id
# Poll: GET /api/orders/{id}
```

### Option C — EDI 850 (see Section 5)

---

## 5. EDI Integration

### One-time trading partner setup

**Step 1: Register as trading partner**

```bash
POST https://sellerpos.onrender.com/edi/partners
X-API-Key: YOUR_KEY
Content-Type: application/json

{
  "partner_id":    "YOURCO",
  "company_name":  "Your Company Inc",
  "buyer_email":   "edi@yourco.com",
  "isa_id":        "YOURCOMPANY",
  "gs_id":         "YOURCOMPANY",
  "as2_id":        "YOURCO-AS2",
  "callback_url":  "https://yourco.com/edi/receive",
  "edi_version":   "00501"
}
```

**Step 2: Configure which documents you want**

```bash
PATCH https://sellerpos.onrender.com/edi/partners/YOURCO/preferences
X-API-Key: YOUR_KEY

{
  "send_997": true,    # receive 997 ack for your 850s  (default: true)
  "send_855": true,    # receive 855 PO ack             (default: true)
  "send_856": true,    # receive 856 ship notice        (default: true)
  "send_810": false,   # receive 810 invoice            (default: false, opt-in)
  "expects_ack": true, # you will send us 997 for our outbound docs
  "ack_timeout_hours": 24
}
```

Or via MCP:

```
configure_edi_delivery(
  partner_id:         "YOURCO",
  callback_url:       "https://yourco.com/edi/receive",
  wants_997:          true,
  wants_855:          true,
  wants_856:          true,
  wants_810:          false,
  will_send_997_back: true,
  ack_timeout_hours:  24
)
```

---

### Send EDI 850 (Purchase Order)

#### Via HTTPS (raw X12)

```bash
POST https://sellerpos.onrender.com/edi/receive
Content-Type: application/edi-x12
X-API-Key: YOUR_KEY

ISA*00*          *00*          *ZZ*YOURCOMPANY    *ZZ*SELLERAGENT    *230601*1200*^*00501*000000001*0*P*:~
GS*PO*YOURCOMPANY*SELLERAGENT*20230601*1200*1*X*005010~
ST*850*0001~
BEG*00*SA*PO-2024-001**20230601~
N1*ST*Your Company Inc*92*YOURCO~
N3*456 Corporate Blvd~
N4*Chicago*IL*60601*US~
PO1*1*50*EA*10.00*PE*VP*9~
PO1*2*20*EA*25.00*PE*VP*12~
CTT*2~
SE*11*0001~
GE*1*1~
IEA*1*000000001~
```

Returns **202** immediately with `edi_message_id`. Processing is async.

#### Via AS2

```bash
POST https://sellerpos.onrender.com/edi/as2
Content-Type: application/edi-x12
AS2-From: YOURCO-AS2
AS2-To:   SELLERAGENT-AS2
Message-ID: <msg-001@yourco.com>

[X12 body as above]
```

Returns synchronous **MDN** (Message Disposition Notification).

#### Via MCP (AI agent builds X12 for you)

```
send_edi_850(
  mode:          "structured",
  partner_id:    "YOURCO",
  po_number:     "PO-2024-001",
  items: [
    { product_id: 9,  quantity: 50, unit_price: 9.50 },
    { product_id: 12, quantity: 20 }
  ],
  shipping_city:  "Chicago",
  shipping_state: "IL",
  shipping_zip:   "60601"
)
```

We build the X12 for you — no EDI expertise needed.

---

### Required 850 Segments

| Segment | Required | Key Elements |
|---|---|---|
| `ISA` | ✅ | ISA06=your ID, ISA08=`SELLERAGENT` |
| `GS` | ✅ | GS01=`PO`, GS03=`SELLERAGENT` |
| `BEG` | ✅ | BEG02=`SA`, BEG03=your PO#, BEG05=date |
| `N1*ST` | ✅ | Ship-to company name |
| `N3` | ✅ | Ship-to street address |
| `N4` | ✅ | Ship-to city / state / zip |
| `PO1` | ✅ | Qty (PO102), EA (PO103), price (PO104), `VP` (PO106), our product ID (PO107) |
| `CTT` | ✅ | Total line item count |
| `SE/GE/IEA` | ✅ | Standard X12 trailers |

**Product IDs:** Use `PO106=VP` (Vendor Part) with our numeric product ID as `PO107`.
Get the full product list from `GET /api/products`.

---

### What we send back

| Document | Trigger | Delivery |
|---|---|---|
| **997** Functional Ack | Immediately on 850 receipt | POST to your `callback_url` |
| **855** PO Acknowledgment | When order is confirmed (~2-10 sec) | POST to your `callback_url` |
| **856** Ship Notice / ASN | When order status → `shipped` | POST to your `callback_url` |
| **810** Invoice | When order status → `delivered` (opt-in) | POST to your `callback_url` |

All sent as raw X12 with headers:
```
Content-Type: application/edi-x12
AS2-From: SELLERAGENT-AS2
AS2-To:   <your as2_id>
EDI-Transaction: 855   (or 856, 810, 997)
```

---

### Track EDI status

```bash
# By ISA control number
GET /edi/status/000000001
X-API-Key: YOUR_KEY

# Or via MCP
check_edi_status(isa_control_number: "000000001")
```

---

### Acknowledge our outbound docs (your 997 to us)

If `expects_ack=true`, send us a 997 when you receive our 855/856/810:

**Option A — via MCP (instant)**
```
acknowledge_edi(
  isa_control_number: "000000005",
  partner_id:         "YOURCO",
  accepted:           true
)
```

**Option B — raw X12 997 to our endpoint**
```bash
POST https://sellerpos.onrender.com/edi/receive
Content-Type: application/edi-x12
X-API-Key: YOUR_KEY

ISA*00*          *00*          *ZZ*YOURCOMPANY    *ZZ*SELLERAGENT    ...~
GS*FA*YOURCOMPANY*SELLERAGENT*20230601*1200*2*X*005010~
ST*997*0001~
AK1*PR*[our GS control number]~
AK2*855*[our ST control]~
AK5*A~
AK9*A*1*1*1~
SE*5*0001~
GE*1*2~
IEA*1*[our ISA control]~
```

**Check your pending acks:**
```
get_edi_delivery_status(partner_id: "YOURCO", unacked_only: true)
```

---

### Send EDI 860 (Purchase Order Change)

To modify or cancel an existing order, send an 860 to the same endpoint:

```bash
POST https://sellerpos.onrender.com/edi/receive
Content-Type: application/edi-x12
X-API-Key: YOUR_KEY

ISA...*~
GS*PC*YOURCOMPANY*SELLERAGENT*...~    # GS01=PC for 860
ST*860*0001~
BCH*03*PO-2024-001**20230602~         # BCH03 = original PO number
MSG*Reduce quantity due to budget constraints~
POC*1*QD*50*30*EA*10.00*PE*VP*9~      # QD=quantity decrease: was 50, now 30
CTT*1~
SE*6*0001~
GE*1*1~
IEA*1*000000002~
```

We'll send a 997 ack and update the order.

> **Note:** Cannot change orders already `shipped`, `delivered`, `cancelled`, or `rejected`.

---

## 6. Price Negotiation with AI

Our Gemini-powered AI negotiation agent evaluates your offers in real time based on:
- Product margin and floor price (70% of list — absolute minimum 60%)
- Your order history and loyalty
- Order quantity (bulk discounts available)
- Shipping zone from your nearest DC

### How it works

```
You offer $8  →  Gemini evaluates  →  counters $8.50 or accepts/rejects
                 (considers: margin, your history, quantity, shipping cost)
```

### Multi-round negotiation

```
# Round 1: submit offer
negotiate_price(
  product_id:     9,
  proposed_price: 7.00,
  quantity:       100,
  buyer_email:    "procurement@yourco.com",
  buyer_name:     "Jane Smith"
)
# Returns: negotiation_id=1, status=countered, counter_offer=8.00

# Round 2: counter back
negotiate_price(
  product_id:     9,
  proposed_price: 7.50,
  quantity:       100,
  buyer_email:    "procurement@yourco.com",
  negotiation_id: 1          ← continue same negotiation
)
# Returns: status=countered, counter_offer=7.80, "Round 3 — final offer"

# Accept the counter
accept_counter_offer(
  negotiation_id: 1,
  buyer_email:    "procurement@yourco.com"
)
# Returns: ✅ accepted, order placed automatically via RabbitMQ
```

### Price floors

| Scenario | Behaviour |
|---|---|
| Offer ≥ list price | Instant accept ✅ |
| Offer 70–99% of list | Gemini negotiates |
| Offer 60–70% of list | Gemini may accept for large orders / loyal buyers |
| Offer < 60% of list | **Instant reject** — no counter offered |

### Negotiation via REST API

Negotiated orders auto-flow through our RabbitMQ pipeline — no separate action needed.
Accepted negotiation → order created and queued automatically.

---

## 7. Track Orders & Shipments

### MCP tools

```
track_order(order_id: 42)
# Returns: status, DC name, ship-to address, estimated days, line items, total

list_my_orders(buyer_email: "procurement@yourco.com")
# Returns: all orders with status summary
```

### REST API

```bash
# Single order
GET /api/orders/42
X-API-Key: YOUR_KEY

# All your orders
GET /api/orders?buyer_email=procurement@yourco.com

# Response includes:
# status:        queued | confirmed | shipped | delivered | cancelled | rejected
# dc_name:       "US Central DC"
# dc_city:       "Chicago"
# shipping_days: "1-2"
# shipping_cost: 8.50
# items:         [ { product_name, quantity, unit_price, subtotal } ]
```

### Order status lifecycle

```
queued          ← order received, in RabbitMQ
    ↓
confirmed       ← stock validated, inventory deducted  →  855 sent to you
    ↓
shipped         ← seller marks shipped                 →  856 sent to you
    ↓
delivered       ← seller marks delivered               →  810 sent to you (if opted in)
```

---

## 8. Build an Autonomous AI Buying Agent

Here is a complete blueprint for a fully autonomous AI agent that monitors your
inventory and autonomously restocks from our catalogue.

### Architecture

```
Your Inventory System
        │ low stock event
        ▼
  Buying Agent (LLM)
        │
        ├─ check_inventory()          ← is seller in stock?
        ├─ check_delivery_options()   ← which DC, how long, how much?
        ├─ negotiate_price()          ← get best price (optional)
        │        ↓
        ├─ place_order() or send_edi_850()
        │
        ▼
  Poll track_order() until confirmed
        │
        ▼
  Receive 855 (confirmed) → 856 (shipped) at your callback_url
```

### Python example (using Anthropic SDK + MCP)

```python
import anthropic

client = anthropic.Anthropic(api_key="your-anthropic-key")

SYSTEM_PROMPT = """
You are an autonomous procurement agent for a stationery company.
Your job: when inventory is low, check the seller catalogue, negotiate
the best price, and place orders automatically.

Rules:
1. Always check stock availability BEFORE ordering
2. For orders > 50 units, always try to negotiate price first
3. Use the buyer profile (procurement@ourco.com) — address is pre-registered
4. Target price: no more than 85% of list price
5. If negotiation fails or rejects, place at list price if budget allows
6. After placing, poll track_order() every 30s until confirmed
7. Log every action with timestamp

You have access to these MCP tools:
- browse_catalogue, check_inventory, check_delivery_options
- negotiate_price, accept_counter_offer
- place_order, track_order, list_my_orders
"""

def run_procurement_agent(low_stock_items: list[dict]):
    """
    low_stock_items: [{"name": "Blue Ball Pen", "qty_needed": 200}]
    """
    task = f"""
    Our inventory system flagged these items as low stock:
    {low_stock_items}

    Please:
    1. Check if seller has stock for each item
    2. Get delivery estimate for our Chicago office
    3. For orders > 50 units, negotiate price first (target 80-85% of list)
    4. Place the order(s)
    5. Report: order IDs, confirmed price, expected delivery
    """

    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": task}],
        # MCP server configured in your Claude environment
    )
    return response.content[0].text

# Example trigger
result = run_procurement_agent([
    {"name": "Blue Ball Pen", "qty_needed": 500},
    {"name": "Gel Pen Black",  "qty_needed": 200},
])
print(result)
```

### Node.js example (direct MCP calls)

```javascript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function autonomousBuyer(lowStockItems) {
  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 4096,
    mcp_servers: [
      {
        type: "url",
        url: "https://sellerpos.onrender.com/mcp",
        name: "seller",
        authorization_token: "YOUR_BUYER_API_KEY",
      },
    ],
    messages: [
      {
        role: "user",
        content: `
          Low stock alert: ${JSON.stringify(lowStockItems)}
          
          Use the seller MCP tools to:
          1. Check availability and nearest DC
          2. Negotiate price if order > 50 units
          3. Place the order
          4. Return order ID and expected delivery
        `,
      },
    ],
  });

  return response.content;
}
```

### Webhook handler — receive 855/856 from us

```javascript
// Express endpoint to receive our outbound EDI
app.post('/edi/receive', express.text({ type: 'application/edi-x12' }), (req, res) => {
  const ediType = req.headers['edi-transaction'];   // '855', '856', '810'
  const rawEdi  = req.body;

  if (ediType === '855') {
    // Purchase Order Acknowledged — order confirmed
    const poNumber = rawEdi.match(/BAK\*[A-Z]{2}\*[A-Z]{2}\*([^*]+)/)?.[1];
    console.log(`Order confirmed for PO: ${poNumber}`);
    // Update your ERP / notify procurement team
  }

  if (ediType === '856') {
    // Ship Notice — order is on its way
    const tracking = rawEdi.match(/TD5\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*([^~]+)/)?.[1];
    console.log(`Order shipped, tracking: ${tracking}`);
    // Update your warehouse system
  }

  if (ediType === '810') {
    // Invoice received
    // Route to your AP system
  }

  // Send 997 ack back (optional but recommended)
  // Call our acknowledge_edi MCP tool or POST /edi/receive with 997

  res.status(200).send('OK');
});
```

### Autonomous agent loop (polling + event-driven)

```python
import time
import requests

SELLER_API = "https://sellerpos.onrender.com/api"
HEADERS    = {"X-API-Key": "YOUR_BUYER_KEY"}

def monitor_and_restock(threshold=50):
    """Run continuously — check catalogue stock and restock if needed."""
    while True:
        # 1. Check our products at seller
        inventory = requests.get(f"{SELLER_API}/inventory", headers=HEADERS).json()
        
        # 2. Find low stock at seller that we regularly buy
        our_products = [9, 12, 13]  # product IDs we buy
        to_order = [
            i for i in inventory
            if i['product_id'] in our_products
            and i['stock_status'] in ('low_stock', 'in_stock')
            and i['quantity'] > 0
        ]
        
        if to_order:
            # 3. Have AI agent evaluate and place orders
            agent_result = run_procurement_agent(to_order)
            print(f"Agent result: {agent_result}")
        
        time.sleep(3600)  # check every hour
```

---

## 9. Reference: All MCP Tools

| # | Tool | Description |
|---|---|---|
| 1 | `browse_catalogue` | List/filter products with live stock status |
| 2 | `get_product` | Single product details, price, availability |
| 3 | `check_inventory` | Stock levels — all or by product ID |
| 4 | `place_order` | Submit order (address from profile, DC auto-assigned) |
| 5 | `track_order` | Order status, DC, shipping details |
| 6 | `list_my_orders` | Full order history by email |
| 7 | `register_buyer` | Save office address — set once, reused forever |
| 8 | `get_my_profile` | View saved address and preferred DC |
| 9 | `check_delivery_options` | DC, shipping days, cost BEFORE ordering |
| 10 | `negotiate_price` | Propose price — AI responds with accept/counter/reject |
| 11 | `get_negotiation` | Check status of a negotiation by ID |
| 12 | `accept_counter_offer` | Accept seller's counter — places order automatically |
| 13 | `configure_edi_delivery` | Set callback URL + which EDI docs to receive |
| 14 | `acknowledge_edi` | Send 997 ack for our outbound 855/856/810 |
| 15 | `get_edi_delivery_status` | What EDI we sent you + ack status |
| 16 | `get_edi_guidelines` | Full EDI setup guide with example X12 |
| 17 | `send_edi_850` | Place order via EDI — raw X12 or structured JSON |
| 18 | `check_edi_status` | Track 850 by ISA control — see 997/855/856 responses |

Full interactive docs: **https://sellerpos.onrender.com/mcp-docs.html**

---

## 10. Reference: API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET`   | `/api/products` | Catalogue with stock status |
| `GET`   | `/api/products/:id` | Single product |
| `GET`   | `/api/inventory` | Full inventory |
| `GET`   | `/api/inventory/:id` | Single product stock |
| `POST`  | `/api/orders` | Place order |
| `GET`   | `/api/orders/:id` | Order detail |
| `POST`  | `/api/buyers` | Register buyer profile |
| `GET`   | `/api/buyers/:email` | Get buyer profile |
| `POST`  | `/edi/receive` | Inbound EDI (850, 860, 997) via HTTPS |
| `POST`  | `/edi/as2` | Inbound EDI via AS2 |
| `GET`   | `/edi/info` | EDI setup guide (no auth) |
| `GET`   | `/edi/status/:isa` | Track inbound EDI by ISA control |
| `POST`  | `/edi/partners` | Register trading partner |
| `PATCH` | `/edi/partners/:id/preferences` | Update delivery prefs |

Full Swagger docs: **https://sellerpos.onrender.com/docs**

---

## Support

| Channel | Details |
|---|---|
| EDI Setup Guide | `GET https://sellerpos.onrender.com/edi/info` |
| EDI Operations | `https://sellerpos.onrender.com/edi-dashboard.html` |
| API Reference  | `https://sellerpos.onrender.com/docs` |
| MCP Tool Docs  | `https://sellerpos.onrender.com/mcp-docs.html` |

---

*Last updated: June 2026 — Seller Agent v3.0*
