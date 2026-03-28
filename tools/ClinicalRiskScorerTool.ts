import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

// ── Condition code maps ──────────────────────────────────────────────

const CONDITION_MAPS = {
  CHF: {
    snomedCodes: ["42343007", "84114007", "85232009"],
    icd10Prefixes: ["I50"],
    keywords: ["heart failure", "chf", "congestive heart failure"],
  },
  HYPERTENSION: {
    snomedCodes: ["38341003", "59621000"],
    icd10Prefixes: ["I10", "I11", "I12", "I13", "I15"],
    keywords: ["hypertension", "high blood pressure"],
  },
  DIABETES: {
    snomedCodes: ["73211009", "44054006", "46635009"],
    icd10Prefixes: ["E10", "E11", "E13"],
    keywords: ["diabetes"],
  },
  STROKE_TIA: {
    snomedCodes: ["230690007", "266257000", "71444005"],
    icd10Prefixes: ["I63", "I64", "G45"],
    keywords: ["stroke", "tia", "transient ischemic attack", "cva"],
  },
  VASCULAR_DISEASE: {
    snomedCodes: ["22298006", "399957001"],
    icd10Prefixes: ["I21", "I25", "I70"],
    keywords: ["myocardial infarction", "peripheral arterial disease"],
  },
  ATRIAL_FIBRILLATION: {
    snomedCodes: ["49436004", "5370000"],
    icd10Prefixes: ["I48"],
    keywords: ["atrial fibrillation", "afib"],
  },
  LIVER_DISEASE: {
    snomedCodes: ["235856003", "197321007", "19943007"],
    icd10Prefixes: ["K70", "K71", "K72", "K73", "K74"],
    keywords: ["cirrhosis", "liver disease", "hepatic"],
  },
  HYPERLIPIDEMIA: {
    snomedCodes: ["55822004"],
    icd10Prefixes: ["E78"],
    keywords: ["hyperlipidemia", "hypercholesterolemia", "dyslipidemia"],
  },
} as const;

interface ConditionTarget {
  snomedCodes: readonly string[];
  icd10Prefixes: readonly string[];
  keywords: readonly string[];
}

// ── LOINC codes for lab extraction ───────────────────────────────────

const RISK_LOINC = {
  TROPONIN_I: ["6598-7", "10839-9", "49563-0"],
  TROPONIN_T: ["6597-9", "67151-1"],
  BILIRUBIN: ["1975-2"],
  INR: ["6301-6"],
  CREATININE: ["2160-0"],
  SODIUM: ["2951-2"],
};

// ── Helpers ──────────────────────────────────────────────────────────

function patientHasCondition(
  conditions: fhirR4.Condition[],
  target: ConditionTarget,
): boolean {
  return conditions.some((c) => {
    const codings = c.code?.coding ?? [];
    for (const coding of codings) {
      if (
        coding.system?.includes("snomed") &&
        target.snomedCodes.includes(coding.code ?? "")
      )
        return true;
      if (
        coding.system?.includes("icd") &&
        target.icd10Prefixes.some((p) => (coding.code ?? "").startsWith(p))
      )
        return true;
    }
    const text = (c.code?.text ?? "").toLowerCase();
    return target.keywords.some((kw) => {
      // Use word boundary matching to avoid partial matches (e.g., "dementia" matching "tia")
      const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return regex.test(text);
    });
  });
}

function getMostRecentLab(
  observations: fhirR4.Observation[],
  loincCodes: string[],
): { value: number; date: string } | null {
  const matching = observations
    .filter(
      (obs) =>
        obs.code?.coding?.some(
          (c) =>
            c.system === "http://loinc.org" &&
            loincCodes.includes(c.code ?? ""),
        ) && obs.valueQuantity?.value !== undefined,
    )
    .sort(
      (a, b) =>
        new Date(b.effectiveDateTime ?? "").getTime() -
        new Date(a.effectiveDateTime ?? "").getTime(),
    );
  if (!matching.length) return null;
  return {
    value: matching[0]!.valueQuantity!.value!,
    date: matching[0]!.effectiveDateTime ?? "unknown",
  };
}

function conditionListText(conditions: fhirR4.Condition[]): string {
  if (!conditions.length) return "None recorded";
  return conditions
    .map((c) => c.code?.text || c.code?.coding?.[0]?.display || "Unknown")
    .join(", ");
}

// ── Score interfaces ─────────────────────────────────────────────────

interface ScoreComponent {
  name: string;
  points: number;
  present: boolean;
  source: string;
}

