# DocSim: document similarity explorer

Upload documents in bulk, then explore how similar they are:

- **Dashboard**: an interactive 2-D map of every document. Similar documents sit close together, and clusters are drawn as labelled hulls. You can pan, zoom, search and recompute the clusters.
- **Similarity graph**: click a document to see a network of its nearest neighbors. Each edge's color (red → green) and thickness show the cosine similarity. You can tune the neighbor count, the minimum score, and the cross-links between neighbors.
- **Ingestion**: bulk drag-and-drop upload of PDF, DOCX and TXT files, with per-batch progress, reprocessing and deletion.

## How a document is processed

1. **Extract text**: PDF via unpdf/pdf.js (line and page aware), DOCX via mammoth, TXT as-is.
2. **Extract the body**: repeated page-edge lines are detected heuristically. A Foundry LLM (`gpt-6-luna`) then reviews the first and last lines of each page and returns the header and footer lines to drop, plus a title and summary. Those lines are removed only at page edges.
3. **Embed**: the cleaned body is chunked; each chunk is embedded with `text-embedding-3-large` (3072 dims), and the chunks are mean-pooled into one normalized document vector.
4. **Store**: the original goes to Blob Storage; metadata, body and embedding go to Cosmos DB, which serves similarity queries through its vector index.
5. **Cluster**: after each batch (debounced), or on demand, UMAP projects all embeddings to 2-D for the canvas layout. HDBSCAN finds clusters on the full (256-d projected) embeddings, so nearby topics aren't merged by the 2-D squeeze. The LLM then labels each cluster from member titles and keywords.
6. **Compare** (on demand, `POST /api/compare`): both bodies are split into passages, the passages are embedded, and the most similar pairs are matched one-to-one. `gpt-6-luna` then writes a verdict, an overview, the similarities and differences, and a note for each matched pair. Results are cached in Blob Storage (`compare/`). `POST /api/compare/chat` answers follow-up questions, with both documents in the model's context.
7. **Near-duplicates** (`GET /api/pairs`): each ready document's 10 nearest neighbours (whole-document cosine, Cosmos vector search) with a score of at least 0.75 become candidate pairs. The snapshot is cached in Blob Storage (`pairs/`) and recomputed when the set of ready documents changes. `POST /api/pairs/dismiss` marks a pair as "not a duplicate". The UI applies the threshold you choose and builds complete-linkage groups, so every document in a group passes the threshold against every other one.

In the UI, the dashboard canvas is full screen; individual clusters can be hidden from the cluster panel, and the copy button draws near-duplicate links on the map. In a document's similarity graph, click a node to open its properties pane, then choose **Compare side by side** for the full-screen comparison with highlighted similar parts and an AI chat. The **Near-duplicates** page shows a score histogram with a threshold slider, groups with a suggested document to keep, and a pair table with Compare and Dismiss actions.

Every document stores its body `language` (ISO 639-1, `und` when unknown). The language is reported by the LLM during the cleaning step, with a stop-word heuristic as fallback; documents ingested before this existed are backfilled with the heuristic at API startup. The **Same language only** switch (Near-duplicates page and the map legend) hides pairs whose documents are in different known languages, e.g. the NL/FR/DE versions of the same letter template.

To delete in bulk, tick rows on the **Documents** page and choose **Delete N**. To delete everything that matches the current filters, use "Select all N matching". To remove a whole cluster, use **Delete cluster** on the Documents page (when filtered by cluster) or the trash icon in the dashboard's cluster panel. The API endpoint is `POST /api/documents/delete` with `{ ids: [...] }` or `{ filter: { clusterId, status, batchId, q } }`. A filter needs at least one criterion, and one call deletes at most 5000 documents. Each deleted document's blobs are removed too, and a recluster is scheduled.

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | Fastify + TypeScript API, ingestion pipeline, clustering worker (`npm test`, `npm run dev`) |
| `frontend/` | React 19 + Vite + Tailwind v4 SPA (MSAL, React Flow, canvas map) |
| `infra/` | Bicep and `deploy.ps1` / `destroy.ps1` (see [infra/README.md](infra/README.md)) |
| `sample-data/` | 16 generated documents (4 topics) with repeating headers and footers, for demos and tests |

## Run locally (no Azure needed)

```powershell
cd backend;  npm install; npm run dev     # http://localhost:8000, in-memory store, fake AI, no auth
cd frontend; npm install; npm run dev     # http://localhost:5173 (proxies /api to :8000)
```

Locally, the backend runs with `STORE=memory`, `BLOB=local` and `AI=fake` by default. Fake AI uses deterministic hashed embeddings and the heuristic header/footer detector. To use real Azure services, set `STORE=cosmos`, `BLOB=azure`, `AI=foundry` and the matching endpoints (see `backend/src/config.ts`).

Regenerate the sample data with `cd backend; npx tsx scripts/generate-samples.ts`.

## Deploy to Azure

```powershell
cd infra
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim            # full deployment
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps seed # load sample-data
./deploy.ps1 -SubscriptionId <guid> -EnvironmentName docsim -Steps api,smoke   # backend-only update
```

The frontend runs on Azure Static Web Apps; the API runs on Azure Container Apps. Sign-in uses Entra ID: MSAL in the SPA, with bearer tokens validated by the API. Access is restricted to the assigned users.
