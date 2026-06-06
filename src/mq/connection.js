require('dotenv').config();
const amqp = require('amqplib');

let connection = null;
let channel    = null;

const QUEUE = process.env.RABBITMQ_QUEUE || 'order_staging';

async function getChannel() {
  if (channel) return channel;

  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel    = await connection.createChannel();

  // Durable queue — survives broker restarts
  await channel.assertQueue(QUEUE, { durable: true });

  // Graceful shutdown
  process.on('SIGINT',  () => closeConnection());
  process.on('SIGTERM', () => closeConnection());

  console.log(`[MQ] Connected — queue: "${QUEUE}"`);
  return channel;
}

async function closeConnection() {
  try {
    if (channel)    await channel.close();
    if (connection) await connection.close();
  } catch (_) {}
}

module.exports = { getChannel, QUEUE };
