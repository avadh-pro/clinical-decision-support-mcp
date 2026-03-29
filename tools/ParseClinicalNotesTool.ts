import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

interface ParsedClinicalData {
  diagnoses: { name: string; icd10: string | null; status: string }[];
  medications: {
    name: string;
    dosage: string | null;
    frequency: string | null;
  }[];
  procedures: { name: string; date: string | null }[];
  labResults: {
    test: string;
    value: string;
    flag: string | null;
  }[];
  vitalSigns: { type: string; value: string }[];
  clinicalFindings: string[];
  followUp: string[];
  summary: string;
}

const SYSTEM_PROMPT = `You are a clinical documentation specialist. Extract structured clinical information from the following clinical notes/documents.

Extract and organize:
- Diagnoses/Conditions (with ICD-10 codes if identifiable)
- Medications (with dosages)
- Procedures performed
- Lab results mentioned
- Vital signs
- Clinical findings and assessments
- Follow-up recommendations

If a focus area is specified, prioritize extraction in that area.

Respond with valid JSON:
{
  "diagnoses": [{"name": "string", "icd10": "string or null", "status": "active|resolved|suspected"}],
  "medications": [{"name": "string", "dosage": "string or null", "frequency": "string or null"}],
  "procedures": [{"name": "string", "date": "string or null"}],
  "labResults": [{"test": "string", "value": "string", "flag": "normal|abnormal|critical|null"}],
  "vitalSigns": [{"type": "string", "value": "string"}],
  "clinicalFindings": ["string"],
  "followUp": ["string"],
  "summary": "string (2-3 sentence overall summary)"
}`;

function buildMarkdownOutput(parsed: ParsedClinicalData): string {
  const sections: string[] = [];

  sections.push(`# Clinical Notes Analysis`);
  sections.push(``);

  // Summary
  if (parsed.summary) {
    sections.push(`## Summary`);
    sections.push(parsed.summary);
    sections.push(``);
  }

  // Diagnoses
  if (parsed.diagnoses.length > 0) {
    sections.push(`## Diagnoses/Conditions`);
    sections.push(``);
    sections.push(`| Diagnosis | ICD-10 | Status |`);
    sections.push(`|-----------|--------|--------|`);
    for (const d of parsed.diagnoses) {
      sections.push(
        `| ${d.name} | ${d.icd10 ?? "—"} | ${d.status} |`,
      );
    }
    sections.push(``);
  }

  // Medications
  if (parsed.medications.length > 0) {
    sections.push(`## Medications`);
    sections.push(``);
    for (const m of parsed.medications) {
      const details = [m.dosage, m.frequency].filter(Boolean).join(", ");
      sections.push(`- **${m.name}**${details ? ` — ${details}` : ""}`);
    }
    sections.push(``);
  }

  // Procedures
  if (parsed.procedures.length > 0) {
    sections.push(`## Procedures`);
    sections.push(``);
    for (const p of parsed.procedures) {
      sections.push(`- ${p.name}${p.date ? ` (${p.date})` : ""}`);
    }
    sections.push(``);
  }

  // Lab Results
  if (parsed.labResults.length > 0) {
    sections.push(`## Lab Results`);
    sections.push(``);
    sections.push(`| Test | Value | Flag |`);
    sections.push(`|------|-------|------|`);
    for (const l of parsed.labResults) {
      const flag =
        l.flag === "critical"
          ? "🔴 Critical"
          : l.flag === "abnormal"
            ? "🟡 Abnormal"
            : l.flag === "normal"
              ? "🟢 Normal"
              : "—";
      sections.push(`| ${l.test} | ${l.value} | ${flag} |`);
    }
    sections.push(``);
  }

  // Vital Signs
  if (parsed.vitalSigns.length > 0) {
    sections.push(`## Vital Signs`);
    sections.push(``);
    for (const v of parsed.vitalSigns) {
      sections.push(`- **${v.type}:** ${v.value}`);
    }
    sections.push(``);
  }

  // Clinical Findings
  if (parsed.clinicalFindings.length > 0) {
    sections.push(`## Clinical Findings`);
    sections.push(``);
    for (const f of parsed.clinicalFindings) {
      sections.push(`- ${f}`);
    }
    sections.push(``);
  }

  // Follow-up
  if (parsed.followUp.length > 0) {
    sections.push(`## Follow-up Recommendations`);
    sections.push(``);
    for (const f of parsed.followUp) {
      sections.push(`- ${f}`);
    }
    sections.push(``);
  }

  return sections.join("\n");
}

class ParseClinicalNotesTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "parse_clinical_notes",
      {
        description:
          "Analyzes unstructured clinical documents and notes for a patient, extracting structured clinical information including diagnoses, medications, procedures, lab results, and clinical findings. Uses AI-powered natural language processing to bridge the gap between unstructured text and structured clinical data.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "The patient ID. Do NOT provide this parameter — it is automatically resolved from the patient context. Only provide if explicitly given a specific patient ID.",
            ),
          focusArea: z
            .string()
            .optional()
            .describe(
              "Optional area to focus extraction on, e.g., 'medications', 'diagnoses', 'procedures'",
            ),
        },
      },
      async ({ patientId, focusArea }) => {
        try {
          // 1. Get patient ID
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Search FHIR for DocumentReference resources
          const entries = await FhirDataServiceInstance.safeSearch(
            req,
            "DocumentReference",
            [
              `patient=${resolvedPatientId}`,
              `_count=20`,
              `_sort=-date`,
            ],
          );

          // 3. Extract document content
          const documentTexts: string[] = [];

          for (const entry of entries) {
            const docRef = entry.resource as fhirR4.DocumentReference;
            if (!docRef) continue;

            const docDate = docRef.date ?? "Unknown date";
            const docType =
              docRef.type?.text ??
              docRef.type?.coding?.[0]?.display ??
              "Clinical Document";

            for (const content of docRef.content ?? []) {
              const attachment = content.attachment;
              if (!attachment) continue;

              if (attachment.data) {
                // Base64-encoded content
                try {
                  const decoded = Buffer.from(
                    attachment.data,
                    "base64",
                  ).toString("utf-8");
                  documentTexts.push(
                    `--- ${docType} (${docDate}) ---\n${decoded}`,
                  );
                } catch {
                  documentTexts.push(
                    `--- ${docType} (${docDate}) ---\n[Unable to decode base64 content]`,
                  );
                }
              } else if (attachment.url) {
                documentTexts.push(
                  `--- ${docType} (${docDate}) ---\n[Document available at: ${attachment.url}]`,
                );
              }
            }
          }

          // 4. No documents found
          if (documentTexts.length === 0) {
            return ResponseFormatter.success(
              `# Clinical Notes Analysis\n\nNo clinical documents found for this patient.`,
            );
          }

          // 5. Send to Claude for analysis
          const focusInstruction = focusArea
            ? `\n\nFocus Area: Prioritize extraction of information related to "${focusArea}".`
            : "";

          const userPrompt = `Extract structured clinical information from the following ${documentTexts.length} clinical document(s):${focusInstruction}\n\n${documentTexts.join("\n\n")}`;

          const warnings: string[] = [];
          let parsed: ParsedClinicalData | null = null;

          try {
            const claudeResponse = await ClaudeServiceInstance.analyze(
              SYSTEM_PROMPT,
              userPrompt,
            );

            parsed =
              ClaudeServiceInstance.parseJSON<ParsedClinicalData>(
                claudeResponse,
              );

            if (!parsed) {
              return ResponseFormatter.partialSuccess(
                `# Clinical Notes Analysis\n\n## Analysis (Unstructured)\n${claudeResponse}`,
                [
                  "The AI response could not be parsed as structured data. Raw analysis provided above.",
                ],
              );
            }
          } catch (error) {
            console.error(
              "Claude clinical notes analysis failed:",
              error instanceof Error ? error.message : error,
            );
            return ResponseFormatter.partialSuccess(
              `# Clinical Notes Analysis\n\nFound ${documentTexts.length} clinical document(s) but AI analysis is temporarily unavailable. Please review documents manually.`,
              [
                "AI-powered extraction unavailable — document content could not be analyzed",
              ],
            );
          }

          // 6. Build markdown output
          const markdown = buildMarkdownOutput(parsed);

          if (warnings.length > 0) {
            return ResponseFormatter.partialSuccess(markdown, warnings);
          }

          return ResponseFormatter.success(markdown);
        } catch (error) {
          return ResponseFormatter.error(
            `Failed to parse clinical notes: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  }
}

export const ParseClinicalNotesToolInstance = new ParseClinicalNotesTool();
