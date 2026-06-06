const { getChannel, QUEUE } = require('./connection');

function generateId() {
  return require('crypto').randomUUID
    ? require('crypto').randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function publishOrder(orderPayload) {
  const channel = getChannel();
  if (!channel) throw new Error('RabbitMQ not connected — try again shortly');

  const messageId = generateId();
  const message   = { messageId, timestamp: new Date().toISOString(), payload: orderPayload };

  const sent = channel.sendToQueue(
    QUEUE,
    Buffer.from(JSON.stringify(message)),
    { persistent: true, messageId, contentType: 'application/json' }
  );

  if (!sent) throw new Error('RabbitMQ channel buffer full — try again');

  console.log(`[MQ] Published order — messageId: ${messageId}`);
  return messageId;
}

module.exports = { publishOrder };
