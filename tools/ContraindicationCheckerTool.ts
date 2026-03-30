import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

// ── Interfaces ──────────────────────────────────────────────────────

interface Contraindication {
  type: "absolute" | "relative" | "interaction" | "allergy";
  description: string;
  severity: "critical" | "major" | "moderate";
  recommendation: string;
}

interface DoseAdjustment {
  reason: string;
  suggestion: string;
}

interface ContraindicationAnalysis {
  canPrescribe: "yes" | "no" | "caution";
  contraindications: Contraindication[];
  doseAdjustments: DoseAdjustment[];
  summary: string;
}

// ── Severity ordering ───────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  moderate: 2,
};

const VERDICT_ICONS: Record<string, string> = {
  no: "\u274C",      // red X
  caution: "\u26A0\uFE0F", // warning
  yes: "\u2705",     // green check
};

// ── System prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a clinical pharmacologist with deep expertise in drug safety, pharmacokinetics, and pharmacodynamics. You are part of a clinical decision support system. Your role is to evaluate whether a specific drug can be safely prescribed to a patient, given their full clinical context.

Rules:
- Check for ABSOLUTE contraindications (organ dysfunction, known allergy class, pregnancy category X, etc.)
- Check for RELATIVE contraindications (age, renal/hepatic impairment, disease interactions)
- Check for DRUG-DRUG INTERACTIONS with every current medication
- Check for DRUG-ALLERGY CROSS-REACTIVITY (e.g., penicillin allergy and cephalosporins)
- Evaluate whether DOSE ADJUSTMENTS are needed based on renal function (eGFR/creatinine), hepatic function (AST/ALT/bilirubin), age, or weight
- Be thorough — missing a contraindication is a patient safety issue
- Do NOT make final prescribing decisions — flag issues for clinician review
- If no contraindications exist, state that clearly

