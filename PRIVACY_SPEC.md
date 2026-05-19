# Privacy & Anonymization Spec (v0.5)

**Status:** Spec only — not implemented. Surfaced 2026-05-18 during the OSS prep pass for v0.2.

This document specifies what `prompt-guard` v0.5 needs to do to make corpus ingestion privacy-safe by default. The motivation came from preparing v0.2 for public release: scrubbing client identifiers from the codebase and git history exposed how easily a corpus owner's private data could leak into:

- Code system prompts (ICL examples train on real corpus content)
- Documentation examples (showcase outputs name real entities)
- Eval result writeups (per-pair findings reference real prompts)
- Git history (commit messages mention client work in narrative)

**The whole point of `prompt-guard` is other developers using it on their own corpus.** Without anonymization, every adopter will have to do the same manual scrub before sharing anything derived from their corpus — design docs, demo videos, blog posts, eval baselines they want to publish, README examples, even casual screenshots in Slack. Most won't, and will leak.

---

## Problem statement

The v0.2 corpus stores raw user prompts, raw assistant responses, raw file paths, raw URLs. The local `~/.prompt-guard/corpus.db` and `~/.Trash` snapshots are full-fidelity copies of whatever was in the source JSONL files — typically:

- **Personal identifiers:** the developer's name in prompts, their family members, friends, addresses
- **Client identifiers:** customer names, project codenames, employee names, meeting attendees
- **Brand/product names:** real product names referenced in dev work
- **Infrastructure identifiers:** deployed URLs, IP addresses, server hostnames, internal subdomain names
- **Credentials:** API keys casually pasted into prompts during debugging (observed in this project's own dev corpus: `sk-` prefixed third-party LLM keys leaked through user messages)
- **Financial info:** dollar amounts in business context (revenue, salaries, deal sizes)
- **Path information:** absolute paths revealing home directory, OS username, mounted volumes

Even tools that consume the corpus locally (the eval harness, the `learn` command) embed corpus content into outputs:

- `learn` retrieves past prompts and feeds them to the question generator → questions reference real entities
- `eval` writes gold clarifications into `eval_cases` → JSON dumps of real text
- `corpus stats` samples 5 random prompts per top-3 project → screenshot-able output with real content

**Current mitigation:** none, beyond the self-referential project exclusion (which only filters one project).

---

## Goals

1. **Ingest-time anonymization** — apply entity replacement during corpus ingestion, before any downstream consumer touches the data. Single point of control.
2. **Reversible mapping** — store the entity ↔ placeholder map locally (encrypted), so the developer can de-anonymize their own outputs if they want full-fidelity local use, while shared outputs stay scrubbed.
3. **Opt-in by flag (`--anonymize`)** initially, **opt-out by flag (`--no-anonymize`)** after one minor version.
4. **Privacy-preserving by default** for new corpora ingested after v0.5 lands. Existing v0.2 corpora can be re-ingested with `--anonymize` or migrated via a `prompt-guard anonymize-existing` one-shot.
5. **No external services.** Entity detection runs locally. (Sending corpus data to a cloud NER API would defeat the purpose.)

---

## What gets anonymized

| Category | Detection | Replacement |
|---|---|---|
| Personal names (first/last) | Local NER model (see "Detection" below) | `[Person]`, `[Person 1]`, `[Person 2]`... stable per-name |
| Email addresses | regex `[\w.-]+@[\w.-]+\.\w+` | `[email]`, `[email 1]`... stable |
| Phone numbers | regex (multiple formats) | `[phone]` |
| API keys | regex `(sk-|pk-|api[_-]?key=)[\w-]{16,}` plus known prefixes (Anthropic `sk-ant-`, OpenAI `sk-`, Stripe `pk_*`/`sk_*`, etc.) | `[redacted-key]` — irreversible |
| Credit cards | regex `\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b` | `[redacted-card]` |
| Absolute paths | regex `/Users/\w+`, `/home/\w+`, `C:\\Users\\\w+` | `~/` (or `[home]/`) |
| URLs to non-public hosts | parse + check against allowlist (github.com, npm, openai, anthropic, etc.) | `[internal-url]` for non-allowlisted, keep allowlisted as-is |
| IP addresses | regex IPv4/IPv6 | `[ip]` |
| Dollar amounts > $1k | regex `\$[\d,]+` parsed | `[amount]` (optional — off by default; opt-in via `--scrub-money`) |
| Org/product names | NER + user-configured `customEntities` list in `.prompt-guard.json` | `[Company A]`, `[Product B]` stable per entity |

**Conservative defaults.** False positives are recoverable (entity-map lookup); false negatives leak. Bias toward over-scrubbing.

---

## Detection

**Two-tier approach:**

1. **Regex tier (fast, deterministic):** emails, phones, API keys, paths, URLs, IPs, credit cards, dollar amounts. No model required. Runs at ingest time, ~negligible cost.
2. **NER tier (model-based, opt-in):** personal names, org names, product names. Two options:
   - **Local Hugging Face model** (e.g. `dslim/bert-base-NER` or `Davlan/distilbert-base-multilingual-cased-ner-hrl`). Requires Python + transformers runtime. Bundles ~250MB model. Privacy-safe (fully local).
   - **Configured allowlist + custom-entity list in `.prompt-guard.json`** — opt-in user-curated entities. Faster than NER, no model bundle. Coverage limited to what the user lists.

**Default v0.5:** regex tier + custom-entity list. NER tier is documented as an opt-in extension. (Bundling a 250MB Python model in an npm CLI is a hard sell for v0.5; revisit if NER coverage gap matters.)

---

## The entity map

A local file `~/.prompt-guard/entity-map.json.enc`, encrypted with a key derived from a passphrase the user sets on first `--anonymize` run. Schema:

```json
{
  "version": 1,
  "createdAt": "ISO8601",
  "salt": "base64",
  "entities": {
    "[Person 1]": "Acme Founder",
    "[Person 2]": "Beth Smith",
    "[Company A]": "ActualClient Inc",
    "[email 1]": "ceo@actualclient.com",
    "[ip]": "10.0.0.42"
  }
}
```

**Stability:** the same source entity always maps to the same placeholder across runs (deterministic via salt + hash). New entities get new sequential IDs.

**Read access:**
- `prompt-guard learn` uses the anonymized corpus by default. To de-anonymize the questions it surfaces for the local user, decrypt the entity map and reverse-substitute before printing. Output to the developer is fully readable.
- `prompt-guard eval` operates on the anonymized corpus throughout. eval_cases stay anonymized. When reviewing failures, the developer can run `prompt-guard reveal <case-id>` to decrypt that specific case's content.

**Sharing:**
- The corpus DB itself is anonymized — safe to attach to a bug report, blog post, screenshot.
- The entity-map file is NEVER shared. `.gitignore` includes `entity-map.json.enc`.
- If the developer wants to share with a co-worker who needs the originals, they can transfer the map file out-of-band.

---

## CLI changes

```bash
# v0.5
prompt-guard ingest --source all --anonymize           # opt-in for v0.5
prompt-guard ingest --source all                       # without flag: warning + suggestion

# v0.6 (one version later)
prompt-guard ingest --source all                       # anonymize by default
prompt-guard ingest --source all --no-anonymize        # opt-out

# new commands
prompt-guard anonymize-existing                        # re-process existing corpus.db
prompt-guard reveal <eval-case-id>                     # de-anonymize one case
prompt-guard entities list                             # show entity-map summary
prompt-guard entities add "ActualClient Inc" "[Client A]"  # manual entry
prompt-guard entities export > entities.json          # for backup
```

---

## PRIVACY.md (separate user-facing doc, ships with v0.5)

A short doc that explains, in plain English:
- What data prompt-guard reads from your machine
- What it stores locally and where
- What gets sent to Anthropic when you run `learn` or `eval`
- How `--anonymize` works
- What it does NOT do (no automated re-scrubbing of existing committed git history)
- How to fully purge: `prompt-guard purge` deletes the corpus DB + entity map + snapshots

---

## Migration path for v0.2 → v0.5

1. Ship v0.5 with `--anonymize` flag on `ingest`.
2. v0.5 release notes call out: "Existing v0.2 corpora are not anonymized. To migrate, run `prompt-guard anonymize-existing` (one-shot, ~30s per 1k prompts)."
3. The migration command: walks every row in `prompts`, `clarifying_pairs`, `eval_cases` and applies the regex/NER scrub. Builds the entity-map. Writes a new schema column `anonymized_at TEXT`.
4. After migration, `prompt-guard corpus stats` flags rows where `anonymized_at IS NULL` — surfaces any partially-migrated state.

---

## Out of scope for v0.5

- **Differential privacy on outputs.** The system retrieves raw past prompts and feeds them to an LLM. Even with anonymization, two correlated retrieved prompts can fingerprint a developer's work patterns. DP would require synthesizing past prompts, which is its own project. Defer to v1.
- **Audit trail.** Logging which entities were detected/replaced for a given ingest run. Useful for compliance but adds complexity. Defer.
- **Network-level isolation.** Preventing the user from accidentally pasting their raw corpus into a different LLM via copy/paste. Out of scope — that's a separate tool category.

---

## Effort estimate

- **Regex tier:** ~4 hours (regex patterns, replacement logic, write-through at ingest)
- **Entity map encryption + storage:** ~3 hours (using `crypto.scrypt` + AES-GCM via node stdlib)
- **`reveal`, `entities`, `purge` commands:** ~4 hours
- **PRIVACY.md drafting:** ~2 hours
- **Migration command + schema column:** ~3 hours
- **Tests covering: regex coverage, entity map round-trip, migration idempotency:** ~4 hours
- **NER tier (deferred to v0.6+):** ~1 day minimum, includes model bundling decision

**v0.5 scope (regex tier only):** ~20 hours of focused work. Defer NER.

---

## Open questions

1. **Should the entity map be encrypted at rest, or just gitignored?** Encryption adds friction (passphrase prompt). For a personal-dev-machine tool, gitignored may be enough. Decision point at start of v0.5 work.
2. **Should `learn` output be auto-anonymized for shared use?** Default could be: print the de-anonymized version to the terminal, but offer `prompt-guard learn --share` that prints the anonymized version for paste into a Slack message / Twitter thread.
3. **What happens when a corpus is ingested from a teammate's machine?** Their entity-map is different. Either re-anonymize on import (slow) or accept that cross-developer corpora can't share entity-maps. Probably the latter.
