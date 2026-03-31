import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

// ── Interfaces ──────────────────────────────────────────────────────

interface ExtractedCondition {
  name: string;
  code: string | null;
  system: string | null;
}

interface ExtractedMedication {
  name: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
}

interface ExtractedAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
}

interface ExtractedLab {
  name: string;
  value: number;
  unit: string;
  date: string;
  loincCode: string | null;
}

interface ContraindicationReason {
  category:
    | "allergy"
    | "condition"
    | "interaction"
    | "renal"
    | "hepatic"
    | "age"
    | "other";
  detail: string;
  severity: "high" | "moderate" | "low";
}

interface ContraindicationAnalysis {
  verdict: "SAFE" | "CAUTION" | "CONTRAINDICATED";
  reasons: ContraindicationReason[];
  alternatives: string[];
  monitoring: string[];
}

// ── LOINC codes for relevant labs ───────────────────────────────────

const LAB_LOINC: Record<string, string[]> = {
  eGFR: ["33914-3", "48642-3", "62238-1", "69405-9"],
  creatinine: ["2160-0"],
  bilirubin: ["1975-2"],
  INR: ["6301-6"],
  ALT: ["1742-6"],
  AST: ["1920-8"],
};

// ── System prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a clinical pharmacist reviewing a prescribing decision as part of a clinical decision support system. Your role is to determine whether a proposed medication is safe for a specific patient by cross-referencing their conditions, current medications, allergies, and recent lab results.

Rules:
- Evaluate the proposed medication against ALL patient data provided
- Check for absolute contraindications (allergies, organ dysfunction, dangerous interactions)
- Check for relative contraindications (age-related risks, renal/hepatic dose adjustments needed)
- Check for drug-drug interactions with current medications
- Check for drug-allergy cross-reactivity (e.g., penicillin allergy and cephalosporins)
- If the medication is contraindicated, suggest safer alternatives
- If the medication can proceed with caution, specify required monitoring
- Be thorough — missing a contraindication is a patient safety issue
- Do NOT make the final prescribing decision — flag risks for the clinician

