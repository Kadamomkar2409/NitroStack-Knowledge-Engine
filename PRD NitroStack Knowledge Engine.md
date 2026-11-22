# PRD: NitroStack Knowledge Engine

MongoDB Atlas Vector Search + Voyage AI | Reusable MCP retrieval service for RAG applications

Author: Omkar Kadam | Version 1.1 (updated with mentor decisions) | Source: MongoDB Vector Search & Voyage AI research brief (18 November 2026), project #15

## 1. Overview

The NitroStack Knowledge Engine is a real, production-style retrieval service that any NitroStack/MCP application can plug into to get secure, cited, measurable RAG. It ingests real documents, stores chunks and metadata in MongoDB Atlas, embeds them with Voyage AI, retrieves with hybrid (lexical + semantic) search, optionally reranks with the Voyage reranker, and returns authorized, source-attributed context through MCP tools. An answer layer uses an LLM to generate grounded answers with citations.

The first real workload is a knowledge assistant over a real documentation corpus (docs.nitrostack.com).

## 2. Hard rule for the building agent: NO MOCKS, NO DEMO DATA

This is a non-negotiable requirement for the whole project.

- Every integration must call the real service: real MongoDB Atlas cluster, real Voyage API, real LLM API, real vector index.
- No hardcoded answers, fake documents, fake embeddings, fake scores, simulated latency, or placeholder metrics anywhere in product code.
- Evaluation numbers must be computed from actual runs and stored; never typed in by hand.
- Token usage and cost must be read from actual API responses.
- Unit tests may use small fixtures for pure logic (chunking, filter building, parsing). Integration, security and evaluation tests must run against the real Atlas and Voyage services.
- If a real credential or service is missing, stop and ask the user. Do not substitute a mock.
- Secrets live only in environment variables, never in the repository.

## 3. Goals

1. Ship a working, reusable knowledge retrieval service exposed as MCP tools on NitroStack.
2. Enforce tenant isolation and access control at query time, failing closed.
3. Return every result with source references so answers are verifiable.
4. Measure retrieval quality, latency and cost with a repeatable evaluation harness.
5. Compare configurations (vector only, hybrid, hybrid + rerank, different Voyage models) using real data.
6. Be documented, deployable and demonstrable as the actual running system.

## 4. Non-goals (v1)

- Autonomous decision-making in regulated domains (legal, medical, insurance).
- Full database independence. v1 is MongoDB-first behind a thin storage interface, so other backends can be added later.
- A heavily designed UI. The frontend must be functional and clean and talk to the real backend, but it is not a design showcase.
- Fine-tuning models.

## 5. Users and use cases

| User | Need |
| --- | --- |
| Developer building a NitroStack app | Add retrieval and cited answers through MCP tools without writing embedding or sync code |
| Tenant admin | Ingest, update and delete their own documents; see usage and cost |
| End user / support agent | Ask a natural-language question and get a cited answer from permitted sources |
| Mentor / reviewer | See measured quality, latency, cost and security test results |

Primary use cases: enterprise/internal knowledge search, customer-support copilot, developer documentation search.

## 6. System architecture

Flow: Documents -> parse and chunk -> MongoDB -> automated embeddings + vector index -> query -> hybrid retrieval with tenant/permission prefilter -> optional Voyage rerank -> authorized context -> LLM answer with citations.

Components:

1. **Ingestion service** - accepts real files (Markdown, PDF, HTML, plain text), parses and chunks them, writes chunks with metadata, tracks indexing status.
2. **Retrieval service** - metadata-filtered hybrid search, optional reranking, returns ranked chunks with source references.
3. **MCP server (NitroStack, TypeScript)** - exposes tools to MCP clients; follow the NitroStack documentation for structure and conventions.
4. **Auth and tenancy layer** - per-tenant API keys/tokens; tenant and visibility filters applied before retrieval.
5. **Answer layer** - calls a real LLM with only authorized retrieved context; returns citations; says "not found" when evidence is weak.
6. **Evaluation harness** - runs labeled questions against configurations and stores metrics.
7. **Observability** - structured logs, latency, token usage, cost, index status and freshness.

