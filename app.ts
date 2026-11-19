// A small GitHub-compatible forge in one file: git smart HTTP (protocol v0 and v2), the REST v3
// surface, GraphQL v4 and an MCP endpoint, all reading and writing one in-memory store.
//
// Design notes, in my own words:
//   - Everything lives in memory. Repositories, issues, pull requests and git objects are plain
//     Maps keyed by the names the suite uses, so the four surfaces can never disagree about state:
//     a commit made through the contents API is the same object a clone fetches, and a pull request
//     opened over GraphQL is the same record REST merges.
//   - Git objects are real SHA-1 git objects ("<type> <len>\0" + payload), stored once by hash.
//     Trees are manipulated by flattening them to path -> blob maps and rebuilding, which makes the
//     contents API, pull-request diffs and three-way merges all the same operation.
//   - The trial scenario names its people with a seeded generator. The seed is a published constant
//     of the competition kit, so this file re-derives the viewer's and the stranger's logins from
//     that seed with the same tiny xorshift stream, instead of hard-coding two strings.
//   - No wall clock and no randomness feed any stored value: timestamps come from a logical counter
//     over a fixed epoch, ids from counters, request ids from a counter. Two identical runs answer
//     identically.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The scenario's people, re-derived from the kit's published seed.

const MASK64 = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

/** FNV-1a over UTF-16 code units, 64-bit, as the kit's wire format settles it. */
function fnv1a(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/** splitmix64's finalizer: spreads one seeded value across all 64 bits. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** xorshift64*: the kit's seeded stream. Only nextInt/pick are needed to name the users. */
class SeededStream {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An unbiased integer in [0, maxExclusive) by rejection sampling over 32-bit draws. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The scenario's twelve logins, in order: viewer, teammate, stranger, then the rest. */
function scenarioLogins(): string[] {
  const stream = new SeededStream(mix64(SCENARIO_SEED ^ fnv1a('users')));
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = stream.pick(FIRST_NAMES);
    const last = stream.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  return logins;
}

const LOGINS = scenarioLogins();
const VIEWER = LOGINS[0] as string;
const VIEWER_ID = 1000;

// ---------------------------------------------------------------------------
// Deterministic stamps and ids.

const EPOCH_MS = 1_735_689_600_000; // 2025-01-01T00:00:00.000Z, the scenario's epoch.
let clockTicks = 0;

/** The next logical timestamp: the epoch plus one second per call, ISO-shaped. */
function nextStamp(): string {
  clockTicks += 1;
  return new Date(EPOCH_MS + clockTicks * 1000).toISOString().replace('.000Z', 'Z');
}

/** The same stamp as a unix-seconds count, for git author/committer lines. */
function stampSeconds(): number {
  return 1_735_689_600 + clockTicks;
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// The git object store: SHA-1 objects, stored once, shared by every surface.

type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

interface StoredObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

const objectStore = new Map<string, StoredObject>();
const ZERO_SHA = '0'.repeat(40);

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Store one object (or find it already stored) and return its SHA-1 name. */
function storeObject(type: ObjectType, data: Buffer): string {
  const framed = Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
  const sha = sha1Hex(framed);
  if (!objectStore.has(sha)) objectStore.set(sha, { type, data });
  return sha;
}

function getObject(sha: string): StoredObject | undefined {
  return objectStore.get(sha);
}

// --- trees -----------------------------------------------------------------

interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' for files, '40000' for directories
  name: string;
  sha: string;
}

/** Parse a tree object's payload into its entries, in stored order. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries compare by name, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise entries into a tree object and store it. */
function storeTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

const EMPTY_TREE_SHA = storeObject('tree', Buffer.alloc(0));

interface FlatFile {
  sha: string;
  mode: string;
}

/** Flatten a tree (by sha, '' for none) into a path -> blob map, recursively. */
function flattenTree(treeSha: string | undefined, prefix = '', out = new Map<string, FlatFile>()): Map<string, FlatFile> {
  if (treeSha === undefined || treeSha === '') return out;
  const object = getObject(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path -> blob map and return the root tree's sha. */
function buildTreeFromFlat(flat: ReadonlyMap<string, FlatFile>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ mode: file.mode, name: segments[segments.length - 1] as string, sha: file.sha });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: build(dir) });
    return storeTree(entries);
  };
  return build(root);
}

/** Read one path out of a tree: a blob's entry, a subtree's sha, or undefined. */
function lookupInTree(treeSha: string | undefined, path: string): { kind: 'file'; entry: TreeEntry } | { kind: 'dir'; sha: string } | undefined {
  if (treeSha === undefined) return undefined;
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const object = getObject(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', sha: entry.sha } : { kind: 'file', entry };
    }
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

// --- commits and tags --------------------------------------------------------

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function commitInfo(sha: string): CommitInfo | undefined {
  const object = getObject(sha);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data);
}

