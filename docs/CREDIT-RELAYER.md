# VPN credit relayer (test only)

The send-capable core uses real LUKSO mainnet gas (chain 42), minting 10 test soulbound credits per UP. **Current deployed service is read-only:** claims fail closed with `shared-signer-nonce-coordination-required`; health reports `claimsEnabled:false`. The EOA is shared with an active blob service, which has no shared durable nonce coordinator. No environment switch bypasses this interlock. See [deployment](CREDIT-VPN-DEPLOYMENT.md). It is NOT a public faucet or production relayer. Gate checks only nonempty LSP3 + LSP26 following of the service UP. **No key-publication condition is checked; this is not Sybil-safe and does not authenticate UP ownership.** Anyone with network access can request an eligible UP's once-only claim. CORS is not authentication. Keep behind the local/VPN reverse proxy/firewall, never expose publicly.

## Settings

Run from repository: `node poc/lab-ups/credit-relayer-service.mjs`.

- CREDIT_RELAYER_HOST: default 127.0.0.1; retain for local VPN proxy. Only 127.0.0.1 or ::1 is accepted. Do not bind wildcard/public interfaces.
- CREDIT_RELAYER_PORT: default 8790.
- CREDIT_RELAYER_KEY_FILE: default $HOME/.openclaw/credentials/credit-relayer.json; absolute path recommended, JSON with privateKey property. Must resolve outside this repository and have no group/other permission bits (0600). Provision securely; never print it or commit it.
- CREDIT_RELAYER_STATE_FILE: default poc/lab-ups/credit-relayer-service-state.json beside service (portable, independent of cwd). For deployment use an absolute persistent private path, e.g. $HOME/.local/state/credit-relayer/state.json. **Move/copy the existing ledger while stopped when changing this path; never start a fresh ledger for an already-used deployment.**
- CREDIT_RELAYER_ALLOWED_ORIGINS: comma-separated exact canonical origins, e.g. https://vpn.example:8443,http://localhost:5173. Default empty rejects every browser Origin. No wildcard, null origin, path or trailing slash. Origin-less local/API clients are allowed. Foreign Origin requests are rejected before work, including preflight.
- CREDIT_RELAYER_MAX_SPEND_LYX: default 0.1; positive decimal LYX. This is a lifetime cumulative maximum-fee reservation budget, not a balance delta. Values above 0.1 are rejected; changing configuration cannot expand the authorized cap.

RPC is https://rpc.mainnet.lukso.network; startup, health and each claim query actual eth_chainId. Topology remains svc-up-topology-e2e-result.json beside service. ethers must be installed in the existing project/poc dependency tree.

## Durability and recovery

Global claim queue serializes eligibility, EOA/LSP25 nonce preparation and submission; queue bounded to 32. Use one dedicated signer and one canonical ledger path, never multiple services with different ledgers or another sender using this EOA concurrently.

Ledger uses exclusive .lock, temp-file fsync, atomic rename, directory fsync. Invalid/unreadable ledger fails startup; persistence failure disables further claims. Hash, EOA nonce and full gasLimit*maxFeePerGas budget reservation persist BEFORE broadcast. Reservations never decrease, even on revert or restart. Private key and signed raw transaction are not stored in the ledger.

Pending transactions globally block new submissions. A later claim reconciles only after two confirmations; success records once-only claim, revert consumes reservation but allows retry within remaining budget. Unknown/dropped/unbroadcast pending stays blocked: deliberately no automatic retry or nonce replacement. An operator must investigate chain/nonce history before recovery; do not delete pending or reset ledger to make the service work. Reorgs beyond two confirmations remain a test-service limitation.

Normal SIGTERM drains connections and releases lock on exit. Crash/SIGKILL can leave .lock: verify the old process is dead before removing ONLY the stale lock. Never delete state. Maintain backups; missing state is treated as first-time provisioning, so filesystem loss/operator deletion cannot be safely auto-recovered.

Legacy {claimed:...} maps are preserved and normalized. Unknown historical spend conservatively exhausts budget and marks legacyBudgetUnknown; new claims stay blocked even if cap increases. Reconcile historical submissions and costs offline under operator review before migrating; do not simply clear that flag/reset spend. Legacy service crashes before recording claims cannot be reconstructed from its ledger alone.

## HTTP / tests

JSON routes remain GET /health, GET /gate?up=..., GET /balance?up=..., POST /claim with {"up":"0x..."}. Claim success returns txHash and minted; refresh /balance separately. 409 already-claimed includes txHash; 503 transaction-pending may include txHash. Errors do not expose RPC internals. JSON-only claims, 1024-byte maximum body, 5-second body deadline, bounded RPC/request timeouts. No arbitrary mint amount or transaction input endpoint.

Offline verification (no key/RPC required):

    node --check poc/lab-ups/credit-relayer-service.mjs
    node --test poc/lab-ups/credit-relayer-test.mjs

No live chain send is required by these tests. Network access control, signer permission correctness and on-chain deployment are separate operator responsibilities.
