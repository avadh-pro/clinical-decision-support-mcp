# Clinical Decision Support MCP Server

> **Preventing the 7,000–9,000 medication-related deaths that happen every year in the US** — one AI-assisted clinical decision at a time.

A healthcare AI MCP server that gives any AI agent on the [Prompt Opinion](https://promptopinion.ai) platform real-time clinical decision support: drug interaction checks, stroke risk scoring, contraindication screening, lab interpretation, and care plan generation — all backed by patient data from FHIR R4 electronic health records.

Built for the [Agents Assemble — Healthcare AI Endgame](https://agents-assemble.devpost.com/) hackathon.

## Why This Matters

| Statistic | Source |
|-----------|--------|
| **1.3 million ED visits/year** from adverse drug events in the US | CDC |
| **250,000+ deaths/year** from medical errors — the third leading cause of death | BMJ |
| **40% of adults 65+** take 5 or more concurrent medications, creating complex polypharmacy | NCHS |
| **6 million+ patients** with atrial fibrillation depend on CHA2DS2-VASc-driven anticoagulation decisions | AHA |
| **$42 billion/year** in medication-related harm globally | WHO |

This server provides AI-augmented clinical decision support that addresses these challenges directly — catching dangerous drug interactions, flagging contraindications, and calculating risk scores **before** a prescribing decision is made.

## What It Does

9 clinical decision support tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Each tool retrieves live patient data from FHIR R4 servers via [SHARP Extension Specs](https://sharponmcp.com) and combines **deterministic clinical logic with AI-powered reasoning**.

### Clinical Tools (7)

| Tool | What It Does |
|------|-------------|
| `generate_patient_summary` | Comprehensive patient overview aggregating 6 FHIR resource types into a clinician-ready narrative |
| `check_drug_interactions` | AI pharmacist analyzing polypharmacy risks with severity classification (critical/major/moderate/minor) and mechanism explanations |
| `check_contraindications` | Prescribing safety check — cross-references conditions, allergies, labs, and current medications before a new drug is ordered |
| `interpret_lab_results` | Reference range flagging, trend detection, and clinical interpretation across all available laboratory observations |
| `calculate_risk_scores` | Deterministic CHA2DS2-VASc, HEART, and MELD-Na scoring with AI-powered clinical interpretation |
| `suggest_care_plan` | Evidence-based care recommendations citing clinical guidelines, synthesized from the full clinical picture |
| `parse_clinical_notes` | NLP extraction of structured data (diagnoses, medications, procedures, labs) from unstructured clinical documents |

### Utility Tools (2)

| Tool | What It Does |
|------|-------------|
| `FindPatientId` | Patient lookup by name from SHARP context |
| `GetPatientAge` | Age calculation from patient birth date |

## AI Factor: Hybrid Architecture

This is not "send FHIR data to an LLM and hope for the best." The server uses a **hybrid architecture** where deterministic clinical formulas and AI reasoning each handle what they do best.

**Deterministic layer (zero hallucination risk):**
- CHA2DS2-VASc stroke risk scoring uses the exact published point system
- MELD-Na uses the validated logarithmic formula
- HEART score follows the established 0-10 point scale
- Lab flagging uses published reference ranges with trend detection
- Condition matching uses SNOMED CT and ICD-10 codes, not free-text guessing

**AI reasoning layer (genuine clinical value):**
- Drug interaction analysis with mechanism explanations
- Contraindication screening across conditions, allergies, labs, and medications
- Care plan synthesis aligned with clinical guidelines
- Clinical note parsing via NLP
- Contextual interpretation of deterministic results

**Example:** CHA2DS2-VASc is calculated deterministically from FHIR data — CHF(+1), Hypertension(+1), Age>=75(+2), Diabetes(+1), Stroke/TIA(+2), Vascular disease(+1), Age 65-74(+1), Female(+1). The AI then interprets that score in the patient's full clinical context, considering their medications, renal function, and bleeding risk factors. The number is reproducible; the interpretation adds clinical reasoning that goes beyond rule-based systems.

```
Patient Question
       |
       v
+------------------------------+
|   Deterministic Layer        |  <- Published formulas, reference ranges
|   (CHA2DS2-VASc, MELD-Na,   |     SNOMED/ICD-10 code matching
|    HEART, lab flagging)      |     Zero hallucination risk
+-------------+----------------+
              |
              v
+------------------------------+
|   AI Interpretation Layer    |  <- Clinical reasoning, drug knowledge
|   (Claude Sonnet 4.6)       |     Interaction analysis, care plans
|                              |     Always marked as AI-generated
+-------------+----------------+
              |
              v
    Clinician-ready output
    with disclaimer
```

## Demo Scenario: Margaret Chen

Margaret Chen is a 67-year-old female with **6 active conditions**: atrial fibrillation, type 2 diabetes, hypertension, CKD stage 3, hyperlipidemia, and HFrEF. She takes **8 concurrent medications** creating complex polypharmacy. Her chart includes **12 recent lab results** with multiple abnormal findings and **3 documented drug allergies**.

This complexity is where AI adds genuine value over manual review. Her demo bundle includes 37 FHIR resources.

**One question triggers a clinical cascade:**

1. **"Summarize this patient"** → `generate_patient_summary` aggregates her full clinical picture
2. **"What's her stroke risk?"** → `calculate_risk_scores` returns CHA2DS2-VASc **score of 4/9** (Moderate-high) with component breakdown: Hypertension(+1), Diabetes(+1), Age 65-74(+1), Female(+1)
3. **"Check her drug interactions"** → `check_drug_interactions` identifies interactions between her apixaban, metformin, lisinopril, and atorvastatin
4. **"Can I prescribe amiodarone?"** → `check_contraindications` flags the amiodarone-apixaban interaction (major — increases bleeding risk) and checks against her diabetes and renal function
5. **"Create a care plan"** → `suggest_care_plan` synthesizes everything into actionable recommendations

**The agent orchestrates this naturally** — each tool builds on the previous one's context.

## Setup

### Prerequisites

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com)

### Install & Run

```bash
git clone https://github.com/avadh-pro/clinical-decision-support-mcp.git
cd clinical-decision-support-mcp

npm install

cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

npm run start
```

The server starts on port 5000 (configurable via `PORT` env var).

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for Claude |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6-20250514` | Claude model to use |
| `PORT` | No | `5000` | Server port |
| `RENDER_EXTERNAL_URL` | No | — | Set in Render deployments for keep-alive ping |

### Health Check

```bash
curl http://localhost:5000/health
# Returns: {"status":"ok","server":"Clinical Decision Support MCP Server"}
```

## Testing

### Automated Tests

```bash
npm test
```

49 unit tests across 6 suites covering all deterministic clinical logic:
- CHA2DS2-VASc scoring (10 tests: boundary values, age brackets, sex scoring, risk categories)
- HEART score calculation (7 tests: age brackets, risk factors, troponin thresholds)
- MELD-Na calculation (6 tests: known values, sodium correction, edge cases)
- Condition detection (9 tests: word-boundary matching, SNOMED/ICD-10 codes, false-positive prevention)
- Lab reference range flagging (13 tests: LOINC thresholds, critical/abnormal ranges, pediatric ranges)
- Lab result retrieval (4 tests: most recent selection, multi-LOINC search)

### Manual Testing (HAPI FHIR Sandbox)

```bash
PORT=3000 npm run start

curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-fhir-server-url: https://hapi.fhir.org/baseR4" \
  -H "x-patient-id: 131284056" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_drug_interactions",
      "arguments": {}
    },
    "id": 1
  }'
