# Clinical Decision Support MCP Server — DevPost Submission

## Tagline
An AI-powered clinical reasoning engine that catches dangerous drug interactions, scores stroke risk, and screens contraindications — before a prescribing decision is made.

---

## What it does

Our MCP server gives any healthcare AI agent on the Prompt Opinion platform real-time clinical decision support. When a clinician asks a question about a patient, the agent orchestrates our tools in a **clinical cascade**:

**One question triggers a chain of clinical reasoning:**
1. "Summarize this patient" → aggregates the full clinical picture from FHIR records
2. "What's her stroke risk?" → CHA2DS2-VASc score of 4/9 with deterministic component breakdown
3. "Check her medications" → flags drug-drug interactions by severity with pharmacological mechanisms
4. "Can I prescribe amiodarone?" → screens contraindications against conditions, allergies, current meds, and labs
5. "Create a care plan" → synthesizes evidence-based recommendations from the complete picture

**9 tools total:** Patient summary, drug interaction checker, contraindication screener, lab interpreter, risk score calculator (CHA2DS2-VASc, HEART, MELD-Na), care plan generator, clinical notes parser, plus utility tools.

---

## AI Factor

### Hybrid Architecture: Deterministic + AI Reasoning

We don't just send FHIR data to an LLM and hope for the best. Our **hybrid approach** separates what should be exact from what benefits from reasoning:

**Deterministic Layer (zero hallucination risk):**
- CHA2DS2-VASc stroke risk uses the exact published scoring: CHF(+1), Hypertension(+1), Age>=75(+2), Diabetes(+1), Stroke/TIA(+2), Vascular(+1), Age 65-74(+1), Female(+1)
- MELD-Na liver severity uses the validated logarithmic formula with sodium correction
- Lab flagging uses established clinical reference ranges (critical/abnormal/normal) with LOINC-coded thresholds
- SNOMED CT + ICD-10 coded condition matching for automatic score component detection

**AI Reasoning Layer (Claude Sonnet 4.6):**
- Drug interaction analysis with pharmacological mechanisms and evidence levels
- Contraindication screening across conditions, allergies, and renal/hepatic function
- Clinical note parsing (NLP extraction of diagnoses, medications, procedures from unstructured text)
- Care plan generation aligned with clinical guidelines
- Contextual interpretation that connects score results to patient-specific factors

**Why this matters:** A physician judge will immediately notice if an AI invents a fake drug interaction or miscalculates a stroke risk score. Our deterministic layer makes the critical computations trustworthy. The AI layer adds the clinical reasoning that would take a pharmacist 15 minutes to produce.

### Clinical Rigor

Every deterministic score cites its published source:
- CHA2DS2-VASc: Lip GYH et al., Chest 2010; European Heart Journal 2012
- HEART Score: Six AJ et al., Netherlands Heart Journal 2008
- MELD-Na: Kim WR et al., Hepatology 2008; Biggins SW et al., Gastroenterology 2006
- Lab Reference Ranges: LOINC-coded thresholds from standard clinical laboratory references

The system is designed so a physician can audit every computed value — no black boxes.

---

## Potential Impact

### The Problem We're Solving

| Statistic | Impact |
|-----------|--------|
| **7,000–9,000 deaths/year** in the US from medication errors | Our drug interaction + contraindication tools catch dangerous combinations before prescribing |
| **$42 billion/year** global cost of medication-related harm | Automated screening reduces adverse drug events at scale |
| **6 million Americans** with atrial fibrillation | Our CHA2DS2-VASc tool ensures every AFib patient gets proper stroke risk assessment |
| **1.3 million injuries/year** from medication errors in the US | Real-time clinical decision support at the point of care |

### Who Benefits

- **Physicians** get evidence-based decision support in their workflow, not after the fact
- **Pharmacists** get automated interaction screening for complex medication regimens
- **Patients** get safer prescribing — dangerous combinations caught before they happen
- **Health systems** reduce medication errors, adverse events, and associated costs

### Clinical Cascade = Real Workflow

Our tools don't work in isolation. The **clinical cascade** mirrors how physicians actually think:
1. First understand the patient (summary)
2. Then assess risk (scores)
3. Then check safety (interactions + contraindications)
4. Then plan next steps (care plan)

The AI agent orchestrates this naturally — each tool builds on previous context.

---

## Health Equity & Access

This server works with ANY FHIR R4 compliant endpoint — Epic, Cerner, HAPI FHIR, or open-source EHRs. A rural community health center running an open-source FHIR server gets the exact same CHA2DS2-VASc scoring, drug interaction analysis, and care plan recommendations as Cleveland Clinic or Mayo Clinic.

- **Zero vendor lock-in** — no proprietary APIs, no enterprise contracts
- **Marketplace distribution** — discoverable and installable on Prompt Opinion with zero integration cost
- **Open standards** — FHIR R4, MCP protocol, SHARP headers — all open specifications
- **Under-resourced systems benefit most** — smaller facilities without clinical pharmacists or specialist coverage gain the most from automated CDS

