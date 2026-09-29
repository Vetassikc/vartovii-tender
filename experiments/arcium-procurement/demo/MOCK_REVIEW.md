# Local mock buyer review

This is a loopback-only UI review aid backed by named synthetic fixtures. It
does not run or reproduce Arcium, B2, localnet, or the accepted single B3 flow.
The mock server does not import the live adapter, read `.runtime`, access RPC,
or use a wallet.

## Fresh-source setup

From the repository root, make a disposable copy of the demo source. `rsync`
excludes the existing dependency tree and build output so neither the shared
`node_modules/` nor `dist/` is copied or modified:

```sh
REPO_ROOT="$PWD"
TMP_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
RUN_ROOT="$(mktemp -d "$TMP_PARENT/vartovii-tender-mock.XXXXXX")"
rsync -a \
  --exclude=.git --exclude=.runtime --exclude=node_modules --exclude=dist \
  --exclude='.env*' --exclude='*.pem' --exclude='*.key' \
  --exclude='*.p12' --exclude='*.pfx' --exclude='*keypair*.json' \
  --exclude='*wallet*.json' \
  "$REPO_ROOT/experiments/arcium-procurement/demo/" "$RUN_ROOT/"
cd "$RUN_ROOT"
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm install --frozen-lockfile` uses the committed lockfile for a fresh
review copy. If dependencies are already installed in that copy, skip the
install command. The mock server serves the Vite output in the isolated
copy's `dist/`; `vite build` clears that directory, so do not build in the
shared workspace. The shared `demo/dist/` may be stale relative to current
source.

## Run, inspect, and stop

From the isolated demo copy containing the freshly built `dist/`:

```sh
pnpm run check
node --test test/mock-server.test.mjs
pnpm run mock
```

`pnpm run mock` prints the actual loopback URL. Open each fixture URL below
in a local browser. Stop the server with **Ctrl-C**. Then return to the
repository root and remove only the disposable directory created above:

```sh
cd "$REPO_ROOT"
case "$RUN_ROOT" in
  "$TMP_PARENT"/vartovii-tender-mock.*) rm -r "$RUN_ROOT" ;;
  *) echo "Refusing to remove unexpected RUN_ROOT: $RUN_ROOT" ;;
esac
```

The existing `check` script is syntax-only; it parses the live adapter file
without importing or executing it. The `mock` script starts only
`mock-server.mjs`, which uses Node built-ins.

The mock server binds only to `127.0.0.1`, defaults to port `4174`, and serves
only GET requests. If that port is already occupied, choose another local
port with `L1_MOCK_PORT=4175 pnpm run mock`. Every HTML page begins with a
visible **MOCK ONLY · SYNTHETIC** banner before the client renders any result.

Open each buyer view in a local browser:

| Fixture | URL suffix | Expected result |
| --- | --- | --- |
| Finalized success | `/buyer?tender=finalized-success-85` | Synthetic allocation total 85 |
| Pending | `/buyer?tender=pending` | Queued; no award |
| Finalized nonzero | `/buyer?tender=finalized-nonzero-no-award` | Finalized; no award |
| Account read failure | `/buyer?tender=account-read-failure` | Unavailable; no award |

Prefix each suffix with `http://127.0.0.1:4174` (or the selected local port).
The first API read is `GET /api/config`; each buyer view then requests
`GET /api/tenders/<fixture-name>`. The account-read-failure fixture returns a
synthetic HTTP 503 so the existing buyer UI renders its unavailable state.
Every non-GET request returns HTTP 405 with `Allow: GET`; unknown API paths and
fixture names return 404. No mutation endpoint is present.

## Evidence boundary

The DTOs and failure are synthetic, static fixtures. Browser screenshots or
test results establish only that this UI renders those local GET responses.
They do not establish a live Tender account, callback transaction, optimizer
result, B2 integrity, or B3 replay. The current buyer receipt's statement
about separately reviewed B3 evidence remains a distinct historical claim;
the banner labels every page in this session as mock-only.

The focused test command uses Node's built-in test runner and does not import
`server/adapter.mjs`. The `check` script is syntax-only; it parses the live
adapter file without importing or executing it. The full demo test suite is
outside this mock procedure: some existing tests import that adapter, which
requires excluded generated B2 IDL files at module load. Do not start the
normal `pnpm run dev` server for this mock review.
