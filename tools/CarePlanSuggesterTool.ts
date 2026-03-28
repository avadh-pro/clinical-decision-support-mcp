import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

interface ExtractedCondition {
  display: string;
  onsetDate: string | null;
}

interface ExtractedMedication {
  name: string;
  dosage: string | null;
  route: string | null;
}

interface ExtractedLab {
  testName: string;
  value: string;
  unit: string | null;
  date: string | null;
}

interface ExtractedAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
}

interface CarePlanRecommendation {
  category:
    | "medication"
    | "monitoring"
    | "lifestyle"
    | "referral"
    | "screening"
    | "preventive";
  priority: "urgent" | "important" | "routine";
  condition: string;
  recommendation: string;
  rationale: string;
  timeframe: string;
}

interface CarePlanAnalysis {
  recommendations: CarePlanRecommendation[];
  gaps: string[];
  summary: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  medication: "[Medication]",
  monitoring: "[Monitoring]",
  lifestyle: "[Lifestyle]",
  referral: "[Referral]",
  screening: "[Screening]",
  preventive: "[Preventive]",
};

const SYSTEM_PROMPT = `You are a clinical decision support system specializing in care plan development. You provide evidence-based care plan modification suggestions grounded in current clinical guidelines (e.g., AHA/ACC, ADA, KDIGO, AASLD).

Rules:
- Base all recommendations on established clinical guidelines
- Consider the patient's complete clinical picture (conditions, medications, labs, allergies)
- Flag potential medication-condition conflicts
- Suggest appropriate monitoring and follow-up intervals
- Identify preventive care opportunities
- Note drug allergies that may affect recommendations
- Prioritize recommendations by clinical urgency
- Do NOT prescribe — suggest considerations for the care team
- Cite which guideline supports each recommendation when possible
- Consider age and sex-appropriate screening recommendations

Respond ONLY with valid JSON:
{
  "recommendations": [
    {
      "category": "medication" | "monitoring" | "lifestyle" | "referral" | "screening" | "preventive",
      "priority": "urgent" | "important" | "routine",
      "condition": "string (which condition this addresses)",
      "recommendation": "string (specific actionable recommendation)",
      "rationale": "string (clinical reasoning and guideline reference)",
      "timeframe": "string (when to implement/review)"
    }
  ],
  "gaps": ["string array of identified gaps in current care"],
  "summary": "string (2-3 sentence care plan overview)"
}`;

class CarePlanSuggesterTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "suggest_care_plan",
      {
        description:
          "Analyzes a patient's conditions, medications, and recent lab results to suggest evidence-based care plan modifications. Provides recommendations aligned with current clinical guidelines including medication adjustments, monitoring plans, and preventive care measures.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "Patient ID. Optional if patient context exists.",
            ),
          focusCondition: z
            .string()
            .optional()
            .describe(
              "Optional specific condition to focus care plan on",
            ),
        },
      },
      async ({ patientId, focusCondition }) => {
        try {
          // 1. Get patient ID from input or context
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Fetch patient demographics
          const patient = await FhirDataServiceInstance.getPatient(
            req,
            resolvedPatientId,
          );
          if (!patient) {
            return ResponseFormatter.error(
              `Patient with ID '${resolvedPatientId}' could not be found.`,
            );
          }

          const age = FhirDataServiceInstance.getPatientAge(patient);
          const sex = FhirDataServiceInstance.getPatientSex(patient);

          // 3. Fetch clinical data in parallel
          const results = await FhirDataServiceInstance.fetchParallel(req, [
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
              resourceType: "Observation",
              params: [
                `patient=${resolvedPatientId}`,
                "category=laboratory",
                "_count=50",
                "_sort=-date",
              ],
            },
            {
              resourceType: "AllergyIntolerance",
              params: [
                `patient=${resolvedPatientId}`,
                "clinical-status=active",
                "_count=50",
              ],
            },
          ]);

          const conditionEntries = results.get("Condition") ?? [];
          const medicationEntries = results.get("MedicationRequest") ?? [];
          const observationEntries = results.get("Observation") ?? [];
          const allergyEntries = results.get("AllergyIntolerance") ?? [];

          // Track warnings for partial failures
          const warnings: string[] = [];
          if (conditionEntries.length === 0 && medicationEntries.length === 0) {
            warnings.push(
              "Limited clinical data available for this patient",
            );
          }

          // 4. Extract conditions
          const conditions: ExtractedCondition[] = [];
          for (const entry of conditionEntries) {
            const resource = entry.resource as fhirR4.Condition;
            const condition = this._extractCondition(resource);
            if (condition) conditions.push(condition);
          }

          if (conditions.length === 0) {
            return ResponseFormatter.success(
              "# Care Plan Recommendations\n\nNo active conditions found for this patient. Care plan suggestions require at least one documented condition.",
            );
          }

          // 5. Extract medications
          const medications: ExtractedMedication[] = [];
          for (const entry of medicationEntries) {
            const resource = entry.resource as fhirR4.MedicationRequest;
            const med = this._extractMedication(resource);
            if (med) medications.push(med);
          }

          // 6. Extract recent labs (last 20)
          const labs: ExtractedLab[] = [];
          for (const entry of observationEntries.slice(0, 20)) {
            const resource = entry.resource as fhirR4.Observation;
            const lab = this._extractLab(resource);
            if (lab) labs.push(lab);
          }

          // 7. Extract allergies
          const allergies: ExtractedAllergy[] = [];
          for (const entry of allergyEntries) {
            const resource = entry.resource as fhirR4.AllergyIntolerance;
            const allergy = this._extractAllergy(resource);
            if (allergy) allergies.push(allergy);
          }

          // 8. Build user prompt and send to Claude
          const userPrompt = this._buildUserPrompt(
            age,
            sex,
            conditions,
            medications,
            labs,
            allergies,
            focusCondition,
          );

          let claudeResponse: string;
          try {
            claudeResponse = await ClaudeServiceInstance.analyze(
              SYSTEM_PROMPT,
              userPrompt,
            );
          } catch {
            return ResponseFormatter.partialSuccess(
              this._buildFallbackMarkdown(
                age,
                sex,
                conditions,
                medications,
                focusCondition,
              ),
              [
                "AI care plan analysis temporarily unavailable. Please review patient data manually.",
              ],
            );
          }

          // 9. Parse Claude JSON response
          const parsed =
            ClaudeServiceInstance.parseJSON<CarePlanAnalysis>(claudeResponse);

          if (!parsed) {
            return ResponseFormatter.partialSuccess(
              `# Care Plan Recommendations\n\n## Analysis (Unstructured)\n${claudeResponse}`,
              [
                "The AI response could not be parsed as structured data. Raw analysis provided above.",
              ],
            );
          }

          // 10. Build markdown response
          const markdown = this._buildMarkdownResponse(
            age,
            sex,
            conditions,
            medications,
            parsed,
            focusCondition,
          );

          if (warnings.length > 0) {
            return ResponseFormatter.partialSuccess(markdown, warnings);
          }
          return ResponseFormatter.success(markdown);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return ResponseFormatter.error(
            `Care plan suggestion failed: ${message}`,
          );
        }
      },
    );
  }

  private _extractCondition(
    resource: fhirR4.Condition,
  ): ExtractedCondition | null {
    const codeable = resource.code;
    if (!codeable) return null;

    const display =
      codeable.text ?? codeable.coding?.[0]?.display ?? null;
    if (!display) return null;

    let onsetDate: string | null = null;
    if (resource.onsetDateTime) {
      onsetDate = resource.onsetDateTime;
    } else if (resource.onsetPeriod?.start) {
      onsetDate = String(resource.onsetPeriod.start);
    }

    return { display, onsetDate };
  }

  private _extractMedication(
    resource: fhirR4.MedicationRequest,
  ): ExtractedMedication | null {
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

    return {
      name,
      dosage,
      route: dosageInstruction?.route?.text ?? null,
    };
  }

  private _extractLab(resource: fhirR4.Observation): ExtractedLab | null {
    const codeable = resource.code;
    if (!codeable) return null;

    const testName =
      codeable.text ?? codeable.coding?.[0]?.display ?? null;
    if (!testName) return null;

    let value: string | null = null;
    let unit: string | null = null;

    if (resource.valueQuantity) {
      value =
        resource.valueQuantity.value != null
          ? String(resource.valueQuantity.value)
          : null;
      unit = resource.valueQuantity.unit ?? null;
    } else if (resource.valueString) {
      value = resource.valueString;
    } else if (resource.valueCodeableConcept) {
      value =
        resource.valueCodeableConcept.text ??
        resource.valueCodeableConcept.coding?.[0]?.display ??
        null;
    }

    if (!value) return null;

    const date = resource.effectiveDateTime ?? resource.issued ?? null;

    return { testName, value, unit, date };
  }

  private _extractAllergy(
    resource: fhirR4.AllergyIntolerance,
  ): ExtractedAllergy | null {
    const codeable = resource.code;
    if (!codeable) return null;

    const substance =
      codeable.text ?? codeable.coding?.[0]?.display ?? null;
    if (!substance) return null;

    const reactionEntry = resource.reaction?.[0];
    const reaction =
      reactionEntry?.manifestation?.[0]?.text ??
      reactionEntry?.manifestation?.[0]?.coding?.[0]?.display ??
      null;

    const severity = reactionEntry?.severity ?? null;

    return { substance, reaction, severity };
  }

  private _buildUserPrompt(
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    labs: ExtractedLab[],
    allergies: ExtractedAllergy[],
    focusCondition?: string,
  ): string {
    const sections: string[] = [];

    sections.push(
      `Review the following patient data and suggest evidence-based care plan modifications:`,
    );

    // Demographics
    sections.push(
      `\n## Patient Demographics\nAge: ${age ?? "unknown"}, Sex: ${sex}`,
    );

    // Conditions
    const conditionLines = conditions
      .map((c) => {
        const onset = c.onsetDate ? ` (onset: ${c.onsetDate})` : "";
        return `- ${c.display}${onset}`;
      })
      .join("\n");
    sections.push(`\n## Active Conditions\n${conditionLines}`);

    // Medications
    if (medications.length > 0) {
      const medLines = medications
        .map((m) => {
          const details = [m.dosage, m.route].filter(Boolean).join(", ");
          return `- ${m.name}${details ? ` — ${details}` : ""}`;
        })
        .join("\n");
      sections.push(`\n## Current Medications\n${medLines}`);
    } else {
      sections.push(`\n## Current Medications\nNo active medications documented.`);
    }

    // Labs
    if (labs.length > 0) {
      const labLines = labs
        .map((l) => {
          const unitStr = l.unit ? ` ${l.unit}` : "";
          const dateStr = l.date ? ` (${l.date})` : "";
          return `- ${l.testName}: ${l.value}${unitStr}${dateStr}`;
        })
        .join("\n");
      sections.push(`\n## Recent Laboratory Results\n${labLines}`);
    } else {
      sections.push(
        `\n## Recent Laboratory Results\nNo recent laboratory results available.`,
      );
    }

    // Allergies
    if (allergies.length > 0) {
      const allergyLines = allergies
        .map((a) => {
          const parts = [a.substance];
          if (a.reaction) parts.push(`reaction: ${a.reaction}`);
          if (a.severity) parts.push(`severity: ${a.severity}`);
          return `- ${parts.join(" — ")}`;
        })
        .join("\n");
      sections.push(`\n## Known Allergies\n${allergyLines}`);
    } else {
      sections.push(`\n## Known Allergies\nNo documented allergies.`);
    }

    // Focus condition
    if (focusCondition) {
      sections.push(
        `\nPlease focus recommendations primarily on: ${focusCondition}`,
      );
    }

    return sections.join("\n");
  }

  private _buildFallbackMarkdown(
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    focusCondition?: string,
  ): string {
    const conditionList = conditions.map((c) => `- ${c.display}`).join("\n");
    const medList =
      medications.length > 0
        ? medications
            .map(
              (m) =>
                `- **${m.name}** — ${m.dosage ?? "no dosage info"} ${m.route ?? ""}`.trim(),
            )
            .join("\n")
        : "No active medications documented.";

    const focusLine = focusCondition
      ? `\n**Focus Area:** ${focusCondition}`
      : "";

    return [
      `# Care Plan Recommendations`,
      ``,
      `## Patient Overview`,
      `- **Age:** ${age ?? "unknown"} | **Sex:** ${sex}`,
      `- **Active Conditions:** ${conditions.length} | **Current Medications:** ${medications.length}${focusLine}`,
      ``,
      `## Active Conditions`,
      conditionList,
      ``,
      `## Current Medications`,
      medList,
      ``,
      `## Recommendations`,
      `AI care plan analysis temporarily unavailable. Please review patient data manually.`,
    ].join("\n");
  }

  private _buildMarkdownResponse(
    age: number | null,
    sex: string,
    conditions: ExtractedCondition[],
    medications: ExtractedMedication[],
    analysis: CarePlanAnalysis,
    focusCondition?: string,
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`# Care Plan Recommendations`);
    lines.push(``);

    // Patient overview
    const focusLine = focusCondition
      ? `\n- **Focus Area:** ${focusCondition}`
      : "";
    lines.push(`## Patient Overview`);
    lines.push(
      `- **Age:** ${age ?? "unknown"} | **Sex:** ${sex}`,
    );
    lines.push(
      `- **Active Conditions:** ${conditions.length} | **Current Medications:** ${medications.length}${focusLine}`,
    );
    lines.push(``);

    // Recommendations grouped by priority
    lines.push(`## Recommendations`);
    lines.push(``);

    const recommendations = analysis.recommendations ?? [];
    const urgent = recommendations.filter((r) => r.priority === "urgent");
    const important = recommendations.filter(
      (r) => r.priority === "important",
    );
    const routine = recommendations.filter((r) => r.priority === "routine");

    if (urgent.length > 0) {
      lines.push(`### Urgent`);
      lines.push(``);
      for (const rec of urgent) {
        lines.push(...this._formatRecommendation(rec));
      }
    }

    if (important.length > 0) {
      lines.push(`### Important`);
      lines.push(``);
      for (const rec of important) {
        lines.push(...this._formatRecommendation(rec));
      }
    }

    if (routine.length > 0) {
      lines.push(`### Routine`);
      lines.push(``);
      for (const rec of routine) {
        lines.push(...this._formatRecommendation(rec));
      }
    }

    if (recommendations.length === 0) {
      lines.push(
        `No specific recommendations generated for the current clinical picture.`,
      );
      lines.push(``);
    }

    // Care gaps
    const gaps = analysis.gaps ?? [];
    if (gaps.length > 0) {
      lines.push(`## Identified Care Gaps`);
      lines.push(``);
      for (const gap of gaps) {
        lines.push(`- ${gap}`);
      }
      lines.push(``);
    }

    // Summary
    if (analysis.summary) {
      lines.push(`## Summary`);
      lines.push(analysis.summary);
    }

    return lines.join("\n");
  }

  private _formatRecommendation(rec: CarePlanRecommendation): string[] {
    const label = CATEGORY_LABELS[rec.category] ?? `[${rec.category}]`;
    return [
      `#### ${label} ${rec.recommendation}`,
      `- **Condition:** ${rec.condition}`,
      `- **Rationale:** ${rec.rationale}`,
      `- **Timeframe:** ${rec.timeframe}`,
      ``,
    ];
  }
}

export const CarePlanSuggesterToolInstance = new CarePlanSuggesterTool();
