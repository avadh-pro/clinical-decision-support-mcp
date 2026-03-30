# Demo Video Script — Clinical Cascade

**Duration:** 3 minutes
**Style:** Clinical story, not tech tour. Speak like presenting to physician colleagues, not engineers.
**Patient:** Margaret Chen, 67F, atrial fibrillation + type 2 diabetes + hypertension

---

## [0:00 – 0:20] Hook — The Problem

**VISUAL:** Impact statistics on screen (dark background, bold numbers)

**NARRATION:**
"Every year, 7,000 to 9,000 Americans die from medication errors. 42 billion dollars in global harm. What if an AI agent could catch dangerous drug combinations and score risk — before a prescribing decision is made?"

**TEXT ON SCREEN:**
- 7,000–9,000 deaths/year (medication errors)
- $42B/year global cost
- 6M Americans with atrial fibrillation

---

## [0:20 – 0:40] What We Built

**VISUAL:** Architecture diagram — simple, clinical language

**NARRATION:**
"We built a clinical decision support engine — 8 tools that any healthcare AI agent can call through the Model Context Protocol. It connects directly to patient records via FHIR, the universal standard for electronic health records. And it uses a hybrid approach: deterministic formulas for risk scores — these never hallucinate — combined with AI reasoning for drug interactions and care plans."

**TEXT ON SCREEN:**
- "Hybrid AI: Deterministic formulas + AI reasoning"
- "FHIR R4 → Patient data → Clinical decisions"

---

## [0:40 – 2:20] The Clinical Cascade Demo

**VISUAL:** Live screen recording of agent interaction on Prompt Opinion

### Scene 1: Patient Summary [0:40 – 1:00]

**NARRATION:**
"Let's meet Margaret Chen. 67 years old, recently diagnosed with atrial fibrillation, managing diabetes and hypertension for over a decade. One question to the agent..."

**AGENT PROMPT:** "Summarize this patient"
**TOOL FIRES:** `generate_patient_summary`

**NARRATION:**
"The agent pulls her demographics, conditions, medications, labs, allergies, and encounters — and synthesizes a clinician-ready summary. But here's where it gets interesting..."

### Scene 2: Risk Scoring — The Key Moment [1:00 – 1:30]

**NARRATION:**
"Every patient with atrial fibrillation needs a stroke risk assessment. Let's ask..."

**AGENT PROMPT:** "What's her stroke risk?"
**TOOL FIRES:** `calculate_risk_scores`

**NARRATION (slow, emphasize):**
"CHA2DS2-VASc score: 4 out of 9. Moderate to high risk. And look at the component breakdown — this is deterministic math, not AI guessing. Hypertension: plus one. Diabetes: plus one. Age 65 to 74: plus one. Female: plus one. Each point traced back to her actual FHIR data. The recommendation: oral anticoagulation is indicated."

**TEXT ON SCREEN:** Show the component table with checkmarks

### Scene 3: Drug Safety [1:30 – 1:50]

**NARRATION:**
"She's on apixaban, metformin, lisinopril, and atorvastatin. Are there interactions?"

**AGENT PROMPT:** "Check her drug interactions"
**TOOL FIRES:** `check_drug_interactions`

**NARRATION:**
"The system identifies the interaction between apixaban and atorvastatin — moderate severity, CYP3A4-mediated. Now the critical question..."

### Scene 4: Contraindication Check — The Wow Moment [1:50 – 2:10]

**NARRATION:**
"Her cardiologist is considering amiodarone for rate control. Can she take it safely?"

**AGENT PROMPT:** "Can I prescribe amiodarone for this patient?"
**TOOL FIRES:** `check_contraindications`

**NARRATION (emphasis):**
"Caution. The system flags the amiodarone-apixaban interaction — major severity, increases bleeding risk. It also checks her renal function, her diabetes medications, and her allergies. This is the moment that prevents a medication error."

**TEXT ON SCREEN:** Verdict with contraindication details

### Scene 5: Care Plan [2:10 – 2:20]

**AGENT PROMPT:** "Create a care plan"
**TOOL FIRES:** `suggest_care_plan`

**NARRATION:**
"Finally, the agent synthesizes everything into an evidence-based care plan — medication adjustments, monitoring schedule, follow-up timing. Five tools, one clinical workflow, zero manual data gathering."

---

## [2:20 – 2:50] Why This Matters

**VISUAL:** Side-by-side comparison

**NARRATION:**
"What you just saw wasn't 8 isolated tools. It was a clinical reasoning engine. The hybrid approach means risk scores are mathematically exact — zero hallucination — while AI adds the drug knowledge and clinical interpretation that would take a pharmacist 15 minutes to produce. And it works with any FHIR-compliant EHR through standard protocols."

**TEXT ON SCREEN:**
- Deterministic: CHA2DS2-VASc, MELD-Na, lab ranges
- AI-powered: Drug interactions, contraindications, care plans
- Standard: FHIR R4 + SHARP + MCP

---

## [2:50 – 3:00] Close

**VISUAL:** Logo + team info

**NARRATION:**
"Clinical Decision Support MCP Server. Because catching a dangerous drug interaction shouldn't depend on how tired the pharmacist is at 2 AM."

**TEXT ON SCREEN:**
- GitHub repo link
- "Built for Agents Assemble 2026"

---

## Production Notes

- Record the Prompt Opinion agent interaction as screen capture
- Use `/transcript-router` skill to plan the visual production:
  - Kling AI for the hook sequence (cinematic medical imagery)
  - Remotion for the statistics overlays and architecture diagram
  - Screen recording for the live demo sections
- Add subtle background music (medical/tech feel, low volume)
- Ensure all tool outputs are visible and readable (zoom in on key moments)
- The CHA2DS2-VASc component table is the "money shot" — linger on it
