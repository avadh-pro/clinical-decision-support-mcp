import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

interface ExtractedMedication {
  name: string;
  rxNormCode: string | null;
  dosage: string | null;
  route: string | null;
  frequency: string | null;
  source: "MedicationRequest" | "MedicationStatement";
}

interface DrugInteraction {
  drugA: string;
  drugB: string;
  severity: "critical" | "major" | "moderate" | "minor";
  mechanism: string;
  clinicalEffect: string;
  recommendation: string;
  evidenceLevel: "well-established" | "probable" | "theoretical";
}

interface InteractionAnalysis {
  interactions: DrugInteraction[];
  summary: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  moderate: 2,
  minor: 3,
};

const SYSTEM_PROMPT = `You are a clinical pharmacist with expertise in drug-drug interactions. You are part of a clinical decision support system. Your role is to analyze a medication list and identify potential drug-drug interactions.

Rules:
- Identify ALL clinically significant interactions between the listed medications
- Classify each interaction by severity: critical, major, moderate, or minor
- Explain the pharmacological mechanism of each interaction
- Provide a specific clinical recommendation for each interaction
- If no interactions exist, state that clearly
- Do NOT diagnose the patient or make treatment decisions
- Be thorough -- missing a critical interaction is a patient safety issue

Respond ONLY with valid JSON:
{
  "interactions": [
    {
      "drugA": "string",
      "drugB": "string",
      "severity": "critical" | "major" | "moderate" | "minor",
      "mechanism": "string",
      "clinicalEffect": "string",
      "recommendation": "string",
      "evidenceLevel": "well-established" | "probable" | "theoretical"
    }
  ],
  "summary": "string"
}`;

class DrugInteractionCheckerTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "check_drug_interactions",
      {
        description:
          "Analyzes a patient's active medications for potential drug-drug interactions using AI-powered pharmacological reasoning. Returns identified interactions with severity classifications, mechanisms, and clinical recommendations.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "The patient ID. Do NOT provide this parameter — it is automatically resolved from the patient context. Only provide if explicitly given a specific patient ID.",
            ),
          severityFilter: z
            .enum(["all", "critical", "major", "moderate", "minor"])
            .optional()
            .default("all")
            .describe("Filter results by minimum severity level"),
        },
      },
      async ({ patientId, severityFilter }) => {
        try {
          // 1. Get patient ID from input or context
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Fetch MedicationRequest and MedicationStatement in parallel
          const results = await FhirDataServiceInstance.fetchParallel(req, [
            {
              resourceType: "MedicationRequest",
              params: [
                `patient=${resolvedPatientId}`,
                "status=active",
                "_count=100",
              ],
            },
            {
              resourceType: "MedicationStatement",
              params: [
                `patient=${resolvedPatientId}`,
                "status=active",
                "_count=100",
              ],
            },
          ]);

          const medRequestEntries = results.get("MedicationRequest") ?? [];
          const medStatementEntries =
            results.get("MedicationStatement") ?? [];

          // 3. Extract medications from both sources
          const medications: ExtractedMedication[] = [];

          for (const entry of medRequestEntries) {
            const resource = entry.resource as fhirR4.MedicationRequest;
            const med = this._extractFromMedicationRequest(resource);
            if (med) medications.push(med);
          }

          for (const entry of medStatementEntries) {
            const resource = entry.resource as fhirR4.MedicationStatement;
            const med = this._extractFromMedicationStatement(resource);
            if (med) medications.push(med);
          }

          // 4. Deduplicate
          const deduplicated = this._deduplicateMedications(medications);

          // 5. Check medication count
          if (deduplicated.length === 0) {
            return ResponseFormatter.success(
              "# Drug Interaction Analysis\n\nNo active medications found for this patient.",
            );
          }

          if (deduplicated.length === 1) {
            const singleMed = deduplicated[0]!;
            return ResponseFormatter.success(
              `# Drug Interaction Analysis\n\nOnly 1 active medication found (${singleMed.name}). Drug interaction analysis requires at least 2 medications.`,
            );
          }

          // 6. Send to Claude for interaction analysis
          const userPrompt = this._buildUserPrompt(deduplicated);

          let claudeResponse: string;
          try {
            claudeResponse = await ClaudeServiceInstance.analyze(
              SYSTEM_PROMPT,
              userPrompt,
            );
          } catch {
            // Claude fails -> return medication list without interaction analysis
            const medList = deduplicated
              .map(
                (m) =>
                  `- **${m.name}** — ${m.dosage ?? "no dosage info"} ${m.route ?? ""} ${m.frequency ?? ""}`.trim(),
              )
              .join("\n");

            return ResponseFormatter.partialSuccess(
              `# Drug Interaction Analysis\n\n## Medications Reviewed (${deduplicated.length})\n${medList}\n\n## Interaction Analysis Unavailable\nThe AI analysis service is currently unavailable. Please review medications manually for potential interactions.`,
              [
                "AI interaction analysis could not be completed. Medication list provided for manual review.",
              ],
            );
          }

          // 7. Parse Claude JSON response
          const parsed =
            ClaudeServiceInstance.parseJSON<InteractionAnalysis>(
              claudeResponse,
            );

          if (!parsed) {
            // Claude JSON unparseable -> return raw Claude text with warning
            const medList = deduplicated
              .map(
                (m) =>
                  `- **${m.name}** — ${m.dosage ?? "no dosage info"} ${m.route ?? ""} ${m.frequency ?? ""}`.trim(),
              )
              .join("\n");

            return ResponseFormatter.partialSuccess(
              `# Drug Interaction Analysis\n\n## Medications Reviewed (${deduplicated.length})\n${medList}\n\n## Analysis (Unstructured)\n${claudeResponse}`,
              [
                "The AI response could not be parsed as structured data. Raw analysis provided above.",
              ],
            );
          }

          // Apply severity filter
          let filteredInteractions = parsed.interactions ?? [];
          if (severityFilter && severityFilter !== "all") {
            const minSeverity = SEVERITY_ORDER[severityFilter] ?? 3;
            filteredInteractions = filteredInteractions.filter(
              (i) => (SEVERITY_ORDER[i.severity] ?? 3) <= minSeverity,
            );
          }

          // 8. Build markdown response
          const markdown = this._buildMarkdownResponse(
            deduplicated,
            filteredInteractions,
            parsed.summary,
          );

          return ResponseFormatter.success(markdown);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return ResponseFormatter.error(
            `Drug interaction check failed: ${message}`,
          );
        }
      },
    );
  }

  private _extractFromMedicationRequest(
    resource: fhirR4.MedicationRequest,
  ): ExtractedMedication | null {
    const codeable = resource.medicationCodeableConcept;
    if (!codeable) return null;

    const name =
      codeable.text ?? codeable.coding?.[0]?.display ?? null;
    if (!name) return null;

    const rxNormCoding = codeable.coding?.find((c) =>
      c.system?.toLowerCase().includes("rxnorm"),
    );

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
      rxNormCode: rxNormCoding?.code ?? null,
      dosage,
      route: dosageInstruction?.route?.text ?? null,
      frequency: dosageInstruction?.timing?.code?.text ?? null,
      source: "MedicationRequest",
    };
  }

  private _extractFromMedicationStatement(
    resource: fhirR4.MedicationStatement,
  ): ExtractedMedication | null {
    const codeable = resource.medicationCodeableConcept;
    if (!codeable) return null;

    const name =
      codeable.text ?? codeable.coding?.[0]?.display ?? null;
    if (!name) return null;

    const rxNormCoding = codeable.coding?.find((c) =>
      c.system?.toLowerCase().includes("rxnorm"),
    );

    const dosageInfo = resource.dosage?.[0];
    let dosage: string | null = dosageInfo?.text ?? null;
    if (!dosage) {
      const doseQuantity =
        dosageInfo?.doseAndRate?.[0]?.doseQuantity;
      if (doseQuantity?.value != null) {
        dosage = `${doseQuantity.value} ${doseQuantity.unit ?? ""}`.trim();
      }
    }

    return {
      name,
      rxNormCode: rxNormCoding?.code ?? null,
      dosage,
      route: dosageInfo?.route?.text ?? null,
      frequency: dosageInfo?.timing?.code?.text ?? null,
      source: "MedicationStatement",
    };
  }

  private _deduplicateMedications(
    medications: ExtractedMedication[],
  ): ExtractedMedication[] {
    const seen = new Map<string, ExtractedMedication>();

    for (const med of medications) {
      // Key by rxNormCode if present, otherwise by lowercased name
      const key = med.rxNormCode
        ? `rxnorm:${med.rxNormCode}`
        : `name:${med.name.toLowerCase()}`;

      if (!seen.has(key)) {
        seen.set(key, med);
      }
    }

    return Array.from(seen.values());
  }

  private _buildUserPrompt(medications: ExtractedMedication[]): string {
    const lines = medications.map((m, i) => {
      const parts = [`${i + 1}. ${m.name}`];
      if (m.rxNormCode) parts.push(`(RxNorm: ${m.rxNormCode})`);
      if (m.dosage) parts.push(`— Dosage: ${m.dosage}`);
      if (m.route) parts.push(`— Route: ${m.route}`);
      if (m.frequency) parts.push(`— Frequency: ${m.frequency}`);
      return parts.join(" ");
    });

    return `Analyze the following active medications for potential drug-drug interactions:\n\n${lines.join("\n")}`;
  }

  private _buildMarkdownResponse(
    medications: ExtractedMedication[],
    interactions: DrugInteraction[],
    summary: string,
  ): string {
    const medLines = medications
      .map((m) => {
        const details = [m.dosage, m.route, m.frequency]
          .filter(Boolean)
          .join(" ");
        return `- **${m.name}** — ${details || "no additional details"}`;
      })
      .join("\n");

    let interactionSection: string;
    if (interactions.length === 0) {
      interactionSection =
        "No clinically significant interactions identified.";
    } else {
      const interactionBlocks = interactions
        .sort(
          (a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 3) -
            (SEVERITY_ORDER[b.severity] ?? 3),
        )
        .map((i) => {
          const severityLabel = i.severity.toUpperCase();
          return [
            `### ⚠ ${severityLabel}: ${i.drugA} + ${i.drugB}`,
            `- **Mechanism:** ${i.mechanism}`,
            `- **Clinical Effect:** ${i.clinicalEffect}`,
            `- **Recommendation:** ${i.recommendation}`,
            `- **Evidence:** ${i.evidenceLevel}`,
          ].join("\n");
        })
        .join("\n\n");

      interactionSection = interactionBlocks;
    }

    return [
      `# Drug Interaction Analysis`,
      ``,
      `## Medications Reviewed (${medications.length})`,
      medLines,
      ``,
      `## Identified Interactions (${interactions.length})`,
      ``,
      interactionSection,
      ``,
      `## Summary`,
      summary,
    ].join("\n");
  }
}

export const DrugInteractionCheckerToolInstance =
  new DrugInteractionCheckerTool();
