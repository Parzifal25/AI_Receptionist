# WS3 owner actions and readiness matrix

Recommendations below are engineering advice, never approvals. Decision states stay in [DECISIONS.md](DECISIONS.md). Scope count: **nine distinct outstanding decision IDs explicitly actioned below**: R8, D19, D21, D22, D14, D8 (conditional), D23 and D11 (pilot), D15 (audit naming). This expands the earlier six-ID first-rollout-only count; it is not the count of every pending decision in the entire project. D14 has grouped sub-decisions, counted once. The separate K1 engineering approval is CLOSED by the owner’s explicit Final Closure prompt; it is not a new decision ID and confers no hosted execution authority. None of the nine pending decision IDs was ratified by that narrow authorization.

OWNER DECISION IDS: R8, D19, D21, D22, D14, D8, D23, D11, D15

| ID / exact question | Current source state / recommendation and alternatives | Consequences, dependency and required closure | Blocks |
|---|---|---|---|
| R8 — authorize environment and data/evidence handling/provider setup? | PENDING other owners; recommend explicit synthetic-only first target with named privacy/security/operations owners | Written target, data scope, read/write evidence authorization and controls; depends on D8/D19, pilot D6/D11/D23 | First migration, pilot, GA |
| D19 — where/how app, gateway/worker and DB run; region/topology/residency? | PENDING; recommend decide co-location after privacy/latency review. Alternatives: retain existing Sydney region, single gateway then later multi-instance | Named region/target/topology and processing-location position; owner, deployment and privacy approval; D1/D8/D12 dependencies per register | First migration, pilot, GA |
| D21 — how apply 0001 without editing applied history? | PENDING; recommend operational session-path option only for compatible extension state. Alternatives: explicit historical-file exception or reviewed one-off baseline | Owner/database approval + real ledger/schema/vector/session evidence + exact runner clone test. Vector-in-extensions remains STOP | First migration |
| D22 — adopt 0034 tenant guards and privilege hardening? | PENDING; recommend adoption after census and creator-role/default-ACL review. Deferral leaves isolation/grant gaps | Explicit owner adoption; R8/D19/D21; separately authorize legacy data correction, not part of migration | Full first rollout, pilot, GA |
| D14 — ratify knowledge design/defaults and legacy rollout? | Local implementation authorized, defaults unratified; items 1–2 described as settled within implementation, items 3–6 need decisions. Recommend explicit acceptance of single approver and restricted FAQ exclusion; per-turn recommendation diverges from original snapshot wording | Decide self-approval vs four-eyes, FAQs excluded vs binding migration, per-turn vs snapshot and persisted answer revision traceability, planned knowledge blackout/replacement versions. No FAQ binding/snapshot/traceability migration authorized. Require locally verified 0035 and the provenance-preserving draft indexing procedure before affected backfill | 0033 rollout; useful knowledge/pilot |
| D8 — what budget or exception allows paid STT/TTS/LLM/carrier usage for the pilot? | PENDING; recommend preserve exactly $0 and prove target/backup capacity. No paid alternative authorized here | Written budget/action approval only in a later task if needed; hard $0 for WS3. Free-plan limits/restore capacity not assumed | Conditional hosting/recovery; paid provider/pilot work |

| D23 — which personal-data tables should retention purge, retain, and for how long? | PENDING owner/privacy owner; recommend decide before real data, with operational/business-record separation; alternatives extend purge broadly, retain business records or document no change | Written per-table policy, DNC preservation, export/deletion and backup-retention position; any implementation needs approved additive migration; R8 | Pilot personal data; not synthetic first hosting |
| D11 — dated business facts, disclosures, consent, DNC, contacts/hours, visits and claims? | PENDING business/privacy owners and Telugu reviewer; recommend obtain dated attributable inputs, leave missing values UNSET; alternative delay pilot | Approved facts and handling/contact policy, human language review; no fabricated defaults | Useful pilot knowledge and handoff |
| D15 — database audit label versus voice ENG-04/ENG-12 naming? | PENDING release owner; recommend retain ENG-04 for voice and assign ENG-12 with aliases; alternative approved numbering | Written release-owner naming choice; continue descriptive SEC-04 audit wording meanwhile; no task renamed here | Register dependency of D21/W1.6; no technical migration semantics |

Additional operational actions: database/security owner must approve target adaptation of the locally verified restore method; K1 is implemented in 0035 under the final-closure authorization, with 0033 preserved; knowledge owner decides provenance-preserving indexing/resubmission; operators collect full inventory and legacy mismatch dispositions; release owner approves RPO/RTO, runner behavior and future exact action. These are actions, not invented approved decision IDs. D23 retention scope and D11 facts remain pilot gates. D15 audit naming remains a documented D21 dependency; WS3 does not close it or rename plan tasks.

## Readiness matrix

