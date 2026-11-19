param accountName string
param projectName string
param location string
param tags object
param identityPrincipalId string

@description('Model deployments: [{ name, model, version, sku, capacity }]. Created sequentially.')
param deployments array

var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    allowProjectManagement: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'Document similarity: body extraction and embeddings'
  }
}

@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [
  for d in deployments: {
    parent: account
    name: d.name
    tags: tags
    sku: {
      name: d.sku
      capacity: d.capacity
    }
    properties: {
      model: {
        format: 'OpenAI'
        name: d.model
        version: d.version
      }
    }
    dependsOn: [project]
  }
]

resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, identityPrincipalId, openAiUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output name string = account.name
output openAiEndpoint string = 'https://${accountName}.openai.azure.com/'
output foundryEndpoint string = 'https://${accountName}.services.ai.azure.com/'
output projectName string = project.name
output roleAssignmentId string = openAiUser.id
