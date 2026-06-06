require('dotenv').config();
const amqp = require('amqplib');

const QUEUE = process.env.RABBITMQ_QUEUE || 'order_staging';

let state = {
  connection: null,
  channel:    null,
  connected:  false,
  lastError:  null,
};

// Callbacks registered by the consumer — re-invoked after reconnect
let onReadyCallbacks = [];

function onReady(fn) {
  onReadyCallbacks.push(fn);
}

async function connect(retryDelay = 5000) {
  if (!process.env.RABBITMQ_URL) {
    console.error('[MQ] RABBITMQ_URL is not set — consumer disabled');
    state.lastError = 'RABBITMQ_URL not set';
    return;
  }

  try {
    console.log('[MQ] Connecting...');
    state.connection = await amqp.connect(process.env.RABBITMQ_URL);
    state.channel    = await state.connection.createChannel();

    await state.channel.assertQueue(QUEUE, { durable: true });
    state.channel.prefetch(1);

    state.connected = true;
    state.lastError = null;
    console.log(`[MQ] Connected — queue: "${QUEUE}"`);

    // Re-register all consumers after reconnect
    for (const fn of onReadyCallbacks) {
      try { await fn(state.channel); } catch (e) { console.error('[MQ] onReady callback error:', e.message); }
    }

    // Reconnect on unexpected close
    state.connection.on('close', () => {
      state.connected = false;
      state.channel   = null;
      state.connection = null;
      console.warn(`[MQ] Connection closed — reconnecting in ${retryDelay / 1000}s...`);
      setTimeout(() => connect(retryDelay), retryDelay);
    });

    state.connection.on('error', (err) => {
      state.lastError = err.message;
      console.error('[MQ] Connection error:', err.message);
    });

  } catch (err) {
    state.connected = false;
    state.lastError = err.message;
    console.error(`[MQ] Failed to connect: ${err.message} — retrying in ${retryDelay / 1000}s`);
    setTimeout(() => connect(retryDelay), retryDelay);
  }
}

function getChannel() {
  return state.channel;
}

function getMQStatus() {
  return {
    connected:        state.connected,
    queue:            QUEUE,
    rabbitmq_url_set: !!process.env.RABBITMQ_URL,
    last_error:       state.lastError,
  };
}

module.exports = { connect, getChannel, onReady, QUEUE, getMQStatus };
