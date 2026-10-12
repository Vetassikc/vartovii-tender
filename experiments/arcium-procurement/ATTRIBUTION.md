# Upstream attribution

The code written for this project is licensed under AGPL-3.0 (see the repository's `LICENSE`). The notes below describe the upstream Arcium example used only as a
reference; its own terms are not changed by this repository's license.

This experiment uses an isolated, unmodified copy of the official Arcium
examples repository only for the Checkpoint A smoke:

- Source: https://github.com/arcium-hq/examples
- Archive: https://github.com/arcium-hq/examples/archive/refs/heads/main.tar.gz
- Retrieved: 2026-09-19
- Retrieved archive SHA-256: `02f90196db121a8e3227159f2987c228aae16f2846d2344e7e199fe5707d15ac`
- Example: `voting`

The upstream archive did not contain a top-level `LICENSE` file. The example
package metadata declares `ISC`; that metadata remains upstream-only. This
repository does not publish or redistribute the copied example. The upstream source copy is retained under the ignored
`.runtime/arcium-spike/upstream/` directory and is not modified.

## B1 bounded adaptation

B1 used the same public voting example scaffold and the installed Arcium
toolchain as a local reference. The B1 allocation circuit, Anchor queue/callback
program, fixtures, and independent oracle are new bounded experiment code under
the owned B1 paths. The source reference remains read-only; no private
portfolio code was copied.

## B2 bounded adaptation

B2 retains the public voting scaffold and installed Arcium toolchain only as an
attributed local reference. The tender account, invited-slot rules,
Ed25519-bound supplier bids, freeze commitment, stored-bid queue binding,
three-input encrypted circuit, callback persistence, validator adversarial
fixtures and independent oracle are authored bounded experiment logic. The
upstream source reference remains read-only; no private portfolio code was
copied.
