# Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository (Security tab), or by email to hunt@halldon.com. Do not open a public issue for a vulnerability.

Include the package and version, a description of the impact, and steps to reproduce. You will get an acknowledgement within a few days.

## Scope

- The TypeScript packages under `packages/`.
- The Solidity contracts under `packages/contracts/src`. The base contract, the rental extension and `BoundedAction` are in scope; the use-case examples under `src/examples` are teaching code, tested but not audited, and are in scope on a best-effort basis.

Weaknesses the ERC-8426 specification discloses by design (for example, forwarding under an unchanged owner in the capability configuration) are not vulnerabilities in this SDK, but reports that a bound is not enforced as documented are.