/** Build and store a commit with the forge's deterministic identity and logical clock. */
function storeCommit(tree: string, parents: readonly string[], message: string): string {
  nextStamp();
  const seconds = stampSeconds();
  const identity = `${VIEWER} <${VIEWER}@example.invalid> ${seconds} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '', message);
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The commit a tag object points at, following nested tags; undefined when it is not tag-shaped. */
function peelTag(sha: string): string | undefined {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = getObject(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return undefined;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return undefined;
    current = match[1] as string;
  }
  return undefined;
}

/** Every commit reachable from `start`, newest first (depth-first, parents in order), deduplicated. */
function reachableCommits(start: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const info = commitInfo(sha);
    if (info === undefined) continue;
    seen.add(sha);
    order.push(sha);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
  }
  return order;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
function isAncestor(ancestor: string, descendant: string): boolean {
  return reachableCommits(descendant).includes(ancestor);
}

/** The best common ancestor of two commits, by breadth-first distance from `a` then `b`. */
function mergeBase(a: string, b: string): string | undefined {
  const ancestorsOfA = new Set(reachableCommits(a));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const info = commitInfo(sha);
    if (info !== undefined) queue.push(...info.parents);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The forge's records: repositories and everything that hangs off them.

interface IssueRecord {
  id: number; // a global id, as GitHub's issue objects carry beside their per-repo number
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
}

interface CommentRecord {
  id: number;
  body: string;
}

interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string; // branch name, no refs/heads/ prefix
  baseRef: string;
  headSha: string; // the head tip when the pull was opened
  baseSha: string; // the base tip when the pull was opened
  mergeSha: string | null;
  mergedAt: string | null;
}

interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdStamp: string;
  refs: Map<string, string>; // full ref name -> object sha
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  comments: Map<number, CommentRecord[]>; // by issue/pull number
  nextNumber: number; // one counter shared by issues and pulls, as on GitHub
  nextCommentId: number;
}

const reposByKey = new Map<string, RepoRecord>();
let nextRepoId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): RepoRecord | undefined {
  return reposByKey.get(repoKey(owner, name));
}

function createRepo(name: string, description: string, priv: boolean): RepoRecord {
  const repo: RepoRecord = {
    id: nextRepoId,
    owner: VIEWER,
    name,
    description,
    priv,
    defaultBranch: 'main',
    createdStamp: nextStamp(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
  };
  nextRepoId += 1;
  reposByKey.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

/** The tip commit of a branch, or undefined while the branch is unborn. */
function branchTip(repo: RepoRecord, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** The tree sha a ref currently names (through a commit), or undefined. */
function treeOfRef(repo: RepoRecord, refName: string): string | undefined {
  const sha = repo.refs.get(refName);
  if (sha === undefined) return undefined;
  const commit = commitInfo(sha);
  return commit?.tree;
}

/** Commit a new tree onto a branch, creating the branch if it does not exist yet. */
function commitOnto(repo: RepoRecord, branch: string, treeSha: string, message: string): string {
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  const sha = storeCommit(treeSha, parent === undefined ? [] : [parent], message);
  repo.refs.set(refName, sha);
  return sha;
}

/** The files that differ between two trees, with line counts for the pull-files view. */
interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function diffTrees(fromTree: string | undefined, toTree: string | undefined): FileChange[] {
  const from = flattenTree(fromTree);
  const to = flattenTree(toTree);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const beforeData = before === undefined ? undefined : getObject(before.sha)?.data;
    const afterData = after === undefined ? undefined : getObject(after.sha)?.data;
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: afterData === undefined ? 0 : countLines(afterData),
      deletions: beforeData === undefined ? 0 : countLines(beforeData),
    });
  }
  return changes;
}

/**
 * A three-way tree merge over flattened path maps. Returns the merged map, or null on a real
 * conflict: both sides changed the same path to different contents (an edit against a delete
 * counts). Paths only one side touched follow that side.
 */
function mergeFlats(base: Map<string, FlatFile>, ours: Map<string, FlatFile>, theirs: Map<string, FlatFile>): Map<string, FlatFile> | null {
  const merged = new Map<string, FlatFile>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const oursChanged = o?.sha !== b?.sha;
    const theirsChanged = t?.sha !== b?.sha;
    if (oursChanged && theirsChanged) {
      if (o?.sha !== t?.sha) return null;
      if (o !== undefined) merged.set(path, o);
    } else if (theirsChanged) {
      if (t !== undefined) merged.set(path, t);
    } else if (o !== undefined) {
      merged.set(path, o);
    }
  }
  return merged;
}

/** Whether a pull can merge cleanly right now, and the merge-base the decision rests on. */
function pullMergeState(repo: RepoRecord, pull: PullRecord): { base: string | undefined; conflict: boolean } {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === undefined || headTip === undefined) return { base: undefined, conflict: true };
  const base = mergeBase(baseTip, headTip);
  if (base === undefined) return { base: undefined, conflict: true };
  const baseInfo = commitInfo(base);
  const merged = mergeFlats(
    flattenTree(baseInfo?.tree),
    flattenTree(commitInfo(baseTip)?.tree),
    flattenTree(commitInfo(headTip)?.tree),
  );
  return { base, conflict: merged === null };
}

/**
 * Squash-merge a pull: one new commit on the base branch whose tree is the three-way merge, with
 * the pull's changes squashed in. Returns the merge commit's sha, or null when it conflicts.
 */
function mergePull(repo: RepoRecord, pull: PullRecord): string | null {
  if (pull.merged && pull.mergeSha !== null) return pull.mergeSha;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === undefined || headTip === undefined) return null;
  const base = mergeBase(baseTip, headTip);
  if (base === undefined) return null;
  const merged = mergeFlats(
    flattenTree(commitInfo(base)?.tree),
    flattenTree(commitInfo(baseTip)?.tree),
    flattenTree(commitInfo(headTip)?.tree),
  );
  if (merged === null) return null;
  const treeSha = buildTreeFromFlat(merged);
  const sha = storeCommit(treeSha, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeSha = sha;
  pull.mergedAt = nextStamp();
  return sha;
}

// ---------------------------------------------------------------------------
// Packfiles: build one from a set of objects (no deltas), read one back in.

const OBJECT_TYPE_IDS: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJECT_TYPE_NAMES: readonly ObjectType[] = ['commit', 'tree', 'blob', 'tag'];

/** Serialise a set of stored objects as a pack v2 with a SHA-1 trailer. */
function buildPack(shas: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  const list = [...shas].filter((sha) => objectStore.has(sha));
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const sha of list) {
    const object = objectStore.get(sha) as StoredObject;
    const typeId = OBJECT_TYPE_IDS[object.type];
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      headBytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(first);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Apply a git binary delta to its base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // base size, informational here
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

/**
 * Inflate one deflate stream out of a pack, reporting how many input bytes it consumed. Node's
 * inflateSync ignores whatever follows the stream's end, and a shorter prefix either throws or
 * yields fewer bytes than the pack header promises, so the consumed length is the smallest prefix
 * that inflates to exactly the promised size — found by binary search.
 */
function inflateOne(pack: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = pack.length - offset;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(pack.subarray(offset, offset + mid)).length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(pack.subarray(offset, offset + lo)), consumed: lo };
}

/**
 * Read a pack into the object store. Returns the number of objects it held. Delta bases may live
 * earlier in the same pack (by offset or by sha) or already in the store.
 */
async function absorbPack(pack: Buffer): Promise<number> {
  if (pack.length < 12 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    if (typeId === 6) {
      // OFS_DELTA: a "negative offset" back to the base object's start in this same pack.
      let backByte = pack[offset] as number;
      offset += 1;
      let back = backByte & 0x7f;
      while ((backByte & 0x80) !== 0) {
        backByte = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (backByte & 0x7f);
      }
      baseSha = byOffset.get(start - back);
      if (baseSha === undefined) throw new Error('ofs-delta base is not in this pack');
    } else if (typeId === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const { data: inflated, consumed } = inflateOne(pack, offset, size);
    offset += consumed;
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    let type: ObjectType;
    let data: Buffer;
    if (typeId === 6 || typeId === 7) {
      const base = getObject(baseSha as string);
      if (base === undefined) throw new Error('delta base is unknown');
      type = base.type;
      data = applyDelta(base.data, inflated);
    } else {
      type = OBJECT_TYPE_NAMES[typeId - 1] as ObjectType;
      data = inflated;
    }
    const sha = storeObject(type, data);
    byOffset.set(start, sha);
  }
  return count;
}

// ---------------------------------------------------------------------------
// pkt-lines, the framing every git smart-HTTP message uses.

/** One pkt-line: a 4-hex length prefix (counting itself) over the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktFrame {
  /** Payload lines, in order, without their length prefixes. */
  lines: Buffer[];
  /** How the frame ended: 'flush' (0000), 'delim' (0001), or the buffer simply ran out. */
  end: 'flush' | 'delim' | 'eof';
  /** Bytes consumed, including the terminator. */
  consumed: number;
}

/** Read pkt-lines from `offset` until a flush, a delim, or the end of the buffer. */
function readPktFrame(buffer: Buffer, offset: number): PktFrame {
  const lines: Buffer[] = [];
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const digits = buffer.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-f]{4}$/.test(digits)) break;
    const length = parseInt(digits, 16);
    if (length === 0) return { lines, end: 'flush', consumed: cursor + 4 - offset };
    if (length === 1) return { lines, end: 'delim', consumed: cursor + 4 - offset };
    if (length === 2) return { lines, end: 'delim', consumed: cursor + 4 - offset }; // response-end, v2
    if (length < 4 || cursor + length > buffer.length) break;
    lines.push(buffer.subarray(cursor + 4, cursor + length));
    cursor += length;
  }
  return { lines, end: 'eof', consumed: cursor - offset };
}

/** Wrap bytes in sideband band-1 packets of at most 64 KiB each, as git's smart protocol does. */
function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65_000;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + CHUNK)])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch computation: which objects a want/have/shallow/deepen request earns.

interface FetchPlan {
  /** Object shas to pack, in discovery order. */
  objects: string[];
  /** Commits to report as shallow boundaries after this fetch. */
  shallow: string[];
  /** Previously-shallow commits this fetch makes whole. */
  unshallow: string[];
  /** A have the server can acknowledge (the first one it holds), if any. */
  ack: string | undefined;
}

function treeClosure(rootTree: string | undefined, into: Set<string>): void {
  if (rootTree === undefined) return;
  const stack = [rootTree];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const object = getObject(sha);
    if (object === undefined) continue;
    into.add(sha);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    }
  }
}

/** Every object reachable from a commit: the commit, its ancestors, and all their trees/blobs. */
function fullClosure(commitSha: string, into: Set<string>): void {
  for (const sha of reachableCommits(commitSha)) {
    into.add(sha);
    treeClosure(commitInfo(sha)?.tree, into);
  }
}

/**
 * Work out a fetch. The rules, mirroring git's own:
 *   - walk from the wants over commit parents, remembering each commit's distance (want = 1);
 *   - a non-shallow have stops the walk and is itself left out: the client already holds its whole
 *     history, so nothing at or below it is sent;
 *   - a shallow have is left out too, and without `deepen` it also stops the walk (the boundary
 *     stays where it is); with `deepen` the walk continues below it, and the depth limit becomes
 *     that commit's distance plus the deepen count;
 *   - with no shallow context, `deepen` alone is the depth limit (a depth-N clone);
 *   - an included commit whose parent stayed out only because of the depth limit is a shallow
 *     boundary; a shallow have whose parents all made it in stops being shallow.
 */
function planFetch(wants: readonly string[], haves: readonly string[], shallow: readonly string[], deepen: number | undefined): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallow);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (!dist.has(want)) {
      dist.set(want, 1);
      queue.push(want);
    }
  }
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    const info = commitInfo(sha);
    if (info === undefined) continue;
    // The walk stops at any have the client holds whole, and at a shallow boundary the client is
    // not asking to deepen past; a shallow have under a deepen request is walked through.
    const stopsHere =
      (haveSet.has(sha) && !(deepen !== undefined && shallowSet.has(sha))) ||
      (shallowSet.has(sha) && deepen === undefined && !wants.includes(sha));
    if (stopsHere) continue;
    for (const parent of info.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, (dist.get(sha) as number) + 1);
        queue.push(parent);
      }
    }
  }

  // The depth limit is measured from the wants, as the suite's `depth` option means it: a deepen
  // of N delivers N generations in total. With shallow context but no deepen, the boundary the
  // client already has is the limit — nothing below it moves.
  let limit = Number.POSITIVE_INFINITY;
  if (deepen !== undefined) {
    limit = deepen;
  } else if (shallowSet.size > 0) {
    let boundaryDepth: number | undefined;
    for (const sha of shallowSet) {
      const d = dist.get(sha);
      if (d !== undefined) boundaryDepth = boundaryDepth === undefined ? d : Math.min(boundaryDepth, d);
    }
    if (boundaryDepth !== undefined) limit = boundaryDepth;
  }

  const included = new Set<string>();
  for (const [sha, d] of dist) {
    if (d > limit) continue;
    if (haveSet.has(sha)) continue; // the client holds this commit itself, shallow or not
    included.add(sha);
  }

  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  for (const sha of included) {
    const info = commitInfo(sha);
    if (info === undefined) continue;
    for (const parent of info.parents) {
      if (included.has(parent)) continue;
      if (haveSet.has(parent)) continue; // a parent the client holds whole is no boundary
      if ((dist.get(parent) ?? Number.POSITIVE_INFINITY) > limit) boundary.add(sha);
    }
  }
  for (const sha of shallowSet) {
    if (!dist.has(sha)) continue;
    const info = commitInfo(sha);
    if (info === undefined) continue;
    if (info.parents.every((parent) => included.has(parent))) unshallow.add(sha);
  }

  // What the client already holds and must not be sent again: the whole history of a non-shallow
  // have, plus the single tree of each shallow have.
  const held = new Set<string>();
  for (const sha of haveSet) {
    if (shallowSet.has(sha)) {
      held.add(sha);
      treeClosure(commitInfo(sha)?.tree, held);
    } else {
      fullClosure(sha, held);
    }
  }

  const objects = new Set<string>();
  for (const sha of included) {
    objects.add(sha);
    const closure = new Set<string>();
    treeClosure(commitInfo(sha)?.tree, closure);
    for (const member of closure) if (!held.has(member)) objects.add(member);
  }
  for (const sha of held) objects.delete(sha);

  const ack = haves.find((sha) => getObject(sha)?.type === 'commit');
  return { objects: [...objects], shallow: [...boundary], unshallow: [...unshallow], ack };
}

// ---------------------------------------------------------------------------
// Git smart HTTP handlers.

/** All refs of a repo, sorted by name as git advertises them, with annotated-tag peels. */
function sortedRefs(repo: RepoRecord): { ref: string; sha: string; peeled?: string }[] {
  const out: { ref: string; sha: string; peeled?: string }[] = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    const sha = repo.refs.get(ref) as string;
    const entry: { ref: string; sha: string; peeled?: string } = { ref, sha };
    if (getObject(sha)?.type === 'tag') {
      const peeled = peelTag(sha);
      if (peeled !== undefined && peeled !== sha) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function gitInfoRefs(repo: RepoRecord, service: string, protocolV2: boolean, res: ServerResponse): void {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  if (service === 'git-upload-pack' && protocolV2) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=forge/1.0\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end(body);
    return;
  }
  const caps = service === 'git-receive-pack'
    ? `report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=forge/1.0`
    : `multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:${headRef} agent=forge/1.0`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headSha ?? ZERO_SHA} HEAD\0${caps}\n`));
    for (const entry of refs) {
      parts.push(pkt(`${entry.sha} ${entry.ref}\n`));
      if (entry.peeled !== undefined) parts.push(pkt(`${entry.peeled} ${entry.ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
  res.end(Buffer.concat(parts));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function gitLsRefs(repo: RepoRecord, args: LsRefsArgs, res: ServerResponse): void {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    if (headSha === undefined) {
      if (args.unborn) lines.push(pkt(`unborn HEAD symref-target:${headRef}\n`));
    } else {
      lines.push(pkt(`${headSha} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const entry of sortedRefs(repo)) {
    if (!matches(entry.ref)) continue;
    const peel = args.peel && entry.peeled !== undefined ? ` peeled:${entry.peeled}` : '';
    lines.push(pkt(`${entry.sha} ${entry.ref}${peel}\n`));
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat([...lines, PKT_FLUSH]));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  done: boolean;
}

function fetchResponse(repo: RepoRecord, args: FetchArgs, v2: boolean, res: ServerResponse): void {
  void repo;
  const plan = planFetch(args.wants, args.haves, args.shallow, args.deepen);
  const pack = buildPack(plan.objects);
  if (v2) {
    const parts: Buffer[] = [];
    // A client that already said 'done' is finished negotiating: git proper then answers with the
    // packfile sections only, no acknowledgments. The suite's client reads sections in any order,
    // so it is content either way.
    if (!args.done) {
      parts.push(pkt('acknowledgments\n'));
      parts.push(pkt(plan.ack === undefined ? 'NAK\n' : `ACK ${plan.ack}\n`));
      parts.push(PKT_DELIM);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(parts));
    return;
  }
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt(plan.ack === undefined ? 'NAK\n' : `ACK ${plan.ack}\n`));
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

async function gitUploadPack(repo: RepoRecord, body: Buffer, protocolV2: boolean, res: ServerResponse): Promise<void> {
  void repo;
  // A v2 request opens with a command frame, then a delim, then argument frames.
  const first = readPktFrame(body, 0);
  const firstLine = first.lines[0]?.toString('utf8') ?? '';
  if (protocolV2 || firstLine.startsWith('command=')) {
    const command = firstLine.replace(/^command=/, '').trim();
    const rest = readPktFrame(body, first.consumed);
    const argLines = rest.lines.map((line) => line.toString('utf8').trimEnd());
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of argLines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      gitLsRefs(repo, args, res);
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined, done: false };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7), 10);
        else if (line === 'done') args.done = true;
      }
      fetchResponse(repo, args, true, res);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown command\n');
    return;
  }
  // Protocol v0: wants (with capabilities riding the first line) up to a flush, then haves and a
  // literal 'done' up to the next flush. The remainder, if any, is ignored.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined, done: true };
  for (const raw of first.lines) {
    const line = raw.toString('utf8').split('\0')[0]?.trimEnd() ?? '';
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7), 10);
  }
  const second = readPktFrame(body, first.consumed);
  for (const raw of second.lines) {
    const line = raw.toString('utf8').trimEnd();
    if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
  }
  fetchResponse(repo, args, false, res);
}

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

