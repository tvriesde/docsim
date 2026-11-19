<#
.SYNOPSIS
  Removes a DocSim environment: the resource group and (optionally) the Entra app registrations.

.EXAMPLE
  ./destroy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -DeleteAppRegistrations
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)] [string] $SubscriptionId,
    [Parameter(Mandatory)] [string] $EnvironmentName,
    [string] $ResourceGroupName,
    [switch] $DeleteAppRegistrations,
    # Purge the soft-deleted Foundry (Cognitive Services) account so the name can be reused immediately.
    [switch] $Purge,
    [switch] $NoWait
)

$ErrorActionPreference = 'Stop'
if (-not $ResourceGroupName) { $ResourceGroupName = "rg-$EnvironmentName" }

az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'az account set failed' }

$exists = az group exists --name $ResourceGroupName --only-show-errors
if ($exists -eq 'true') {
    $ai = @(az cognitiveservices account list -g $ResourceGroupName --query '[].{name:name,location:location}' -o json --only-show-errors | ConvertFrom-Json)
    if ($PSCmdlet.ShouldProcess($ResourceGroupName, 'Delete resource group')) {
        $wait = if ($NoWait -and -not $Purge) { @('--no-wait') } else { @() }
        az group delete --name $ResourceGroupName --yes @wait --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'az group delete failed' }
        Write-Host "Deleted resource group $ResourceGroupName"
        if ($Purge) {
            foreach ($a in $ai) {
                az cognitiveservices account purge -g $ResourceGroupName -n $a.name -l $a.location --only-show-errors
                Write-Host "Purged Foundry account $($a.name)"
            }
        }
    }
}
else {
    Write-Host "Resource group $ResourceGroupName does not exist."
}

if ($DeleteAppRegistrations) {
    foreach ($name in "$EnvironmentName-docsim-api", "$EnvironmentName-docsim-spa") {
        $ids = @(az ad app list --display-name $name --query "[?displayName=='$name'].id" -o tsv --only-show-errors)
        foreach ($id in $ids) {
            if ($id -and $PSCmdlet.ShouldProcess($name, 'Delete app registration')) {
                az ad app delete --id $id --only-show-errors
                Write-Host "Deleted app registration $name"
            }
        }
    }
}