Respond ONLY with valid JSON:
{
  "canPrescribe": "yes" | "no" | "caution",
  "contraindications": [
    {
      "type": "absolute" | "relative" | "interaction" | "allergy",
      "description": "string",
      "severity": "critical" | "major" | "moderate",
      "recommendation": "string"
    }
  ],
  "doseAdjustments": [
    {
      "reason": "string",
      "suggestion": "string"
    }
  ],
  "summary": "string"
}`;

// ── Extraction helpers ──────────────────────────────────────────────

interface ExtractedCondition {
  name: string;
  codes: string[];
}

interface ExtractedMedication {
  name: string;
  dosage: string | null;
}

interface ExtractedAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
}

interface ExtractedLabResult {
  name: string;
  value: string;
  referenceRange: string | null;
  date: string | null;
  isAbnormal: boolean;
}

function extractConditions(
  entries: fhirR4.BundleEntry[],
): ExtractedCondition[] {
  return entries
    .map((e) => {
      const resource = e.resource as fhirR4.Condition;
      const name =
        resource.code?.text ??
        resource.code?.coding?.[0]?.display ??
        null;
      if (!name) return null;

      const codes = (resource.code?.coding ?? [])
        .map((c) => {
          if (c.system?.includes("snomed")) return `SNOMED:${c.code}`;
          if (c.system?.includes("icd")) return `ICD-10:${c.code}`;
          return c.code ? `${c.system ?? "unknown"}:${c.code}` : null;
        })
        .filter(Boolean) as string[];

      return { name, codes };
    })
    .filter(Boolean) as ExtractedCondition[];
}

function extractMedications(
  entries: fhirR4.BundleEntry[],
): ExtractedMedication[] {
  return entries
    .map((e) => {
      const resource = e.resource as fhirR4.MedicationRequest;
      const codeable = resource.medicationCodeableConcept;
      if (!codeable) return null;

      const name =
        codeable.text ?? codeable.coding?.[0]?.display ?? null;
      if (!name) return null;

      const dosageInstruction = resource.dosageInstruction?.[0];
      let dosage: string | null = dosageInstruction?.text ?? null;
      if (!dosage) {
        const doseQuantity =
          dosageInstruction?.doseAndRate?.[0]?.doseQuantity;
        if (doseQuantity?.value != null) {
          dosage = `${doseQuantity.value} ${doseQuantity.unit ?? ""}`.trim();
        }
      }

      return { name, dosage };
    })
    .filter(Boolean) as ExtractedMedication[];
}

function extractAllergies(
  entries: fhirR4.BundleEntry[],
): ExtractedAllergy[] {
  return entries
    .map((e) => {
      const resource = e.resource as fhirR4.AllergyIntolerance;
      const substance =
        resource.code?.text ??
        resource.code?.coding?.[0]?.display ??
        null;
      if (!substance) return null;

      const reaction = resource.reaction?.[0];
      const reactionText =
        reaction?.manifestation?.[0]?.text ??
        reaction?.manifestation?.[0]?.coding?.[0]?.display ??
        null;
      const severity = reaction?.severity ?? null;

      return { substance, reaction: reactionText, severity };
    })
    .filter(Boolean) as ExtractedAllergy[];
}

function extractAbnormalLabs(
  entries: fhirR4.BundleEntry[],
): ExtractedLabResult[] {
  return entries
    .map((e) => {
      const resource = e.resource as fhirR4.Observation;
      const name =
        resource.code?.text ??
        resource.code?.coding?.[0]?.display ??
        null;
      if (!name) return null;

      let value: string;
      if (resource.valueQuantity?.value != null) {
        value = `${resource.valueQuantity.value} ${resource.valueQuantity.unit ?? ""}`.trim();
      } else if (resource.valueString) {
        value = resource.valueString;
      } else {
        return null;
      }

      const refRange = resource.referenceRange?.[0];
      let referenceRange: string | null = null;
      if (refRange?.text) {
        referenceRange = refRange.text;
      } else if (refRange?.low?.value != null || refRange?.high?.value != null) {
        const low = refRange.low?.value != null ? `${refRange.low.value}` : "";
        const high = refRange.high?.value != null ? `${refRange.high.value}` : "";
        const unit = refRange.low?.unit ?? refRange.high?.unit ?? "";
        referenceRange = `${low}-${high} ${unit}`.trim();
      }

      // Check if abnormal via interpretation or reference range
      const isAbnormal =
        resource.interpretation?.[0]?.coding?.some(
          (c) =>
            c.code === "H" ||
            c.code === "L" ||
            c.code === "HH" ||
            c.code === "LL" ||
            c.code === "A",
        ) ?? false;

      const date = resource.effectiveDateTime ?? null;

      return { name, value, referenceRange, date, isAbnormal };
    })
    .filter(Boolean) as ExtractedLabResult[];
}

// ── Tool class ──────────────────────────────────────────────────────

class ContraindicationCheckerTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "check_contraindications",
      {
        description:
          "Evaluates whether a specific drug can be safely prescribed to a patient by cross-referencing their active conditions, current medications, allergies, and recent lab results against known contraindications, drug interactions, and allergy cross-reactivities. Returns a prescribing verdict with detailed contraindication findings and dose adjustment recommendations.",
        inputSchema: {
          drugName: z
            .string()
            .describe("The name of the drug being considered for prescribing"),
          patientId: z
            .string()
            .optional()
            .describe(
              "The patient ID. Do NOT provide this parameter \u2014 it is automatically resolved from the patient context. Only provide if explicitly given a specific patient ID.",
            ),
        },
      },
      async ({ drugName, patientId }) => {
        try {
          // 1. Resolve patient ID
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Fetch patient demographics + clinical data in parallel
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
                resourceType: "MedicationRequest",
                params: [
                  `patient=${resolvedPatientId}`,
                  "status=active",
                  "_count=100",
                ],
              },
              {
                resourceType: "AllergyIntolerance",
                params: [
                  `patient=${resolvedPatientId}`,
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
          const sex = FhirDataServiceInstance.getPatientSex(patient);

          // 4. Extract clinical data from FHIR resources
          const conditions = extractConditions(
            dataMap.get("Condition") ?? [],
          );
          const medications = extractMedications(
            dataMap.get("MedicationRequest") ?? [],
          );
          const allergies = extractAllergies(
            dataMap.get("AllergyIntolerance") ?? [],
          );
          const allLabs = extractAbnormalLabs(
            dataMap.get("Observation") ?? [],
          );
          // Include all labs for context but highlight abnormal ones
          const abnormalLabs = allLabs.filter((l) => l.isAbnormal);

          // 5. Build user prompt with full patient context
          const userPrompt = this._buildUserPrompt(
            drugName,
            age,
            sex,
            conditions,
            medications,
            allergies,
            allLabs,
            abnormalLabs,
          );

          // 6. Send to Claude for contraindication analysis
          let claudeResponse: string;
          try {
            claudeResponse = await ClaudeServiceInstance.analyze(
              SYSTEM_PROMPT,
              userPrompt,
            );
          } catch {
            // Claude fails -> return patient data without analysis
            const patientDataMarkdown = this._buildPatientDataFallback(
              drugName,
              age,
              sex,
              conditions,
              medications,
              allergies,
              abnormalLabs,
            );

            return ResponseFormatter.partialSuccess(patientDataMarkdown, [
              "AI contraindication analysis could not be completed. Patient data provided for manual review.",
            ]);
          }

          // 7. Parse Claude JSON response
          const parsed =
            ClaudeServiceInstance.parseJSON<ContraindicationAnalysis>(
              claudeResponse,
            );

          if (!parsed) {
            const patientDataMarkdown = this._buildPatientDataFallback(
              drugName,
              age,
              sex,
              conditions,
              medications,
              allergies,
              abnormalLabs,
            );

            return ResponseFormatter.partialSuccess(
              `${patientDataMarkdown}\n\n## Analysis (Unstructured)\n${claudeResponse}`,
              [
                "The AI response could not be parsed as structured data. Raw analysis provided above.",
              ],
            );
          }

          // 8. Build structured markdown response
          const markdown = this._buildMarkdownResponse(
            drugName,
            age,
            sex,
            conditions,
            medications,
            allergies,
            abnormalLabs,
            parsed,
          );

          return ResponseFormatter.success(markdown);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return ResponseFormatter.error(
            `Contraindication check failed: ${message}`,
          );
        }
      },
    );
  }

  private _buildUserPrompt(
    drugName: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    allLabs: ExtractedLabResult[],
    abnormalLabs: ExtractedLabResult[],
  ): string {
    const sections: string[] = [];

    sections.push(`Drug being evaluated for prescribing: **${drugName}**`);
    sections.push(
      `Patient: Age ${age !== null ? age : "unknown"}, Sex ${sex}`,
    );

    // Conditions
    if (conditions.length > 0) {
      const condLines = conditions.map((c) => {
        const codeStr = c.codes.length > 0 ? ` (${c.codes.join(", ")})` : "";
        return `- ${c.name}${codeStr}`;
      });
      sections.push(`Active Conditions:\n${condLines.join("\n")}`);
    } else {
      sections.push("Active Conditions: None recorded");
    }

    // Medications
    if (medications.length > 0) {
      const medLines = medications.map(
        (m) => `- ${m.name}${m.dosage ? ` \u2014 ${m.dosage}` : ""}`,
      );
      sections.push(`Current Medications:\n${medLines.join("\n")}`);
    } else {
      sections.push("Current Medications: None recorded");
    }

    // Allergies
    if (allergies.length > 0) {
      const allergyLines = allergies.map((a) => {
        const parts = [a.substance];
        if (a.reaction) parts.push(`reaction: ${a.reaction}`);
        if (a.severity) parts.push(`severity: ${a.severity}`);
        return `- ${parts.join(" | ")}`;
      });
      sections.push(`Allergies:\n${allergyLines.join("\n")}`);
    } else {
      sections.push("Allergies: None recorded");
    }

    // Labs — show abnormal prominently, include recent normals for context
    if (abnormalLabs.length > 0) {
      const labLines = abnormalLabs.map((l) => {
        const ref = l.referenceRange ? ` (ref: ${l.referenceRange})` : "";
        const date = l.date ? ` [${l.date}]` : "";
        return `- **ABNORMAL** ${l.name}: ${l.value}${ref}${date}`;
      });
      sections.push(`Recent Abnormal Lab Results:\n${labLines.join("\n")}`);
    }

    // Also include a selection of recent normal labs for dose-adjustment context
    const normalLabs = allLabs.filter((l) => !l.isAbnormal).slice(0, 20);
    if (normalLabs.length > 0) {
      const labLines = normalLabs.map((l) => {
        const ref = l.referenceRange ? ` (ref: ${l.referenceRange})` : "";
        const date = l.date ? ` [${l.date}]` : "";
        return `- ${l.name}: ${l.value}${ref}${date}`;
      });
      sections.push(`Recent Lab Results (normal):\n${labLines.join("\n")}`);
    }

    if (allLabs.length === 0) {
      sections.push("Recent Lab Results: None available");
    }

    return sections.join("\n\n");
  }

  private _buildPatientDataFallback(
    drugName: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    abnormalLabs: ExtractedLabResult[],
  ): string {
    const parts: string[] = [];

    parts.push(`# Contraindication Check: ${drugName}`);
    parts.push(
      `\n## Patient Context\n- **Age:** ${age !== null ? age : "Unknown"} | **Sex:** ${sex}`,
    );

    // Conditions
    if (conditions.length > 0) {
      const condLines = conditions
        .map((c) => `- ${c.name}`)
        .join("\n");
      parts.push(`\n## Active Conditions\n${condLines}`);
    } else {
      parts.push("\n## Active Conditions\nNone recorded");
    }

    // Medications
    if (medications.length > 0) {
      const medLines = medications
        .map(
          (m) =>
            `- **${m.name}**${m.dosage ? ` \u2014 ${m.dosage}` : ""}`,
        )
        .join("\n");
      parts.push(`\n## Current Medications\n${medLines}`);
    } else {
      parts.push("\n## Current Medications\nNone recorded");
    }

    // Allergies
    if (allergies.length > 0) {
      const allergyLines = allergies
        .map((a) => {
          const details = [a.reaction, a.severity]
            .filter(Boolean)
            .join(", ");
          return `- **${a.substance}**${details ? ` \u2014 ${details}` : ""}`;
        })
        .join("\n");
      parts.push(`\n## Allergies\n${allergyLines}`);
    } else {
      parts.push("\n## Allergies\nNone recorded");
    }

    // Abnormal labs
    if (abnormalLabs.length > 0) {
      const labLines = abnormalLabs
        .map((l) => {
          const ref = l.referenceRange
            ? ` (ref: ${l.referenceRange})`
            : "";
          return `- **${l.name}:** ${l.value}${ref}`;
        })
        .join("\n");
      parts.push(`\n## Abnormal Lab Results\n${labLines}`);
    }

    parts.push(
      "\n## Contraindication Analysis Unavailable\nThe AI analysis service is currently unavailable. Please review the patient data above and check for contraindications manually before prescribing.",
    );

    return parts.join("");
  }

  private _buildMarkdownResponse(
    drugName: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    abnormalLabs: ExtractedLabResult[],
    analysis: ContraindicationAnalysis,
  ): string {
    const verdictIcon = VERDICT_ICONS[analysis.canPrescribe] ?? "";
    const verdictLabel =
      analysis.canPrescribe === "yes"
        ? "Yes \u2014 No contraindications identified"
        : analysis.canPrescribe === "no"
          ? "No \u2014 Contraindication(s) found"
          : "Caution \u2014 Prescribe with modifications";

    const parts: string[] = [];

    // Header with verdict
    parts.push(`# Contraindication Check: ${drugName}`);
    parts.push(`\n## Verdict: ${verdictIcon} ${verdictLabel}`);

    // Patient context
    parts.push(
      `\n## Patient Context\n- **Age:** ${age !== null ? age : "Unknown"} | **Sex:** ${sex}`,
    );
    parts.push(
      `- **Active Conditions:** ${conditions.length > 0 ? conditions.map((c) => c.name).join(", ") : "None recorded"}`,
    );
    parts.push(
      `- **Current Medications:** ${medications.length > 0 ? medications.map((m) => m.name).join(", ") : "None recorded"}`,
    );
    parts.push(
      `- **Allergies:** ${allergies.length > 0 ? allergies.map((a) => a.substance).join(", ") : "None recorded"}`,
    );

    // Contraindications table
    const contraindications = (analysis.contraindications ?? []).sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 2) -
        (SEVERITY_ORDER[b.severity] ?? 2),
    );

    if (contraindications.length > 0) {
      parts.push(`\n## Contraindications (${contraindications.length})\n`);
      parts.push(
        `| Severity | Type | Description | Recommendation |`,
      );
      parts.push(
        `|----------|------|-------------|----------------|`,
      );
      for (const ci of contraindications) {
        const severityLabel = ci.severity.toUpperCase();
        const typeLabel = ci.type.charAt(0).toUpperCase() + ci.type.slice(1);
        parts.push(
          `| **${severityLabel}** | ${typeLabel} | ${ci.description} | ${ci.recommendation} |`,
        );
      }
    } else {
      parts.push(
        "\n## Contraindications\nNo contraindications identified.",
      );
    }

    // Dose adjustments
    const doseAdjustments = analysis.doseAdjustments ?? [];
    if (doseAdjustments.length > 0) {
      parts.push(`\n## Dose Adjustments\n`);
      for (const adj of doseAdjustments) {
        parts.push(`- **${adj.reason}:** ${adj.suggestion}`);
      }
    }

    // Abnormal labs for reference
    if (abnormalLabs.length > 0) {
      parts.push(`\n## Relevant Abnormal Labs\n`);
      for (const lab of abnormalLabs) {
        const ref = lab.referenceRange
          ? ` (ref: ${lab.referenceRange})`
          : "";
        parts.push(`- **${lab.name}:** ${lab.value}${ref}`);
      }
    }

    // Summary
    parts.push(`\n## Summary\n${analysis.summary}`);

    return parts.join("\n");
  }
}

export const ContraindicationCheckerToolInstance =
  new ContraindicationCheckerTool();
