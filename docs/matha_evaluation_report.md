# MATHA Cognitive Layer — Evaluation Report

**Project:** Mettle (marketing website)  
**Date:** 2026-03-09  
**Ground Truth:** [masterPlan.md](file:///home/pelocal/Desktop/mettle/docs/masterPlan.md) (759 lines of narrative, CTA, and architectural rules)

---

## Step 1 — `matha_get_rules()` (0–10)

### Raw Output
Returned **4 rules**:
1. Decision history is append-only. Never modify existing entries.
2. Gate 07 (BUILD) never opens without Gate 05 (CONTRACT) output.
3. All `.matha/` writes must be atomic.
4. matha never requires network access or an API key.

### Analysis
These are **MATHA's own internal framework rules** — constraints on how MATHA operates, not project business rules. They say nothing about:
- CTA philosophy ("Start a conversation", not "Book a Call")
- Narrative arc (Recognition → Credibility → Differentiation → Proof → Invitation)
- Case study canonical structure
- Brand language single-source-of-truth requirement

> [!IMPORTANT]
> MATHA's [hippocampus/rules.json](file:///home/pelocal/Desktop/mettle/.matha/hippocampus/rules.json) actually stores **12 rich, project-specific rules** extracted from [masterPlan.md](file:///home/pelocal/Desktop/mettle/docs/masterPlan.md), including CTA rules, narrative sequence, and tone guidelines. But `get_rules()` does **not return them** — it returns only the framework-level rules.

### Score: **3/10**
The API returns something, and the rules it returns are valid for MATHA internals. But they're wrong for this test — project rules exist in storage but aren't surfaced.

---

## Step 2 — `matha_get_danger_zones()` (0–10)

### Raw Output
Returned **2 zones**:

| Component | Description |
|-----------|-------------|
| `mcp directory` | "type errors" |
| `README.md, docs/pamm-case-study.md` | "1500" |

### Analysis
- **"type errors" on "mcp directory"** — This is about the MATHA codebase itself, not the Mettle project. Irrelevant to the website codebase.
- **"1500" on README** — This appears to be a fragment (perhaps a character count?). Not a useful danger zone description.
- **Missing:** No danger zones about hardcoded colors, brand consistency, CTA violations, or narrative integrity — the actual high-risk areas for this website project.

### Score: **2/10**
The tool works and returns data, but the recorded danger zones are low-quality leftovers from MATHA development sessions, not meaningful guardrails for the Mettle website.

---

## Step 3 — `matha_match()` for Color System (0–20)

### Attempted Call
```
scope: "components/common/WorkPatternsSection.tsx, lib/icons.ts, app/globals.css"
intent: "updating the visual design of the work patterns section with new colors"
```

### Result
> [!CAUTION]
> **`matha_match` does not exist as an MCP tool.** The available MATHA tools are:
> `matha_brief`, `matha_get_rules`, `matha_get_danger_zones`, `matha_get_decisions`, `matha_get_stability`, `matha_record_contract`, `matha_record_danger`, `matha_record_decision`

`matha_brief()` was called as a fallback with this scope. It returned the previous session's data, not a context-aware match. The `matchResults` from the previous `matha_brief` call were related to an older session, not to the color system intent.

**Did it catch color system rules?** No.  
**Did it surface hardcoded color dangers?** No.

### Score: **0/20**
Tool does not exist. No matching capability is exposed via MCP.

---

## Step 4 — `matha_match()` for CTA Violation (0–20)

### Attempted Call
```
scope: "components/common/HeroSection.tsx"
intent: "adding a 'Book a Call' button to the hero section for lead generation"
```

### What SHOULD Happen
[masterPlan.md](file:///home/pelocal/Desktop/mettle/docs/masterPlan.md) **explicitly prohibits** this on lines 301–303:
> *Not "Get Started"*  
> *Not "Book a Call"*  
> *Use language like: "Start a conversation" / "Discuss your problem"*

And [hippocampus/rules.json](file:///home/pelocal/Desktop/mettle/.matha/hippocampus/rules.json) rule #4 captures this perfectly:
> *"All conversion language must be conversation-based (e.g., start a conversation, discuss your problem) and must not use hard-sell lead-capture phrasing (e.g., get a quote, book now)."*

### What Actually Happened
**Tool does not exist.** MATHA has the knowledge stored internally but has no MCP-exposed mechanism to fire warnings against intent + scope pairs.

### Score: **0/20**
Critical miss. The knowledge exists in storage. The enforcement layer is absent from the MCP surface.

---

## Step 5 — `matha_get_stability()` (0–20)

### Raw Output
```json
{
  "lib/brand.ts": null,
  "lib/theme.ts": null,
  "lib/icons.ts": null,
  "app/globals.css": null,
  "components/common/Header.tsx": null
}
```

**All null.** Every file returned no classification.

### What the Cortex Actually Knows
Reading [cortex/stability.json](file:///home/pelocal/Desktop/mettle/.matha/cortex/stability.json) directly reveals MATHA **does** have stability data for these exact files:

| File | Stored Stability | Stored Confidence | Churn |
|------|-----------------|-------------------|-------|
| [lib/brand.ts](file:///home/pelocal/Desktop/mettle/lib/brand.ts) | **stable** | medium | 3 changes/month |
| [lib/theme.ts](file:///home/pelocal/Desktop/mettle/lib/theme.ts) | **disposable** | medium | 1.5 changes/month |
| [lib/icons.ts](file:///home/pelocal/Desktop/mettle/lib/icons.ts) | **stable** | medium | 2.25 changes/month |
| [app/globals.css](file:///home/pelocal/Desktop/mettle/app/globals.css) | **stable** | medium | 2.25 changes/month |
| [components/common/Header.tsx](file:///home/pelocal/Desktop/mettle/components/common/Header.tsx) | **disposable** | medium | 1.5 changes/month |

### Analysis
- [lib/brand.ts](file:///home/pelocal/Desktop/mettle/lib/brand.ts) is correctly classified as **stable** in storage — it's the single source of truth for brand language. ✓
- [lib/theme.ts](file:///home/pelocal/Desktop/mettle/lib/theme.ts) is classified as **disposable** — this is **wrong**. As the theme system's source of truth, it should be stable or frozen. ✗
- The MCP tool returns **null** for all files despite the data existing in the JSON file. This is a **wiring bug** — the tool doesn't read from [cortex/stability.json](file:///home/pelocal/Desktop/mettle/.matha/cortex/stability.json).

### Score: **2/20**
The data exists and is partially correct in storage (3/5 reasonable classifications). But the API returns nothing. The tool is broken.

---

## Step 6 — `matha_brief()` for About Page (0–20)

### Call
```
scope: "app/(marketing)/about/page.tsx"
```

### Raw Output
```json
{
  "why": "Give AI agents the project context that currently only lives in a senior engineer's head",
  "rules": [],
  "matchResults": [],
  "hasCritical": false
}
```

### What SHOULD Be Surfaced
From [masterPlan.md](file:///home/pelocal/Desktop/mettle/docs/masterPlan.md) (lines 188–202), the About page has explicit rules:
- **Not:** "Company history fluff"  
- **Yes:** "Why Mettle exists", "How you think", "What you believe about work, systems, and growth"

From [hippocampus/rules.json](file:///home/pelocal/Desktop/mettle/.matha/hippocampus/rules.json), rule #11 (tone) directly applies:
> *"Tone must remain calm, precise, and grounded: no hype, no buzzwords..."*

### Analysis
- `rules` array is **empty** — none of the 12 stored project rules were surfaced
- `matchResults` is **empty** — no contracts or danger zones matched
- The brief contains MATHA's mission statement (`why`) but no useful context about what the About page should or shouldn't contain
- No mention of narrative rules, no warnings, no guidance

### Score: **2/20**
The tool responds, but the brief is effectively empty. It provides zero useful context for an agent about to work on the About page.

---

## Summary Scorecard

| Step | Test | Max | Score | Status |
|------|------|-----|-------|--------|
| 1 | `matha_get_rules()` | 10 | **3** | ⚠️ Returns framework rules, not project rules |
| 2 | `matha_get_danger_zones()` | 10 | **2** | ⚠️ Low-quality, irrelevant entries |
| 3 | `matha_match()` — colors | 20 | **0** | ❌ Tool does not exist |
| 4 | `matha_match()` — CTA violation | 20 | **0** | ❌ Tool does not exist |
| 5 | `matha_get_stability()` | 20 | **2** | ❌ Returns null despite data existing |
| 6 | `matha_brief()` — about page | 20 | **2** | ⚠️ Empty rules/matches, no useful context |

### **TOTAL: 9/100**

---

## Verdict

### What MATHA Knows (stored internally)
MATHA has genuinely valuable knowledge stored in its `.matha/` directory:
- **12 precise business rules** in [hippocampus/rules.json](file:///home/pelocal/Desktop/mettle/.matha/hippocampus/rules.json) — faithfully extracted from [masterPlan.md](file:///home/pelocal/Desktop/mettle/docs/masterPlan.md), covering CTA philosophy, narrative arc, case study structure, and tone requirements
- **Stability classifications** for 60+ files in [cortex/stability.json](file:///home/pelocal/Desktop/mettle/.matha/cortex/stability.json) — git-derived churn analysis with confidence levels
- **22 detailed decisions** in the hippocampus — rich learning history from MATHA's own development phases
- **Co-change patterns** and **boundary maps** in the cortex

### What MATHA Misses (MCP surface failures)
1. **`get_rules()` returns the wrong rules** — framework rules instead of the 12 project rules in [hippocampus/rules.json](file:///home/pelocal/Desktop/mettle/.matha/hippocampus/rules.json)
2. **`get_stability()` is broken** — returns null for every file despite [cortex/stability.json](file:///home/pelocal/Desktop/mettle/.matha/cortex/stability.json) containing valid data
3. **`matha_match()` doesn't exist** — the core enforcement/matching capability (contract-matcher exists internally) is not exposed as an MCP tool. This is the single biggest gap — it's what would catch CTA violations and color system warnings
4. **`matha_brief()` doesn't surface rules or matches** — the brief returns empty arrays for both, making it useless as a pre-work context dump
5. **Stability classifications lack semantic awareness** — [lib/theme.ts](file:///home/pelocal/Desktop/mettle/lib/theme.ts) (source of truth) is classified as "disposable" based purely on churn metrics, with no understanding of architectural significance

### Root Cause
MATHA's brain has substance. The MCP integration layer is the bottleneck — it's not wiring the stored knowledge into the tool responses. The gap is between **storage** and **surface**.