## 7. Technology

| Area | Choice |
| --- | --- |
| Language | TypeScript (Node.js) |
| MCP framework | NitroStack (follow its docs) |
| Database / vector store | MongoDB Atlas with Atlas Vector Search and Atlas Search (hybrid) |
| Embeddings | Voyage AI via Atlas Automated Embedding; support externally generated Voyage embeddings as a configurable alternative |
| Reranking | Voyage rerank-3 (quality) / rerank-3-lite (cost), selectable per query |
| LLM for answers | Own OpenRouter API key with NVIDIA Nemotron models (Nemotron 3 Ultra or Nemotron 3.5 Lightning) or free alternatives such as Google Gemma 4 31B and ERNIE 5.5 Flash Preview; choose by requirements and availability |
| Deployment | MCP server on NitroCloud; frontend and backend on Vercel or Cloudflare |
| Tooling | Antigravity agent for development; GitHub for source control |

Voyage models to evaluate (prices are USD per 1M tokens as published in the research brief; re-verify before use): voyage-4-lite ($0.02), voyage-4 ($0.06, default baseline), voyage-4-large ($0.12), voyage-code-4 ($0.12, for code and technical docs), rerank-3-lite ($0.02), rerank-3 ($0.05).

## 8. Functional requirements

### 8.1 Ingestion

- FR-1: Ingest real documents from file upload or URL list; supported types: Markdown, PDF, HTML, plain text.
- FR-2: Parse and chunk with configurable size and overlap; preserve headings, page numbers and section paths in metadata.
- FR-3: Store each chunk with: tenantId, collectionId, documentId, chunkId, text, source (title, URL/path), version, visibility/role list, createdAt, updatedAt, status.
- FR-4: Track indexing status per document (pending, indexed, failed) and expose it.
- FR-5: Support update (re-ingest new version) and delete; deletions must propagate so deleted content is never returned.
- FR-6: Redact configured sensitive patterns before embedding.
- FR-7: Idempotent ingestion: re-ingesting identical content must not create duplicates.

### 8.2 Retrieval

- FR-8: Vector search using an Atlas vector index with metadata prefilters (tenant, collection, visibility, version, source type).
- FR-9: Hybrid search combining lexical and semantic retrieval; exact identifiers (function names, error codes) must be findable.
- FR-10: Optional Voyage reranking per query, with candidate count configurable.
- FR-11: Support ANN by default and exact (ENN) search as an option for evaluation baselines.
- FR-12: Every result includes text, score, source reference (document, section, page/URL), and chunk id.
- FR-13: Never assume immediate index visibility after writes; expose freshness/status and handle the asynchronous window.

### 8.3 MCP tools

| Tool | Purpose | Key inputs | Output |
| --- | --- | --- | --- |
| search\_knowledge | Retrieve ranked, authorized chunks | query, collection, topK, mode (vector/hybrid), rerank (bool), filters | Ranked results with sources and scores |
| answer\_question | Grounded answer with citations | query, collection, topK, rerank | Answer text, citations, or "not found" |
| get\_source | Fetch the full source/chunk context | chunkId or documentId | Source text and metadata |
| list\_collections | List collections the caller may access | none | Collection names and stats |
| ingest\_document | Add or update a document | collection, file/URL, metadata, visibility | Document id and indexing status |
| delete\_document | Remove a document and its chunks | documentId | Deletion confirmation |
| get\_usage | Token usage and cost for the caller | period | Tokens and estimated spend |

All tools validate input, return structured errors, and require authentication.

### 8.4 Answer layer

- FR-14: Build the prompt only from authorized retrieved chunks; treat retrieved text as untrusted data (prompt-injection defense).
- FR-15: Return citations that map to chunk and document ids.
- FR-16: If retrieval confidence is below a configurable threshold, return "not found" rather than guessing.

