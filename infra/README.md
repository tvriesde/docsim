# Infrastructure and deployment

Bicep templates plus an idempotent Azure CLI deploy script for DocSim.

## What gets deployed

| Resource | Module | Notes |
|---|---|---|
| Log Analytics + Application Insights | `modules/monitoring.bicep` | 1 GB/day cap; the API exports OpenTelemetry via `APPLICATIONINSIGHTS_CONNECTION_STRING` |
| User-assigned managed identity | `modules/identity.bicep` | Used by the API for ACR, Cosmos DB, Blob and Foundry (no keys anywhere) |
| Azure Container Registry (Basic) | `modules/acr.bicep` | AcrPull for the identity |
| Storage account + `documents` container | `modules/storage.bicep` | Shared key disabled; Storage Blob Data Contributor for the identity |
| Cosmos DB for NoSQL (serverless) | `modules/cosmos.bicep` | Vector search on `/embedding` (3072 dims, cosine, diskANN); containers `documents`, `batches`, `clusterRuns` (pk `/corpus`); local auth disabled |
| Microsoft Foundry (AIServices) + project | `modules/foundry.bicep` | Deployments from `model-profile.json` (`gpt-6-luna` for header/footer detection and cluster labels, `text-embedding-3-large`) |
| Container Apps environment + API app | `modules/environment.bicep`, `modules/api.bicep` | 1 vCPU / 2 GiB, exactly 1 replica (in-process ingestion queue) |
| Static Web App (Free) | `modules/staticwebapp.bicep` | Hosts the SPA; `westeurope` by default (SWA is not offered in every region) |

All resources are tagged `SecurityControl=Ignore`.

## Authentication

The `identity` step creates two Entra ID app registrations:

- `<env>-docsim-api`: exposes `api://<appId>/Documents.ReadWrite`. The SPA and the Azure CLI are pre-authorized, so the CLI can get a token for seeding and smoke tests.
- `<env>-docsim-spa`: a SPA client with redirect URIs for the Static Web App URL and `http://localhost:5173`.

On both enterprise apps, *assignment required* is enabled. Only `-AllowedUsers` plus the deploying user can sign in. The list is authoritative: other user assignments are removed. Users that don't exist in the tenant are skipped with a warning; invite them as guests first.

The API validates the v2 access token itself (issuer, audience and the `Documents.ReadWrite` scope). `/api/health` is anonymous.

## Deploy

```powershell
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim                  # everything
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps seed      # upload ../sample-data
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps seed -SampleDataDir ../input
```

| Step | What it does | Typical use |
|---|---|---|
| `identity` | App registrations, scope, redirect URIs, user assignment | First run, or when changing `-AllowedUsers` |
| `infra` | Resource group + Bicep deployment | First run, or after Bicep / model-profile changes |
| `api` | `az acr build` of `backend/`, then roll out (`az containerapp update`, or a Bicep redeploy when `infra` also runs) | Backend code changes |
| `frontend` | `npm run build`, writes `dist/config.json`, uploads with the SWA CLI | Frontend changes |
| `seed` | Creates a batch and uploads `-SampleDataDir` through the API, then waits for processing | Demo data |
| `smoke` | Health 200, 401 without a token, an authenticated call with a CLI token, and SWA `config.json` | After any change |
| `tags` | Ensures every resource carries `SecurityControl=Ignore` | After `infra` |

`all` = identity, infra, api, frontend, smoke, tags. `images` = api, frontend.

Examples:

```powershell
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps api,smoke   # backend change
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps frontend    # UI change
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps infra,tags  # Bicep change, keep image
```

Other parameters:
- `-Location` (default `swedencentral`) and `-StaticWebAppLocation` (default `westeurope`).
- `-ModelProfile` (default `model-profile.json`).
- `-AllowedUsers` (default `tvriesde@microsoft.com`).
- `-SkipDeployerAccess`.

## Models

Edit `model-profile.json` rather than the Bicep. `main.bicep` loads it as the default, and `deploy.ps1` passes it explicitly. The `embedding.dimensions` value drives the Cosmos DB vector policy and `EMBEDDING_DIMENSIONS`. Changing the dimensions requires recreating the `documents` container and re-embedding.

Deployments use `DataZoneStandard`, which keeps processing in the EU data zone. Each `capacity` (in thousands of tokens per minute) must fit the subscription's regional quota. Check it with `az cognitiveservices usage list -l swedencentral`.

## Destroy

```powershell
./destroy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -DeleteAppRegistrations -Purge
```
