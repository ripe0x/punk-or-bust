# punk-or-bust

Personal FWA V2 pull vaults. `SPEC.md` is the only requirements document. `docs/FWA-HAZARDS.md`
lists the FWA behaviors the code must handle.

## Rules

- This repo is public. No secrets, keys, `.env` files, personal names or emails, or local paths.
- The spec is canonical. If code needs a decision the spec does not make, stop and ask; the answer
  goes into `SPEC.md` in the same PR.
- No new docs beyond `SPEC.md`, `docs/FWA-HAZARDS.md`, `docs/LAUNCH.md` and READMEs. No reports,
  logs or run notes.
- `refs/` holds verified FWA sources from Sourcify, checked by `python3 script/fwa_refs.py`. Never
  edit them by hand; re-vendor with the script.
- Tests run against the real verified FWA V2 bytecode (`refs/fwa-v2/FWAV2.json`). A test double
  for another deployed contract must mirror its verified source and gets a mainnet fork
  conformance test. Fork tests are named `Fork*.t.sol` and pin a block.
- Every FWA hazard in `docs/FWA-HAZARDS.md` has a test.
- No em or en dashes in code comments or user-facing text.

## Commands

```sh
python3 script/fwa_refs.py   # verified FWA sources match provenance
forge fmt --check
forge build --sizes
forge test
```

Mainnet deploys and admin transactions are the owner's to approve and sign.
