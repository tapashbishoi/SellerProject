const { getChannel, QUEUE } = require('./connection');
const { v4: uuidv4 } = require('crypto').webcrypto
  ? (() => { try { return require('crypto'); } catch { return null; } })()
  : null;

// Simple UUID using built-in crypto
function generateId() {
  return require('crypto').randomUUID
    ? require('crypto').randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Publish a staged order to RabbitMQ.
 * Returns the messageId so we can track it back.
 */
async function publishOrder(orderPayload) {
  const channel   = await getChannel();
  const messageId = generateId();

  const message = {
    messageId,
    timestamp: new Date().toISOString(),
    payload: orderPayload,
  };

  const sent = channel.sendToQueue(
    QUEUE,
    Buffer.from(JSON.stringify(message)),
    {
      persistent:  true,          // survives broker restart
      messageId,
      contentType: 'application/json',
    }
  );

  if (!sent) throw new Error('RabbitMQ channel buffer full — try again');

  console.log(`[MQ] Published order — messageId: ${messageId}`);
  return messageId;
}

module.exports = { publishOrder };