---

## Standards & Interoperability

Built as a next-generation Clinical Decision Support system on the Model Context Protocol — the spiritual successor to CDS Hooks for the agentic AI era. Every design decision prioritizes open, permissionless interoperability:

- **FHIR R4** — the universal healthcare data standard (HL7)
- **MCP** — Anthropic's Model Context Protocol for composable AI tools
- **SHARP Extension Specs** — secure patient context propagation without coupling to specific EHRs
- **Clinical terminologies** — SNOMED CT, ICD-10, LOINC, RxNorm for coded condition and medication matching
- **Stateless, request-scoped** — no session state, horizontally scalable, cloud-native

---

## Feasibility

### It Works Today

- **Live on Render** — deployed, accessible, published to Prompt Opinion marketplace
- **Standard protocols** — FHIR R4 + SHARP Extension Specs + MCP = works with any conformant EHR
- **Tested against real FHIR servers** — validated with HAPI FHIR sandbox patients beyond our demo data
- **49 automated tests** across 6 suites for deterministic clinical logic (CHA2DS2-VASc, MELD-Na, HEART, condition detection, lab flagging)
- **Graceful degradation** — if Claude is unavailable, tools return deterministic results + raw data for manual review

### Production-Ready Architecture

- **Request timeout** (25s) prevents hanging during FHIR server delays
- **Keep-alive ping** prevents Render cold starts during judging
- **Parallel FHIR queries** via `Promise.allSettled` — partial results on failure, not full failure
- **Exponential backoff retry** for Claude API calls (rate limits, transient errors)
- **PII stripping** — patient identifiers removed before Claude API calls
- **Token isolation** — FHIR access tokens never forwarded to external services
- **Clinical disclaimer** on every response — AI output requires professional validation

### Path to Production

This is a hackathon prototype, but the architecture is production-ready:
1. **HIPAA compliance** — deploy on BAA-covered infrastructure (Azure, AWS GovCloud)
2. **Clinical validation** — physician-reviewed scoring accuracy study
3. **Pharmacological databases** — integrate FDB or OpenFDA for deterministic drug interaction checking
4. **EHR embedding** — deploy as a backend for EHR-integrated AI assistants (similar to CHOP's CHIPPER)
5. **Marketplace scaling** — the MCP tool interface allows any institution to publish additional clinical tools

### Business Model

The clinical decision support market is projected at $2.3B by 2028 (MarketsAndMarkets), addressing $42B/year in medication-related harm globally. Our go-to-market path:

- **Marketplace distribution** — free discovery on Prompt Opinion, per-tool-call pricing ($0.01–0.05/call) for production usage
- **Enterprise licenses** — site licenses for health systems wanting unlimited CDS tool access across their FHIR infrastructure
- **EHR embedding** — white-label backend for EHR vendors building AI assistants (Epic, Oracle Health, athenahealth)
- **TAM**: Every FHIR-enabled health system in the US is a potential customer — that's every hospital under the 21st Century Cures Act

---

## How we built it

- **TypeScript + Express 5** — MCP server using the official ModelContextProtocol SDK
- **Claude Sonnet 4.6** — AI reasoning layer with structured JSON output
- **FHIR R4** — standard healthcare data via @smile-cdr/fhirts type library
- **SHARP Extension Specs** — secure patient context propagation
- **Zod 4** — runtime schema validation for all tool inputs
- **Node.js 20** built-in test runner — deterministic logic tests

---

## Challenges we ran into

1. **Balancing AI and determinism** — deciding which clinical computations should be exact (risk scores) vs. AI-reasoned (drug interactions) required deep clinical knowledge research
2. **FHIR data heterogeneity** — different EHR systems represent the same medication differently (MedicationRequest vs MedicationStatement, RxNorm vs text-only). Robust extraction handles both.
3. **False positive prevention** — "dementia" was matching the keyword "tia" (transient ischemic attack). Fixed with word-boundary regex matching.
4. **Clinical note availability** — most FHIR sandboxes don't include DocumentReference resources, requiring us to build realistic synthetic clinical notes.

---

## What we learned

- Physicians think in **clinical cascades**, not individual tool calls — designing for workflow, not features
- **Deterministic clinical formulas are sacred** — published scoring systems must be exact, not approximated by AI
- The gap between "technically works" and "clinically trustworthy" is where hybrid AI architecture lives
- FHIR data quality varies enormously — robust extraction with graceful degradation is essential

---

## What's next

- Integration with **FDB/OpenFDA** for deterministic drug interaction and contraindication databases
- **Clinical validation** with physician reviewers from academic medical centers
- **SMART on FHIR app** launch for direct EHR integration
- **Multi-language support** for global clinical decision support
- **Real-time alerting** — proactive contraindication warnings when new medications are ordered
- **Pediatric-specific CDS** — weight-based dosing checks, age-adjusted reference ranges, and growth chart integration for pediatric clinical decision support at institutions like Children's Hospital of Philadelphia
