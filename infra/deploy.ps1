<#
.SYNOPSIS
  Deploys DocSim (document similarity) to Azure (idempotent): RG, Entra app registrations, Bicep, API image,
  Static Web App frontend, sample data and smoke tests.

.DESCRIPTION
  -Steps selects what runs (default: all). Steps always run in this order:
    identity  Entra app registrations (API scope, SPA redirects), user assignment (-AllowedUsers + deployer)
    infra     Resource group + Bicep (Cosmos DB vector search, Blob storage, Foundry models, ACR,
              Container Apps environment + API app, Static Web App, monitoring)
    api       Build the API image in ACR and roll it out to the Container App
    frontend  Build the SPA locally, write config.json and upload it to the Static Web App
    seed      Upload sample-data/ through the API (uses an Azure CLI token for the API scope)
    smoke     API health, auth enforcement (401 without token), frontend reachability
    tags      Enforce SecurityControl=Ignore on every resource
  'all' = identity, infra, api, frontend, smoke, tags. 'images' = api, frontend.
  Without 'infra', a new API image is rolled out with 'az containerapp update' (fast) instead of a Bicep redeploy.

.EXAMPLE
  ./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim

.EXAMPLE
  # Backend code change only
  ./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps api,smoke

.EXAMPLE
  # Frontend change only
  ./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps frontend
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $SubscriptionId,
    [string] $Location = 'swedencentral',
    [string] $StaticWebAppLocation = 'westeurope',
    [Parameter(Mandatory)] [ValidatePattern('^[a-z0-9][a-z0-9-]{1,15}$')] [string] $EnvironmentName,
    [string] $ResourceGroupName,
    [string] $ModelProfile = (Join-Path $PSScriptRoot 'model-profile.json'),
    # Only these users (plus the deploying user, unless -SkipDeployerAccess) can sign in: both enterprise apps get
    # "assignment required". Users that do not exist in the tenant are skipped with a warning.
    [string[]] $AllowedUsers = @('tvriesde@microsoft.com'),
    [switch] $SkipDeployerAccess,
    [ValidateSet('all', 'identity', 'infra', 'api', 'frontend', 'images', 'seed', 'smoke', 'tags')]
    [string[]] $Steps = @('all'),
    [string] $SampleDataDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sample-data')
)

$ErrorActionPreference = 'Stop'
if (-not $ResourceGroupName) { $ResourceGroupName = "rg-$EnvironmentName" }

$InfraDir = $PSScriptRoot
$RepoDir = Split-Path $InfraDir -Parent
$WorkDir = Join-Path $InfraDir '.work'
$Placeholder = 'mcr.microsoft.com/k8se/quickstart:latest'
$ApiScopeName = 'Documents.ReadWrite'
$ApiAppName = "$EnvironmentName-docsim-api"
$SpaAppName = "$EnvironmentName-docsim-spa"
# Well-known Azure CLI client id; pre-authorized so 'az account get-access-token' works for the seed step.
$AzureCliAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
$env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL = 'yes_without_prompt'