Respond ONLY with valid JSON:
{
  "verdict": "SAFE" | "CAUTION" | "CONTRAINDICATED",
  "reasons": [
    {
      "category": "allergy" | "condition" | "interaction" | "renal" | "hepatic" | "age" | "other",
      "detail": "string",
      "severity": "high" | "moderate" | "low"
    }
  ],
  "alternatives": ["string — safer medication alternatives if contraindicated"],
  "monitoring": ["string — recommended monitoring if prescribing proceeds"]
}`;

// ── Extraction helpers ──────────────────────────────────────────────

function extractConditions(
  entries: fhirR4.BundleEntry[],
): ExtractedCondition[] {
  return entries
    .map((e) => {
      const resource = e.resource as fhirR4.Condition;
      const coding = resource.code?.coding?.[0];
      const name =
        resource.code?.text ?? coding?.display ?? null;
      if (!name) return null;

      return {
        name,
        code: coding?.code ?? null,
        system: coding?.system ?? null,
      };
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
      let dose: string | null = dosageInstruction?.text ?? null;
      if (!dose) {
        const doseQuantity =
          dosageInstruction?.doseAndRate?.[0]?.doseQuantity;
        if (doseQuantity?.value != null) {
          dose = `${doseQuantity.value} ${doseQuantity.unit ?? ""}`.trim();
        }
      }

      return {
        name,
        dose,
        route: dosageInstruction?.route?.text ?? null,
        frequency: dosageInstruction?.timing?.code?.text ?? null,
      };
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

      return {
        substance,
        reaction: reactionText,
        severity: reaction?.severity ?? null,
      };
    })
    .filter(Boolean) as ExtractedAllergy[];
}

function extractRelevantLabs(
  entries: fhirR4.BundleEntry[],
): ExtractedLab[] {
  const allLoincCodes = Object.values(LAB_LOINC).flat();
  const labs: ExtractedLab[] = [];

  for (const entry of entries) {
    const obs = entry.resource as fhirR4.Observation;
    if (obs.valueQuantity?.value === undefined) continue;

    const coding = obs.code?.coding?.find(
      (c) =>
        c.system === "http://loinc.org" &&
        allLoincCodes.includes(c.code ?? ""),
    );
    if (!coding) continue;

    const name =
      obs.code?.text ??
      coding.display ??
      coding.code ??
      "Unknown";

    labs.push({
      name,
      value: obs.valueQuantity.value,
      unit: obs.valueQuantity.unit ?? "",
      date: obs.effectiveDateTime ?? "unknown",
      loincCode: coding.code ?? null,
    });
  }

  // Sort by date descending, deduplicate by LOINC code (keep most recent)
  labs.sort(
    (a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const seen = new Set<string>();
  const deduplicated: ExtractedLab[] = [];
  for (const lab of labs) {
    const key = lab.loincCode ?? lab.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(lab);
    }
  }

  return deduplicated;
}

// ── Severity ordering for display ───────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  high: 0,
  moderate: 1,
  low: 2,
};

// ── Tool class ──────────────────────────────────────────────────────

class ContraindicationCheckerTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "check_contraindications",
      {
        description:
          "Check if a proposed medication is safe for this patient by cross-referencing their conditions, current medications, allergies, and recent lab results (renal/hepatic function). Returns pass/warn/block verdict with clinical reasoning.",
        inputSchema: {
          proposedMedication: z
            .string()
            .describe(
              "The medication being considered for prescribing (e.g., 'Metformin', 'Warfarin', 'Lisinopril')",
            ),
        },
      },
      async ({ proposedMedication }) => {
        try {
          // 1. Resolve patient ID from SHARP headers
          const patientId = FhirDataServiceInstance.getPatientId(req);

          // 2. Fetch patient demographics and FHIR data in parallel
          const [patient, dataMap] = await Promise.all([
            FhirDataServiceInstance.getPatient(req, patientId),
            FhirDataServiceInstance.fetchParallel(req, [
              {
                resourceType: "Condition",
                params: [
                  `patient=${patientId}`,
                  "clinical-status=active",
                  "_count=100",
                ],
              },
              {
                resourceType: "MedicationRequest",
                params: [
                  `patient=${patientId}`,
                  "status=active",
                  "_count=100",
                ],
              },
              {
                resourceType: "AllergyIntolerance",
                params: [
                  `patient=${patientId}`,
                  "_count=100",
                ],
              },
              {
                resourceType: "Observation",
                params: [
                  `patient=${patientId}`,
                  "category=laboratory",
                  "_count=100",
                  "_sort=-date",
                ],
              },
            ]),
          ]);

          if (!patient) {
            return ResponseFormatter.error(
              `Patient ${patientId} could not be found.`,
            );
          }

          // 3. Extract structured data from FHIR resources
          const age = FhirDataServiceInstance.getPatientAge(patient);
          const sex = FhirDataServiceInstance.getPatientSex(patient);
          const conditions = extractConditions(
            dataMap.get("Condition") ?? [],
          );
          const currentMeds = extractMedications(
            dataMap.get("MedicationRequest") ?? [],
          );
          const allergies = extractAllergies(
            dataMap.get("AllergyIntolerance") ?? [],
          );
          const labs = extractRelevantLabs(
            dataMap.get("Observation") ?? [],
          );

          // 4. Build structured prompt for Claude
          const userPrompt = this._buildUserPrompt(
            proposedMedication,
            age,
            sex,
            conditions,
            currentMeds,
            allergies,
            labs,
          );

          // 5. Send to Claude for contraindication analysis
          let claudeResponse: string;
          try {
            claudeResponse = await ClaudeServiceInstance.analyze(
              SYSTEM_PROMPT,
              userPrompt,
            );
          } catch {
            // Claude unavailable — return raw FHIR data for manual review
            const fallbackMarkdown = this._buildFallbackMarkdown(
              proposedMedication,
              age,
              sex,
              conditions,
              currentMeds,
              allergies,
              labs,
            );

            return ResponseFormatter.partialSuccess(fallbackMarkdown, [
              "AI contraindication analysis could not be completed. Patient data provided for manual review.",
            ]);
          }

          // 6. Parse Claude JSON response
          const parsed =
            ClaudeServiceInstance.parseJSON<ContraindicationAnalysis>(
              claudeResponse,
            );

          if (!parsed) {
            const fallbackMarkdown = this._buildFallbackMarkdown(
              proposedMedication,
              age,
              sex,
              conditions,
              currentMeds,
              allergies,
              labs,
            );

            return ResponseFormatter.partialSuccess(
              `${fallbackMarkdown}\n\n## Analysis (Unstructured)\n${claudeResponse}`,
              [
                "The AI response could not be parsed as structured data. Raw analysis provided above.",
              ],
            );
          }

          // 7. Build formatted markdown response
          const markdown = this._buildMarkdownResponse(
            proposedMedication,
            age,
            sex,
            conditions,
            currentMeds,
            allergies,
            labs,
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
    proposedMedication: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    currentMeds: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    labs: ExtractedLab[],
  ): string {
    const sections: string[] = [];

    sections.push(
      `**Proposed Medication:** ${proposedMedication}`,
    );
    sections.push(
      `**Patient:** Age ${age !== null ? age : "unknown"}, Sex ${sex}`,
    );

    // Active conditions
    if (conditions.length > 0) {
      const condLines = conditions.map((c) => {
        const codeInfo =
          c.code && c.system
            ? ` (${c.system.includes("snomed") ? "SNOMED" : c.system.includes("icd") ? "ICD-10" : "code"}: ${c.code})`
            : "";
        return `- ${c.name}${codeInfo}`;
      });
      sections.push(
        `**Active Conditions:**\n${condLines.join("\n")}`,
      );
    } else {
      sections.push("**Active Conditions:** None recorded");
    }

    // Current medications
    if (currentMeds.length > 0) {
      const medLines = currentMeds.map((m) => {
        const details = [m.dose, m.route, m.frequency]
          .filter(Boolean)
          .join(", ");
        return `- ${m.name}${details ? ` (${details})` : ""}`;
      });
      sections.push(
        `**Current Medications:**\n${medLines.join("\n")}`,
      );
    } else {
      sections.push("**Current Medications:** None recorded");
    }

    // Allergies
    if (allergies.length > 0) {
      const allergyLines = allergies.map((a) => {
        const parts = [a.substance];
        if (a.reaction) parts.push(`reaction: ${a.reaction}`);
        if (a.severity) parts.push(`severity: ${a.severity}`);
        return `- ${parts.join(" — ")}`;
      });
      sections.push(
        `**Allergies:**\n${allergyLines.join("\n")}`,
      );
    } else {
      sections.push("**Allergies:** None recorded");
    }

    // Recent labs (renal/hepatic function)
    if (labs.length > 0) {
      const labLines = labs.map(
        (l) => `- ${l.name}: ${l.value} ${l.unit} (${l.date})`,
      );
      sections.push(
        `**Recent Labs (renal/hepatic function):**\n${labLines.join("\n")}`,
      );
    } else {
      sections.push(
        "**Recent Labs:** No relevant renal/hepatic labs available",
      );
    }

    return `Evaluate whether the following medication is safe to prescribe for this patient:\n\n${sections.join("\n\n")}`;
  }

  private _buildFallbackMarkdown(
    proposedMedication: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    currentMeds: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    labs: ExtractedLab[],
  ): string {
    const condText =
      conditions.length > 0
        ? conditions.map((c) => c.name).join(", ")
        : "None recorded";
    const medText =
      currentMeds.length > 0
        ? currentMeds
            .map((m) => `${m.name}${m.dose ? ` (${m.dose})` : ""}`)
            .join(", ")
        : "None recorded";
    const allergyText =
      allergies.length > 0
        ? allergies.map((a) => a.substance).join(", ")
        : "None recorded";
    const labText =
      labs.length > 0
        ? labs
            .map((l) => `${l.name}: ${l.value} ${l.unit}`)
            .join(", ")
        : "No relevant labs available";

    return [
      `# Contraindication Check: ${proposedMedication}`,
      ``,
      `## Patient Context`,
      `- **Age:** ${age !== null ? age : "unknown"} | **Sex:** ${sex}`,
      `- **Active Conditions:** ${condText}`,
      `- **Current Medications:** ${medText}`,
      `- **Allergies:** ${allergyText}`,
      `- **Recent Labs:** ${labText}`,
      ``,
      `## AI Analysis Unavailable`,
      `The AI analysis service is currently unavailable. Please review the patient data above and manually assess contraindications for **${proposedMedication}**.`,
    ].join("\n");
  }

  private _buildMarkdownResponse(
    proposedMedication: string,
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    currentMeds: ExtractedMedication[],
    allergies: ExtractedAllergy[],
    labs: ExtractedLab[],
    analysis: ContraindicationAnalysis,
  ): string {
    const lines: string[] = [];

    // Title with color-coded verdict
    const verdictEmoji =
      analysis.verdict === "SAFE"
        ? "\u2705"
        : analysis.verdict === "CAUTION"
          ? "\u26A0\uFE0F"
          : "\uD83D\uDEAB";
    lines.push(`# Contraindication Check: ${proposedMedication}`);
    lines.push("");
    lines.push(`## Verdict: ${verdictEmoji} ${analysis.verdict}`);
    lines.push("");

    // Patient context summary
    lines.push("## Patient Context");
    lines.push(
      `- **Age:** ${age !== null ? age : "unknown"} | **Sex:** ${sex}`,
    );
    lines.push(
      `- **Active Conditions:** ${conditions.length > 0 ? conditions.map((c) => c.name).join(", ") : "None recorded"}`,
    );
    lines.push(
      `- **Current Medications:** ${currentMeds.length > 0 ? currentMeds.map((m) => m.name).join(", ") : "None recorded"}`,
    );
    lines.push(
      `- **Allergies:** ${allergies.length > 0 ? allergies.map((a) => a.substance).join(", ") : "None recorded"}`,
    );
    if (labs.length > 0) {
      lines.push(
        `- **Key Labs:** ${labs.map((l) => `${l.name}: ${l.value} ${l.unit}`).join(", ")}`,
      );
    }
    lines.push("");

    // Reasons table (sorted by severity)
    if (analysis.reasons.length > 0) {
      const sortedReasons = [...analysis.reasons].sort(
        (a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 2) -
          (SEVERITY_ORDER[b.severity] ?? 2),
      );

      lines.push(`## Identified Concerns (${sortedReasons.length})`);
      lines.push("");
      lines.push("| Severity | Category | Detail |");
      lines.push("|----------|----------|--------|");
      for (const reason of sortedReasons) {
        const severityIcon =
          reason.severity === "high"
            ? "\uD83D\uDD34 High"
            : reason.severity === "moderate"
              ? "\uD83D\uDFE1 Moderate"
              : "\uD83D\uDFE2 Low";
        lines.push(
          `| ${severityIcon} | ${reason.category} | ${reason.detail} |`,
        );
      }
      lines.push("");
    } else {
      lines.push("## Identified Concerns");
      lines.push("");
      lines.push("No contraindications or concerns identified.");
      lines.push("");
    }

    // Alternatives section
    if (analysis.alternatives.length > 0) {
      lines.push("## Suggested Alternatives");
      lines.push("");
      for (const alt of analysis.alternatives) {
        lines.push(`- ${alt}`);
      }
      lines.push("");
    }

    // Monitoring recommendations
    if (analysis.monitoring.length > 0) {
      lines.push("## Recommended Monitoring");
      lines.push("");
      for (const mon of analysis.monitoring) {
        lines.push(`- ${mon}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

export const ContraindicationCheckerToolInstance =
  new ContraindicationCheckerTool();
