# Compute Contract Full Flow — Summary

## Participants

| Role | DID |
|------|-----|
| Requester | `did:plc:6vccw2ui4tk46zsytpxzes35` |
| Bidder | `did:plc:l2v5yribzywrncgkrh2zjpk7` |

## Result

```json
{
  "event": "compute_request_complete",
  "vmUri": "at://did:plc:6vccw2ui4tk46zsytpxzes35/com.publicdomainrelay.temp.compute.vm/3mpzwdilhdk2a",
  "vmCid": "bafyreihfivdmlguypz4nxypdkd5lgdhgqauejkthsfkkxg7vim2faxm6ym",
  "rfpUri": "at://did:plc:6vccw2ui4tk46zsytpxzes35/com.publicdomainrelay.temp.market.rfp/3mpzwdilics2a",
  "rfpCid": "bafyreigalf6jzbujgvi5kliiliir6rv2z4t44gwc4tuyi6m342pi6bhrty",
  "acceptUri": "at://did:plc:6vccw2ui4tk46zsytpxzes35/com.publicdomainrelay.temp.market.accept/3mpzwdwvz632a",
  "acceptCid": "bafyreifesc72g5lgb2gnw7tlvfpjusyuhn3x47zdwrwhravk25camhqm3a",
  "bidUri": "at://did:plc:l2v5yribzywrncgkrh2zjpk7/com.publicdomainrelay.temp.market.bid/3mpzwdilwxl2a",
  "bidCid": "bafyreihvbtezemxs4yhmcdu7xldhvv47l5l3b7evzdoilxd3bxevgbiihe",
  "winnerDid": "did:plc:l2v5yribzywrncgkrh2zjpk7",
  "receiptUri": "at://did:plc:l2v5yribzywrncgkrh2zjpk7/com.publicdomainrelay.temp.market.receipt/3mpzwdwway32a",
  "receiptCid": "bafyreidjsnqsopfeu52yljhr36zffrfzlw7nrixcojmcsv7rmp7k53mkwe",
  "submitEventRef": "https://did-key-zq3shsprdpsumjabky57zuy6byhdipea2pfukykt8itz9zur7.localhost",
  "receiptOk": true,
  "bids": 1,
  "sshReady": false
}
```

## Dispatcher

Host: `localhost:62116`
PLC: `http://localhost:62117`

## AT Protocol Records Created

| Collection | Count |
|------------|-------|
| `com.publicdomainrelay.temp.market.rfp` | 1 |
| `com.publicdomainrelay.temp.market.accept` | 1 |
| `com.publicdomainrelay.temp.compute.vm` | 1 |
| `com.publicdomainrelay.temp.market.offering` | 1 |
| `com.publicdomainrelay.temp.market.bid` | 1 |
| `com.publicdomainrelay.temp.market.receipt` | 1 |
| `com.publicdomainrelay.temp.auth.allowlist.rbacDid` | 1 |

## Full Record Details

See [atproto-records.json](./atproto-records.json)

## Log

See [full-flow.log](./full-flow.log)

## How to Reproduce

```bash
# From the polyrepo root:
deno run --allow-all compute-contract-full-flow/run_full_flow.ts
```

## Architecture

```
Requester                    AT Protocol (PDS/relay)              Bidder                    Guest Container
────────                     ──────────────────────              ──────                    ───────────────
runComputeContract()
  ├─ ssh-keygen ed25519
  ├─ buildDefaultUserData()  ──►  compute.vm record
  ├─ createSignedRepoRecord  ──►  market.rfp (signed)
  ├─ discoverBidders         ──►  relay index + extraBidderDids
  ├─ submitRfp XRPC          ──►  ──►  rfpCallback → bid
  │                                    ├─ onAccept → provision
  │                                    │    ├─ OIDC enrichment
  │                                    │    ├─ runContainer()
  │                                    │    └─ cloud-init: sshd + websocat
  │                                    └─ eventCallbacks
  ├─ wait bidWindowSec (15s)
  ├─ pick lowest-cost bid
  ├─ createSignedRepoRecord  ──►  market.accept
  ├─ submitAccept XRPC       ──►  ──►  provision guest
  ├─ verify receipt
  ├─ pollReady → SSH         ──►  ──►  websocat ws:// → sshd
  │  └─ exec 'hostname'
  └─ vm.delete event         ──►  ──►  destroy()
```

## SSH Tunnel Path

```
requester SSH client
  ProxyCommand websocat --binary wss://<service>--did-plc-<key>.localhost
    → dispatcher (did-key-relay, routes by SNI subdomain)
      → relay WebSocket → bidder PDS → guest container
        → websocat ws-l:127.0.0.1:8080
          → sshd 127.0.0.1:22
```

Generated: 2026-07-07T05:59:20.111Z
