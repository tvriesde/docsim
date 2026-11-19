param accountName string
param location string
param tags object
param identityPrincipalId string
@description('Optional object id of the deploying user; gets Cosmos DB data-plane access for ad-hoc queries.')
param deployerPrincipalId string = ''
@description('Must match the embedding model output dimensions.')
param embeddingDimensions int = 3072

var databaseName = 'docsim'
var dataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource account 'Microsoft.DocumentDB/databaseAccounts@2025-04-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      { name: 'EnableServerless' }
      { name: 'EnableNoSQLVectorSearch' }
    ]
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2025-04-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

var partitionKey = {
  paths: ['/corpus']
  kind: 'Hash'
  version: 2
}

resource documents 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = {
  parent: database
  name: 'documents'
  properties: {
    resource: {
      id: 'documents'
      partitionKey: partitionKey
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/*' }]
        excludedPaths: [
          { path: '/embedding/*' }
          { path: '/proj/*' }
          { path: '/body/?' }
          { path: '/"_etag"/?' }
        ]
        vectorIndexes: [
          {
            path: '/embedding'
            type: 'diskANN'
          }
        ]
      }
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: '/embedding'
            dataType: 'float32'
            dimensions: embeddingDimensions
            distanceFunction: 'cosine'
          }
        ]
      }
    }
  }
}

resource simple 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = [
  for name in ['batches', 'clusterRuns']: {
    parent: database
    name: name
    properties: {
      resource: {
        id: name
        partitionKey: partitionKey
        indexingPolicy: {
          indexingMode: 'consistent'
          automatic: true
          includedPaths: [{ path: '/*' }]
        }
      }
    }
  }
]

resource identityRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = {
  parent: account
  name: guid(account.id, identityPrincipalId, dataContributorRoleId)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${dataContributorRoleId}'
    principalId: identityPrincipalId
    scope: account.id
  }
}

resource deployerRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = if (!empty(deployerPrincipalId)) {
  parent: account
  name: guid(account.id, deployerPrincipalId, dataContributorRoleId)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${dataContributorRoleId}'
    principalId: deployerPrincipalId
    scope: account.id
  }
}

output endpoint string = account.properties.documentEndpoint
output name string = account.name
output databaseName string = databaseName
output roleAssignmentId string = identityRole.id
