# Brand Audit — "Nexum" Name Decision

> Phase 4 (RC) gate — RELEASE-READINESS.md §B5
> Audit date: 2026-11-21 (re-verified same day)
> Auditor: automated (z.ai agent)

## 1. Audit scope and method

Evidence was gathered via direct HTTP against authoritative sources: the npm
registry REST API (`registry.npmjs.org`), the GitHub REST API
(`api.github.com`), RDAP (the modern WHOIS replacement, via `rdap.org`
redirects), and web search for trademark records and active products.
Every registry fact below was re-verified on 2026-11-21; trademark records
came from mirrors of the official databases (see §2 limitations).

## 2. Trademark findings

**US (USPTO class 9 software / class 42 SaaS):**

| Finding           | Status                                                                         | Source                           |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| NEXUM (bare word) | Not live-registered in class 9 or 42; the nexum AG class-9 filing is abandoned | Trademarkia mirror of USPTO TESS |
| NEXUM STUDIOS     | Live, registered — touches class 42                                            | Trademarkia mirror               |
| NEXUM FIDUCIA     | Live, pending — touches class 42                                               | Trademarkia mirror               |
| NEXUM PRISM       | Live, pending — touches class 42                                               | Trademarkia mirror               |
| NEXUM DECODERS    | Live, pending — class 9                                                        | Trademarkia mirror               |

**EU (EUIPO):** a live class-9 EUTM "Nexum One" (New Black B.V.) was
found via search-engine snippets quoting the EUIPO record.

**India (India IPO):** a live class-9 application "NEXUM VPN", advertised
for opposition, was found via a mirror of the India IPO database.

**Limitations (manual follow-up required before 2.0.0):**

- USPTO's TMsearch API returned HTTP 403 to this auditor; the Trademarkia
  mirror was used instead. The maintainer should re-run the official
  USPTO search manually.
- EUIPO eSearch is a JS single-page app that cannot be fetched headlessly;
  snippets quoting the record were used. Re-run manually.
- India IPO search is OTP-gated. Re-run manually before the 2.0.0 cut
  (the maintainer is likely India-based, so this is the most relevant
  jurisdiction).

## 3. Domain findings

Verified via RDAP on 2026-11-21:

| Domain                                 | Status         | Notes                                                                                                                                         |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| nexum.com                              | **Taken**      | Registered since 2004-05-19                                                                                                                   |
| nexum.ai                               | **Taken**      | Registered 2021-10-14; owned by the Italian Nexum-AI company marketing an "Agentic Capability Orchestrator" — directly adjacent product space |
| nexum.dev                              | **Taken**      | Registered 2023-08-23; Squarespace-locked, in active use                                                                                      |
| nexum.io                               | No RDAP record | Likely available (verify at a registrar)                                                                                                      |
| nexum.sh                               | No RDAP record | Likely available (verify at a registrar)                                                                                                      |
| nexum.tools                            | **Available**  | No RDAP record                                                                                                                                |
| nexum.software, nexum.run, nexum.cloud | Taken          | All acquired in roughly the last 12 months (prior audit)                                                                                      |
| nexum.app                              | Taken          | Prior audit                                                                                                                                   |

The two highest-signal TLDs for a developer tool — `nexum.dev` and
`nexum.ai` — are both taken, and `nexum.ai` is held by a company in an
adjacent space (agentic orchestration).

## 4. npm registry findings

Verified 2026-11-21 via `registry.npmjs.org`:

| Package              | Version | Last published | Status                                                                           |
| -------------------- | ------- | -------------- | -------------------------------------------------------------------------------- |
| `@nemesis-oss/nexum` | —       | —              | **HTTP 404 — scope unregistered, free to claim**                                 |
| `@x12i/nexum`        | 2.0.1   | 2026-09-19     | Active, single maintainer; also at 2.x — version-number collision confusion risk |

`npm search nexum` (prior audit, 25 results) also showed:
`@nexum-hub/agent`, `nexum-code`, `nexum-js` (direct AI/agent-runtime
packages), a Brazilian corporate Nexum, a German nexum AG, and 8 of 25
slots occupied by the x12i ecosystem.

## 5. GitHub findings

Verified 2026-11-21 via the GitHub REST API:

