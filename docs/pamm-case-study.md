# The 12-Day Debugging Nightmare That Built MATHA

---

## The Project

A friend needed a platform to track pooled PAMM trading. Each investor in the pool had a share. The broker managed the trades. The platform needed to calculate who earned what, when, and from what.

It sounded manageable: track money, show profits. The implementation surface was familiar — auth, KYC, deposits, withdrawals, dashboards. Standard CRUD. That part was fine.

The real problem was the core: the P&L cycle, the commission engine, and the promotional income calculations.

**HWM** — High Water Mark. Profit is only calculated when the account value exceeds its previous peak. Sounds simple. The implementation of "previous peak" is not.

**Referral commissions** — slab-based, not flat percentages. Paid across indirect chains. Different rules from promotional income, which only touches direct referrals.

**Promotional slabs** — income calculated on different bases depending on a pyramid of referral depth. Different levels, different rates, different triggers.

**Deposit events** — must not trigger profit cycles. This rule exists because of how the cycle calculation is structured. It is not obvious from the code. It lives only in the mind of someone who has built it once and watched it break.

The platform was built using Cursor, Claude, and other agentic AI tools. Full agentic workflow. The kind that is impressive until the project reaches a certain size.

---

## What Went Wrong

V1 was delivered. The client — the friend — said it was wrong.

Not wrong in the way bugs are wrong. Wrong in the way that what he wanted and what he conveyed were different things. The HWM calculation was using opening balance, not `max(opening, previous_peak)`. The difference seems small. In a long-running pool, it changes every number in the system.

V2 had to be built.

The AI was given full code access. The changes were explained. A two-hour Q&A session clarified every business rule. The AI asked good questions. The session felt productive.

Then it built V2.

- V1 logic was kept alongside V2 in multiple places. The AI did not know which parts of V1 were superseded and which were still valid.
- Preview calculations and actual calculations diverged. Different paths through the same logic, different results.
- Deposit events could trigger profit cycles. The rule against this was never written down. It had been caught manually in V1. In V2 it came back.
- Hallucinated profit cycles appeared — cycles triggered by conditions that should not have triggered them.
- No validation layer existed to catch any of this before client review.

Building V2 took four days.

Making V2 run correctly took twelve days. Five rounds of testing with the client. At some point during those twelve days, the builder — the person who had built both V1 and V2 — could no longer reconstruct confidently why certain parts of the core were written the way they were. The context had been spread across so many sessions, so many conversations, so many corrections, that even the person closest to it had lost confidence.

When a bug appeared on day eleven, the question was not "what is wrong." The question was "which part of the logic is responsible, given everything that changed across every session."

There was no answer on file.

---

## Why It Happened

Three types of knowledge were never captured anywhere.

**Business knowledge** — lived in the client's head. HWM meant `max(opening_balance, previous_peak)`, not just `max(0, close - open)`. This distinction was clarified verbally in a session. It was not written down. The AI never knew. Every new session started without it.

**Decision knowledge** — lived in the builder's head. Why V1 was structured a certain way. What assumption V2 was correcting and where. When the builder lost confidence — after twelve days inside a codebase that had been rebuilt once and patched many times — the AI had no way to reconstruct it. The AI only knew what was in the context window of the current session.

**Evolution knowledge** — existed nowhere. The arc from V1 assumption → where it broke → V2 correction was never recorded. The AI treated V1 remnants and V2 additions as a single codebase. It had no concept of which code superseded which, or why, or in what bounded area. When told to "fix the commission engine," it had no way to know that parts of the commission engine were intentionally left from V1 and parts were intentional V2 replacements.

This was not an AI capability problem. Claude, Cursor, and Copilot all performed correctly within the limits of what they were given. They were given a stateless context window, a large codebase, and a description of what to change. They produced reasonable output given those inputs.

The problem was architectural. No tool existed to hold the knowledge that only emerges through building.

---

## What MATHA Would Have Done

If MATHA had been running from day one, the `.matha/` directory would have accumulated this:

**After `matha init` — seeded from the first conversation:**

