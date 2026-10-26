# Credit panel VPN deployment (2026-10-26)

Use `https://<VPN_HOST>:8443/vpn/wall/` (replace the host; not a public service).
API base: /vpn/creditrelay. No keys belong in VITE_ variables.

## Safety and status

- User unit: pazoor-lukso-creditrelay.service, loopback 127.0.0.1:8790.
- Shared index route forwards only loopback or WireGuard-subnet source peers; ignores forwarded-IP claims. OPTIONS is forwarded for origin filtering.
- Current signer is also the live blob relayer. Credit sends are hard-disabled before RPC/signing/nonce allocation; HTTP 503 shared-signer-nonce-coordination-required. No new permission, deployment or transaction was made. Blob service was not restarted or stopped.
- GET health reports claimsEnabled:false and the block reason. Gate and balance remain functional. Eligibility does not imply the service may send.
- Only the index app was restarted to activate its route; no Gateway restart. Existing static wall service continues serving frontend2/dist.
- Credential used from private external credentials/updawg/relayer.json, never printed or bundled. State lives under ~/.local/state/updawg/.

## Reconciliation and budget

Read-only mainnet receipt + all token logs from block 8640628 through 8650609 confirm the preserved legacy claim 0x201b44f80b2fbd3edf562cc7a88ef03595d36f9cbb74fbe643c0d76282ad3683 (success at 8641664, EOA nonce 116). Its actual gas fee is 0.000240668373371712 LYX; maximum gas reservation is 0.0010587049296 LYX. Token mint history contains 10 + 1 + 10 credits, all to the already-recorded Alice UP; balance/soulbound are 21/21, free 0. No additional recipient was omitted.

Ledger version 1 retains the original claim and stores reconciliation evidence. Token logs do **not** prove absence of reverted or unrecorded legacy attempts. Therefore legacyBudgetUnknown remains true and the entire 0.1 LYX service allowance stays reserved: **service spendable remainder 0 LYX**. Do not clear this flag, reset the ledger, or increase the cap. A private legacy backup and detailed receipt/log evidence are retained beside the ledger.

Six historical E2E artifacts report 0.032892 LYX aggregate spend (rounded values, not an exhaustive independently audited ledger). Conservatively adding the full 0.1 service reservation gives 0.132892 LYX accounted/reserved, nominal 1.867108 LYX under the task's 2 LYX ceiling. This is **not certified spendable headroom**: historical artifacts may omit failures. This deployment added exactly zero chain spend; no further sends are authorized by this document.

## Verification completed

- node --check poc/lab-ups/credit-relayer-service.mjs
- node --test poc/lab-ups/credit-relayer-test.mjs: 7/7 pass, including shared-signer zero-sign/zero-broadcast interlock.
- Python proxy syntax compile passes.
- HTTPS VPN path: health/gate/balance 200; Alice eligible; balance 21/21/0.
- Valid claim 503 safety block; malformed JSON/up 400; oversized body 413.
- Foreign Origin POST and OPTIONS 403 without allow-origin; configured Origin OPTIONS 204 with exact allow-origin.
- Listener confirmed only 127.0.0.1:8790; relayer/index/blob/wall user units active.
- Non-VPN source unit probe rejected before upstream access. Credit-unit restart preserves ledger SHA-256 unchanged.

## Build

After dependency work settles, from frontend2:

    VITE_BASE=/vpn/wall/ VITE_CREDIT_RELAYER_URL=/vpn/creditrelay VITE_BLOB_RELAYER_URL=/vpn/blobrelay VITE_BEACON_URL=/vpn/beacon VITE_BLOBS_ENABLED=1 VITE_CREDITS_PANEL=1 npm run build

Final build/browser verification pending dependency remediation at the time of this incremental note.

## External files changed

- ~/.config/systemd/user/pazoor-lukso-creditrelay.service and enablement symlink
- ~/.local/state/updawg/credit-relayer.json (migration, no claim deletion)
- ~/.local/state/updawg/credit-relayer.json.legacy-backup
- ~/.local/state/updawg/reconciliation-evidence.json
- pazoor/scripts/user-vpn-index/pazoor_user_index.py (credit route VPN guard + OPTIONS)

Recovery: stop only the credit unit before state maintenance; preserve ledger/backup. Never delete state or pending entries to unblock sends. A dedicated signer with separately authorized permissions or a proven shared durable nonce coordinator, plus complete accounting review, is required before replacing the fail-closed deployment.