### 8.5 Auth and tenancy

- FR-17: Every request is authenticated and resolved to a tenant and role.
- FR-18: Tenant and visibility filters are applied inside the database query before retrieval, never only after.
- FR-19: Verify permissions of returned records again before responding.
- FR-20: Fail closed on any authorization failure or missing identity.
- FR-21: API credentials for Atlas, Voyage and the LLM stay server-side.

### 8.6 Evaluation harness

- FR-22: Corpus: a real document set ingested by the harness; no synthetic documents.
- FR-23: 100-200 labeled questions written from the real corpus, including exact-term queries, paraphrased queries, multilingual queries (if the corpus supports them) and cross-tenant adversarial queries.
- FR-24: Metrics: Recall@10, nDCG@10, grounded answer accuracy, p50 and p95 latency, index freshness, update/delete propagation time, cost per query and estimated monthly cost.
- FR-25: Compare configurations: vector only, hybrid, hybrid + rerank-3-lite, hybrid + rerank-3, and voyage-4-lite vs voyage-4 vs voyage-4-large.
- FR-26: Store every run (config, timestamp, metrics) and generate a results table/report from stored runs.

### 8.7 Observability and cost

- FR-27: Structured logs for each request: tenant, tool, latency, result count, errors.
- FR-28: Record tokens and cost from actual API responses; aggregate per tenant.
- FR-29: Monitor rate limits, index status, latency and spend; surface them in logs and get\_usage.

## 9. Data model (MongoDB)

Collections (names are suggestions):

- **tenants**: tenantId, name, apiKeyHash, roles, createdAt
- **documents**: documentId, tenantId, collectionId, title, source, version, visibility, status, checksum, createdAt, updatedAt
- **chunks**: chunkId, documentId, tenantId, collectionId, text, sectionPath, page, visibility, version, embedding (if externally generated), createdAt
- **usage**: tenantId, tool, tokens, estimatedCost, timestamp
- **eval\_runs**: runId, config, metrics, timestamp
- **eval\_questions**: questionId, question, expectedChunkIds/documentIds, type (exact, paraphrase, multilingual, adversarial)

Indexes: an Atlas vector index on chunk text (automated embedding) or embedding field, with filter fields tenantId, collectionId, visibility, version; an Atlas Search (lexical) index for hybrid retrieval. Store API keys only as hashes.

## 10. Non-functional requirements

- Security: zero cross-tenant exposure in tests; no secrets in the repository; prompt-injection resistant context handling.
- Performance: record p50/p95; target thresholds to be agreed with the mentor after the first baseline run.
- Reliability: retries with backoff on Voyage/Atlas/LLM rate limits; clear errors; no silent failures.
- Freshness: documented stale-index window; tests for update and delete propagation.
- Maintainability: typed code, linting, README, environment-variable template, architecture diagram.
- Cost: cost per query visible; reranking selectable because it can cost far more than query embedding.

## 11. Configuration (environment variables)

MONGODB\_URI, MONGODB\_DB, VOYAGE\_API\_KEY, OPENROUTER\_API\_KEY, LLM\_MODEL, EMBEDDING\_MODEL, RERANK\_MODEL, DEFAULT\_TOP\_K, RERANK\_CANDIDATES, CONFIDENCE\_THRESHOLD, CHUNK\_SIZE, CHUNK\_OVERLAP. Provide a .env.example with names only, never values.

## 12. Milestones and acceptance criteria

Each milestone must work end to end on real services before the next begins.

