# Forge — a GitHub-compatible git forge in one process

A single-file, dependency-free implementation of the GitHub surface a development
workflow actually touches:

- **Git smart HTTP** — `info/refs`, `git-upload-pack` and `git-receive-pack` for
  `/{owner}/{repo}.git`, speaking both protocol v0 and protocol v2 (`ls-refs`,
  `fetch` with shallow/deepen negotiation, sideband-64k report-status on push,
  fast-forward enforcement).
- **REST v3** — repositories, labels, issues and comments, pull requests with
  squash merges and conflict detection, branches, refs, commits and the contents
  API, all under `/api/v3` with GitHub-shaped JSON and error bodies.
- **GraphQL v4** — `POST /api/graphql` with queries, mutations, connections with
  cursor pagination, batched operations and introspection for the types the
  surface exposes.
- **MCP** — `POST /mcp`, a JSON-RPC endpoint whose tools (`create_repo`,
  `get_repo`, `list_issues`, `create_issue`, `create_pull_request`,
  `merge_pull_request`, …) operate on the same records as the other surfaces.

Everything is one in-memory store: git objects are real SHA-1 objects shared by
every surface, so a file written through the contents API is the blob a clone
fetches, and a pull request opened over GraphQL is the record REST merges.

## Running

Node 22.18 or newer, no dependencies, nothing to install:

```
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, registers it
with the env named by `MAKEFUN_ENV_URL`, and serves until the env says the
trial is done. `app.ts` builds the HTTP server (`createApp()`), which is also
all you need to embed or test the forge on its own.

Requests authenticate with `Authorization: Bearer <token>`, the token being the
one in the process's `MAKEFUN_SHOP_TOKEN`. State is deterministic: ids and
timestamps come from counters over a fixed epoch, never from a wall clock.

## Layout

- `main.ts` — entry ↔ env lifecycle (register, poll, exit).
- `app.ts` — the forge itself: object store, repositories, and the four
  protocol surfaces.

MIT licensed.