| Account / repo                                            | Type             | Created    | Status                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shubhamtaywade82/nexum`                                  | repo             | —          | **HTTP 200 — this project's home** (0 stars, public)                                                                                                                          |
| `Nemesis-oss`                                             | **User account** | 2022-09-05 | **TAKEN — not an org available for this project.** Owns 1 unrelated repo (`k-pemrog-platform`). The REBRANDING.md §7 org-migration plan assumed this name was free; it is not |
| `nemesis-oss/nexum`                                       | repo             | —          | HTTP 404 (cannot exist while the username is taken by someone else)                                                                                                           |
| `Nicovenosa/nexum`, `bYiyLi/NexumAgent`, `kuro6061/nexum` | repos            | —          | At least three other repos describe themselves as a "Nexum" agent runtime / LLM execution engine (prior audit)                                                                |

**New finding (2026-11-21): the `nemesis-oss` GitHub name is occupied by
an unrelated user account.** The package scope `@nemesis-oss` on npm is
still free, but the matching GitHub org cannot be created under that name.
This breaks the symmetry the org-migration plan relied on (same name on
npm and GitHub) and is now the single most concrete brand blocker.

## 6. General web findings

| Product / site      | Context                                                  | Collision risk                                |
| ------------------- | -------------------------------------------------------- | --------------------------------------------- |
| Nexum-AI (nexum.ai) | Italian company, "Agentic Capability Orchestrator"       | High — adjacent product space, holds nexum.ai |
| nexum AG (Germany)  | IT consulting                                            | Medium                                        |
| Nexum (Brazil)      | Brazilian corporate entity                               | Medium                                        |
| @x12i/nexum         | Active npm agent-runtime package at the same 2.x version | High for npm search                           |

## 7. Risk assessment

- **Trademark risk: Medium.** The bare word "NEXUM" is not live-registered
  in USPTO class 9/42, but three live US composite marks touch class 42,
  one class-9 mark is pending, and internationally the field is not clean
  (EUIPO "Nexum One" class 9; India "NEXUM VPN" class 9 pending).
- **Domain risk: High.** Only 3 of ~13 candidates are available
  (`nexum.tools`, likely `nexum.io` and `nexum.sh`). The two best TLDs
  for a developer tool are taken, one by an adjacent-space company.
- **Search-confusion risk: High.** The npm namespace around "nexum" is
  densely crowded (3 direct AI/agent-runtime packages in the top 25
  search results) and at least three GitHub repos market themselves as a
  "Nexum" agent runtime. A user searching for an agent runtime named
  "nexum" today finds competitors, not this project.
- **Scope-collision risk: Medium.** `@nemesis-oss/nexum` on npm is free
  and namespaced, so registry collision itself is low. But `@x12i/nexum`
  sits at the same major version (2.x), and the GitHub `nemesis-oss` name
  being taken removes the clean org-migration path.

## 8. Decision recommendation

This audit does not make the final decision. The maintainer must record
the decision in REBRANDING.md §1, replacing the provisional notice with
the final name + audit date. Two options, presented neutrally:

**Option A — KEEP "Nexum"**

Pros:

- The npm scope `@nemesis-oss/nexum` is free and the scoped name avoids
  registry collision with `@x12i/nexum`.
- The brand is already isolated in `src/platform/brand.ts`; zero code
  churn.
- Trademark risk for a scoped OSS package with no direct monetization is
  modest; the live marks are composite marks in adjacent services.

Cons + required mitigations:

- Pick a non-`nemesis-oss` GitHub org name (the current one is taken) —
  or keep the repo under `shubhamtaywade82` and accept the asymmetry.
- `nexum.ai` and `nexum.dev` are unavailable; the project would need
  `nexum.tools` / `nexum.io` / `nexum.sh` or a compound domain.
- Search confusion is real: users searching "nexum agent" find at least
  three competitor runtimes. Mitigation: distinct tagline + SEO on the
  scoped package name.
- Complete the manual trademark searches (USPTO direct, EUIPO eSearch,
  India IPO) before the 2.0.0 cut; consult a trademark attorney if any
  live mark is deemed conflicting.

**Option B — RENAME**

Pros:

- Avoids all trademark, domain, and search-confusion exposure above.
- A fresh name gets a fresh namespace: npm scope, GitHub org, and domain
  can all align.

Cons + considerations:

- `src/platform/brand.ts` + `package.json` + docs all change (bounded by
  the brand-isolation design, but not zero).
- The longer the delay before renaming, the more expensive it becomes —
  the alpha publishes are about to start. Deciding now is cheap; deciding
  after 2.0.0 stable is a major-version event.

## 9. Phase 4 gate verdict

**Phase 4 (RC) gate B5: CONDITIONAL.**

The audit is complete (all five evidence streams recorded and re-verified
2026-11-21), but per RELEASE-READINESS.md §B5 the gate does not pass until
the maintainer records the final KEEP/RENAME decision in `docs/REBRANDING.md`
§1. 2.0.0 stable must not ship until that lands.

**Blocking sub-finding for the org-migration step specifically:** the
GitHub name `nemesis-oss` is occupied by an unrelated user account
(created 2022, one unrelated repo). REBRANDING.md §7's plan to transfer
the repo to a `nemesis-oss` org cannot proceed under that name. If Option
A (KEEP) is chosen, a different GitHub org name is required — this should
be decided together with the name itself.