interface CHA2DS2VAScResult {
  type: "CHA2DS2-VASc";
  score: number;
  maxScore: 9;
  riskCategory: string;
  recommendation: string;
  components: ScoreComponent[];
}

interface HEARTResult {
  type: "HEART";
  score: number;
  maxScore: 10;
  riskCategory: string;
  partial: boolean;
  warnings: string[];
  components: ScoreComponent[];
}

interface MELDResult {
  type: "MELD-Na";
  canCalculate: boolean;
  score: number | null;
  riskCategory: string;
  missingLabs: string[];
  components: { name: string; value: number | null; date: string }[];
}

// ── Score calculators ────────────────────────────────────────────────

function calculateCHA2DS2VASc(
  age: number,
  sex: string,
  conditions: fhirR4.Condition[],
): CHA2DS2VAScResult {
  const hasCHF = patientHasCondition(conditions, CONDITION_MAPS.CHF);
  const hasHTN = patientHasCondition(conditions, CONDITION_MAPS.HYPERTENSION);
  const hasDM = patientHasCondition(conditions, CONDITION_MAPS.DIABETES);
  const hasStroke = patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA);
  const hasVasc = patientHasCondition(
    conditions,
    CONDITION_MAPS.VASCULAR_DISEASE,
  );
  const isFemale = sex === "female";

  const components: ScoreComponent[] = [
    {
      name: "CHF (C)",
      points: hasCHF ? 1 : 0,
      present: hasCHF,
      source: hasCHF ? "Active condition" : "Not found",
    },
    {
      name: "Hypertension (H)",
      points: hasHTN ? 1 : 0,
      present: hasHTN,
      source: hasHTN ? "Active condition" : "Not found",
    },
    {
      name: "Age >= 75 (A2)",
      points: age >= 75 ? 2 : 0,
      present: age >= 75,
      source: `Age: ${age}`,
    },
    {
      name: "Diabetes (D)",
      points: hasDM ? 1 : 0,
      present: hasDM,
      source: hasDM ? "Active condition" : "Not found",
    },
    {
      name: "Stroke/TIA (S2)",
      points: hasStroke ? 2 : 0,
      present: hasStroke,
      source: hasStroke ? "Active condition" : "Not found",
    },
    {
      name: "Vascular disease (V)",
      points: hasVasc ? 1 : 0,
      present: hasVasc,
      source: hasVasc ? "Active condition" : "Not found",
    },
    {
      name: "Age 65-74 (A)",
      points: age >= 65 && age < 75 ? 1 : 0,
      present: age >= 65 && age < 75,
      source: `Age: ${age}`,
    },
    {
      name: "Sex category female (Sc)",
      points: isFemale ? 1 : 0,
      present: isFemale,
      source: `Sex: ${sex}`,
    },
  ];

  const score = components.reduce((sum, c) => sum + c.points, 0);

  let riskCategory: string;
  let recommendation: string;
  if (score === 0) {
    riskCategory = "Low";
    recommendation = "No antithrombotic therapy recommended.";
  } else if (score === 1) {
    riskCategory = "Low-moderate";
    recommendation =
      "Consider oral anticoagulation or antiplatelet therapy based on clinical judgment.";
  } else {
    riskCategory = "Moderate-high";
    recommendation = "Oral anticoagulation is recommended.";
  }

  return {
    type: "CHA2DS2-VASc",
    score,
    maxScore: 9,
    riskCategory,
    recommendation,
    components,
  };
}