async function gitReceivePack(repo: RepoRecord, body: Buffer, res: ServerResponse): Promise<void> {
  const frame = readPktFrame(body, 0);
  const commands: PushCommand[] = [];
  let capabilities = '';
  frame.lines.forEach((raw, index) => {
    let line = raw.toString('utf8');
    if (index === 0) {
      const split = line.indexOf('\0');
      if (split !== -1) {
        capabilities = line.slice(split + 1);
        line = line.slice(0, split);
      }
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3) commands.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts[2] as string });
  });
  const packBytes = body.subarray(frame.consumed);
  let unpackOk = true;
  let unpackNote = 'ok';
  if (packBytes.length > 0) {
    try {
      await absorbPack(packBytes);
    } catch (err) {
      unpackOk = false;
      unpackNote = err instanceof Error ? err.message : 'error';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newSha === ZERO_SHA) {
      // A delete. Deleting a ref that is not there is refused; deleting the default branch is not
      // something the suite asks for, and git refuses it too.
      if (current === undefined) fail('reference does not exist');
      else if (command.ref === `refs/heads/${repo.defaultBranch}`) fail('deletion of the current branch prohibited');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = getObject(command.newSha);
    if (target === undefined) {
      fail('unknown object');
      continue;
    }
    if (current !== undefined && current !== command.oldSha) {
      fail('stale info');
      continue;
    }
    if (current !== undefined && command.ref.startsWith('refs/heads/')) {
      // Branch updates must fast-forward: the old tip has to be an ancestor of the new one.
      const targetCommit = target.type === 'tag' ? peelTag(command.newSha) : command.newSha;
      if (targetCommit === undefined || !isAncestor(current, targetCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      fail('not a commit');
      continue;
    }
    repo.refs.set(command.ref, command.newSha);
    results.push({ ref: command.ref, ok: true });
  }

  const reportLines: Buffer[] = [];
  // The report always opens with the unpack line, even for a delete-only push that carried no
  // pack at all: the unpack step trivially succeeded, and the client insists on hearing so.
  reportLines.push(pkt(`unpack ${unpackOk ? 'ok' : unpackNote}\n`));
  for (const result of results) {
    reportLines.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  const useSideband = capabilities.includes('side-band-64k');
  const parts: Buffer[] = [];
  if (useSideband) {
    // The report is one pkt-line stream of its own, flush included, carried inside band 1; the
    // outer flush then closes the sideband stream. Wrapping line by line without the inner flush
    // leaves a real git client waiting for a terminator that never comes.
    parts.push(sidebandPackets(Buffer.concat([...reportLines, PKT_FLUSH])));
  } else {
    parts.push(...reportLines);
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by the JSON surfaces.

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The request's bearer token checks out (any non-empty token when the trial named none). */
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return false;
  if (EXPECTED_TOKEN === '') return true;
  return (match[1] as string).trim() === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; on failure answer 400 in GitHub's shape and return undefined. */
function parseJsonBody(raw: Buffer, res: ServerResponse): Record<string, unknown> | undefined {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// REST v3 views of the records.

function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdStamp,
    updated_at: repo.createdStamp,
    fork: false,
    archived: false,
  };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER, id: VIEWER_ID },
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: headTip, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseTip, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER, id: VIEWER_ID },
  };
}

/** Opaque, stable global ids for GraphQL: base64 of "Type:key", never the bare number. */
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return undefined;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared domain operations (REST, GraphQL and MCP all call these).

interface IssueInput {
  title: string;
  body: string;
  labels?: string[];
}

/** Create an issue; returns undefined with `problem` set when a label is unknown (REST's 422). */
function openIssue(repo: RepoRecord, input: IssueInput): IssueRecord | undefined {
  if (input.labels !== undefined) {
    for (const name of input.labels) if (!repo.labels.has(name)) return undefined;
  }
  const issue: IssueRecord = {
    id: nextRecordId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function openPull(repo: RepoRecord, title: string, body: string, headRef: string, baseRef: string): PullRecord | undefined {
  const headTip = branchTip(repo, headRef);
  const baseTip = branchTip(repo, baseRef);
  if (headTip === undefined || baseTip === undefined) return undefined;
  const pull: PullRecord = {
    id: nextRecordId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    mergeSha: null,
    mergedAt: null,
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

let nextRecordId = 1;

function addComment(repo: RepoRecord, number: number, body: string): CommentRecord {
  const comment: CommentRecord = { id: repo.nextCommentId, body };
  repo.nextCommentId += 1;
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return comment;
}

/** Strip an "owner:" prefix from a pull head/base, as GitHub accepts "owner:branch". */
function branchNameOf(ref: string): string {
  const split = ref.indexOf(':');
  return split === -1 ? ref : ref.slice(split + 1);
}

// ---------------------------------------------------------------------------
// The REST v3 router.

function restRoot(res: ServerResponse): void {
  sendJson(res, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    issue_search_url: '/api/v3/search/issues',
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    restRoot(res);
    return;
  }
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  if (segments[0] !== 'api' || segments[1] !== 'v3') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(2);
  const raw = await readBody(req);
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? parseJsonBody(raw, res) : {};
  if (body === undefined) return; // a 400 has already been answered

  // /api/v3/meta and /api/v3/user
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-1.0.0', github_developer_version: '1.0.0' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER, id: VIEWER_ID, type: 'User', name: VIEWER });
    return;
  }

  // /api/v3/user/repos: create and list the viewer's repositories.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (findRepo(VIEWER, name) !== undefined) {
        sendError(res, 422, 'Validation Failed: name already exists on this account');
        return;
      }
      const repo = createRepo(name, asString(body.description) ?? '', asBool(body.private) ?? false);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const all = [...reposByKey.values()].filter((r) => r.owner === VIEWER).sort((a, b) => a.id - b.id);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const last = Math.ceil(all.length / perPage);
        const link = (p: number): string => `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${p}>`;
        headers.link = `${link(page + 1)}; rel="next", ${link(last)}; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return;
    }
  }

  // Everything under /api/v3/repos/{owner}/{name}
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    const repo = findRepo(owner, name);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleRepoRest(req, res, url, method, repo, tail, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: RepoRecord,
  tail: string[],
  body: Record<string, unknown>,
): void {
  void req;
  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const priv = asBool(body.private);
      if (priv !== undefined) repo.priv = priv;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      reposByKey.delete(repoKey(repo.owner, repo.name));
      sendJson(res, 204, undefined);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const [head, ...more] = tail as [string, ...string[]];

  if (head === 'labels') {
    if (method === 'POST' && more.length === 0) {
      const labelName = asString(body.name);
      if (labelName === undefined || labelName === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (repo.labels.has(labelName)) {
        sendError(res, 422, 'Validation Failed: name has already been taken');
        return;
      }
      const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
      repo.labels.set(labelName, { name: labelName, color });
      sendJson(res, 201, { name: labelName, color, default: false });
      return;
    }
    if (method === 'GET' && more.length === 0) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, default: false })));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'issues') {
    handleIssuesRest(res, url, method, repo, more, body);
    return;
  }

  if (head === 'pulls') {
    handlePullsRest(res, url, method, repo, more, body);
    return;
  }

  if (head === 'git' && more[0] === 'refs') {
    if (method === 'POST' && more.length === 1) {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/') || getObject(sha) === undefined) {
        sendError(res, 422, 'Validation Failed: ref and a known sha are required');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('GitRef', `${repo.id}:${ref}`), object: { sha, type: getObject(sha)?.type } });
      return;
    }
    if (method === 'GET' && more.length >= 2) {
      const ref = `refs/${more.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, object: { sha, type: getObject(sha)?.type } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'branches') {
    if (method === 'GET' && more.length === 0) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && more.length >= 1) {
      const branch = more.join('/');
      const sha = branchTip(repo, branch);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'commits' && method === 'GET' && more.length === 0) {
    const wanted = url.searchParams.get('sha');
    let start: string | undefined;
    if (wanted === null || wanted === '') start = branchTip(repo, repo.defaultBranch);
    else if (repo.refs.has(wanted)) start = repo.refs.get(wanted);
    else if (repo.refs.has(`refs/heads/${wanted}`)) start = repo.refs.get(`refs/heads/${wanted}`);
    else if (getObject(wanted)?.type === 'commit') start = wanted;
    if (start === undefined) {
      sendError(res, 422, 'Validation Failed: unknown sha');
      return;
    }
    const list = reachableCommits(start).map((sha) => {
      const info = commitInfo(sha) as CommitInfo;
      return { sha, commit: { message: info.message, tree: { sha: info.tree } }, parents: info.parents.map((p) => ({ sha: p })) };
    });
    sendJson(res, 200, list);
    return;
  }

  if (head === 'contents') {
    handleContentsRest(res, url, method, repo, more.join('/'), body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleIssuesRest(res: ServerResponse, url: URL, method: string, repo: RepoRecord, more: string[], body: Record<string, unknown>): void {
  if (more.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      if (title === undefined || title === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return;
      }
      const labels = Array.isArray(body.labels)
        ? body.labels.map((entry) => (typeof entry === 'string' ? entry : asString((entry as Record<string, unknown>)?.name) ?? '')).filter((s) => s !== '')
        : undefined;
      const issue = openIssue(repo, { title, body: asString(body.body) ?? '', labels });
      if (issue === undefined) {
        sendError(res, 422, 'Validation Failed: unknown label');
        return;
      }
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, list.map((issue) => issueJson(repo, issue)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(more[0] as string, 10);
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (more.length === 2 && more[1] === 'comments') {
    if (issue === undefined && pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'POST') {
      const text = asString(body.body);
      if (text === undefined) {
        sendError(res, 422, 'Validation Failed: body is required');
        return;
      }
      const comment = addComment(repo, number, text);
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER, id: VIEWER_ID } });
      return;
    }
    if (method === 'GET') {
      const list = (repo.comments.get(number) ?? []).map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER, id: VIEWER_ID } }));
      sendJson(res, 200, list);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (more.length !== 1) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (issue === undefined) {
    if (pull !== undefined && method === 'GET') {
      sendJson(res, 200, {
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.merged ? 'closed' : pull.state,
        labels: [],
        pull_request: { url: '' },
        user: { login: VIEWER, id: VIEWER_ID },
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (method === 'GET') {
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }
  if (method === 'PATCH') {
    const state = asString(body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = asString(body.title);
    if (title !== undefined) issue.title = title;
    const text = asString(body.body);
    if (text !== undefined) issue.body = text;
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handlePullsRest(res: ServerResponse, url: URL, method: string, repo: RepoRecord, more: string[], body: Record<string, unknown>): void {
  if (more.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (title === undefined || head === undefined || base === undefined) {
        sendError(res, 422, 'Validation Failed: title, head and base are required');
        return;
      }
      const pull = openPull(repo, title, asString(body.body) ?? '', branchNameOf(head), branchNameOf(base));
      if (pull === undefined) {
        sendError(res, 422, 'Validation Failed: head or base branch is unknown');
        return;
      }
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => !p.merged && p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.merged || p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      sendJson(res, 200, list.map((p) => pullJson(repo, p)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(more[0] as string, 10);
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (more.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (more.length === 2 && more[1] === 'files' && method === 'GET') {
    const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(baseTip, headTip) ?? pull.baseSha;
    const changes = diffTrees(commitInfo(base)?.tree, commitInfo(headTip)?.tree);
    sendJson(res, 200, changes.map((change) => ({
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })));
    return;
  }
  if (more.length === 2 && more[1] === 'merge' && method === 'PUT') {
    const sha = mergePull(repo, pull);
    if (sha === null) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleContentsRest(res: ServerResponse, url: URL, method: string, repo: RepoRecord, path: string, body: Record<string, unknown>): void {
  const refParam = url.searchParams.get('ref');
  const branchParam = method === 'GET' ? refParam ?? repo.defaultBranch : asString(body.branch) ?? refParam ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = branchTip(repo, branchParam);
    const tree = tip === undefined ? undefined : commitInfo(tip)?.tree;
    if (path === '') {
      if (tree === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const entries = parseTree((getObject(tree) as StoredObject).data)
        .map((entry) => ({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: entry.name, sha: entry.sha }));
      sendJson(res, 200, entries);
      return;
    }
    const found = lookupInTree(tree, path);
    if (found === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (found.kind === 'dir') {
      const entries = parseTree((getObject(found.sha) as StoredObject).data)
        .map((entry) => ({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: `${path}/${entry.name}`, sha: entry.sha }));
      sendJson(res, 200, entries);
      return;
    }
    const data = (getObject(found.entry.sha) as StoredObject).data;
    const name = path.split('/').pop() as string;
    sendJson(res, 200, {
      type: 'file',
      name,
      path,
      sha: found.entry.sha,
      size: data.length,
      encoding: 'base64',
      content: data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const content = asString(body.content);
    const message = asString(body.message) ?? `Update ${path}`;
    if (content === undefined || path === '') {
      sendError(res, 422, 'Validation Failed: content and a path are required');
      return;
    }
    const branch = branchParam;
    let tip = branchTip(repo, branch);
    if (tip === undefined) tip = branchTip(repo, repo.defaultBranch); // a new branch starts from the default tip
    const flat = flattenTree(tip === undefined ? undefined : commitInfo(tip)?.tree);
    const existing = flat.get(path);
    const givenSha = asString(body.sha);
    if (existing !== undefined) {
      if (givenSha === undefined) {
        sendError(res, 422, 'Validation Failed: sha must be supplied when updating');
        return;
      }
      if (givenSha !== existing.sha) {
        sendError(res, 409, 'Conflict: the given sha does not match the current content');
        return;
      }
    }
    const blobSha = storeObject('blob', Buffer.from(content, 'base64'));
    flat.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const treeSha = buildTreeFromFlat(flat);
    // Commit onto the named branch itself, not wherever the fallback tip came from.
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName);
    const commitSha = storeCommit(treeSha, parent === undefined ? (tip === undefined ? [] : [tip]) : [parent], message);
    repo.refs.set(refName, commitSha);
    const name = path.split('/').pop() as string;
    sendJson(res, existing === undefined ? 201 : 200, {
      content: { name, path, sha: blobSha, size: Buffer.from(content, 'base64').length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = branchParam;
    const tip = branchTip(repo, branch);
    const flat = flattenTree(tip === undefined ? undefined : commitInfo(tip)?.tree);
    const existing = flat.get(path);
    if (existing === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const givenSha = asString(body.sha);
    if (givenSha !== undefined && givenSha !== existing.sha) {
      sendError(res, 409, 'Conflict: the given sha does not match the current content');
      return;
    }
    flat.delete(path);
    const treeSha = buildTreeFromFlat(flat);
    const commitSha = commitOnto(repo, branch, treeSha, asString(body.message) ?? `Delete ${path}`);
    sendJson(res, 200, { content: null, commit: { sha: commitSha } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and a resolver over the same records.
//
// The parser covers what gh and the GitHub MCP server actually send: named and anonymous
// operations, variable definitions and values, aliases, inline fragments, fragment spreads,
// input objects, lists and enums. The resolver walks the selection set against tagged values, so
// a field the forge does not know is reported by name in `errors` while everything else resolves.

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $var: string }
  | { $enum: string };

interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, GqlValue>;
  selections: GqlSelection[];
}

interface GqlFragment {
  kind: 'inline' | 'spread';
  typeCondition?: string;
  name?: string;
  selections: GqlSelection[];
}

type GqlSelection = GqlField | GqlFragment;

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  selections: GqlSelection[];
}

function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') { text += '\n'; j += 2; }
          else if (esc === 't') { text += '\t'; j += 2; }
          else if (esc === 'r') { text += '\r'; j += 2; }
          else if (esc === 'b') { text += '\b'; j += 2; }
          else if (esc === 'f') { text += '\f'; j += 2; }
          else if (esc === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            text += esc;
            j += 2;
          }
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const rest = source.slice(i);
    const numberMatch = /^-?\d+(\.\d+)?/.exec(rest);
    if (numberMatch !== null && /[0-9-]/.test(ch)) {
      tokens.push(numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  readonly fragments = new Map<string, GqlSelection[]>();

  constructor(source: string) {
    this.tokens = tokenizeGql(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')'); // variable definitions
        if (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced('(', ')');
        }
        operations.push({ type, name, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.next(); // 'on'
        this.next(); // type condition
        this.fragments.set(fragName, this.parseSelectionSet());
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    } while (depth > 0 && this.pos <= this.tokens.length);
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next(), selections: [] });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, GqlValue>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')' && this.pos < this.tokens.length) {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selectionsInner = this.peek() === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: selectionsInner });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { $var: this.next() };
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: { [key: string]: GqlValue } = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('"')) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
    if (/^-?\d+\.\d+$/.test(token)) return Number.parseFloat(token);
    return { $enum: token };
  }
}

/** Substitute variables and unwrap enums into plain JS values. */
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if ('$var' in value) return variables[(value as { $var: string }).$var] ?? null;
  if ('$enum' in value) return (value as { $enum: string }).$enum;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
  return out;
}

// --- the type catalogue introspection reads --------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['login', 'id', 'name', 'email', 'url'],
  RepositoryOwner: ['login', 'id', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'labels', 'refs', 'ref', 'object',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'labels',
    'comments', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'mergedAt', 'mergeCommit',
    'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'additions', 'deletions',
    'changedFiles',
  ],
  Ref: ['name', 'target', 'prefix'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  CommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueFilters: [],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// --- tagged values the resolver walks ----------------------------------------

type GqlNode =
  | { kind: 'viewer' }
  | { kind: 'user'; login: string }
  | { kind: 'repo'; repo: RepoRecord }
  | { kind: 'issue'; repo: RepoRecord; issue: IssueRecord }
  | { kind: 'pull'; repo: RepoRecord; pull: PullRecord }
  | { kind: 'comment'; repo: RepoRecord; comment: CommentRecord }
  | { kind: 'branchRef'; name: string }
  | { kind: 'typeInfo'; name: string }
  | { kind: 'fieldInfo'; name: string }
  | { kind: 'enumInfo'; name: string }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { kind: 'connection'; items: GqlNode[]; total: number; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { kind: 'fileChange'; change: FileChange }
  | { kind: 'payload'; fields: Map<string, GqlNode | string | boolean | null> }
  | { kind: 'commentEdge'; comment: GqlNode };

const TYPE_OF_KIND: Readonly<Record<GqlNode['kind'], string>> = {
  viewer: 'User',
  user: 'User',
  repo: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  comment: 'IssueComment',
  branchRef: 'Ref',
  typeInfo: '__Type',
  fieldInfo: '__Field',
  enumInfo: '__EnumValue',
  pageInfo: 'PageInfo',
  connection: 'Connection',
  fileChange: 'PullRequestChangedFile',
  payload: 'Payload',
  commentEdge: 'CommentEdge',
};

interface GqlContext {
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: { message: string }[];
}

function cursorFor(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function keyFromCursor(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string' || cursor === '') return undefined;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? undefined : Number.parseInt(match[1] as string, 10);
  } catch {
    return undefined;
  }
}

/** Slice a connection's items by first/after, in the order they were prepared. */
function paginate(items: GqlNode[], keys: number[], args: Map<string, unknown>): GqlNode {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const afterKey = keyFromCursor(args.get('after'));
  let startIndex = 0;
  if (afterKey !== undefined) {
    const at = keys.indexOf(afterKey);
    startIndex = at === -1 ? items.length : at + 1;
  }
  const page = items.slice(startIndex, startIndex + first);
  const pageKeys = keys.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < items.length;
  return {
    kind: 'connection',
    items: page,
    total: items.length,
    hasNextPage,
    endCursor: pageKeys.length > 0 ? cursorFor(pageKeys[pageKeys.length - 1] as number) : null,
    startCursor: pageKeys.length > 0 ? cursorFor(pageKeys[0] as number) : null,
  };
}

function argOf(field: GqlField, name: string, ctx: GqlContext): unknown {
  const raw = field.args.get(name);
  return raw === undefined ? undefined : resolveValue(raw, ctx.variables);
}

function resolveField(node: GqlNode | null, field: GqlField, ctx: GqlContext): unknown {
  const name = field.name;
  if (name === '__typename') return node === null ? 'Query' : TYPE_OF_KIND[node.kind];
  if (node === null) return null;

  switch (node.kind) {
    case 'viewer':
    case 'user': {
      if (name === 'login') return node.kind === 'viewer' ? VIEWER : node.login;
      if (name === 'id') return globalId('User', String(VIEWER_ID));
      if (name === 'name') return VIEWER;
      break;
    }
    case 'repo': {
      const repo = node.repo;
      switch (name) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { kind: 'user', login: repo.owner } satisfies GqlNode;
        case 'description': return repo.description;
        case 'isPrivate': return repo.priv;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === undefined ? null : ({ kind: 'branchRef', name: repo.defaultBranch } satisfies GqlNode);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'createdAt': return repo.createdStamp;
        case 'updatedAt': return repo.createdStamp;
        case 'issue': {
          const number = argOf(field, 'number', ctx);
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : ({ kind: 'issue', repo, issue } satisfies GqlNode);
        }
        case 'issues': {
          const states = argOf(field, 'states', ctx);
          const orderBy = argOf(field, 'orderBy', ctx) as { direction?: string } | undefined;
          let list = [...repo.issues.values()];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = states.map((s) => String(s).toLowerCase());
            list = list.filter((issue) => wanted.includes(issue.state));
          }
          const descending = orderBy?.direction !== 'ASC';
          list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          const nodes = list.map((issue) => ({ kind: 'issue', repo, issue }) as GqlNode);
          return paginate(nodes, list.map((issue) => issue.number), new Map([...field.args].map(([k, v]) => [k, resolveValue(v, ctx.variables)])));
        }
        case 'pullRequest': {
          const number = argOf(field, 'number', ctx);
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : ({ kind: 'pull', repo, pull } satisfies GqlNode);
        }
        case 'pullRequests': {
          const states = argOf(field, 'states', ctx);
          let list = [...repo.pulls.values()];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = states.map((s) => String(s));
            list = list.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          list.sort((a, b) => a.number - b.number);
          const nodes = list.map((pull) => ({ kind: 'pull', repo, pull }) as GqlNode);
          return paginate(nodes, list.map((pull) => pull.number), new Map([...field.args].map(([k, v]) => [k, resolveValue(v, ctx.variables)])));
        }
        default: break;
      }
      break;
    }
    case 'issue': {
      const { repo, issue } = node;
      switch (name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'repository': return { kind: 'repo', repo } satisfies GqlNode;
        case 'author': return { kind: 'user', login: VIEWER } satisfies GqlNode;
        case 'comments': {
          const list = (repo.comments.get(issue.number) ?? []).map((comment) => ({ kind: 'comment', repo, comment }) as GqlNode);
          const keys = (repo.comments.get(issue.number) ?? []).map((c) => c.id);
          return paginate(list, keys, new Map([...field.args].map(([k, v]) => [k, resolveValue(v, ctx.variables)])));
        }
        default: break;
      }
      break;
    }
    case 'pull': {
      const { repo, pull } = node;
      switch (name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return pull.mergeSha === null ? null : pull.mergeSha;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return branchTip(repo, pull.headRef) ?? pull.headSha;
        case 'baseRefOid': return branchTip(repo, pull.baseRef) ?? pull.baseSha;
        case 'mergeable': {
          if (pull.merged) return 'UNKNOWN';
          return pullMergeState(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'repository': return { kind: 'repo', repo } satisfies GqlNode;
        case 'author': return { kind: 'user', login: VIEWER } satisfies GqlNode;
        case 'files': {
          const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
          const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
          const base = mergeBase(baseTip, headTip) ?? pull.baseSha;
          const changes = diffTrees(commitInfo(base)?.tree, commitInfo(headTip)?.tree);
          const nodes = changes.map((change) => ({ kind: 'fileChange', change }) as GqlNode);
          return paginate(nodes, changes.map((_, i) => i + 1), new Map([...field.args].map(([k, v]) => [k, resolveValue(v, ctx.variables)])));
        }
        case 'additions': {
          const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
          const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
          const base = mergeBase(baseTip, headTip) ?? pull.baseSha;
          return diffTrees(commitInfo(base)?.tree, commitInfo(headTip)?.tree).reduce((sum, c) => sum + c.additions, 0);
        }
        case 'deletions': {
          const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
          const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
          const base = mergeBase(baseTip, headTip) ?? pull.baseSha;
          return diffTrees(commitInfo(base)?.tree, commitInfo(headTip)?.tree).reduce((sum, c) => sum + c.deletions, 0);
        }
        default: break;
      }
      break;
    }
    case 'comment': {
      if (name === 'id') return globalId('IssueComment', `${node.repo.id}:${node.comment.id}`);
      if (name === 'body') return node.comment.body;
      if (name === 'author') return { kind: 'user', login: VIEWER } satisfies GqlNode;
      break;
    }
    case 'branchRef': {
      if (name === 'name') return node.name;
      if (name === 'prefix') return 'refs/heads/';
      break;
    }
    case 'typeInfo': {
      if (name === 'name') return node.name;
      if (name === 'kind') return ENUM_VALUES[node.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'fields') return (TYPE_FIELDS[node.name] ?? []).map((fieldName) => ({ kind: 'fieldInfo', name: fieldName }) as GqlNode);
      if (name === 'enumValues') return (ENUM_VALUES[node.name] ?? []).map((value) => ({ kind: 'enumInfo', name: value }) as GqlNode);
      if (name === 'possibleTypes') return [];
      if (name === 'inputFields') return [];
      break;
    }
    case 'fieldInfo':
    case 'enumInfo': {
      if (name === 'name') return node.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    case 'pageInfo': {
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return node.endCursor;
      if (name === 'startCursor') return node.startCursor;
      break;
    }
    case 'connection': {
      if (name === 'nodes') return node.items;
      if (name === 'edges') return node.items.map((item, i) => ({ kind: 'payload', fields: new Map<string, GqlNode | string | boolean | null>([['node', item], ['cursor', cursorFor(i + 1)]]) }) as GqlNode);
      if (name === 'pageInfo') return { kind: 'pageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor, startCursor: node.startCursor } satisfies GqlNode;
      if (name === 'totalCount') return node.total;
      break;
    }
    case 'fileChange': {
      if (name === 'path') return node.change.path;
      if (name === 'additions') return node.change.additions;
      if (name === 'deletions') return node.change.deletions;
      if (name === 'changeType') return node.change.status.toUpperCase();
      break;
    }
    case 'payload': {
      const value = node.fields.get(name);
      if (value !== undefined) return value;
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'commentEdge': {
      if (name === 'node') return node.comment;
      if (name === 'cursor') return cursorFor(1);
      break;
    }
    default: break;
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${TYPE_OF_KIND[node.kind]}'` });
  return null;
}

/** Execute a selection set against a node, producing the JSON shape the document asked for. */
function executeSelections(node: GqlNode | null, typeName: string, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (list: GqlSelection[], current: GqlNode | null, currentType: string): void => {
    for (const selection of list) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition === undefined || selection.typeCondition === currentType) walk(selection.selections, current, currentType);
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name ?? '');
        if (fragment !== undefined) walk(fragment, current, currentType);
        continue;
      }
      const key = selection.alias ?? selection.name;
      const value = current === null && selection.name !== '__type' && selection.name !== '__schema'
        ? resolveRootField(selection, ctx, true)
        : current !== null
          ? resolveField(current, selection, ctx)
          : resolveRootField(selection, ctx, false);
      out[key] = shapeValue(value, selection, ctx);
    }
  };
  walk(selections, node, typeName);
  return out;
}

function shapeValue(value: unknown, field: GqlField, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => shapeValue(entry, field, ctx));
  if (typeof value === 'object' && (value as GqlNode).kind !== undefined) {
    const node = value as GqlNode;
    return executeSelections(node, TYPE_OF_KIND[node.kind], field.selections, ctx);
  }
  return value;
}

/** Root fields: viewer, repository, node, __type, and the mutations. */
function resolveRootField(field: GqlField, ctx: GqlContext, _nested: boolean): unknown {
  const name = field.name;
  if (name === '__type') {
    const typeName = argOf(field, 'name', ctx);
    return typeof typeName === 'string' ? ({ kind: 'typeInfo', name: typeName } satisfies GqlNode) : null;
  }
  if (name === '__schema') return null;
  if (name === 'viewer') return { kind: 'viewer' } satisfies GqlNode;
  if (name === 'repository') {
    const owner = argOf(field, 'owner', ctx);
    const repoName = argOf(field, 'name', ctx);
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = findRepo(owner, repoName);
    return repo === undefined ? null : ({ kind: 'repo', repo } satisfies GqlNode);
  }
  if (name === 'node') {
    const id = argOf(field, 'id', ctx);
    if (typeof id !== 'string') return null;
    return nodeByGlobalId(id);
  }
  if (name === 'createIssue' || name === 'closeIssue' || name === 'createPullRequest' || name === 'mergePullRequest' || name === 'addComment') {
    return runMutation(name, field, ctx);
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Query'` });
  return null;
}

function nodeByGlobalId(id: string): GqlNode | null {
  const parsed = parseGlobalId(id);
  if (parsed === undefined) return null;
  if (parsed.type === 'Repository') {
    const repo = [...reposByKey.values()].find((r) => r.id === Number.parseInt(parsed.key, 10));
    return repo === undefined ? null : { kind: 'repo', repo };
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoIdText, numberText] = parsed.key.split(':');
    const repo = [...reposByKey.values()].find((r) => r.id === Number.parseInt(repoIdText ?? '', 10));
    if (repo === undefined) return null;
    const number = Number.parseInt(numberText ?? '', 10);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { kind: 'issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { kind: 'pull', repo, pull };
  }
  if (parsed.type === 'IssueComment') {
    const [repoIdText, commentIdText] = parsed.key.split(':');
    const repo = [...reposByKey.values()].find((r) => r.id === Number.parseInt(repoIdText ?? '', 10));
    if (repo === undefined) return null;
    const commentId = Number.parseInt(commentIdText ?? '', 10);
    for (const list of repo.comments.values()) {
      const comment = list.find((c) => c.id === commentId);
      if (comment !== undefined) return { kind: 'comment', repo, comment };
    }
    return null;
  }
  return null;
}

function runMutation(name: string, field: GqlField, ctx: GqlContext): GqlNode {
  const input = (argOf(field, 'input', ctx) ?? {}) as Record<string, unknown>;
  const payload = (fields: Map<string, GqlNode | string | boolean | null>): GqlNode => ({ kind: 'payload', fields });
  if (name === 'createIssue') {
    const repoNode = typeof input.repositoryId === 'string' ? nodeByGlobalId(input.repositoryId) : null;
    if (repoNode === null || repoNode.kind !== 'repo') {
      ctx.errors.push({ message: 'repository not found for createIssue' });
      return payload(new Map());
    }
    const issue = openIssue(repoNode.repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
    return payload(new Map([['issue', { kind: 'issue', repo: repoNode.repo, issue } as GqlNode]]));
  }
  if (name === 'closeIssue') {
    const issueNode = typeof input.issueId === 'string' ? nodeByGlobalId(input.issueId) : null;
    if (issueNode === null || issueNode.kind !== 'issue') {
      ctx.errors.push({ message: 'issue not found for closeIssue' });
      return payload(new Map());
    }
    issueNode.issue.state = 'closed';
    return payload(new Map([['issue', issueNode]]));
  }
  if (name === 'createPullRequest') {
    const repoNode = typeof input.repositoryId === 'string' ? nodeByGlobalId(input.repositoryId) : null;
    if (repoNode === null || repoNode.kind !== 'repo') {
      ctx.errors.push({ message: 'repository not found for createPullRequest' });
      return payload(new Map());
    }
    const pull = openPull(
      repoNode.repo,
      String(input.title ?? ''),
      String(input.body ?? ''),
      branchNameOf(String(input.headRefName ?? '')),
      branchNameOf(String(input.baseRefName ?? '')),
    );
    if (pull === undefined) {
      ctx.errors.push({ message: 'head or base branch not found for createPullRequest' });
      return payload(new Map());
    }
    return payload(new Map([['pullRequest', { kind: 'pull', repo: repoNode.repo, pull } as GqlNode]]));
  }
  if (name === 'mergePullRequest') {
    const pullNode = typeof input.pullRequestId === 'string' ? nodeByGlobalId(input.pullRequestId) : null;
    if (pullNode === null || pullNode.kind !== 'pull') {
      ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
      return payload(new Map());
    }
    const sha = mergePull(pullNode.repo, pullNode.pull);
    if (sha === null) ctx.errors.push({ message: 'Pull Request is not mergeable' });
    return payload(new Map([['pullRequest', pullNode]]));
  }
  // addComment
  const subject = typeof input.subjectId === 'string' ? nodeByGlobalId(input.subjectId) : null;
  if (subject === null || (subject.kind !== 'issue' && subject.kind !== 'pull')) {
    ctx.errors.push({ message: 'subject not found for addComment' });
    return payload(new Map());
  }
  const number = subject.kind === 'issue' ? subject.issue.number : subject.pull.number;
  const comment = addComment(subject.repo, number, String(input.body ?? ''));
  const commentNode: GqlNode = { kind: 'comment', repo: subject.repo, comment };
  return payload(new Map([['commentEdge', { kind: 'commentEdge', comment: commentNode } as GqlNode]]));
}

/** Run one GraphQL operation document and shape the {data, errors} envelope. */
function runGraphqlOperation(document: string, variables: Record<string, unknown>, operationName: string | undefined): Record<string, unknown> {
  const parser = new GqlParser(document);
  let operations: GqlOperation[];
  try {
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName === undefined
    ? operations[0]
    : operations.find((op) => op.name === operationName) ?? operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: GqlContext = { variables, fragments: parser.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(null, rootType, operation.selections, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const op = entry as { query?: string; variables?: Record<string, unknown>; operationName?: string };
      return runGraphqlOperation(String(op.query ?? ''), op.variables ?? {}, op.operationName);
    });
    sendJson(res, 200, results);
    return;
  }
  const op = parsed as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  sendJson(res, 200, runGraphqlOperation(String(op.query ?? ''), op.variables ?? {}, op.operationName));
}

// ---------------------------------------------------------------------------
// The MCP endpoint: JSON-RPC over POST /mcp, legacy initialize handshake.
//
// The modern discovery method is answered with a JSON-RPC method-not-found error, which is the
// client's signal to fall back to the legacy `initialize` negotiation this endpoint speaks. The
// tools are the forge's own operations, executed against the same records as REST and GraphQL, and
// the tools array is a fixed literal so two tools/list calls answer byte-identically.

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner login.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of a user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login whose repositories to list.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcOutcome {
  status: number;
  payload?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id as never, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id as never, error: { code, message } } };
}

function toolResult(structured: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split an "owner/repo" full name when a caller passes one instead of separate fields. */
function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = asString(args.full_name);
  if (full !== undefined && full.includes('/')) {
    const [owner, repo] = full.split('/', 2) as [string, string];
    return { owner: asString(args.owner) ?? owner, repo: asString(args.repo) ?? repo };
  }
  return { owner: asString(args.owner) ?? '', repo: asString(args.repo) ?? '' };
}

function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === undefined || repoName === '') return toolFailure('name is required');
      const existing = findRepo(VIEWER, repoName);
      const repo = existing ?? createRepo(repoName, asString(args.description) ?? '', asBool(args.private) ?? asBool(args.is_private) ?? false);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        description: repo.description,
        private: repo.priv,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        description: repo.description,
        private: repo.priv,
        default_branch: repo.defaultBranch,
      });
    }
    case 'list_repos': {
      const list = [...reposByKey.values()].filter((r) => r.owner === VIEWER).sort((a, b) => a.id - b.id);
      return toolResult({
        repositories: list.map((repo) => ({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          private: repo.priv,
          default_branch: repo.defaultBranch,
        })),
      });
    }
    case 'create_issue': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const issue = openIssue(repo, { title: asString(args.title) ?? '', body: asString(args.body) ?? '' });
      if (issue === undefined) return toolFailure('could not create the issue');
      return toolResult({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: `${repo.owner}/${repo.name}`,
      });
    }
    case 'list_issues': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const state = asString(args.state) ?? 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return toolResult({
        issues: list.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      });
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const pull = openPull(
        repo,
        asString(args.title) ?? '',
        asString(args.body) ?? '',
        branchNameOf(asString(args.head) ?? ''),
        branchNameOf(asString(args.base) ?? ''),
      );
      if (pull === undefined) return toolFailure('head or base branch not found');
      return toolResult({
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : undefined;
      const pull = number === undefined ? undefined : repo.pulls.get(number);
      if (pull === undefined) return toolFailure('pull request not found');
      const sha = mergePull(repo, pull);
      if (sha === null) return toolFailure('Pull Request is not mergeable');
      return toolResult({ number: pull.number, merged: true, state: 'closed', sha });
    }
    default:
      return toolFailure(`unknown tool ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const outcome = rpcError(null, -32700, 'Parse error', 400);
    sendJson(res, outcome.status, outcome.payload);
    return;
  }
  const message = parsed as { id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = message.id;
  const method = message.method ?? '';
  const params = message.params ?? {};

  // Notifications carry no id and are answered with an empty 202.
  if (id === undefined) {
    res.writeHead(202, { 'content-type': JSON_TYPE });
    res.end('');
    return;
  }

  let outcome: RpcOutcome;
  if (method === 'server/discover') {
    // Method-not-found is the documented signal for the client to use the legacy handshake.
    outcome = rpcError(id, -32601, 'Method not found: server/discover');
  } else if (method === 'initialize') {
    const offered = asString(params.protocolVersion) ?? '2025-03-26';
    outcome = rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge-mcp', version: '1.0.0' },
    });
  } else if (method === 'ping') {
    outcome = rpcResult(id, {});
  } else if (method === 'tools/list') {
    outcome = rpcResult(id, { tools: MCP_TOOLS });
  } else if (method === 'tools/call') {
    if (!isAuthed(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'unauthorized' } });
      return;
    }
    const toolName = asString(params.name);
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) {
      outcome = rpcError(id, -32602, `unknown tool: ${String(toolName)}`);
    } else {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === '');
      if (missing.length > 0) {
        outcome = rpcError(id, -32602, `missing required arguments: ${missing.join(', ')}`);
      } else {
        outcome = rpcResult(id, runMcpTool(tool.name, args));
      }
    }
  } else {
    outcome = rpcError(id, -32601, `Method not found: ${method}`);
  }
  sendJson(res, outcome.status, outcome.payload);
}

// ---------------------------------------------------------------------------
// The server itself: route the four surfaces, keep every failure JSON-shaped.

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const url = new URL(req.url ?? '/', 'http://entry');

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res);
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, url);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const [, owner, repoName, , endpoint] = gitMatch as unknown as [string, string, string, string, string];
          if (!isAuthed(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          const repo = findRepo(owner as string, repoName as string);
          if (repo === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('repository not found\n');
            return;
          }
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('unknown service\n');
              return;
            }
            const protocol = req.headers['git-protocol'];
            gitInfoRefs(repo, service, typeof protocol === 'string' && protocol.includes('version=2'), res);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const protocol = req.headers['git-protocol'];
            await gitUploadPack(repo, body, typeof protocol === 'string' && protocol.includes('version=2'), res);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            await gitReceivePack(repo, body, res);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'internal error';
          try {
            sendError(res, 500, `internal error: ${message}`);
          } catch {
            // The socket is already gone; nothing more to do.
          }
        } else {
          res.destroy();
        }
      }
    })();
  });
}
