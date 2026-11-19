# forge-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/agungseptiana60-cpu/forge-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/agungseptiana60-cpu/forge-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one process and one file: git smart HTTP (protocol v0 and v2), the REST v3 surface, GraphQL v4 and an MCP endpoint, all reading and writing a single in-memory store of real SHA-1 git objects — so a file written through the contents API is the blob a clone fetches, and a pull request opened over GraphQL is the record REST merges. No dependencies, nothing to install.

What it covers:

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

Requests authenticate with `Authorization: Bearer <token>`, the token being the
one in the process's `MAKEFUN_SHOP_TOKEN`. State is deterministic: ids and
timestamps come from counters over a fixed epoch, never from a wall clock.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or newer. `main.ts` is the harness lifecycle: it binds an ephemeral
port, registers it with the env named by `MAKEFUN_ENV_URL`, and serves until the
env says the trial is done. `app.ts` builds the HTTP server (`createApp()`),
which is also all you need to embed or test the forge on its own.

## Layout

- `main.ts` — entry ↔ env lifecycle (register, poll, exit).
- `app.ts` — the forge itself: object store, repositories, and the four
  protocol surfaces.

MIT licensed.

---

Entered on [make.fun](https://make.fun/?ref=h7q3m07p&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
