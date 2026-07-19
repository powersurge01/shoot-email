import express from 'express';
import { getConfig } from './config.js';
import { closePool } from './db.js';
import {
  getHealthResponse,
  getReadinessResponse,
  handleInboundWebhook,
  handleOpenAiContext,
} from './httpHandlers.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    sendResponse(res, getHealthResponse());
  });

  app.get('/ready', async (_req, res) => {
    sendResponse(res, await getReadinessResponse());
  });

  app.post('/webhooks/email/inbound', async (req, res, next) => {
    try {
      sendResponse(res, await handleInboundWebhook({
        authorization: req.get('authorization'),
        body: req.body,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/apps/openai/context', async (req, res, next) => {
    try {
      sendResponse(res, await handleOpenAiContext(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  });

  return app;
}

function sendResponse(res, result) {
  res.status(result.status).json(result.body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = getConfig();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Webhook server listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
