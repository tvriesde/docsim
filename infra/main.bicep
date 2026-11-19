targetScope = 'resourceGroup'

@description('Short environment name used in resource names (2-16 chars: lowercase letters, digits, hyphens).')
@minLength(2)
@maxLength(16)
param environmentName string

param location string = 'swedencentral'

@description('Static Web Apps is only available in a few regions (westeurope is closest to swedencentral).')
param staticWebAppLocation string = 'westeurope'

@description('Tags applied to every resource. SecurityControl=Ignore is always enforced.')
param tags object = {
  SecurityControl: 'Ignore'
}

@description('Log Analytics daily ingestion cap (GB).')
param dailyQuotaGb int = 1

@description('Container image for the API.')
param apiImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Role -> { deployment, model, version, sku, capacity, reasoningEffort?, dimensions? }. Roles: chat, embedding.')
param modelProfile object = loadJsonContent('model-profile.json')

param entraTenantId string = tenant().tenantId
@description('API app registration client id. Empty disables bearer-token validation in the API.')
param entraApiClientId string = ''

@description('Optional object id of the deploying principal; gets Cosmos DB data-plane access.')
param deployerPrincipalId string = ''

var allTags = union(tags, { SecurityControl: 'Ignore' })
var token = uniqueString(resourceGroup().id)
var baseName = '${environmentName}-${take(token, 5)}'
var compactName = replace(environmentName, '-', '')
var embeddingDimensions = modelProfile.embedding.?dimensions ?? 3072

var deploymentCandidates = [
  for r in items(modelProfile): {
    name: r.value.deployment
    model: r.value.model
    version: r.value.version
    sku: r.value.?sku ?? 'GlobalStandard'
    capacity: r.value.capacity
  }
]
var candidateNames = map(deploymentCandidates, d => d.name)
var modelDeployments = filter(deploymentCandidates, (d, i) => indexOf(candidateNames, d.name) == i)

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: baseName
    location: location
    tags: allTags
    dailyQuotaGb: dailyQuotaGb
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: baseName
    location: location
    tags: allTags
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    registryName: take('acr${compactName}${token}', 50)
    location: location
    tags: allTags
    identityPrincipalId: identity.outputs.principalId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    accountName: take('st${compactName}${token}', 24)
    location: location
    tags: allTags
    identityPrincipalId: identity.outputs.principalId
  }
}

module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  params: {
    accountName: 'cosmos-${baseName}'
    location: location
    tags: allTags
    identityPrincipalId: identity.outputs.principalId
    deployerPrincipalId: deployerPrincipalId
    embeddingDimensions: embeddingDimensions
  }
}

module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  params: {
    accountName: 'aif-${baseName}'
    projectName: 'docsim'
    location: location
    tags: allTags
    identityPrincipalId: identity.outputs.principalId
    deployments: modelDeployments
  }
}

module environment 'modules/environment.bicep' = {
  name: 'environment'
  params: {
    name: 'cae-${baseName}'
    location: location
    tags: allTags
    logAnalyticsWorkspaceName: monitoring.outputs.workspaceName
  }
}

module web 'modules/staticwebapp.bicep' = {
  name: 'web'
  params: {
    name: 'swa-${baseName}'
    location: staticWebAppLocation
    tags: allTags
  }
}

module api 'modules/api.bicep' = {
  name: 'api'
  params: {
    name: 'ca-${baseName}-api'
    location: location
    tags: allTags
    environmentId: environment.outputs.id
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    acrLoginServer: acr.outputs.loginServer
    image: apiImage
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    cosmosEndpoint: cosmos.outputs.endpoint
    cosmosDatabase: cosmos.outputs.databaseName
    storageBlobEndpoint: storage.outputs.blobEndpoint
    blobContainer: storage.outputs.containerName
    openAiEndpoint: foundry.outputs.openAiEndpoint
    modelProfile: modelProfile
    embeddingDimensions: embeddingDimensions
    entraTenantId: entraTenantId
    entraApiClientId: entraApiClientId
    corsOrigins: [web.outputs.url, 'http://localhost:5173']
  }
}

output apiUrl string = api.outputs.url
output apiAppName string = api.outputs.name
output frontendUrl string = web.outputs.url
output staticWebAppName string = web.outputs.name
output acrName string = acr.outputs.name
output acrLoginServer string = acr.outputs.loginServer
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageAccountName string = storage.outputs.name
output foundryEndpoint string = foundry.outputs.foundryEndpoint
output openAiEndpoint string = foundry.outputs.openAiEndpoint
output appInsightsId string = monitoring.outputs.appInsightsId
output appInsightsName string = monitoring.outputs.appInsightsName
output identityClientId string = identity.outputs.clientId