function calculateHEART(
  age: number,
  conditions: fhirR4.Condition[],
  observations: fhirR4.Observation[],
): HEARTResult {
  const warnings: string[] = [];

  // History – not available from FHIR
  const historyPoints = 0;
  warnings.push("History component scored as 0 (not available from FHIR)");

  // ECG – not available from FHIR
  const ecgPoints = 0;
  warnings.push("ECG component scored as 0 (not available from FHIR)");

  // Age
  let agePoints = 0;
  if (age >= 65) agePoints = 2;
  else if (age >= 45) agePoints = 1;

  // Risk factors
  const hasHTN = patientHasCondition(conditions, CONDITION_MAPS.HYPERTENSION);
  const hasDM = patientHasCondition(conditions, CONDITION_MAPS.DIABETES);
  const hasHL = patientHasCondition(conditions, CONDITION_MAPS.HYPERLIPIDEMIA);
  const riskFactorCount = [hasHTN, hasDM, hasHL].filter(Boolean).length;
  let riskFactorPoints = 0;
  if (riskFactorCount >= 3) riskFactorPoints = 2;
  else if (riskFactorCount >= 1) riskFactorPoints = 1;

  // Troponin
  const troponin =
    getMostRecentLab(observations, RISK_LOINC.TROPONIN_I) ??
    getMostRecentLab(observations, RISK_LOINC.TROPONIN_T);
  let troponinPoints = 0;
  let troponinSource: string;
  if (!troponin) {
    troponinPoints = 0;
    troponinSource = "Not available (scored as 0)";
    warnings.push("Troponin not available — scored as 0");
  } else if (troponin.value <= 0.04) {
    troponinPoints = 0;
    troponinSource = `${troponin.value} ng/mL (${troponin.date})`;
  } else if (troponin.value <= 0.12) {
    troponinPoints = 1;
    troponinSource = `${troponin.value} ng/mL (${troponin.date})`;
  } else {
    troponinPoints = 2;
    troponinSource = `${troponin.value} ng/mL (${troponin.date})`;
  }

  const components: ScoreComponent[] = [
    {
      name: "History",
      points: historyPoints,
      present: false,
      source: "Not available from FHIR",
    },
    {
      name: "ECG",
      points: ecgPoints,
      present: false,
      source: "Not available from FHIR",
    },
    {
      name: "Age",
      points: agePoints,
      present: agePoints > 0,
      source: `Age: ${age}`,
    },
    {
      name: "Risk Factors",
      points: riskFactorPoints,
      present: riskFactorCount > 0,
      source: `HTN: ${hasHTN ? "Yes" : "No"}, DM: ${hasDM ? "Yes" : "No"}, Lipids: ${hasHL ? "Yes" : "No"}`,
    },
    {
      name: "Troponin",
      points: troponinPoints,
      present: troponinPoints > 0,
      source: troponinSource,
    },
  ];

  const score = components.reduce((sum, c) => sum + c.points, 0);

  let riskCategory: string;
  if (score <= 3) riskCategory = "Low";
  else if (score <= 6) riskCategory = "Moderate";
  else riskCategory = "High";

  return {
    type: "HEART",
    score,
    maxScore: 10,
    riskCategory,
    partial: true,
    warnings,
    components,
  };
}

function calculateMELD(
  observations: fhirR4.Observation[],
): MELDResult {
  const bilirubin = getMostRecentLab(observations, RISK_LOINC.BILIRUBIN);
  const inr = getMostRecentLab(observations, RISK_LOINC.INR);
  const creatinine = getMostRecentLab(observations, RISK_LOINC.CREATININE);
  const sodium = getMostRecentLab(observations, RISK_LOINC.SODIUM);

  const components: { name: string; value: number | null; date: string }[] = [
    {
      name: "Bilirubin (mg/dL)",
      value: bilirubin?.value ?? null,
      date: bilirubin?.date ?? "N/A",
    },
    { name: "INR", value: inr?.value ?? null, date: inr?.date ?? "N/A" },
    {
      name: "Creatinine (mg/dL)",
      value: creatinine?.value ?? null,
      date: creatinine?.date ?? "N/A",
    },
    {
      name: "Sodium (mEq/L)",
      value: sodium?.value ?? null,
      date: sodium?.date ?? "N/A",
    },
  ];

  const missingLabs: string[] = [];
  if (!bilirubin) missingLabs.push("Bilirubin");
  if (!inr) missingLabs.push("INR");
  if (!creatinine) missingLabs.push("Creatinine");

  if (missingLabs.length > 0) {
    return {
      type: "MELD-Na",
      canCalculate: false,
      score: null,
      riskCategory: "Cannot calculate",
      missingLabs,
      components,
    };
  }

  // Clamp values per MELD formula
  const bili = Math.max(bilirubin!.value, 1);
  const inrVal = Math.max(inr!.value, 1);
  const cr = Math.min(Math.max(creatinine!.value, 1), 4);

  // MELD(i) calculation
  let meld = Math.round(
    10 *
      (0.957 * Math.log(cr) +
        0.378 * Math.log(bili) +
        1.12 * Math.log(inrVal) +
        0.643),
  );

  // Apply sodium correction if available
  if (sodium) {
    const na = Math.min(Math.max(sodium.value, 125), 137);
    meld = Math.round(meld + 1.32 * (137 - na) - 0.033 * meld * (137 - na));
  }

  // Floor 6, cap 40
  meld = Math.min(Math.max(meld, 6), 40);

  let riskCategory: string;
  if (meld < 10) riskCategory = "Low mortality risk";
  else if (meld < 20) riskCategory = "Moderate mortality risk";
  else if (meld < 30) riskCategory = "High mortality risk";
  else riskCategory = "Very high mortality risk";

  return {
    type: "MELD-Na",
    canCalculate: true,
    score: meld,
    riskCategory,
    missingLabs: [],
    components,
  };
}

