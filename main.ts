// The entry's lifecycle with the trial env, in three moves: bind, register, wait.
//
//   1. The env's origin arrives in MAKEFUN_ENV_URL. With no env there is no trial, so the
//      process says so on stderr and exits 1 instead of serving to nobody.
//   2. The forge (app.ts) listens on port 0, letting the kernel pick a free port — never a
//      fixed one, and never 8080, which belongs to the env. The port is then registered with
//      POST $MAKEFUN_ENV_URL/register {"port": N}; the env notes the caller's address beside
//      the port and dials that base URL from then on. A 200 registers us; a 409 means another
//      process registered first and this one simply waits like any other; a 400 or 405 is a
//      contract error worth dying on; anything else (the env still starting, a dropped
//      connection) is retried with a short backoff.
//   3. GET $MAKEFUN_ENV_URL/done is polled until it answers {"done": true}. Only then does the
//      server close and the process exit 0 — leaving early would cut the trial short.
//
// This file imports the server and nothing else: no package, no model call, no clock of its
// own beyond the retry waits.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait before retry number `attempt`: doubling from FIRST_RETRY_MS, capped. */
function backoff(attempt: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

/** One call to the env with the trial's timeout; the caller decides what an answer means. */
async function callEnv(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${envUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Register the bound port, retrying while the env is not ready to hear it. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await callEnv('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // A network failure just means the env is not up yet: fall through and retry.
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the env's /done until it says the trial is over; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await callEnv('/done');
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: either way the trial is not over.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
