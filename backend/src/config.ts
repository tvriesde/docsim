function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(env(name), 10);
  return Number.isFinite(v) ? v : fallback;
}

export interface Config {
  port: number;
  store: 'cosmos' | 'memory';
  blob: 'azure' | 'local';
  ai: 'foundry' | 'fake';
  dataDir: string;
  cosmosEndpoint: string;
  cosmosDatabase: string;
  storageAccountUrl: string;
  blobContainer: string;
  openAiEndpoint: string;
  openAiApiVersion: string;
  chatDeployment: string;
  chatReasoningEffort: string;
  embeddingDeployment: string;
  embeddingDimensions: number;
  azureClientId: string;
  authEnabled: boolean;
  tenantId: string;
  apiClientId: string;
  apiScopeName: string;
  corsOrigins: string[];
  ingestConcurrency: number;
  maxUploadMb: number;
  autoRecluster: boolean;
  reclusterDebounceMs: number;
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 8000),
    store: env('STORE', 'memory') as Config['store'],
    blob: env('BLOB', 'local') as Config['blob'],
    ai: env('AI', 'fake') as Config['ai'],
    dataDir: env('DATA_DIR', '.data'),
    cosmosEndpoint: env('COSMOS_ENDPOINT'),
    cosmosDatabase: env('COSMOS_DATABASE', 'docsim'),
    storageAccountUrl: env('STORAGE_ACCOUNT_URL'),
    blobContainer: env('BLOB_CONTAINER', 'documents'),
    openAiEndpoint: env('AZURE_OPENAI_ENDPOINT'),
    openAiApiVersion: env('AZURE_OPENAI_API_VERSION', '2025-04-01-preview'),
    chatDeployment: env('MODEL_CHAT'),
    chatReasoningEffort: env('MODEL_CHAT_REASONING_EFFORT'),
    embeddingDeployment: env('MODEL_EMBEDDING'),
    embeddingDimensions: int('EMBEDDING_DIMENSIONS', 3072),
    azureClientId: env('AZURE_CLIENT_ID'),
    authEnabled: bool('AUTH_ENABLED', false),
    tenantId: env('ENTRA_TENANT_ID'),
    apiClientId: env('ENTRA_API_CLIENT_ID'),
    apiScopeName: env('API_SCOPE_NAME', 'Documents.ReadWrite'),
    corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ingestConcurrency: Math.max(1, int('INGEST_CONCURRENCY', 4)),
    maxUploadMb: int('MAX_UPLOAD_MB', 50),
    autoRecluster: bool('AUTO_RECLUSTER', true),
    reclusterDebounceMs: int('RECLUSTER_DEBOUNCE_MS', 8000),
  };
}
