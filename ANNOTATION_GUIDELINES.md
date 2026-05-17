# Annotation Guidelines — Hand-Label Gold Subset

> Reference doc for the 90-min hand-labeling pass. Read this before starting,
> keep it open as your anchor if you split the session across evenings.
>
> Goal: produce a clean gold subset of 66 unique `(originating prompt, clarifying prompt)` pairs that the eval harness can backtest against.

---

## What you're deciding for each pair

For each pair the TUI shows you:
- **ORIG** — your earlier prompt (sometimes vague, sometimes a question)
- **CLAR** — a later prompt (usually within 3 turns) that the LLM thinks clarified ORIG
- **LLM's verdict** — proposed `kind` + cleaned `text` + reasoning

Your job:
- **[a] Accept** if the pair IS a real clarification, kind is right, text is good
- **[k] Fix-kind** if real clarification but kind is wrong — pick the correct kind
- **[e] Edit-text** if real clarification but the LLM's wording could be sharper
- **[r] Reject** if NOT a real clarification (paste-back, topic drift, etc.)
- **[s] Skip** if you're unsure — comes back next session
- **[q] Quit** any time; everything labeled so far is saved

---

## The 5 kinds, defined

| Kind | When it applies | Example clarification |
|---|---|---|
| **file-scope** | CLAR specifies *which* files/dirs/modules/paths to touch, create, or modify | "modify `dashboard.py` and `engine.py`, not the test files" |
| **success-criteria** | CLAR specifies *what success looks like* — pass conditions, target metrics, required behaviors | "should match Christian Guzman's tone — grind mentality but humble" |
| **constraint** | CLAR specifies what *not* to do, what *must not* change, prohibited approaches | "Don't break the existing `/api/v1/*` endpoints" |
| **data-shape** | CLAR specifies a type, schema, columns, fields, enum values | "the response should have `{id, name, last_seen_at}` columns" |
| **ui-detail** | CLAR specifies visual or interaction specifics — color, spacing, font, layout, behavior | "blue header, 16px Inter, cards collapse on click" |
| **other** | Real clarification but doesn't fit the above (see below) | "meeting notes adding domain context the AI needs" |

---

## Decision rules for edge cases

These are the rules to apply consistently across the session:

### Rule 1: CLAR must be human-typed (or human-edited) to count

If CLAR is a paste-back of:
- Tool output ("Test report: ... Pass ...")
- Shell session output ("`Last login:` ... `main@the developers-Mac-mini`")
- A list of files / data dump
- A document or message you forwarded

→ **Reject**, even if the content happens to match a kind regex.

Mixed cases (Mohammed-typed prefix + pasted content): accept ONLY if the human-typed part substantively clarifies ORIG. Otherwise reject.

### Rule 2: CLAR must be topically connected to ORIG

If CLAR is on a completely different topic that happens to be sequential, **reject** as topic drift. Same project but different sub-task usually = reject. Same sub-task with new specifics = accept.

Example reject: ORIG asks about API keys, CLAR is a new request to rewrite ad copy. Same project (DemoSaaS), different task.

Example accept: ORIG asks to build a dashboard, CLAR says "use Inter font, blue header". Same task, new specifics.

### Rule 3: When multiple kinds apply, prefer the most-actionable specific

Priority order (most-specific → fallback):
1. **file-scope** beats **ui-detail** if both apply — knowing *which* file beats knowing *how* it looks
2. **constraint** beats **success-criteria** if both apply — "don't X" is stronger guidance than "should Y"
3. **data-shape** beats **file-scope** if both apply — the schema constrains what the file does
4. Pick whichever the LLM's text BEST captures; if its text emphasizes one, go with that

### Rule 4: "Other" is for real clarifications outside the 5 kinds

The most common `other` pattern in YOUR corpus: **meeting notes / domain context delivered after ORIG promised them**. E.g., ORIG = "ingest the iMessage, then I'll send you meeting notes" → CLAR = the meeting notes themselves.

These ARE real clarifications — they ground the AI in business reality ORIG referenced but didn't include. Accept as `other`.

If `other` cases cluster around a coherent pattern during your labeling (e.g., "meeting notes" or "external-context"), surface that to me at the end of the session — it's likely a taxonomy gap we should add as a 6th kind in a v0.5 schema bump.

### Rule 5: Anticipated deliveries DO count as clarification

If ORIG says "I'll send X next" and CLAR delivers X — accept as a clarification. ORIG was deliberately incomplete; CLAR completed it.

### Rule 6: Short ORIG ("yes", "yeah", "ok") + substantive CLAR

