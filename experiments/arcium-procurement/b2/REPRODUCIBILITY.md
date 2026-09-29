# B2 reproducibility inputs

This directory is the authored, nonsecret source snapshot for the bounded
local Arcium B2 experiment. It does not contain generated keypairs, provider
credentials, dependency trees, or compiled artifacts.

## Current status

**B2 remains PARTIAL and on HOLD.** The September 29 SBF/IDL build attempt
stopped at its first offline gate when the host denied a global Solana
toolchain replacement with `Operation not permitted`. No B2 build artifact,
current supported fresh-clone build, localnet result, or adversarial result
was produced. No command in this document is a current supported build or a
one-command live setup.

## Portable harness paths

`tests/tender.ts` requires `ARCIUM_B2_KEYPAIR`. If it is absent, the module
throws a direct error before it attempts to read a key file. Set it only to a
keypair file in a separately authorized disposable runtime.

The existing output variables keep their behavior when supplied:
`ARCIUM_B2_TRANSCRIPT`, `ARCIUM_B2_REMAINING_TRANSCRIPT`, and
`ARCIUM_B2_V0_TRANSCRIPT`. If an output variable is omitted, the harness
places that transcript under `ARCIUM_B2_DISPOSABLE_RUNTIME_DIR`, which must
be an absolute path. No transcript is written beside the authored source.

| Variable | Requirement and fallback |
| --- | --- |
| `ARCIUM_B2_KEYPAIR` | Required explicit path to a disposable keypair file; no source-tree default |
| `ARCIUM_B2_TRANSCRIPT` | Optional override; otherwise `transcript/tender-results.json` under the disposable runtime directory |
| `ARCIUM_B2_REMAINING_TRANSCRIPT` | Optional override; otherwise `transcript/tender-results-remaining.json` under the disposable runtime directory |
| `ARCIUM_B2_V0_TRANSCRIPT` | Optional override; otherwise `transcript/tender-results-v0-2026-09-22.json` under the disposable runtime directory |
| `ARCIUM_B2_DISPOSABLE_RUNTIME_DIR` | Required absolute directory when any transcript override is omitted |

Example values for a future separately authorized disposable run:

```sh
export ARCIUM_B2_DISPOSABLE_RUNTIME_DIR="/absolute/path/to/disposable-b2-runtime"
export ARCIUM_B2_KEYPAIR="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/keys/payer.json"
export ARCIUM_B2_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results.json"
export ARCIUM_B2_REMAINING_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results-remaining.json"
export ARCIUM_B2_V0_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results-v0-2026-09-22.json"
```

These placeholders do not authorize creating, opening, copying, or using a
keypair. `Anchor.toml` retains a tilde-prefixed provider wallet path. This
checkpoint found no local Anchor CLI source or documentation establishing
whether or how that value is expanded and resolved, or proving a replacement
cannot select a real wallet. Treat provider-wallet portability as a release
blocker; `Anchor.toml` was left unchanged.

## Historical v0 packet-size measurement

The command below documents the September 22 v0 packet-size measurement only.
It is not a current supported build or runtime command and was not rerun in
this checkpoint. The test constructs the direct `queueComputation`
instruction and address lookup table, partially signs the payer slot, and
records serialized sizes and resolved accounts before sending; the recorded
measurement says `sent: false`. The local transcript is evidence for that
synthetic run only, not a reproducible deployment or independent-node result.

```sh
# Historical command shape only; B2 is currently on HOLD.
export ARCIUM_B2_DISPOSABLE_RUNTIME_DIR="/absolute/path/to/disposable-b2-runtime"
export ARCIUM_B2_KEYPAIR="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/keys/payer.json"
export ARCIUM_B2_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results.json"
export ARCIUM_B2_REMAINING_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results-remaining.json"
export ARCIUM_B2_V0_TRANSCRIPT="$ARCIUM_B2_DISPOSABLE_RUNTIME_DIR/transcript/tender-results-v0-2026-09-22.json"
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$ARCIUM_B2_KEYPAIR"
export ARCIUM_CLUSTER_OFFSET=0
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 2000000 \
  --grep "legacy and v0 queue packet sizes" tests/tender.ts
```

The recorded sanitized v0 transcript SHA-256 was
`a9f550d515ab8199b5df49bff15be1d92a86755d24afe01c74dab3247e02873f`.