```

### Verified FHIR Endpoints

Tested against **multiple independent FHIR R4 servers** to validate interoperability:

| FHIR Server | URL | Status |
|-------------|-----|--------|
| **HAPI FHIR** (public sandbox) | `https://hapi.fhir.org/baseR4` | All tools pass |
| **SMART Health IT** (Harvard/BCH) | `https://launch.smarthealthit.org/v/r4/fhir` | All tools pass |
| **Prompt Opinion** (hackathon platform) | Via SHARP headers | All tools pass |

### Test Patients

| Server | Patient ID | Name | Data Available |
|--------|-----------|------|----------------|
| HAPI FHIR | `131284056` | Robert Chen, 72M | 4 conditions, 10 medications |
| HAPI FHIR | `123836453` | Michael Kihn, 51M | 12 conditions, 2 allergies |
| SMART Health IT | `a74651a6-8141-4c7e-91b5-a43ce80e6b92` | Emeline Hilll | Synthea-generated |
| Prompt Opinion | Margaret Chen, 67F | 6 conditions, 8 meds, 12 labs, 3 allergies | Demo bundle |

## FHIR Resources Used

| Tool | FHIR Resources |
|------|---------------|
| Patient Summary | Patient, Condition, MedicationRequest, Observation, AllergyIntolerance, Encounter |
| Drug Interactions | MedicationRequest, MedicationStatement |
| Contraindications | Patient, Condition, MedicationRequest, AllergyIntolerance, Observation |
| Lab Interpreter | Observation (category=laboratory) |
| Risk Scorer | Patient, Condition, Observation (laboratory + vital-signs) |
| Care Plan | Patient, Condition, MedicationRequest, Observation, AllergyIntolerance |
| Clinical Notes | DocumentReference |

