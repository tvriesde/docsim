import { loadConfig } from './config.js';

const config = loadConfig();

// Azure Monitor must be initialized before Fastify/http are imported so requests are instrumented.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor();
}

const { buildApp } = await import('./app.js');
const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
app.log.info(
  { store: config.store, blob: config.blob, ai: config.ai, auth: config.authEnabled },
  'docsim api started',
);