The rule extractor mostly filtered these out (originating must be ≥40 chars), but some still slip through via the LLM accept path. **Generally reject** — there's nothing to clarify about a one-word ack. CLAR may be substantive but it's not clarifying ORIG, it's just the next instruction.

### Rule 7: LLM kind-conflict cases (5 in your corpus)

When the TUI shows `⚠ LLM CONFLICT — other verdicts: X, Y`:
- The LLM gave different kinds for the same content across duplicate rule rows
- Pick the kind that best captures CLAR's primary clarification
- Use Rule 3 (priority order) as a tie-breaker
- Use `[k]` to override if the displayed primary kind isn't your pick

### Rule 8: When in doubt, prefer the LLM's call

The LLM has full context, was trained on huge data, and got 8/10 calls right in the dry-run. Override only when you see a clear pattern it missed. Avoid second-guessing borderline calls; consistency beats perfection.

---

## Worked examples from your corpus

### Example 1: Clean accept — kind matches rule
ORIG (turn 26): "do them all, fix it permanently and make it seamless and hands off"
CLAR (turn 40): "i want it to update the leads.md drafts.md etc in the mission control repo in github directly"
LLM: kind=file-scope, text="update leads.md, drafts.md, etc. directly in the mission control GitHub repo"

**Action: [a] accept.** Clean file-scope. LLM's text is sharper than CLAR.

---

### Example 2: Accept with kind refinement
ORIG: "i just restarted the server. plz get started on the other 2."
CLAR: "You need to add an 'Agentic Campaign Builder' page and backend to `dashboard.py`..."
Rule kind: constraint (matched on "DON'T make HTTP requests")
LLM kind: file-scope (refined)

**Action: [a] accept.** LLM's refinement is correct — the constraint phrase is incidental; the real clarification is file-scope (which file/page to build).

---

### Example 3: Reject — paste-back
ORIG: "go check the messages i just sent and make 5 like it"
CLAR: "Here's the list of Claude tips & tricks I've been compiling..." [long list]
LLM: kind=file-scope, text="added file(s): CLAUDE.md, MEMORY.md, AGENT.md"

**Action: [r] reject.** CLAR is a paste-back of tips you'd compiled, not a human clarification of "5 like it". The extracted files are coincidental matches.

---

### Example 4: Accept as "other" — Acme meeting recap
ORIG: "ok go ahead and take alook at the latest message in the open imessage chat with the brothers... ill send u meeting notes from when i met them in person along with some to do items"
CLAR: "Areas of the business they wanna automate: * CMO, CTO and the Acme co-founders were there..." [long meeting notes]
LLM: kind=other, text="meeting notes from in-person session: brothers want automation across reporting, SOPs, web dev, image gen..."

**Action: [a] accept (or [k] if a better kind exists).** ORIG anticipated this delivery; CLAR fulfills it with concrete business context. `other` is right per Rule 4 — these meeting recaps don't fit the 5 specific kinds. Track if you see ≥5 of these during labeling.

---

### Example 5: Borderline reject — topic drift
ORIG: "can we not use the current anthropic subscription youre running on thru oauth?"
CLAR: "You are a senior social media strategist. Generate a complete social media content package..."

**Action: [r] reject.** ORIG asks about API auth; CLAR is an unrelated content-gen prompt. Sequential, not clarifying.

---

## Patterns specific to your corpus (so far)

From the LLM verdicts I've reviewed:

1. **Meeting recaps cluster in `other`** (~23 of 94 LLM verdicts). All Acme-meeting style. Most likely a missing taxonomy kind (`external-context` or `domain-grounding`).
2. **The LLM often refines constraint → file-scope** when the regex matched on "DON'T" / "never" inside a CLAR whose real purpose is specifying files. Trust these refinements.
3. **Paste-backs are the dominant rule false positive.** When you see CLAR starting with `Here's the [X]`, `Last login:`, `main@`, or all-caps headers — likely reject even if LLM accepted.
4. **Eval AI marketing pairs** are mostly the same Acme-meeting recap appearing under different rule kinds. Dedupe handles most; what's left is consistent.
5. **DemoSaaS Automation is your richest source** — 86 of 94 LLM accepts (after dedupe: most of 60+ unique pairs). Expect varied kinds; most labeling time will be here.

---

## After the session

Once you've labeled all 66 (or wherever you stop), surface to me:
- Total accepted / rejected counts
- Per-kind distribution
- Any patterns in the `other` bucket that suggest a missing kind
- Any rule overrides you'd want me to fix in the rule extractor for next corpus

I'll commit the gold subset and we'll move to MVP-2.