| # | Milestone | Acceptance criteria |
| --- | --- | --- |
| 1 | Foundation | Atlas cluster and Voyage key configured; one real document ingested and retrievable by semantic query |
| 2 | Chunking and index | Real corpus chunked with metadata; vector index with filters working |
| 3 | Hybrid + rerank | Hybrid search and switchable Voyage reranking return correct results for exact and semantic queries |
| 4 | MCP and security | MCP tools work from a real MCP client; the backend API exposes the same shared core; tenant isolation proven by real cross-tenant adversarial tests with zero leakage |
| 5 | Answers | Grounded answers with citations; "not found" behaviour verified |
| 6 | Evaluation | Harness runs 100+ labeled questions and stores metrics; configuration comparison table generated from stored runs |
| 7 | Lifecycle and cost | Update/delete propagation verified; usage and cost tracked from real responses; frontend pages for chat, ingestion, evaluation and usage working against the real backend |
| 8 | Release | README, architecture diagram, deployment (MCP server on NitroCloud; frontend and backend on Vercel or Cloudflare), and a recorded walkthrough of the real running system |

Suggested decision gates (from the research brief): zero cross-tenant exposure; grounded accuracy and retrieval quality above agreed targets; acceptable p95 latency and cost versus a baseline.

## 13. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Index updates are asynchronous | Expose status; test freshness; never assume instant visibility |
| Stale or undeleted content returned | Deletion-propagation tests; re-check permissions on results |
| Prompt injection from retrieved text | Treat context as untrusted; strict prompt structure; no tool execution from retrieved text |
| Reranking cost and latency | Per-query toggle; evaluate selective reranking |
| Free-tier limits (research brief: 200M free tokens per automated embedding model per organization, one-time); free OpenRouter models may be rate-limited or withdrawn | Track usage from the start; plan paid usage if needed; keep the LLM model name configurable so it can be swapped |
| Corpus licensing | Corpus is docs.nitrostack.com, chosen by the mentor; crawl politely and respect the site's terms |
| Platform dependency on MongoDB/Voyage | Keep a thin storage interface; support externally generated embeddings |

## 14. Decisions and open questions

1. Corpus: docs.nitrostack.com (decided by the mentor).
2. Accounts: own MongoDB Atlas and Voyage AI accounts on free tiers; keys stay secure and server-side.
3. LLM: own OpenRouter key with NVIDIA Nemotron (Nemotron 3 Ultra or Nemotron 3.5 Lightning) or free models such as Google Gemma 4 31B and ERNIE 5.5 Flash Preview; choose by requirements and availability.
4. Deployment: MCP server on NitroCloud; frontend and backend on Vercel or Cloudflare.
5. What quality, latency and cost targets define success?

## 15. Instructions for the Antigravity agent

1. Read this PRD fully before writing code. Work milestone by milestone; do not start the next until the current acceptance criteria pass on real services.
2. Follow the NO MOCKS rule in section 2 without exception. If something real is unavailable, stop and ask.
3. Before using NitroStack, Atlas or Voyage APIs, consult their current official documentation rather than relying on memory, because APIs and model names change.
4. Keep secrets in environment variables; commit only .env.example.
5. Write tests for chunking, filter building and authorization logic, plus integration and security tests against real services.
6. Commit in small steps with clear messages, and keep the README updated as features land.
7. At the end of each milestone, report what works, what was measured, what failed, and what is next.

## 16. Frontend and backend scope

The mentor asked for the MCP server, frontend and backend all to be deployed, so the product has three real surfaces on one shared core.

**Backend API (TypeScript).** A REST API that wraps the same core logic as the MCP tools. It handles authentication, search, answers, ingestion, usage and evaluation results. It must not duplicate retrieval logic; it imports the shared core package.

**Frontend (Next.js with TypeScript).** Pages, all talking to the real backend:

| Page | What it does |
| --- | --- |
| Chat | Ask a question; shows the cited answer, the source passages, latency and token cost; toggles for vector/hybrid mode and reranking; model selector from the configured OpenRouter models |
| Search | Raw ranked results with scores and source links, for inspecting retrieval quality |
| Collections and ingestion | Start a crawl or upload a file; shows indexing status per document; delete a document |
| Evaluation | Table of stored evaluation runs and configuration comparison, read from the database |
| Usage | Tokens and estimated spend per tenant, read from recorded API responses |

No page may show hardcoded data. Empty states are allowed; fake rows are not.