// ── Markdown formatters ──────────────────────────────────────────────

function formatCHA2DS2VASc(result: CHA2DS2VAScResult): string {
  let md = `### CHA2DS2-VASc Score: ${result.score}/${result.maxScore} — ${result.riskCategory}\n\n`;
  md += `| Component | Points | Present | Source |\n`;
  md += `|-----------|--------|---------|--------|\n`;
  for (const c of result.components) {
    md += `| ${c.name} | ${c.points} | ${c.present ? "Yes" : "No"} | ${c.source} |\n`;
  }
  md += `\n**Recommendation:** ${result.recommendation}\n`;
  return md;
}

function formatHEART(result: HEARTResult): string {
  let md = `### HEART Score: ${result.score}/${result.maxScore} — ${result.riskCategory}\n\n`;
  if (result.partial) {
    md += `> **Partial Score:** History and ECG components are not available from FHIR data and are scored as 0. Actual score may be higher.\n\n`;
  }
  md += `| Component | Points | Present | Source |\n`;
  md += `|-----------|--------|---------|--------|\n`;
  for (const c of result.components) {
    md += `| ${c.name} | ${c.points} | ${c.present ? "Yes" : "No"} | ${c.source} |\n`;
  }
  return md;
}

function formatMELD(result: MELDResult): string {
  if (!result.canCalculate) {
    let md = `### MELD-Na Score: Cannot Calculate\n\n`;
    md += `**Missing required labs:** ${result.missingLabs.join(", ")}\n\n`;
    md += `| Lab | Value | Date |\n`;
    md += `|-----|-------|------|\n`;
    for (const c of result.components) {
      md += `| ${c.name} | ${c.value !== null ? c.value : "**Missing**"} | ${c.date} |\n`;
    }
    return md;
  }

  let md = `### MELD-Na Score: ${result.score} — ${result.riskCategory}\n\n`;
  md += `| Lab | Value | Date |\n`;
  md += `|-----|-------|------|\n`;
  for (const c of result.components) {
    md += `| ${c.name} | ${c.value !== null ? c.value : "N/A"} | ${c.date} |\n`;
  }
  return md;
}

// ── Tool class ───────────────────────────────────────────────────────

class ClinicalRiskScorerTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "calculate_risk_scores",
      {
        description:
          "Calculates standardized clinical risk scores for a patient including CHA2DS2-VASc (stroke risk in atrial fibrillation), HEART (chest pain evaluation), and MELD-Na (liver disease severity). Uses deterministic formulas with AI-powered relevance assessment and interpretation.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "Patient ID. Optional if patient context exists.",
            ),
          scoreType: z
            .enum(["HEART", "CHA2DS2-VASc", "MELD", "all"])
            .optional()
            .default("all")
            .describe(
              "Specific risk score to calculate, or 'all' for AI-selected relevant scores",
            ),
        },
      },
      async ({ patientId, scoreType }) => {
        try {
          // 1. Resolve patient ID
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Fetch data in parallel
          const [patient, dataMap] = await Promise.all([
            FhirDataServiceInstance.getPatient(req, resolvedPatientId),
            FhirDataServiceInstance.fetchParallel(req, [
              {
                resourceType: "Condition",
                params: [
                  `patient=${resolvedPatientId}`,
                  "clinical-status=active",
                  "_count=100",
                ],
              },
              {
                resourceType: "Observation",
                params: [
                  `patient=${resolvedPatientId}`,
                  "category=laboratory",
                  "_count=100",
                  "_sort=-date",
                ],
              },
            ]),
          ]);

          if (!patient) {
            return ResponseFormatter.error(
              `Patient ${resolvedPatientId} could not be found.`,
            );
          }

          // 3. Extract patient demographics
          const age = FhirDataServiceInstance.getPatientAge(patient);
          if (age === null) {
            return ResponseFormatter.error(
              "Patient birth date is not available — cannot calculate risk scores.",
            );
          }
          const sex = FhirDataServiceInstance.getPatientSex(patient);

          // 4. Extract conditions and observations
          const conditions = (dataMap.get("Condition") ?? []).map(
            (e) => e.resource as fhirR4.Condition,
          );
          const observations = (dataMap.get("Observation") ?? []).map(
            (e) => e.resource as fhirR4.Observation,
          );

          // 5. Determine which scores to calculate
          let scoresToCalculate: Array<"CHA2DS2-VASc" | "HEART" | "MELD">;

          if (scoreType && scoreType !== "all") {
            scoresToCalculate = [scoreType as "CHA2DS2-VASc" | "HEART" | "MELD"];
          } else {
            // Determine relevance based on conditions
            const hasAfib = patientHasCondition(
              conditions,
              CONDITION_MAPS.ATRIAL_FIBRILLATION,
            );
            const hasLiver = patientHasCondition(
              conditions,
              CONDITION_MAPS.LIVER_DISEASE,
            );
            const hasCardiacRiskFactors =
              patientHasCondition(conditions, CONDITION_MAPS.HYPERTENSION) ||
              patientHasCondition(conditions, CONDITION_MAPS.DIABETES) ||
              patientHasCondition(conditions, CONDITION_MAPS.HYPERLIPIDEMIA) ||
              patientHasCondition(conditions, CONDITION_MAPS.VASCULAR_DISEASE);

            scoresToCalculate = [];
            if (hasAfib) scoresToCalculate.push("CHA2DS2-VASc");
            if (hasCardiacRiskFactors || hasAfib) scoresToCalculate.push("HEART");
            if (hasLiver) scoresToCalculate.push("MELD");

            // If no conditions suggest any score, calculate all three
            if (scoresToCalculate.length === 0) {
              scoresToCalculate = ["CHA2DS2-VASc", "HEART", "MELD"];
            }
          }

          // 6. Calculate scores
          const results: Array<CHA2DS2VAScResult | HEARTResult | MELDResult> =
            [];
          const warnings: string[] = [];

          for (const score of scoresToCalculate) {
            switch (score) {
              case "CHA2DS2-VASc":
                results.push(calculateCHA2DS2VASc(age, sex, conditions));
                break;
              case "HEART": {
                const heartResult = calculateHEART(age, conditions, observations);
                results.push(heartResult);
                warnings.push(...heartResult.warnings);
                break;
              }
              case "MELD":
                results.push(calculateMELD(observations));
                break;
            }
          }

          // 7. Build score summary for AI interpretation
          const scoreSummary = results
            .map((r) => {
              if (r.type === "CHA2DS2-VASc") {
                const chad = r as CHA2DS2VAScResult;
                return `CHA2DS2-VASc: ${chad.score}/9 (${chad.riskCategory})`;
              } else if (r.type === "HEART") {
                const heart = r as HEARTResult;
                return `HEART (partial): ${heart.score}/10 (${heart.riskCategory})`;
              } else {
                const meld = r as MELDResult;
                return meld.canCalculate
                  ? `MELD-Na: ${meld.score} (${meld.riskCategory})`
                  : `MELD-Na: Cannot calculate (missing: ${meld.missingLabs.join(", ")})`;
              }
            })
            .join("\n");

          // 8. AI interpretation
          let interpretation: string;
          try {
            interpretation = await ClaudeServiceInstance.analyze(
              `You are a clinical decision support assistant. You are given calculated clinical risk scores for a patient. Provide a concise interpretation that:
1. Explains the clinical relevance of each score for this patient.
2. Interprets the score values in context of the patient's conditions.
3. Notes any limitations (e.g., partial HEART score, missing labs for MELD).
4. Does NOT provide specific treatment recommendations — defer to the treating clinician.
Keep the response to 3-5 sentences. Use plain clinical language.`,
              `Patient: Age ${age}, Sex ${sex}
Active Conditions: ${conditionListText(conditions)}
Calculated Scores:
${scoreSummary}`,
            );
          } catch {
            interpretation =
              "AI interpretation unavailable. Please review scores in clinical context.";
          }

          // 9. Build markdown response
          let markdown = `# Clinical Risk Score Assessment\n\n`;
          markdown += `## Patient Context\n`;
          markdown += `- **Age:** ${age} | **Sex:** ${sex}\n`;
          markdown += `- **Active Conditions:** ${conditionListText(conditions)}\n\n`;
          markdown += `## Calculated Scores\n\n`;

          for (const result of results) {
            if (result.type === "CHA2DS2-VASc") {
              markdown += formatCHA2DS2VASc(result as CHA2DS2VAScResult);
            } else if (result.type === "HEART") {
              markdown += formatHEART(result as HEARTResult);
            } else {
              markdown += formatMELD(result as MELDResult);
            }
            markdown += "\n";
          }

          markdown += `## Clinical Interpretation\n\n${interpretation}`;

          return warnings.length > 0
            ? ResponseFormatter.partialSuccess(markdown, warnings)
            : ResponseFormatter.success(markdown);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return ResponseFormatter.error(
            `Failed to calculate risk scores: ${message}`,
          );
        }
      },
    );
  }
}

export const ClinicalRiskScorerToolInstance = new ClinicalRiskScorerTool();
