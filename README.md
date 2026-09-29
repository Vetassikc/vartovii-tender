# Vartovii Tender

Vartovii Tender is a **local, synthetic prototype** for confidential procurement allocation on Solana and Arcium. A buyer needs a feasible award across suppliers with limited capacity, but seeing every losing quote can create pressure to share or reuse competitors' prices. The prototype explores an allocation from encrypted bids while exposing a bounded award result.

Three suppliers submit encrypted prices and declared capacities for two lots. An Arcium computation selects the lowest-cost feasible allocation, and a Solana program verifies and records the bounded result. This is an experiment in a specific buyer workflow, not a production privacy or security guarantee.

The canonical synthetic case awards Lot 1 to Supplier C at 45 and Lot 2 to Supplier A at 40, for a total of 85. The cheaper-looking A+A assignment at 80 is infeasible because A declared capacity for only one lot.

## Current evidence

| Area | Status | What it establishes |
| --- | --- | --- |
| Allocation model | Local tests pass | The oracle enumerates feasible assignments and handles ties, invalid inputs, and no-award cases. |
| Encrypted allocation | Bounded local result accepted | Four synthetic encrypted fixtures matched an independent oracle. |
| Tender integrity | Partial | Signed submissions, frozen-bid binding, and several adversarial checks have local evidence; genuine wrong-context callback delivery and authentic MPC-failure provenance remain unresolved. |
| Browser product flow | One bounded local B3 run accepted | Independent review accepted a single synthetic buyer, three-supplier, Arcium callback and final buyer-reload flow. This does not prove repeatability or deployment. |

There is no public-chain deployment, production security assessment, verified supplier capacity, customer usage, or demand evidence. This prototype does not handle payment or settlement.

## Review the source

With Node.js 24 or later, run the standalone allocation and tender-integrity
model tests from the repository root:

```sh
node --test experiments/arcium-procurement/oracle.test.mjs experiments/arcium-procurement/b2-integrity.test.mjs
```

These tests exercise local model behavior. They do not run Arcium or reproduce
the independently accepted single B3 flow.

For an interactive **MOCK ONLY · SYNTHETIC** buyer receipt, follow the
[isolated mock setup](experiments/arcium-procurement/demo/MOCK_REVIEW.md). It
builds a disposable copy and serves four read-only fixtures on `127.0.0.1`.
The mock does not connect to Solana or Arcium and cannot replay the accepted
live B3 flow. Do not use the demo's normal `dev` server as a fresh-clone
review command: its adapter needs generated IDL and circuit files that are
not distributed here.

The authored B2 program, circuit and test sources are provided for technical
review with [B2 limits and historical setup](experiments/arcium-procurement/b2/REPRODUCIBILITY.md).
B2 integrity remains partial and its build is on hold after a host toolchain
permission denial. The historical `Anchor.toml` wallet path is not a portable
reviewer configuration. No key, generated artifact, dependency tree or raw
local runtime evidence is part of the source package. The accepted B3 evidence
is a separate, single local synthetic run; it is not reproduced by these
commands.

## Design boundary

The proposed value is a narrow decision workflow: compute a feasible allocation while limiting disclosure of losing quotes. A trusted procurement server remains a credible alternative. The prototype does not claim to invent sealed bids or multiparty computation.

See [upstream attribution](experiments/arcium-procurement/ATTRIBUTION.md) for the public Arcium example used as a reference. No repository-wide public license has been selected yet.
