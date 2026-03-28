# Clinical Decision Support MCP Server

A healthcare AI MCP server that provides clinical decision support tools for the [Prompt Opinion](https://promptopinion.ai) platform. Built for the [Agents Assemble - Healthcare AI Endgame](https://agents-assemble.devpost.com/) hackathon.

## What It Does

This server exposes 5 clinical decision support tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) that any healthcare AI agent on the Prompt Opinion platform can invoke. Each tool retrieves patient data from FHIR R4 servers via [SHARP Extension Specs](https://sharponmcp.com) and combines deterministic clinical logic with AI-powered reasoning.

### Tools

| Tool | Description |
|------|-------------|
| `generate_patient_summary` | Aggregates demographics, conditions, medications, labs, allergies, and encounters into a clinician-ready summary with AI narrative synthesis |
| `check_drug_interactions` | Fetches active medications from FHIR, identifies drug-drug interactions using AI pharmacological reasoning, classifies by severity |
| `interpret_lab_results` | Retrieves lab results, flags abnormalities against reference ranges, detects trends, provides AI clinical interpretation |
| `calculate_risk_scores` | Calculates CHA2DS2-VASc (stroke), HEART (chest pain), and MELD-Na (liver) scores using deterministic formulas with AI interpretation |
| `suggest_care_plan` | Analyzes conditions, medications, labs, and allergies to generate evidence-based care plan recommendations aligned with clinical guidelines |

Plus 2 utility tools from the starter template: `GetPatientAge` and `FindPatientId`.

## Architecture

```
Prompt Opinion Platform
        │ SHARP Headers (x-fhir-server-url, x-fhir-access-token, x-patient-id)
        ▼
┌─────────────────────────────────────┐
│   Clinical Decision Support MCP     │
│           (Express:5000)            │
│                                     │
│  ┌─────────┐  ┌──────────────────┐  │
│  │  FHIR   │  │  5 Clinical      │  │
│  │  Data    │  │  Tools           │  │
│  │  Service │  │                  │  │
│  └────┬────┘  └───────┬──────────┘  │
│       │               │             │
│  ┌────┴────┐  ┌───────┴──────────┐  │
│  │ FHIR R4 │  │ Claude API       │  │
│  │ Server  │  │ (AI Reasoning)   │  │
│  └─────────┘  └──────────────────┘  │
└─────────────────────────────────────┘
```

**Hybrid AI approach:** Deterministic computation for published clinical formulas (CHA2DS2-VASc, MELD-Na, reference ranges) + Claude AI for interpretation, interaction analysis, care plan reasoning, and narrative synthesis.

## Setup

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com)

### Install & Run

```bash
# Clone
git clone https://github.com/avadh-pro/clinical-decision-support-mcp.git
cd clinical-decision-support-mcp

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Start the server
npm run start
```

The server starts on port 5000 (configurable via `PORT` env var).

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for Claude |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6-20250514` | Claude model to use |
| `PORT` | No | `5000` | Server port |
| `PO_ENV` | No | `local` | Environment (`dev`, `prod`, `local`) |

### Health Check

```bash
curl http://localhost:5000/hello-world
# Returns: Hello World
```

## FHIR Resources Used

| Tool | FHIR Resources |
|------|---------------|
| Patient Summary | Patient, Condition, MedicationRequest, Observation, AllergyIntolerance, Encounter |
| Drug Interactions | MedicationRequest, MedicationStatement |
| Lab Interpreter | Observation (category=laboratory) |
| Risk Scorer | Patient, Condition, Observation (laboratory + vital-signs) |
| Care Plan | Patient, Condition, MedicationRequest, Observation, AllergyIntolerance |

All FHIR queries use SHARP Extension Specs headers for context propagation:
- `x-fhir-server-url` — FHIR server endpoint
- `x-fhir-access-token` — Bearer token for FHIR auth
- `x-patient-id` — Patient identifier

## Testing

Test against the public HAPI FHIR sandbox:

```bash
# Start server
PORT=3000 npm run start

# Call a tool via MCP protocol
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

## Project Structure

```
├── index.ts                  # Express + MCP server entry point
├── config.ts                 # Configuration constants
├── IMcpTool.ts               # Tool interface
├── fhir-client.ts            # FHIR HTTP client
├── fhir-context.ts           # FHIR context type
├── fhir-utilities.ts         # SHARP header extraction
├── mcp-constants.ts          # Header constants
├── mcp-utilities.ts          # MCP response helpers
├── services/
│   ├── claude-service.ts     # Claude API client (retry, JSON parsing)
│   ├── fhir-data-service.ts  # Parallel FHIR queries, data extraction
│   └── response-formatter.ts # Markdown responses with disclaimers
├── tools/
│   ├── PatientSummaryGeneratorTool.ts
│   ├── DrugInteractionCheckerTool.ts
│   ├── LabResultInterpreterTool.ts
│   ├── ClinicalRiskScorerTool.ts
│   ├── CarePlanSuggesterTool.ts
│   ├── PatientAgeTool.ts     # (starter)
│   ├── PatientIdTool.ts      # (starter)
│   └── index.ts              # Tool registry
├── .env.example
├── Dockerfile
└── package.json
```

## Privacy & Safety

- **Synthetic data only** — never processes real PHI
- **PII minimization** — patient identifiers stripped before Claude API calls
- **Token isolation** — FHIR access tokens are never forwarded to external services
- **No persistence** — no patient data stored beyond request lifecycle
- **Clinical disclaimer** — every response includes a disclaimer that it requires professional validation

## Built With

- [Prompt Opinion po-community-mcp](https://github.com/prompt-opinion/po-community-mcp) starter template
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Anthropic Claude API](https://docs.anthropic.com)
- [FHIR R4](https://hl7.org/fhir/R4/) via [@smile-cdr/fhirts](https://github.com/nickmflorin/fhir-ts)
- [SHARP on MCP](https://sharponmcp.com) specification
- TypeScript, Express, Zod

## Debugging (VS Code)

1. Open `index.ts` as the active tab
2. Select **Run and Debug** from the sidebar
3. Choose `tsx` from the configuration dropdown
4. Click the green play button

## License

ISC
