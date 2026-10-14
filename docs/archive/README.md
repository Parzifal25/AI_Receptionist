# Documentation archive

This folder holds superseded documents. They were kept because they carry historical context or evidence that a summary would lose. **Nothing here is authoritative for current architecture, status or plans.** For those, use:

- [HALO_Architecture.md](../HALO_Architecture.md)
- [DECISIONS.md](../DECISIONS.md)
- [HALO_V1_STATUS.md](../HALO_V1_STATUS.md)
- [HALO_V1_GAP_ANALYSIS.md](../HALO_V1_GAP_ANALYSIS.md)
- [HALO_V1_IMPLEMENTATION_PLAN.md](../HALO_V1_IMPLEMENTATION_PLAN.md)

Archived on 2026-10-15 under [DECISIONS.md G4](../DECISIONS.md#g4--documentation-authority).

## Preservation rules

- **Content is preserved.** No file was deleted or summarized in place. The files were moved with a plain `mv`, not `git mv`, so the git index was left untouched.
- **`HALO_BLUEPRINT_v0.1.md` is byte-identical** to the former untracked `docs/HALO_Architecture.md`. Its SHA-256 is `8855ae779ea70df08165312090514813612bb52b0f7e0ca3894722eb089d1ca5`. Every "blueprint §N" citation in the repository refers to this file.
- **Other files** differ from their originals only in mechanically rewritten **relative link targets** (re-resolved for this folder) and `docs/<file>` path strings pointing at other archived files. Prose is unchanged. The original SHA-256 of each file (before archiving) is listed below. Tracked originals are also in git history.

## Contents

| File | Original location and date | Kind | Why archived | Superseded by | Original SHA-256 |
|---|---|---|---|---|---|
| [HALO_BLUEPRINT_v0.1.md](HALO_BLUEPRINT_v0.1.md) | `docs/HALO_Architecture.md` (untracked; undated v0.1) | Target architecture (blueprint) | The owner asked for one authoritative architecture at the same path | [HALO_Architecture.md](../HALO_Architecture.md). Principles stay in force ([G1](../DECISIONS.md#g1--target-design-and-engineering-principles)); § traceability is in Arch §14. | `8855ae779ea70df08165312090514813612bb52b0f7e0ca3894722eb089d1ca5` (unchanged) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | `docs/ARCHITECTURE.md` (receptionist era) | Architecture guide | Second "architecture" document, with stale `src/core/ports` and `src/providers` paths | [HALO_Architecture.md](../HALO_Architecture.md). A pointer stub stays at `docs/ARCHITECTURE.md` because code cites that path. | `27c0f2c9e64926d122c12c96f09b156d70a7589e865280ba0b1c01b8f9e472c3` |
| [CURRENT_STATE_AUDIT.md](CURRENT_STATE_AUDIT.md) | `docs/` (audit 2026-09-02) | Historical current-state audit | Superseded for current status by source and the status register, as STATUS §I already recorded | HALO_Architecture.md (current state); [HALO_V1_STATUS.md](../HALO_V1_STATUS.md) | `e7f0caa961dd8ff7586a03e1e0c10063ce0321fe56ea9ded8f939fa53475c18e` |
| [HALO_IMPLEMENTATION_PLAN.md](HALO_IMPLEMENTATION_PLAN.md) | `docs/` (plan 2026-09-04) | Implementation plan (P0–P12, §20–§28) | Its header says "PLAN. Nothing in this document is implemented", which the source contradicts. A second plan of record. | [HALO_V1_IMPLEMENTATION_PLAN.md](../HALO_V1_IMPLEMENTATION_PLAN.md) (crosswalk §9). Design sections P3, P4, P5.8, P10 and P11 remain useful reference. | `14c614482e40fe79ac84ec520f71bf5602d402812b8f71e28233505279594292` |
| [HALO_V1_ENGINEERING_BACKLOG.md](HALO_V1_ENGINEERING_BACKLOG.md) | `docs/` (2026-10-11; locally modified, archived with those modifications) | Dependency-ordered backlog (ENG-01–ENG-12) | A second plan of record | [HALO_V1_IMPLEMENTATION_PLAN.md](../HALO_V1_IMPLEMENTATION_PLAN.md) (ENG IDs mapped in §9). ENG-01's evidence also lives in [ENG_01_SECURITY_IDENTITY_REVIEW.md](../ENG_01_SECURITY_IDENTITY_REVIEW.md). | `f6170559a0c85f233f1df20b49338a6bf67ccb9650a36ebe2722ef24185d51e6` |
| [ROADMAP.md](ROADMAP.md) | `docs/` (receptionist roadmap, updated 2026-10-12) | Roadmap, limitations, technical debt | A competing roadmap | Implementation plan and gap analysis. The technical debt is carried forward, unverified, in [gap analysis §5](../HALO_V1_GAP_ANALYSIS.md#5-carried-forward-technical-debt-not-re-verified). | `7b95a9effa9ca1297c3dbcde445c920af98fa5830995a82d27eb1db99ef1d036` |
| [AUTONOMOUS_ENGINE_IMPLEMENTATION.md](AUTONOMOUS_ENGINE_IMPLEMENTATION.md) | `docs/` (2026-09-29) | Audit and implementation plan (gaps G1–G13) | A historical plan, largely executed per [HALO_IMPLEMENTATION_VERIFICATION.md](../HALO_IMPLEMENTATION_VERIFICATION.md) | Implementation plan; open items feed W4.8 and W3.4 | `b18b2aa1b748956a43494ecb3a2bee0cf2605e52d6902fdafb4642c2a08e2e93` |
| [PHASE2_REPORT.md](PHASE2_REPORT.md) | `docs/` (2026-09-15) | Phase report | Historical | [RUNTIME.md](../RUNTIME.md); HALO_Architecture.md §5.3 | `77b1f2cfacaa1879ac78b639cc290037bd79fbae89a1284bfc6f9e0b00f0d63c` |
| [PHASE3_BASELINE.md](PHASE3_BASELINE.md) | `docs/` (2026-09-21) | Baseline record | Historical | — | `effb708a962c6d778cb3d44d6f0724a0f243e5cc2b7f5d346d1f4250c371ced1` |
| [PHASE3_REPORT.md](PHASE3_REPORT.md) | `docs/` (2026-09-21) | Phase report | Historical. **Code cites "PHASE3_REPORT §5.1/§5.2" by name** (`packages/voice/pipecat/remote-session.ts`); those sections are here. | [VOICE_ARCHITECTURE.md](../VOICE_ARCHITECTURE.md), [VOICE_STATE_MACHINE.md](../VOICE_STATE_MACHINE.md) | `bcad114eac1232992d3ea01e58cf5904ee6d185f8fc654a31015bfdc054d0cf7` |
| [PHASE3_PHASE4_EXECUTION_PLAN.md](PHASE3_PHASE4_EXECUTION_PLAN.md) | `docs/` (2026-09-16) | Execution checklist | Historical | — | `9d3816a67f2663dc3e8fca51578bb27a442d8689597bdc0f84116bf0453fa249` |
| [PHASE4_5_FEASIBILITY.md](PHASE4_5_FEASIBILITY.md) | `docs/` (2026-09-22) | Feasibility audit (voice, tokens) | Historical. Its findings were implemented or carried into the latency audit. | [VOICE_LATENCY_COST_AUDIT.md](../VOICE_LATENCY_COST_AUDIT.md) | `fb5f38c09dab199dd8b5cda9bd8c3bf3bbdc510da5d9d9e94df2d69d8b32f36c` |
| [PHASE4_5_SPRINT1_REPORT.md](PHASE4_5_SPRINT1_REPORT.md) | `docs/` (2026-09-22) | Sprint report | Historical | [CHANGELOG.md](../CHANGELOG.md) entry; [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) | `fae25a4f058432605fe32ffb74f07d20a40a4e878fd9ece429f7ff0a338ae2bc` |
| [PHASE4_5_SPRINT2_REPORT.md](PHASE4_5_SPRINT2_REPORT.md) | `docs/` (2026-09-22) | Sprint report | Historical | [CHANGELOG.md](../CHANGELOG.md) entry | `0fd604603afcc8acec431c127bc76e84cf6abb8c7b20f645830692f3eb9ccd72` |

`docs/PHASE4_REPORT.md` is also historical, but it stays at its original path because source code and tests cite it by path.

## Path map for plain-text references

Some retained records name archived files as plain text, without a link. In particular, [HALO_PHASE_BETA_DISCOVERY_REPORT.md](../HALO_PHASE_BETA_DISCOVERY_REPORT.md) is user-owned and was deliberately left byte-for-byte unchanged under `POA` constraint 4. Read those references with this map:

| Former path | Current path |
|---|---|
| `docs/HALO_Architecture.md` cited as "blueprint v0.1" or "blueprint §N" | `docs/archive/HALO_BLUEPRINT_v0.1.md` |
| `docs/ARCHITECTURE.md` (content) | `docs/archive/ARCHITECTURE.md` (the old path now holds a pointer stub) |
| `docs/CURRENT_STATE_AUDIT.md` | `docs/archive/CURRENT_STATE_AUDIT.md` |
| `docs/HALO_IMPLEMENTATION_PLAN.md` | `docs/archive/HALO_IMPLEMENTATION_PLAN.md` |
| `docs/HALO_V1_ENGINEERING_BACKLOG.md` | `docs/archive/HALO_V1_ENGINEERING_BACKLOG.md` |
| `docs/ROADMAP.md` | `docs/archive/ROADMAP.md` |
| `docs/AUTONOMOUS_ENGINE_IMPLEMENTATION.md` | `docs/archive/AUTONOMOUS_ENGINE_IMPLEMENTATION.md` |
| `docs/PHASE2_REPORT.md`, `PHASE3_BASELINE.md`, `PHASE3_REPORT.md`, `PHASE3_PHASE4_EXECUTION_PLAN.md`, `PHASE4_5_FEASIBILITY.md`, `PHASE4_5_SPRINT1_REPORT.md`, `PHASE4_5_SPRINT2_REPORT.md` | same file names under `docs/archive/` |