All FHIR queries use SHARP Extension Specs headers:
- `x-fhir-server-url` — FHIR server endpoint
- `x-fhir-access-token` — Bearer token for FHIR auth
- `x-patient-id` — Patient identifier

## Project Structure

```
├── index.ts                  # Express + MCP server entry point
├── config.ts                 # Configuration constants
├── IMcpTool.ts               # Tool interface
├── fhir-client.ts            # FHIR HTTP client (with timeout)
├── fhir-context.ts           # FHIR context type
├── fhir-utilities.ts         # SHARP header extraction
├── services/
│   ├── claude-service.ts     # Claude API client (retry, JSON parsing)
│   ├── fhir-data-service.ts  # Parallel FHIR queries, data extraction
│   └── response-formatter.ts # Markdown responses with disclaimers
├── tools/
│   ├── PatientSummaryGeneratorTool.ts
│   ├── DrugInteractionCheckerTool.ts
│   ├── ContraindicationCheckerTool.ts   # NEW
│   ├── LabResultInterpreterTool.ts
│   ├── ClinicalRiskScorerTool.ts
│   ├── CarePlanSuggesterTool.ts
│   ├── ParseClinicalNotesTool.ts
│   ├── PatientAgeTool.ts
│   ├── PatientIdTool.ts
│   └── index.ts              # Tool registry
├── tests/
│   └── clinical-logic.test.ts # 49 unit tests (6 suites)
├── demo-patient-bundle.json  # Margaret Chen (37 FHIR resources)
├── .env.example
├── Dockerfile
└── package.json
```

## Feasibility & Safety

- **FHIR R4 compliant** via SHARP Extension Specs — standard healthcare interoperability
- **No real PHI processed** — synthetic data only; no patient data stored beyond request lifecycle
- **Clinical disclaimers** appended to every response requiring professional validation
- **Patient context from SHARP headers** — not LLM-generated, ensuring identity integrity
- **PII minimization** — patient identifiers stripped before Claude API calls
- **Token isolation** — FHIR access tokens never forwarded to external services
- **Graceful degradation** — partial results returned when AI is unavailable (deterministic layer still functions)
- **Production patterns** — retry logic, parallel FHIR queries, error isolation, request timeouts

---

## Judging Criteria Alignment

### AI Factor

The hybrid architecture is the core differentiator. Deterministic clinical formulas (CHA2DS2-VASc, MELD-Na, HEART score, lab reference ranges) ensure reproducibility and safety. Claude AI provides contextual interpretation, drug interaction analysis, and care plan synthesis that goes beyond what rule-based systems can deliver. The AI adds genuine clinical reasoning — not just data retrieval.

### Potential Impact

Adverse drug events, polypharmacy errors, and missed contraindications are preventable harms. This server puts decision support directly into the AI agent workflow — the clinician gets interaction checks, risk scores, and contraindication alerts before making prescribing decisions. With 1.3 million ED visits annually from adverse drug events, even modest adoption reduces harm.

### Feasibility

FHIR R4 is the established standard for EHR interoperability. The MCP protocol enables any compatible AI agent to use these tools without custom integration. SHARP headers provide secure patient context. The server runs on a single Node.js process, deploys to any container host, and requires only an Anthropic API key. Eleven unit tests validate deterministic clinical logic.

---

## Built With

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Anthropic Claude API](https://docs.anthropic.com) (Sonnet 4.6)
- [FHIR R4](https://hl7.org/fhir/R4/) via [@smile-cdr/fhirts](https://github.com/nickmflorin/fhir-ts)
- [SHARP on MCP](https://sharponmcp.com) specification
- [Prompt Opinion](https://promptopinion.ai) platform
- TypeScript, Express 5, Zod 4

## License

ISC
