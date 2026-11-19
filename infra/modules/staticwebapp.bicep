param name string
param location string
param tags object
@allowed(['Free', 'Standard'])
param sku string = 'Free'

resource site 'Microsoft.Web/staticSites@2024-04-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
    provider: 'None'
  }
}

output name string = site.name
output url string = 'https://${site.properties.defaultHostname}'
