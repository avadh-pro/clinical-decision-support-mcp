# Clinical Decision Support MCP Server

> **Preventing the 7,000–9,000 medication-related deaths that happen every year in the US** — one AI-assisted clinical decision at a time.

A healthcare AI MCP server that gives any AI agent on the [Prompt Opinion](https://promptopinion.ai) platform real-time clinical decision support: drug interaction checks, stroke risk scoring, contraindication screening, lab interpretation, and care plan generation — all backed by patient data from FHIR R4 electronic health records.

Built for the [Agents Assemble — Healthcare AI Endgame](https://agents-assemble.devpost.com/) hackathon.

## Why This Matters

| Statistic | Source |
|-----------|--------|
| **7,000–9,000 deaths/year** in the US from medication errors | FDA |
| **$42 billion/year** cost of medication-related harm globally | WHO |
| **6 million Americans** living with atrial fibrillation need stroke risk assessment | CDC |
| **1.3 million injuries/year** from medication errors in the US alone | IOM |

This server puts evidence-based clinical reasoning directly into AI agent workflows — catching dangerous drug interactions, flagging contraindications, and calculating risk scores **before** a prescribing decision is made.

## What It Does

8 clinical decision support tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Each tool retrieves live patient data from FHIR R4 servers via [SHARP Extension Specs](https://sharponmcp.com) and combines **deterministic clinical logic with AI-powered reasoning**.

### Clinical Tools (6)

| Tool | What It Does |
|------|-------------|
| `generate_patient_summary` | Aggregates demographics, conditions, medications, labs, allergies, and encounters into a clinician-ready summary with AI narrative synthesis |
| `check_drug_interactions` | Analyzes active medications for drug-drug interactions, classifies by severity (critical/major/moderate/minor), explains mechanisms |
| `check_contraindications` | **"Can I prescribe Drug X to this patient?"** — cross-references conditions, meds, allergies, and labs to catch contraindications before prescribing |
| `interpret_lab_results` | Retrieves lab results, flags abnormalities against reference ranges, detects trends, provides AI clinical interpretation |
| `calculate_risk_scores` | Calculates CHA2DS2-VASc (stroke risk), HEART (chest pain), and MELD-Na (liver severity) using **deterministic formulas** with AI interpretation |
| `suggest_care_plan` | Analyzes the full clinical picture to generate evidence-based care plan recommendations aligned with clinical guidelines |
| `parse_clinical_notes` | Extracts structured data (diagnoses, medications, procedures, labs) from unstructured clinical documents using NLP |

### Utility Tools (2)

| Tool | What It Does |
|------|-------------|
| `GetPatientAge` | Returns patient age from birth date |
| `FindPatientId` | Returns patient ID from SHARP context |

## The Hybrid AI Approach

This isn't just "send FHIR data to an LLM and hope for the best." We use a **hybrid architecture**:

- **Deterministic computation** for published clinical formulas — CHA2DS2-VASc stroke risk scoring uses the exact published point system (CHF=1, Hypertension=1, Age≥75=2, Diabetes=1, Stroke/TIA=2, Vascular disease=1, Age 65-74=1, Female=1). MELD-Na uses the validated logarithmic formula. Lab flagging uses established reference ranges. **These never hallucinate.**

- **AI reasoning** for interpretation, drug interaction analysis, contraindication screening, care plan synthesis, and clinical note parsing — where Claude's medical knowledge adds genuine value.

```
Patient Question
       │
       ▼
┌──────────────────────────────┐
│   Deterministic Layer        │  ← Published formulas, reference ranges
│   (CHA2DS2-VASc, MELD,      │     SNOMED/ICD-10 code matching
│    lab flagging, trends)     │     Zero hallucination risk
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│   AI Interpretation Layer    │  ← Clinical reasoning, drug knowledge
│   (Claude Sonnet 4.6)       │     Interaction analysis, care plans
│                              │     Always marked as AI-generated
└──────────┬───────────────────┘
           │
           ▼
    Clinician-ready output
    with disclaimer
```

## Demo: Margaret Chen Clinical Cascade

Meet Margaret Chen — 67-year-old female, recently diagnosed with atrial fibrillation, managing type 2 diabetes and hypertension for over a decade. Her demo bundle includes 37 FHIR resources: demographics, conditions, medications, lab results, allergies, encounters, and 3 clinical notes.

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

11 unit tests covering deterministic clinical logic:
- CHA2DS2-VASc scoring (3 patient scenarios)
- Condition detection by SNOMED, ICD-10, and keyword (4 tests including false-positive prevention)
- MELD-Na calculation with and without labs (2 tests)
- Lab result extraction (2 tests)

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

### Test Patients (HAPI FHIR)

| Patient ID | Name | Data Available |
|-----------|------|----------------|
| `131284056` | Robert Chen, 72M | 4 conditions, 10 medications |
| `123836453` | Michael Kihn, 51M | 12 conditions, 2 allergies |

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
│   └── clinical-logic.test.ts # 11 unit tests
├── demo-patient-bundle.json  # Margaret Chen (37 FHIR resources)
├── .env.example
├── Dockerfile
└── package.json
```

## Privacy & Safety

- **Synthetic data only** — never processes real PHI in demo mode
- **PII minimization** — patient identifiers stripped before Claude API calls
- **Token isolation** — FHIR access tokens are never forwarded to external services
- **No persistence** — no patient data stored beyond request lifecycle
- **Clinical disclaimer** — every response includes a disclaimer requiring professional validation
- **Deterministic safety** — risk scores use published formulas, not AI generation

## Built With

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Anthropic Claude API](https://docs.anthropic.com) (Sonnet 4.6)
- [FHIR R4](https://hl7.org/fhir/R4/) via [@smile-cdr/fhirts](https://github.com/nickmflorin/fhir-ts)
- [SHARP on MCP](https://sharponmcp.com) specification
- [Prompt Opinion](https://promptopinion.ai) platform
- TypeScript, Express 5, Zod 4

## License

ISC
