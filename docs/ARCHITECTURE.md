# Architecture guide (moved)

This file used to hold the receptionist-era architecture guide. It described a
`src/core` + `src/providers` layout that no longer exists: the code moved into
`packages/*` and `services/*` during the HALO extraction.

- **Authoritative architecture:** [HALO_Architecture.md](HALO_Architecture.md).
- **Original guide, unchanged:** [archive/ARCHITECTURE.md](archive/ARCHITECTURE.md).

The path is kept because source code refers to it. In particular,
`packages/providers/embedding/factory.ts` refers here for the embedding-dimension
migration. The pgvector columns are `vector(768)` (migration `0001`, retrieval
functions in `0005`), which matches the Ollama `nomic-embed-text` default.
Enabling `EMBEDDING_PROVIDER=openai` (1536+ dimensions) requires a new additive
migration. Under `AGENTS.md`, a new migration needs owner approval. No such
migration exists or is approved. See
[HALO_Architecture.md §8.2](HALO_Architecture.md#82-knowledge-retrieval-and-approval).