function Write-Step([string] $Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

# Runs az, fails on non-zero exit code and returns stdout lines.
function Invoke-Az {
    $out = & az @args --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed with exit code $LASTEXITCODE" }
    return $out
}

function Invoke-AzJson {
    $out = Invoke-Az @args
    if (-not $out) { return $null }
    return ($out -join "`n") | ConvertFrom-Json
}

# Like Invoke-Az but returns $null instead of throwing.
function Try-Az {
    $out = & az @args --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $out
}

function Get-AzTsv {
    return ((Invoke-Az @args -o tsv) -join '').Trim()
}

# az acr build crashes on Windows (cp1252) while streaming build logs with non-ASCII characters,
# so builds run with --no-logs (still waits) and the log is fetched separately on failure.
function Invoke-AcrBuild([string] $Registry, [string] $Image, [string] $Context) {
    Write-Host "Building $Image"
    $run = Invoke-AzJson acr build --registry $Registry --image $Image --no-logs $Context
    if ($run.status -ne 'Succeeded') {
        & az acr task logs --registry $Registry --run-id $run.runId 2>&1 | Select-Object -Last 60 | Write-Host
        throw "ACR build of $Image ended with status $($run.status) (run $($run.runId))"
    }
}

function Write-JsonFile([string] $Name, $Object) {
    $path = Join-Path $WorkDir $Name
    $Object | ConvertTo-Json -Depth 20 | Set-Content -Path $path -Encoding utf8
    return $path
}

function Invoke-GraphPatch([string] $ObjectId, $Body) {
    $file = Write-JsonFile "graph-$ObjectId.json" $Body
    Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$ObjectId" `
        --headers 'Content-Type=application/json' --body "@$file" | Out-Null
}

function Find-App([string] $DisplayName) {
    $apps = Invoke-AzJson ad app list --display-name $DisplayName --query "[?displayName=='$DisplayName'].{id:id,appId:appId}"
    return @($apps) | Select-Object -First 1
}

function Get-OrCreateApp([string] $DisplayName) {
    $app = Find-App $DisplayName
    if (-not $app) {
        Write-Host "Creating app registration '$DisplayName'"
        $created = Invoke-AzJson ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg
        $app = [pscustomobject]@{ id = $created.id; appId = $created.appId }
    }
    else {
        Write-Host "Found app registration '$DisplayName' ($($app.appId))"
    }
    $sp = Invoke-AzJson ad sp list --filter "appId eq '$($app.appId)'" --query '[].id'
    if (-not $sp) {
        Invoke-Az ad sp create --id $app.appId | Out-Null
    }
    return $app
}

# Resolves a UPN or e-mail address to a user object id in the current tenant (members and guests).
function Resolve-User([string] $User) {
    $id = Try-Az ad user show --id $User --query id -o tsv
    if ($id) { return ($id -join '').Trim() }
    $filter = "mail eq '$User' or otherMails/any(m:m eq '$User')"
    $id = Try-Az ad user list --filter $filter --query '[0].id' -o tsv
    if ($id) { return ($id -join '').Trim() }
    return $null
}

# Requires user assignment on the app's enterprise app and assigns exactly $UserIds (default access role).
# Existing user assignments that are not in $UserIds are removed, so the list is authoritative.
function Set-AppAccess([string] $AppId, [hashtable] $UserIds) {
    $spId = Get-AzTsv ad sp list --filter "appId eq '$AppId'" --query '[0].id'
    $file = Write-JsonFile "sp-$spId.json" @{ appRoleAssignmentRequired = $true }
    Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$spId" `
        --headers 'Content-Type=application/json' --body "@$file" | Out-Null

    $existing = @((Invoke-AzJson rest --method GET `
                --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo?`$top=999").value |
        Where-Object { $_.principalType -eq 'User' })
    foreach ($uid in $UserIds.Keys) {
        if (-not ($existing | Where-Object { $_.principalId -eq $uid })) {
            $body = Write-JsonFile "assign-$spId-$uid.json" @{
                principalId = $uid; resourceId = $spId; appRoleId = '00000000-0000-0000-0000-000000000000'
            }
            Invoke-Az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo" `
                --headers 'Content-Type=application/json' --body "@$body" | Out-Null
            Write-Host "  assigned $($UserIds[$uid])"
        }
    }
    foreach ($a in $existing) {
        if (-not $UserIds.ContainsKey($a.principalId)) {
            Invoke-Az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo/$($a.id)" | Out-Null
            Write-Host "  removed $($a.principalDisplayName)"
        }
    }
}

$selected = [System.Collections.Generic.HashSet[string]]::new()
foreach ($s in $Steps) {
    switch ($s) {
        'all' { foreach ($x in 'identity', 'infra', 'api', 'frontend', 'smoke', 'tags') { [void]$selected.Add($x) } }
        'images' { foreach ($x in 'api', 'frontend') { [void]$selected.Add($x) } }
        default { [void]$selected.Add($s) }
    }
}
function Test-Step([string] $Name) { return $selected.Contains($Name) }
$StepOrder = @('identity', 'infra', 'api', 'frontend', 'seed', 'smoke', 'tags')
$StepList = @($StepOrder | Where-Object { Test-Step $_ })

function Get-DeploymentOutputs {
    $o = Try-Az deployment group show --resource-group $ResourceGroupName --name main --query properties.outputs -o json
    if (-not $o) { return $null }
    return ($o -join "`n") | ConvertFrom-Json
}

try {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

    # Prerequisites (always)
    Write-Step "Prerequisites (steps: $($StepList -join ', '))"
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) not found.' }
    if ((Test-Step 'frontend') -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm not found (needed for the frontend step).' }
    if (-not (Try-Az account show -o json)) { throw "Not logged in. Run 'az login' first." }
    Invoke-Az account set --subscription $SubscriptionId | Out-Null
    $TenantId = Get-AzTsv account show --query tenantId
    $deployerId = ''
    $signedIn = Try-Az ad signed-in-user show --query id -o tsv
    if ($signedIn) { $deployerId = ($signedIn -join '').Trim() }
    Write-Host "Subscription $SubscriptionId, tenant $TenantId, resource group $ResourceGroupName"

    if (-not (Test-Path $ModelProfile)) { throw "Model profile not found: $ModelProfile" }
    $profileObj = Get-Content $ModelProfile -Raw | ConvertFrom-Json
    foreach ($role in 'chat', 'embedding') {
        if (-not $profileObj.$role) { throw "Model profile is missing role '$role'." }
    }

    # Outputs of the previous Bicep deployment ($null on a first deployment)
    $out = Get-DeploymentOutputs
    if (-not $out -and -not (Test-Step 'infra')) {
        throw "No existing deployment in '$ResourceGroupName'. Run the 'infra' step (or -Steps all) first."
    }

    # Step: identity
    if (Test-Step 'identity') {
        Write-Step 'identity: Entra ID app registrations and access'
        $apiApp = Get-OrCreateApp $ApiAppName
        $spaApp = Get-OrCreateApp $SpaAppName

        $existingApi = Invoke-AzJson rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$($apiApp.id)?`$select=api"
        $existingScope = @($existingApi.api.oauth2PermissionScopes) | Where-Object { $_.value -eq $ApiScopeName } | Select-Object -First 1
        if ($existingScope) { $scopeId = $existingScope.id } else { $scopeId = [guid]::NewGuid().ToString() }

        Invoke-GraphPatch $apiApp.id @{
            identifierUris = @("api://$($apiApp.appId)")
            api            = @{
                requestedAccessTokenVersion = 2
                oauth2PermissionScopes      = @(@{
                        id                      = $scopeId
                        value                   = $ApiScopeName
                        type                    = 'User'
                        isEnabled               = $true
                        adminConsentDisplayName = 'Read and write documents'
                        adminConsentDescription = 'Allows the app to upload, read and analyze documents on behalf of the signed-in user.'
                        userConsentDisplayName  = 'Read and write documents'
                        userConsentDescription  = 'Allows the app to upload, read and analyze documents on your behalf.'
                    })
            }
        }
        # Graph rejects pre-authorizing a scope in the same PATCH that creates it.
        Invoke-GraphPatch $apiApp.id @{
            api = @{
                preAuthorizedApplications = @(
                    @{ appId = $spaApp.appId; delegatedPermissionIds = @($scopeId) }
                    @{ appId = $AzureCliAppId; delegatedPermissionIds = @($scopeId) }
                )
            }
        }

        $redirects = @('http://localhost:5173')
        if ($out) { $redirects = @($out.frontendUrl.value) + $redirects }
        Invoke-GraphPatch $spaApp.id @{
            spa                    = @{ redirectUris = $redirects }
            requiredResourceAccess = @(@{
                    resourceAppId  = $apiApp.appId
                    resourceAccess = @(@{ id = $scopeId; type = 'Scope' })
                })
        }

        $userIds = @{}
        foreach ($u in $AllowedUsers) {
            $uid = Resolve-User $u
            if ($uid) { $userIds[$uid] = $u }
            else { Write-Warning "User '$u' not found in tenant $TenantId; skipped (invite them as a guest first)." }
        }
        if (-not $SkipDeployerAccess -and $deployerId) { $userIds[$deployerId] = 'deploying user' }
        if ($userIds.Count -eq 0) { throw 'No users to grant access: none of -AllowedUsers exist in the tenant.' }
        Write-Host "Restricting sign-in to: $(($userIds.Values | Sort-Object) -join ', ')"
        Set-AppAccess $spaApp.appId $userIds
        Set-AppAccess $apiApp.appId $userIds
    }
    else {
        $apiApp = Find-App $ApiAppName
        $spaApp = Find-App $SpaAppName
    }

    # API image currently deployed (kept unless the api step replaces it)
    $apiImage = $Placeholder
    if ($out) {
        $img = Try-Az containerapp show -g $ResourceGroupName -n $out.apiAppName.value --query 'properties.template.containers[0].image' -o tsv
        if ($img) { $apiImage = ($img -join '').Trim() }
    }

    function Invoke-BicepDeployment([string] $Image) {
        if (-not $apiApp -or -not $spaApp) { throw "App registrations '$ApiAppName'/'$SpaAppName' not found. Run the 'identity' step." }
        $file = Write-JsonFile 'main.parameters.json' @{
            '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
            contentVersion = '1.0.0.0'
            parameters     = @{
                environmentName      = @{ value = $EnvironmentName }
                location             = @{ value = $Location }
                staticWebAppLocation = @{ value = $StaticWebAppLocation }
                tags                 = @{ value = @{ SecurityControl = 'Ignore' } }
                apiImage             = @{ value = $Image }
                modelProfile         = @{ value = $profileObj }
                entraTenantId        = @{ value = $TenantId }
                entraApiClientId     = @{ value = $apiApp.appId }
                deployerPrincipalId  = @{ value = $deployerId }
            }
        }
        Invoke-Az deployment group create --resource-group $ResourceGroupName --name main `
            --template-file (Join-Path $InfraDir 'main.bicep') --parameters "@$file" -o none | Out-Null
        return Get-DeploymentOutputs
    }

    $tag = Get-Date -Format 'yyyyMMddHHmmss'
    $gitSha = (& git -C $RepoDir rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $gitSha) { $tag = "$gitSha-$tag" }

    # Step: infra
    if (Test-Step 'infra') {
        Write-Step 'infra: resource group and Bicep deployment'
        Invoke-Az group create --name $ResourceGroupName --location $Location --tags SecurityControl=Ignore | Out-Null
        # On a first deployment the ACR does not exist yet, so the API starts with the placeholder image.
        $out = Invoke-BicepDeployment $apiImage
        Write-Host "Bicep deployment succeeded. API: $($out.apiUrl.value)  Web: $($out.frontendUrl.value)"

        # The SPA redirect URI depends on the Static Web App host name, which is only known after the first deployment.
        if ($spaApp) {
            $spa = Invoke-AzJson rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$($spaApp.id)?`$select=spa"
            $uris = @($spa.spa.redirectUris)
            if ($uris -notcontains $out.frontendUrl.value) {
                Write-Host "Adding SPA redirect URI $($out.frontendUrl.value)"
                Invoke-GraphPatch $spaApp.id @{ spa = @{ redirectUris = @($out.frontendUrl.value) + $uris } }
            }
        }
    }

    $apiUrl = $out.apiUrl.value
    $frontendUrl = $out.frontendUrl.value

    # Step: api
    if (Test-Step 'api') {
        Write-Step 'api: build image in ACR and roll out'
        Invoke-AcrBuild $out.acrName.value "docsim-api:$tag" (Join-Path $RepoDir 'backend')
        $apiImage = "$($out.acrLoginServer.value)/docsim-api:$tag"
        if ((Test-Step 'infra')) {
            # Bicep switches the port (80 -> 8000) and enables probes once a real image is used.
            $out = Invoke-BicepDeployment $apiImage
        }
        else {
            Invoke-Az containerapp update -g $ResourceGroupName -n $out.apiAppName.value --image $apiImage -o none | Out-Null
        }
        Write-Host "API image: $apiImage"
    }
    $realImage = -not $apiImage.StartsWith('mcr.microsoft.com/k8se/quickstart')

    # Step: frontend
    if (Test-Step 'frontend') {
        Write-Step 'frontend: build SPA and upload to Static Web Apps'
        if (-not $apiApp -or -not $spaApp) { throw "App registrations not found. Run the 'identity' step." }
        $frontendDir = Join-Path $RepoDir 'frontend'
        Push-Location $frontendDir
        try {
            if (-not (Test-Path 'node_modules')) {
                & npm ci --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
            }
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
        }
        finally { Pop-Location }

        $dist = Join-Path $frontendDir 'dist'
        @{
            authEnabled = $true
            tenantId    = $TenantId
            spaClientId = $spaApp.appId
            apiScope    = "api://$($apiApp.appId)/$ApiScopeName"
            apiBaseUrl  = $apiUrl
        } | ConvertTo-Json | Set-Content -Path (Join-Path $dist 'config.json') -Encoding utf8

        $swaToken = Get-AzTsv staticwebapp secrets list -g $ResourceGroupName -n $out.staticWebAppName.value --query properties.apiKey
        & npx --yes @azure/static-web-apps-cli@2 deploy $dist --deployment-token $swaToken --env production --no-use-keychain
        if ($LASTEXITCODE -ne 0) { throw 'Static Web Apps upload failed' }
        Write-Host "Frontend deployed: $frontendUrl"
    }

    # Step: seed
    if (Test-Step 'seed') {
        Write-Step 'seed: upload sample-data through the API'
        if (-not $realImage) { throw 'Placeholder image deployed; cannot seed. Include the api step.' }
        $files = @(Get-ChildItem $SampleDataDir -File -Include *.pdf, *.docx, *.txt -Recurse)
        if ($files.Count -eq 0) { throw "No sample files in $SampleDataDir" }
        $token = Get-AzTsv account get-access-token --scope "api://$($apiApp.appId)/$ApiScopeName" --query accessToken
        $headers = @{ Authorization = "Bearer $token" }
        $batch = Invoke-RestMethod -Method Post -Uri "$apiUrl/api/batches" -Headers $headers `
            -ContentType 'application/json' -Body (@{ label = 'Sample data' } | ConvertTo-Json)
        $uploaded = Invoke-RestMethod -Method Post -Uri "$apiUrl/api/batches/$($batch.id)/files" -Headers $headers `
            -Form @{ files = $files }
        Write-Host "Uploaded $($files.Count) file(s) to batch $($batch.id); waiting for processing..."
        $progress = $null
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 10
            $progress = Invoke-RestMethod -Uri "$apiUrl/api/batches/$($batch.id)" -Headers $headers
            Write-Host ("  " + (($progress.counts.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '))
            if ($progress.done) { break }
        }
        if (-not $progress.done) { Write-Warning 'Batch still processing; check the dashboard.' }
        elseif ($progress.counts.failed) { Write-Warning "$($progress.counts.failed) document(s) failed to process." }
        else { Write-Host 'Sample data processed.' }
        [void]$uploaded
    }

    # Step: smoke
    if (Test-Step 'smoke') {
        Write-Step 'smoke: health, auth and frontend'
        if (-not $realImage) {
            Write-Warning 'Placeholder image deployed; API checks skipped.'
        }
        else {
            $healthy = $false
            for ($i = 1; $i -le 20 -and -not $healthy; $i++) {
                try {
                    $r = Invoke-RestMethod -Uri "$apiUrl/api/health" -TimeoutSec 30
                    if ($r.status -eq 'ok') { $healthy = $true; Write-Host "API health OK (ai=$($r.ai))" }
                }
                catch { Start-Sleep -Seconds 15 }
            }
            if (-not $healthy) { throw "API health check failed: $apiUrl/api/health" }

            $r = Invoke-WebRequest -Uri "$apiUrl/api/stats" -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
            if ($r.StatusCode -eq 401) { Write-Host 'Protected endpoint returns 401 without a token (auth enforced).' }
            else { throw "GET /api/stats without a token returned $($r.StatusCode) (expected 401)." }

            $token = Try-Az account get-access-token --scope "api://$($apiApp.appId)/$ApiScopeName" --query accessToken -o tsv
            if ($token) {
                $stats = Invoke-RestMethod -Uri "$apiUrl/api/stats" -Headers @{ Authorization = "Bearer $(($token -join '').Trim())" }
                Write-Host "Authenticated call OK: $($stats | ConvertTo-Json -Compress -Depth 4)"
            }
            else { Write-Warning 'Could not get a CLI token for the API scope; authenticated check skipped.' }
        }
        $r = Invoke-WebRequest -Uri "$frontendUrl/config.json" -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
        if ($r.StatusCode -eq 200) { Write-Host 'Frontend serves config.json.' }
        else { Write-Warning "Frontend config.json returned $($r.StatusCode) (run the frontend step)." }
    }

    # Step: tags
    if (Test-Step 'tags') {
        Write-Step 'tags: enforce SecurityControl=Ignore'
        function Get-UntaggedResources {
            $res = Invoke-AzJson resource list --resource-group $ResourceGroupName --query '[].{id:id,tags:tags}'
            return @($res | Where-Object { -not $_.tags -or $_.tags.SecurityControl -ne 'Ignore' })
        }
        foreach ($m in Get-UntaggedResources) {
            # Platform-created resources (e.g. App Insights smart detector rules) are not tagged by Bicep.
            Write-Host "Tagging platform-created resource: $($m.id)"
            Try-Az tag update --resource-id $m.id --operation Merge --tags SecurityControl=Ignore | Out-Null
        }
        $missing = Get-UntaggedResources
        if ($missing.Count -gt 0) {
            $missing | ForEach-Object { Write-Error "Missing tag SecurityControl=Ignore: $($_.id)" -ErrorAction Continue }
            throw "$($missing.Count) resource(s) lack tag SecurityControl=Ignore."
        }
        Write-Host 'All resources carry SecurityControl=Ignore.'
    }

    Write-Step "Done ($($StepList -join ', '))"
    Write-Host "Frontend URL:     $frontendUrl"
    Write-Host "API URL:          $apiUrl"
    Write-Host "API image:        $apiImage"
    Write-Host "Foundry endpoint: $($out.foundryEndpoint.value)"
    Write-Host "Cosmos endpoint:  $($out.cosmosEndpoint.value)"
    Write-Host "App Insights:     https://portal.azure.com/#@$TenantId/resource$($out.appInsightsId.value)/overview"
}
finally {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}
