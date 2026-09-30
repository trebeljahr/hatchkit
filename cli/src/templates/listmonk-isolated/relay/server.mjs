import { createServer } from 'node:http';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { relayConfig, createRelayHandler } from './message.mjs';
const config = relayConfig(process.env);
const client = new SESv2Client({ region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  maxAttempts: 1, // Delivery is not idempotent. An uncertain result requires review.
});
const server = createServer(createRelayHandler(config, message => client.send(new SendEmailCommand(message), { abortSignal: AbortSignal.timeout(15000) })));
server.requestTimeout = 20000; server.headersTimeout = 10000; server.timeout = 20000;
server.listen(8787, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { client.destroy(); process.exit(0); });
  setTimeout(() => { client.destroy(); process.exit(1); }, 20000).unref();
});
