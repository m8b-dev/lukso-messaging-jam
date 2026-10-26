# Publication security review — 2026-10-26

Scope: this feature branch source/index plus an earlier review of 82 reachable commits (including fetched remote refs). Not a forensic audit of every copy, cache, chat, reflog or dangling object.

- Earlier Gitleaks 8.30.1 history scan: 6 findings, reviewed as public blockchain/storage identifiers, not credentials.
- Final candidate index: 201 files scanned; 19 generic-api-key findings manually classified as public token/contract addresses, LSP/ERC725 storage-key constants, token IDs or a localStorage key name.
- Exact comparison against four locally held controller/private keys found no matches in the publishable source. Earlier comparison also found none in 278 repository-history blobs or 26 parent-workspace blobs. Key values were never included in reports.
- Mutable relayer ledger, local environment settings, keys, dependencies and generated browser bundles are excluded. Public test-result addresses and transaction hashes are intentionally included as historical evidence; these are not private keys.
- Local git remotes contain authentication data; `.git` must never be packaged or published. Push only this feature ref; no mirror/all/tags or force push.
- Browser `VITE_` values are public regardless of whether CI labels them secrets. No reusable private credential belongs in the browser configuration.

**No confirmed credential exposure found within the reviewed scope.** This is a bounded result, not an absolute guarantee. Dependency vulnerabilities and deployed-contract limitations are covered separately in the dependency and contract review documents.
