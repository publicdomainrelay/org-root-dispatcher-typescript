# 0001 — Double-VM: two bidders, one accept

Status: investigated (no changes made)
Date: 2026-08-04

## Report

On the 09:30 run, a single compute request produced TWO VMs — a DigitalOcean
droplet from the prod digitalocean-bidder and a local container from the local
hono-bidder — even though `request-vm-ssh` is supposed to accept exactly one
bid. This document records the investigation and the conclusion.

## Bottom line

**request-vm-ssh did NOT accept two bids.** It accepted exactly ONE bid. The
double VM is a bidder-side identity collision: two bidder processes operate
under the SAME ATProto DID and both honored the single accept.

The requester-side single-accept invariant held. The fix must live on the
bidder side.

## Requester side — one accept (evidence, pane 14.1)

Run: `--atproto-oauth-qr --atproto-handle aliceoa.bsky.social --policy
tangled-vouch --no-ingress-proxy --firehose-mode subscriberepos`

| ts (Z) | message | value |
|--------|---------|-------|
| 09:31:02 | `first_free_winner` | bid `3msapbxtwos2f`, did `5svqtrh...` |
| 09:31:02 | `bids_collected` | count 3, earlyExit true |
| 09:31:02 | `winner` | viaFirstFree |
| 09:31:03 | `accept_created` | **one** accept `3msapc6eqdc2r` |
| 09:31:04 | `submitAccept_result` | 200, receipt `3msapc6zifc2f` |
| 09:31:05 | `receipt_verified` | sigOk true, bindOk true |
| — | `compute_request_complete` | one winnerDid, one acceptUri |

`bids:3` = three bids collected, only the first picked. Single accept, single
receipt, single winner. Requester never accepted two bids.

## Bidder side — the collision

Both bidder processes operate as **`did:plc:5svqtrhheairglgiiyvutzik`** and
both publish the **same offering record** (rkey `3mnqwh7zcga2m`):

| | Local hono-bidder (14.0) | Prod digitalocean-bidder (socialweb.computer) |
|---|---|---|
| policy | tangled-vouch | only-me |
| provider | container `pdr-0bdede051870-3msapbwfzws2r-1ef58f05` | DO droplet `589848710` |
| receipt | `3msapc7qthk27` | `3msapc6zifc2f` (the one requester used) |
| onNetwork | `3msapcfsmn227` → `did-key-zq3shnoaa...` @09:31:11 | `3msapfkhymk2f` → `did-key-zq3shzarw5wv...` @09:32:57 |

Both bidders bid on the same RFP (hence `bids:3`). Requester accepted ONE bid →
created ONE accept. But both bidders' accept-watch independently matched the
same accept and both provisioned:

- **Prod**: `submitAccept` → receipt `3msapc6zifc2f` → droplet `589848710`
- **Local**: firehose accept-watch `matched own bid` (bid `3msapbxtwos2f`
  exists under the shared DID) → its OWN receipt `3msapc7qthk27` → container

## Root cause in code

`atproto-market/lib/market-bidder/mod.ts` — firehose ACCEPT_NSID watcher
("accept watch matched own bid"):

- parses the accept's `bid` ref URI
- verifies the referenced bid record EXISTS via `getRecord`
- **never verifies this process created that bid**

Two processes under one DID both pass. The accept-watch is not
authorship-scoped; it only checks existence.

Note: the accept-watch matches a bid the OTHER process authored (prod's
`3msapbxtwos2f`) and provisions a duplicate VM for it. Cross-process dedup of
the accept (the `acceptedUris` map) is per-process only — each bidder has its
own, so it does not help.

## Side benefit — explains the earlier "slow onNetwork" mystery

The "two FQDNs" were two DIFFERENT VMs, not a re-registration:

- Local container booted fast → onNetwork @09:31:11 (`did-key-zq3shnoaa...`)
  under receipt `3msapc7qthk27` ≠ contract receipt → **correctly rejected**
  by the receipt-scoped FQDN discovery (fix from earlier work).
- Prod droplet took ~111s to boot → onNetwork @09:32:57
  (`did-key-zq3shzarw5wv...`) under receipt `3msapc6zifc2f` → accepted.

The 114s delay was the real DO droplet boot latency, NOT a discovery bug. The
receipt-scoped FQDN fix worked: it waited for the right VM and ignored the twin.

## Separate issue found — prod only-me allowed aliceoa

The prod bidder's scope gate returned **allow** for aliceoa's RFP (log shows
`rfp watch discovered` → bid created, no deny). Under `bidder-only-me`,
aliceoa's operator (`did:plc:eoerph3nm7y4vumekqftldrx`) != bidder's operator,
so it should have denied. The firehose RFP-watch path calls `scopeGate(e.did)`
before dispatch, so the gate ran but let aliceoa through.

This is a real policy bug, separate from the double-VM, and needs its own
investigation.

## Fix directions (not yet chosen)

1. **Bidders under one DID must not both watch the accept firehose.** The
   identity collision itself is the root: one ATProto account should map to one
   active bidder process. Run only one of local/prod bidder, or give them
   distinct DIDs/offerings.
2. **Authorship-scope the accept-watch.** "Match own bid" must verify this
   process created the referenced bid (e.g., check a local in-memory set of bid
   URIs this process minted), not merely that the bid record exists.
3. (Policy) **Fix the gha-lite executor scope lane** — DONE, see
   `0002-tangled-vouch-always-allows.md`. The "only-me allowed aliceoa" symptom
   was the same root: the scope lane never surfaced a deny. Gate step added to
   all 9 workflows.

## Evidence files

- `tmux capture-pane -t Main:14.0` — local bidder (DID, offering, receipt,
  onNetwork, container prove)
- `tmux capture-pane -t Main:14.1` — requester (one accept, one winner)
- `ssh root@socialweb.computer` `journalctl -u digitalocean-bidder` — prod
  bidder (badge_blue_key_bound, droplet 589848710, receipt 3msapc6zifc2f,
  guest.onNetwork 3msapfkhymk2f)
- badgeBlueKeys at PDS: `did:plc:5svqtrh...` (8 records) and
  `did:plc:lpfuqerea3deuoyrn7ojser4` (2 records)
