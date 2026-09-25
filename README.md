# Vartovii Tender

Vartovii Tender is a **local, synthetic prototype** for confidential procurement allocation on Solana and Arcium. Three suppliers submit encrypted prices and declared capacities for two lots. An Arcium computation selects the lowest-cost feasible allocation, and a Solana program verifies and records the bounded result.

The canonical synthetic case awards Lot 1 to Supplier C at 45 and Lot 2 to Supplier A at 40, for a total of 85. The cheaper-looking A+A assignment at 80 is infeasible because A declared capacity for only one lot.

## Current evidence

| Area | Status | What it establishes |
| --- | --- | --- |
| Allocation model | Local tests pass | The oracle enumerates feasible assignments and handles ties, invalid inputs, and no-award cases. |
| Encrypted allocation | Bounded local result accepted | Four synthetic encrypted fixtures matched an independent oracle. |
| Tender integrity | Partial | Signed submissions, frozen-bid binding, and several adversarial checks have local evidence; genuine wrong-context callback delivery and authentic MPC-failure provenance remain unresolved. |
| Browser product flow | In progress | A complete buyer-to-supplier-to-MPC-to-reload demonstration has not yet been independently accepted. |

There is no public-chain deployment, production security assessment, verified supplier capacity, customer usage, or demand evidence. This prototype does not handle payment or settlement.

## Reproducible first slice

The repository starts with the allocation oracle and the local tender-integrity model. With Node.js 24 or later:

```sh
node --test experiments/arcium-procurement/oracle.test.mjs experiments/arcium-procurement/b2-integrity.test.mjs
```

These tests exercise local model behavior. They do not run Arcium or prove browser acceptance. The encrypted circuit, Solana program, browser demo, and their own reproducibility instructions will be added in reviewed increments.

## Design boundary

The proposed value is a narrow decision workflow: compute a feasible allocation while limiting disclosure of losing quotes. A trusted procurement server remains a credible alternative. The prototype does not claim to invent sealed bids or multiparty computation.

See [upstream attribution](experiments/arcium-procurement/ATTRIBUTION.md) for the public Arcium example used as a reference. No repository-wide public license has been selected yet.