## 17. Deployment architecture

| Component | Host | Notes |
| --- | --- | --- |
| MCP server (NitroStack) | NitroCloud | Exposes the MCP tools; imports the shared core |
| Backend API | Vercel or Cloudflare | Short-lived request/response work only: search, answer, status, usage |
| Frontend | Vercel or Cloudflare | Calls the backend over HTTPS with configured CORS |
| Ingestion and evaluation jobs | Separate script or scheduled job (local machine, CI or a scheduler) | Crawling and embedding the whole docs site can exceed serverless time limits, so keep it out of request handlers |
| Database | MongoDB Atlas (free tier) | Chunks, metadata, usage, evaluation data, vector and search indexes |
| Embeddings and reranking | Voyage AI API | Own account on the free tier |
| Answer LLM | OpenRouter API | Own key; Nemotron or free alternatives; model name set in configuration |

Deployment rules for the agent:

1. Store every secret as a platform environment variable on NitroCloud, Vercel or Cloudflare. Never commit secrets and never expose them to the browser.
2. Before choosing Vercel or Cloudflare for the backend, check that the MongoDB driver and the required Node APIs work on that platform and within its time limits. If Cloudflare Workers cannot run the driver reliably, use Vercel for the backend.
3. The frontend never calls Atlas, Voyage or OpenRouter directly. All of those calls go through the backend or the MCP server.
4. Each deployed surface exposes a health endpoint that checks its real dependencies.
5. Record the deployed URLs in the README.

## 18. Repository structure and API surface

Suggested monorepo layout (adjust to NitroStack conventions):

| Path | Contents |
| --- | --- |
| packages/core | Ingestion, chunking, retrieval, reranking, auth, answer layer, usage tracking |
| apps/mcp-server | NitroStack MCP server using packages/core |
| apps/api | Backend REST API using packages/core |
| apps/web | Frontend |
| scripts/ingest | Crawler and ingestion job for docs.nitrostack.com |
| eval | Labeled questions, harness, stored run reports |

Backend endpoints (all authenticated, all returning structured errors):

| Endpoint | Purpose |
| --- | --- |
| POST /api/search | Ranked authorized chunks with sources and scores |
| POST /api/answer | Grounded answer with citations, or "not found" |
| GET /api/collections | Collections the caller may access, with stats |
| POST /api/ingest | Add or update a document |
| DELETE /api/documents/:id | Delete a document and its chunks |
| GET /api/documents/:id/status | Indexing status |
| GET /api/usage | Tokens and estimated cost |
| GET /api/eval/runs | Stored evaluation runs |
| GET /api/health | Real dependency checks |

## 19. Corpus and ingestion plan (docs.nitrostack.com)

1. Crawl docs.nitrostack.com page by page, respecting the site's terms and robots rules, with polite request rates.
2. Store each page's URL as the source reference, and keep the heading path as the section path so citations can link to the right place.
3. Chunk by heading structure first, then by size and overlap; keep code blocks intact where possible.
4. Compute a checksum per page so re-crawls update only changed pages and never create duplicates.
5. Schedule re-crawls to detect updated and removed pages, and verify that removed pages disappear from retrieval.
6. For tenant-isolation tests, a second tenant needs real data too. Ingest a different real document set, such as another openly licensed documentation site or the project's own real README files, into a separate tenant, and write adversarial questions that target it from the first tenant's credentials. Do not invent documents.
7. Write the 100-200 evaluation questions from the real crawled pages, recording the expected source page for each.

## 20. Definition of done

- All eight milestones pass their acceptance criteria on real services.
- The MCP server, backend and frontend are deployed on the agreed hosts and their health endpoints pass.
- Cross-tenant tests show zero leakage.
- A stored evaluation report compares vector, hybrid and hybrid + rerank, with real metrics, latency and cost.
- The README documents setup, environment variables (names only), architecture, deployed URLs and known limits.
- A recorded walkthrough shows the real deployed system answering questions about docs.nitrostack.com with citations.