```
WHY: Track P&L and commissions for a pooled PAMM trading platform

RULES:
  · HWM: profit = close - max(opening_balance, previous_peak)
  · Commission slabs: tiered by referral depth, not flat percentage
  · Referral chain: indirect only — direct referrals go through promotional income
  · Promotional income: direct referrals only, separate slab table
  · Deposit events must NOT trigger profit cycle calculations
  · Profit cycles run on trading close events, not deposit events

NOT IN SCOPE:
  · Tax calculation
  · Trade execution or order routing
  · Regulatory compliance or reporting
```

Every subsequent session would have started with this context. The AI could not have forgotten what HWM meant, because MATHA surfaces it before the AI touches anything.

**After V1 delivery and client feedback (`matha after`, day 4):**

```
DECISION RECORDED:
  component: hwm_calculator
  previous_assumption: profit calculates from opening_balance
  correction: profit must use max(opening_balance, previous_peak)
  trigger: client_review_session_1
  confidence: confirmed

DANGER ZONE RECORDED:
  component: commission_engine
  pattern: deposit events in same cycle as trading close
  description: Deposit events can trigger false profit cycles.
  Validate event type before running commission calculation.
```

**Before V2 development (`matha before`, day 5):**

Gate 04 — Surface Danger — would have fired:

```
⚠  DANGER ZONE MATCH: commission_engine
   Prior failure: deposit events can trigger false profit cycles.
   Validate event type before running commission calculation.

⚠  DECISION MATCH: hwm_calculator
   Previous assumption was wrong: profit used opening_balance.
   Correction: use max(opening_balance, previous_peak).
   Recorded after: client_review_session_1.
```

Gate 05 would have required a contract before building:

```
CONTRACT FOR THIS SESSION:
  · HWM uses max(opening_balance, previous_peak) — not opening_balance
  · Deposit events do not trigger profit cycle
  · V1 commission paths are removed, not left alongside V2
  · Preview and actual calculations share the same core function
```

The AI cannot start building until this contract is written. After the session, `matha after` validates each assertion. If any fail — if deposit events still trigger profit cycles — the violation is recorded and surfaces automatically in the next session.

**The timeline, compressed:**

| Day | Without MATHA | With MATHA |
|-----|--------------|------------|
| 1 | Sessions begin, context lives in chat | `matha init` seeds HWM rule, deposit rule, slab structure |
| 4 | V1 delivered, client feedback given verbally | `matha after` records HWM correction as confirmed decision, deposit danger zone written |
| 5 | V2 begins, AI has no memory of V1 problems | `matha before` surfaces HWM danger zone, deposit danger zone. AI reads contract before writing a line. |
| 6 | — | V2 built with correct HWM. Contract validates deposit events. No V1 remnants — contract says they must be removed. |
| 7 | — | Client confirms. Done. |
| 4–16 | 12 days of debugging, 5 client review rounds | — |

The twelve-day debugging period does not happen because the conditions that created it — lost context, silent assumption from V1, unrecorded HWM rule — cannot exist when MATHA is running.

---

## The Broader Pattern

This was not a skill failure. The builder was competent. The AI tools were capable. The process — elaborate, communicative, iterative — was reasonable given the tools available.

It was an architectural absence.

Every project that reaches a certain complexity hits this ceiling. The codebase becomes too large to hold in a context window. The business logic becomes too subtle to reconstruct from reading the code. The distance between what the client wants and what the AI produces grows wider with every session that starts cold.

The tools that exist — Cursor, Copilot, Claude Code, Windsurf — are powerful and amnesiac in equal measure. They do not accumulate. Every session, they start from zero.

MATHA is the accumulation layer.

It is what the senior engineer carries after three years on a project — the why behind every decision, the scars from every production incident, the rules that cannot be broken and the code that cannot be touched without knowing why it works the way it does. Except it is machine-readable, automatically maintained, and survives session boundaries.

The code gets better. The context never resets. The brain stays on.

---

## Try It On Your Next Project

Start with `matha init` before the first AI session. Answer the questions honestly — especially the "what can go wrong" ones. The brain you build in session one is the context you receive in session ten.

See the [README](../README.md) for installation and setup.
