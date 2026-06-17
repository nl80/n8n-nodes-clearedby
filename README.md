# n8n-nodes-clearedby

An [n8n](https://n8n.io) community node for [ClearedBy](https://clearedby.com) — **gate an action behind policy + human approval before your workflow proceeds.**

Drop the **ClearedBy Gate** node in front of any consequential step (a refund, a publish, a payout). ClearedBy's policy clears the safe ones instantly and routes the rest to a human (Slack / dashboard / email); your workflow either continues or branches — and every decision is signed into a tamper-evident record.

## Install

**In a self-hosted n8n** (Settings → Community Nodes → Install):

```
n8n-nodes-clearedby
```

**Local development** (this monorepo): build it and link it into your n8n install:

```sh
pnpm --filter n8n-nodes-clearedby build
cd packages/n8n-nodes-clearedby && pnpm link --global
# then in your n8n custom-extensions dir:
pnpm link --global n8n-nodes-clearedby
```

Restart n8n; **ClearedBy Gate** and **ClearedBy Trigger** appear in the node panel.

## Credential — `ClearedBy API`

| Field | Notes |
|---|---|
| **API Key** | Your `cb_live_…` key from ClearedBy → Settings → Integrations → API keys. Keys can only *request* clearance, never decide. |
| **Base URL** | Defaults to `https://app.clearedby.com`. Override for self-hosted / dev. |

The credential **Test** button hits `GET /v1/policies` to confirm the key works.

## Node — ClearedBy Gate

**1 input → 2 outputs:** `Cleared` and `Rejected / Expired`.

| Property | What it does |
|---|---|
| **Action** | The action to gate, e.g. `refund.create`. Your policy matches rules against it. |
| **Payload** | `All Item JSON` (send the whole item as params) or `Selected Fields` (a comma list). Your policy reads these (e.g. `amount`). |
| **Policy** | Loaded from your org; leave on **Org default**. |
| **Mode** | **Shadow** (default) never blocks — records what *would* happen and always continues on `Cleared`. **Enforce** parks the workflow on a `review` verdict until a human decides. |
| **Summary** | Optional one-line context shown to the reviewer. |
| **Timeout Override** | Override the policy's review deadline (seconds). `0` = policy default. |
| **On Reject** | Route to the 2nd output (default) · stop with an error · or continue on the 1st output with `clearedby.cleared = false`. |

Every emitted item gets a `clearedby` block merged in:

```jsonc
{
  "clearedby": {
    "id": "01J…", "status": "cleared",
    "decided_by": "policy:auto",      // or "user:<id>" for a human decision
    "rule": "rules[2]: refund.create amount<=500",
    "reason": null, "hash": "9f3c…", "shadow": false, "sampled": false
  }
}
```

### How waiting works

- **Shadow mode and auto-decisions are instant** — the node calls ClearedBy, gets the verdict, and continues. No waiting, nothing to set up.
- **When a human needs to approve (Enforce mode), the workflow pauses** and uses **no compute** while it waits — seconds or overnight, it doesn't matter. The moment a reviewer decides in Slack or the dashboard, the run **resumes on its own** and the item flows out of `Cleared` or `Rejected / Expired`. You don't poll, and you don't need a second workflow.

> **One held item per run.** A paused run resumes on the first decision, so the wait is meant for one gated action per execution. For many at once, gate one item per execution (e.g. **Split In Batches**) — or use the two-flow pattern with the **ClearedBy Trigger** node (below).

### One requirement: n8n must be reachable

To wake a paused run, ClearedBy sends the decision **to your n8n** — so your n8n has to be reachable from `app.clearedby.com`:

- **n8n Cloud** — works out of the box.
- **Self-hosted** — expose n8n to the public internet (set `WEBHOOK_URL` to your public address; for local testing, a tunnel like ngrok or Cloudflare Tunnel works). If ClearedBy can't reach your n8n, a paused run never resumes.

The **ClearedBy Trigger** node receives its events the same way, so the same requirement applies.

## Node — ClearedBy Trigger

The other half of the **two-flow** pattern: one workflow gates the action, a *separate* workflow reacts to the decision. The trigger fires whenever ClearedBy clears, rejects, or expires an action.

It rides the org-level **webhook subscriptions** (not the Gate node's per-item callback). On **activation** it registers exactly one subscription (`POST /v1/webhooks`, `source: n8n`); on **deactivation** it removes it (`DELETE /v1/webhooks/:id`). Every inbound event's `X-ClearedBy-Signature` HMAC is **verified before the workflow runs** — a forged or replayed POST is rejected with `401`.

| Property | What it does |
|---|---|
| **Events** | Which decisions fire the trigger: Cleared / Rejected / Expired (any combination). |
| **Action Prefix** | Only fire for actions starting with this prefix (e.g. `refund.`). Blank = all. |
| **Policy** | Only fire for decisions judged by this policy name. Blank = all. |

Each event arrives as:

```jsonc
{
  "event": "decision.cleared",
  "org_id": "01J…",
  "occurred_at": "2026-06-16T…Z",
  "data": {
    "id": "01J…", "action": "refund.create", "status": "cleared",
    "decided_by": "user:01J…", "rule": "rules[2]: …", "reason": null,
    "params": { "amount": 842 }, "attestation": { "seq": 512, "hash": "9f3c…" }
  }
}
```

So the second flow branches on `{{ $json.data.status }}` and acts with the original `params` — no lookup needed.

## Examples

Import via n8n → Workflows → Import from File:

- [`examples/form-to-gate.json`](examples/form-to-gate.json) — Manual trigger → sample refund → **ClearedBy Gate** → branch on Cleared / Rejected.
- [`examples/trigger-on-decision.json`](examples/trigger-on-decision.json) — **ClearedBy Trigger** → branch on the decision status → act. The second flow of the two-flow pattern.

## License

MIT
