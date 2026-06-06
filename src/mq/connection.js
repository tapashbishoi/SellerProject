require('dotenv').config();
const amqp = require('amqplib');

let connection = null;
let channel    = null;
let connected  = false;
let lastError  = null;

const QUEUE = process.env.RABBITMQ_QUEUE || 'order_staging';

async function getChannel() {
  if (channel && connected) return channel;

  if (!process.env.RABBITMQ_URL) {
    throw new Error('RABBITMQ_URL environment variable is not set');
  }

  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel    = await connection.createChannel();

  await channel.assertQueue(QUEUE, { durable: true });

  connected = true;
  lastError = null;

  // Reset state on unexpected close
  connection.on('close', () => {
    console.warn('[MQ] Connection closed unexpectedly');
    connected = false;
    channel   = null;
    connection = null;
  });
  connection.on('error', (err) => {
    console.error('[MQ] Connection error:', err.message);
    connected = false;
    lastError = err.message;
  });

  process.on('SIGINT',  closeConnection);
  process.on('SIGTERM', closeConnection);

  console.log(`[MQ] Connected — queue: "${QUEUE}"`);
  return channel;
}

async function closeConnection() {
  try {
    if (channel)    await channel.close();
    if (connection) await connection.close();
  } catch (_) {}
  connected = false;
}

function getMQStatus() {
  return {
    connected,
    queue: QUEUE,
    rabbitmq_url_set: !!process.env.RABBITMQ_URL,
    last_error: lastError,
  };
}

module.exports = { getChannel, QUEUE, getMQStatus };
