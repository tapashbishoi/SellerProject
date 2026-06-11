/**
 * EDI RabbitMQ Topic Exchange
 * Loosely couples all EDI components via topic-based routing.
 *
 * Exchange: edi  (topic)
 * Routing keys:
 *   edi.inbound.850       → edi_850_processing
 *   edi.inbound.860       → edi_860_processing
 *   edi.outbound.997      → edi_outbound
 *   edi.outbound.855      → edi_outbound
 *   edi.outbound.856      → edi_outbound
 *   edi.outbound.810      → edi_outbound
 *   edi.order.confirmed   → edi_order_events
 *   edi.order.shipped     → edi_order_events
 *   edi.order.delivered   → edi_order_events
 */
require('dotenv').config();
const amqp = require('amqplib');

const EXCHANGE = 'edi';
const QUEUES = {
  edi_850_processing: ['edi.inbound.850'],
  edi_860_processing: ['edi.inbound.860'],
  edi_outbound:       ['edi.outbound.*'],
  edi_order_events:   ['edi.order.*'],
};

let connection = null;
let channel    = null;
let connected  = false;

async function getEDIChannel() {
  if (channel && connected) return channel;

  if (!process.env.RABBITMQ_URL) throw new Error('RABBITMQ_URL not set');

  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel    = await connection.createChannel();

  // Declare topic exchange
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  // Declare queues and bind to exchange
  for (const [queueName, routingKeys] of Object.entries(QUEUES)) {
    await channel.assertQueue(queueName, { durable: true });
    for (const key of routingKeys) {
      await channel.bindQueue(queueName, EXCHANGE, key);
    }
  }

  connected = true;
  console.log('[EDI-MQ] Connected to topic exchange "edi"');

  connection.on('close', () => {
    connected = false; channel = null; connection = null;
    console.warn('[EDI-MQ] Connection closed — reconnecting in 5s');
    setTimeout(getEDIChannel, 5000);
  });
  connection.on('error', err => console.error('[EDI-MQ] Error:', err.message));

  return channel;
}

async function publishEDI(routingKey, payload) {
  const ch = await getEDIChannel();
  const msg = Buffer.from(JSON.stringify({ ...payload, published_at: new Date().toISOString() }));
  ch.publish(EXCHANGE, routingKey, msg, { persistent: true, contentType: 'application/json' });
  console.log(`[EDI-MQ] Published → ${routingKey}`);
}

async function consumeEDI(queueName, handler) {
  const ch = await getEDIChannel();
  ch.prefetch(1);
  ch.consume(queueName, async (msg) => {
    if (!msg) return;
    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch {
      console.error(`[EDI-MQ] Invalid JSON in ${queueName}`);
      ch.nack(msg, false, false);
      return;
    }
    try {
      await handler(payload);
      ch.ack(msg);
    } catch (err) {
      console.error(`[EDI-MQ] Handler error in ${queueName}:`, err.message);
      ch.nack(msg, false, false); // dead-letter, don't requeue indefinitely
    }
  });
  console.log(`[EDI-MQ] Consuming from "${queueName}"`);
}

module.exports = { publishEDI, consumeEDI, getEDIChannel, EXCHANGE };
