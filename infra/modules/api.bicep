param name string
param location string
param tags object
param environmentId string
param identityId string
param identityClientId string
param acrLoginServer string
param image string

@secure()
param appInsightsConnectionString string
param cosmosEndpoint string
param cosmosDatabase string
param storageBlobEndpoint string
param blobContainer string
param openAiEndpoint string
@description('Role -> { deployment, reasoningEffort?, dimensions? } from the model profile.')
param modelProfile object
param embeddingDimensions int

param entraTenantId string
param entraApiClientId string
@description('Browser origins allowed by CORS (the Static Web App URL and local dev).')
param corsOrigins array

var authEnabled = !empty(entraApiClientId)
// The public quickstart image listens on port 80 and has no /api/health, so port and probes depend on it.
var isPlaceholder = startsWith(image, 'mcr.microsoft.com/k8se/quickstart')

var env = [
  { name: 'PORT', value: '8000' }
  { name: 'STORE', value: 'cosmos' }
  { name: 'BLOB', value: 'azure' }
  { name: 'AI', value: 'foundry' }
  { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
  { name: 'COSMOS_DATABASE', value: cosmosDatabase }
  { name: 'STORAGE_ACCOUNT_URL', value: storageBlobEndpoint }
  { name: 'BLOB_CONTAINER', value: blobContainer }
  { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
  { name: 'MODEL_CHAT', value: modelProfile.chat.deployment }
  { name: 'MODEL_CHAT_REASONING_EFFORT', value: modelProfile.chat.?reasoningEffort ?? '' }
  { name: 'MODEL_EMBEDDING', value: modelProfile.embedding.deployment }
  { name: 'EMBEDDING_DIMENSIONS', value: string(embeddingDimensions) }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'AUTH_ENABLED', value: string(authEnabled) }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  { name: 'ENTRA_API_CLIENT_ID', value: entraApiClientId }
  { name: 'API_SCOPE_NAME', value: 'Documents.ReadWrite' }
  { name: 'CORS_ORIGINS', value: join(corsOrigins, ',') }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
  { name: 'OTEL_SERVICE_NAME', value: 'docsim-api' }
]

var probes = [
  {
    type: 'Liveness'
    httpGet: { path: '/api/health', port: 8000 }
    initialDelaySeconds: 10
    periodSeconds: 30
    failureThreshold: 3
  }
  {
    type: 'Readiness'
    httpGet: { path: '/api/health', port: 8000 }
    initialDelaySeconds: 5
    periodSeconds: 10
    failureThreshold: 3
  }
]

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'appinsights-connection-string'
          value: appInsightsConnectionString
        }
      ]
      // CORS and bearer-token validation are handled by the API itself (see backend/src/app.ts and lib/auth.ts).
      ingress: {
        external: true
        targetPort: isPlaceholder ? 80 : 8000
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: env
          probes: isPlaceholder ? [] : probes
        }
      ]
      // Exactly one replica: the ingestion queue and recluster scheduler run in-process.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output name string = api.name
output url string = 'https://${api.properties.configuration.ingress.fqdn}'