| Area | Evidence level / state | Remaining gate |
|---|---|---|
| Repository preservation | VERIFIED_LOCAL / source backup manifest and complete bundle verified | Durable ~/halo-backups/ws3-closeout-20261015T070139Z copy verified; not a DB restore |
| Migration order | VERIFIED_LOCAL / static prefix test, 34 SQL files; source map | Real ledger and full schema not collected |
| Bootstrap | VERIFIED_LOCAL / disposable image A/P/C reproductions | D21 approval; actual runner/session/extension evidence |
| 0032–0034 compatibility | VERIFIED_LOCAL / disposable upgrade succeeds; no sampled legacy rewrites | D14/D22 adoption and target-specific privileges/data/locks |
| Knowledge governance | VERIFIED_LOCAL / synthetic scope/publication/backfill checks | K1 accepted locally via 0035; actual inventory, facts and D14 remain outstanding |
| Tenant references | DOCUMENTED / 19 generic pairs + dedicated guards/composite keys; synthetic new mismatch rejected | Real census, all orphan categories, actual Auth/service role tests |
| RLS/grants | VERIFIED_LOCAL / source/route and disposable migration/RLS gates; opt-in suites recorded in report | Hosted effective/inherited privilege and Auth checks |
| Backup and restore | VERIFIED_LOCAL / unsafe restore rejected; mitigated schema/security comparison passes | Complete hosted/platform scope restore, target adaptations and RPO/RTO |
| CLI | VERIFIED_LOCAL / installed help supports listed flags | Actual runner SQL/ledger atomicity and session path remain NOT VERIFIED |
| Target T1–T10 | REAL_TARGET_EVIDENCE_REQUIRED / all ten groups NOT VERIFIED | Exact authorization and completed evidence worksheet |
| Deployment | OWNER_APPROVAL_REQUIRED / NOT AUTHORIZED | All above; no preparation artifact grants deployment permission |

**Preparation COMPLETE — ROLLOUT PREPARED (local package only).** Recovery and K1 pass the applicable local/disposable gates. K1 was implemented only in additive 0035 under explicit authorization. Historical migrations and the nine decision states are unchanged. Deployment remains NOT READY. No staged or production evidence is claimed.

## Closeout task checklist

| Task | State / evidence | Dependency / next action |
|---|---|---|
| Preserve baseline | DONE / durable bundle, dirty archive and manifest verified | No commit or discard |
| A Restore drift | DONE LOCALLY / unsafe negative + mitigated schema/security snapshots; stable comparisons | Authorized target adaptation remains separate |
| B K1 investigation and boundaries | DONE / historical failure reproduced, then 0035 accepts 499/500 and quarantines 501 in both modes, valid mixed items proceed | Future exact target execution authorization only |
| B Persisted fix | DONE / explicit final-closure authorization, additive 0035, unchanged 0033; DB regression and upgrade proof | No additional local K1 engineering approval outstanding |
| C Indexing/provenance | DONE LOCALLY / same-draft failed/retry, foreign-tenant denial, frozen approved revision | Real provider/cost and target authorization; no dashboard re-save workaround |
| D Migration/ledger | DONE LOCALLY / 35-file map, A/P/C, explicit empty/completion evidence, transaction model | Actual ledger/schema/CLI path NOT VERIFIED |
| E Documentation | DONE / linked package and honest count reconciliation | Owner choices remain pending |
| F Local gates | DONE as recorded / full suite, worker, static gates, isolated DB/rehearsal | Build not run (Google Fonts); hosted checks never substituted |
| T1–T10 | REAL_TARGET_EVIDENCE_REQUIRED / all ten uncollected | Separate exact target/action authorization |

## Decision reconciliation and individual owner requests

**DOCUMENTED/source:** all nine IDs remain pending in DECISIONS.md. G2’s standing $0/local permission, prior D14 local implementation authorization, documented Sydney project, engineering-resolved D21 bootstrap and descriptive audit labels do not ratify the respective target/product decisions. The final-closure prompt resolves only the separate K1 implementation approval. No conditional item is obsolete: D8 remains pilot/paid-work pending even though it does not block this $0 preparation.

Each request below is independently actionable, not a batch approval. The table above gives alternatives, consequences, dependencies and affected rollout/pilot/GA gates.

- **R8 — environment/privacy/security/operations owners:** name the environment, data/evidence scope, retention/access controls and operator, and record exact read authorization separately from future writes. Existing G2 does not name a hosted target.
- **D19 — owner + deployment/privacy owners:** choose region/topology and residency position; explicitly identify whether the documented Sydney project is an intended target. Co-location is recommended; retaining Sydney or deferring the target remains an alternative.
- **D21 — owner + database owner:** approve the operational search_path method only for a target proven to have compatible vector placement and reconciled ledger/schema. For incompatible placement/partial bootstrap, request a separately reviewed baseline/restore plan instead.
- **D22 — owner:** explicitly adopt 0034 as reviewed, request defined amendments or reject/defer it. Adoption requires the pre-application census and separately authorized mismatch dispositions; successful local tests are not adoption.
- **D14 — owner:** independently ratify/change items 3–6: self-approval versus separation of duties; collection-restricted FAQ exclusion versus binding design; per-turn revocation versus snapshot and answer-revision traceability; legacy outage/replacement-version rollout. Items 1–2 match the existing design and are described as settled in its review; do not treat this as authorization to run 0033. K1 authorization changes none of these questions.
- **D8 — owner + finance:** define pilot budget/limits or explicitly retain $0 and defer paid operations; free capacity has not been verified. No budget decision is needed to spend $0 locally.
- **D23 — owner + privacy owner:** approve a per-table retention/deletion/export/backup scope and DNC handling before real personal data; implementation, if requested, is a separate additive migration. Synthetic first hosting need not await a new retention implementation.
- **D11 — business/privacy owners + Telugu reviewer:** provide attributable dated facts, disclosure/consent/DNC policy, contacts/hours, visits and allowed claims. Missing facts remain UNSET. Deferring the pilot is the alternative to supplying them.
- **D15 — release owner:** select ENG-04 for voice and ENG-12 for database audit with aliases (recommended), or explicitly approve another numbering. Until then retain the descriptive SEC-04 wording. No existing canonical document silently resolves the pending naming choice.

Real-target read authorization is separately prepared in [preflight](HOSTED_TARGET_PREFLIGHT.md#operator-authorization-request-not-submitted). No request in this document has been treated as approval or executed.
