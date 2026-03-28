import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";
import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

interface DemographicsData {
  name: string;
  dob: string;
  age: number | null;
  gender: string;
  contact: string;
}

interface ConditionData {
  display: string;
  onsetDate: string;
  clinicalStatus: string;
}

interface MedicationData {
  name: string;
  dosage: string;
  status: string;
}

interface LabResultData {
  testName: string;
  value: string;
  date: string;
}

interface AllergyData {
  substance: string;
  reaction: string;
  severity: string;
}

interface EncounterData {
  type: string;
  date: string;
  status: string;
}

class PatientSummaryGeneratorTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "generate_patient_summary",
      {
        description:
          "Generates a comprehensive clinical summary for a patient by aggregating demographics, active conditions, medications, recent lab results, allergies, and recent encounters from FHIR records. Uses AI to synthesize findings into a clinician-ready narrative.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "Patient ID. Optional if patient context exists.",
            ),
        },
      },
      async ({ patientId }) => {
        // 1. Resolve patient ID
        let resolvedPatientId: string;
        try {
          resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );
        } catch {
          return ResponseFormatter.error(
            "No patient ID provided and no patient context available.",
          );
        }

        // 2. Fetch patient resource and all related data in parallel
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
            {
              resourceType: "Encounter",
              params: [
                `patient=${resolvedPatientId}`,
                "_count=10",
                "_sort=-date",
              ],
            },
          ]),
        ]);

        // Patient not found
        if (!patient) {
          return ResponseFormatter.error(
            `Patient with ID "${resolvedPatientId}" could not be found.`,
          );
        }

        const warnings: string[] = [];

        // 3. Extract data from FHIR resources

        // Demographics
        const demographics = this.extractDemographics(patient);

        // Conditions
        const conditionEntries = dataMap.get("Condition") ?? [];
        if (conditionEntries.length === 0) {
          warnings.push("No active conditions data available");
        }
        const conditions = conditionEntries.map((e) =>
          this.extractCondition(e.resource as fhirR4.Condition),
        );

        // Medications
        const medicationEntries = dataMap.get("MedicationRequest") ?? [];
        if (medicationEntries.length === 0) {
          warnings.push("No active medications data available");
        }
        const medications = medicationEntries.map((e) =>
          this.extractMedication(e.resource as fhirR4.MedicationRequest),
        );

        // Lab Results (limit to last 10)
        const labEntries = (dataMap.get("Observation") ?? []).slice(0, 10);
        if (labEntries.length === 0) {
          warnings.push("No recent lab results available");
        }
        const labResults = labEntries.map((e) =>
          this.extractLabResult(e.resource as fhirR4.Observation),
        );

        // Allergies
        const allergyEntries = dataMap.get("AllergyIntolerance") ?? [];
        if (allergyEntries.length === 0) {
          warnings.push("No allergy data available");
        }
        const allergies = allergyEntries.map((e) =>
          this.extractAllergy(e.resource as fhirR4.AllergyIntolerance),
        );

        // Encounters
        const encounterEntries = dataMap.get("Encounter") ?? [];
        if (encounterEntries.length === 0) {
          warnings.push("No recent encounter data available");
        }
        const encounters = encounterEntries.map((e) =>
          this.extractEncounter(e.resource as fhirR4.Encounter),
        );

        // Check if we have any data at all beyond demographics
        const hasAnyData =
          conditions.length > 0 ||
          medications.length > 0 ||
          labResults.length > 0 ||
          allergies.length > 0 ||
          encounters.length > 0;

        if (!hasAnyData) {
          return ResponseFormatter.error(
            "No clinical data found for this patient.",
          );
        }

        // 4. Request Claude narrative synthesis
        let narrative = "";
        let narrativeAvailable = true;
        try {
          const systemPrompt = `You are a clinical documentation specialist creating a patient summary for a clinical decision support system.

Create a structured clinical summary from the provided patient data.

Rules:
- Synthesize the data into a clear, concise clinical narrative
- Highlight clinically significant findings
- Note any data gaps that may affect clinical decisions
- Use standard medical terminology
- Do NOT add information not present in the data
- Do NOT make diagnoses or treatment recommendations beyond what conditions are listed
- Organize information in standard clinical summary format

Respond with a clinical narrative summary (2-4 paragraphs).`;

          const userPrompt = `Patient Data:

Demographics:
- Name: ${demographics.name}
- Date of Birth: ${demographics.dob} (Age: ${demographics.age ?? "Unknown"})
- Gender: ${demographics.gender}
- Contact: ${demographics.contact}

Active Conditions (${conditions.length}):
${conditions.length > 0 ? conditions.map((c) => `- ${c.display} (Onset: ${c.onsetDate}, Status: ${c.clinicalStatus})`).join("\n") : "- None documented"}

Current Medications (${medications.length}):
${medications.length > 0 ? medications.map((m) => `- ${m.name} — Dosage: ${m.dosage} (Status: ${m.status})`).join("\n") : "- None documented"}

Allergies (${allergies.length}):
${allergies.length > 0 ? allergies.map((a) => `- ${a.substance} — Reaction: ${a.reaction}, Severity: ${a.severity}`).join("\n") : "- None documented"}

Recent Lab Results (${labResults.length}):
${labResults.length > 0 ? labResults.map((l) => `- ${l.testName}: ${l.value} (${l.date})`).join("\n") : "- None available"}

Recent Encounters (${encounters.length}):
${encounters.length > 0 ? encounters.map((e) => `- ${e.type} on ${e.date} (Status: ${e.status})`).join("\n") : "- None documented"}`;

          narrative = await ClaudeServiceInstance.analyze(
            systemPrompt,
            userPrompt,
          );
        } catch (error) {
          console.error(
            "Claude narrative synthesis failed:",
            error instanceof Error ? error.message : error,
          );
          narrativeAvailable = false;
          warnings.push("AI synthesis temporarily unavailable");
        }

        // 5. Build markdown response
        const markdown = this.buildMarkdown(
          demographics,
          conditions,
          medications,
          allergies,
          labResults,
          encounters,
          narrativeAvailable ? narrative : null,
        );

        if (warnings.length > 0) {
          return ResponseFormatter.partialSuccess(markdown, warnings);
        }

        return ResponseFormatter.success(markdown);
      },
    );
  }

  private extractDemographics(patient: fhirR4.Patient): DemographicsData {
    // Name
    const officialName = patient.name?.find((n) => n.use === "official") ?? patient.name?.[0];
    const name = officialName
      ? [officialName.given?.join(" "), officialName.family].filter(Boolean).join(" ")
      : "Unknown";

    // DOB & Age
    const dob = patient.birthDate ?? "Unknown";
    const age = FhirDataServiceInstance.getPatientAge(patient);

    // Gender
    const gender = FhirDataServiceInstance.getPatientSex(patient);

    // Contact
    const phone = patient.telecom?.find((t) => t.system === "phone")?.value;
    const email = patient.telecom?.find((t) => t.system === "email")?.value;
    const contact = [phone, email].filter(Boolean).join(", ") || "Not available";

    return { name, dob, age, gender, contact };
  }

  private extractCondition(condition: fhirR4.Condition): ConditionData {
    const display =
      condition.code?.text ??
      condition.code?.coding?.[0]?.display ??
      "Unknown condition";

    const onsetDate =
      ((condition as unknown as Record<string, unknown>)["onsetDateTime"] as string) ??
      "Unknown onset";

    const clinicalStatus =
      condition.clinicalStatus?.coding?.[0]?.code ?? "Unknown";

    return { display, onsetDate, clinicalStatus };
  }

  private extractMedication(
    medRequest: fhirR4.MedicationRequest,
  ): MedicationData {
    const name =
      medRequest.medicationCodeableConcept?.text ??
      medRequest.medicationCodeableConcept?.coding?.[0]?.display ??
      "Unknown medication";

    const dosage = medRequest.dosageInstruction?.[0]?.text ?? "No dosage info";

    const status = medRequest.status ?? "Unknown";

    return { name, dosage, status };
  }

  private extractLabResult(observation: fhirR4.Observation): LabResultData {
    const testName =
      observation.code?.text ??
      observation.code?.coding?.[0]?.display ??
      "Unknown test";

    let value = "No value";
    if (observation.valueQuantity) {
      const qty = observation.valueQuantity;
      value = `${qty.value ?? ""}${qty.unit ? " " + qty.unit : ""}`.trim();
    } else if ((observation as unknown as Record<string, unknown>)["valueString"]) {
      value = (observation as unknown as Record<string, unknown>)["valueString"] as string;
    }

    const date =
      ((observation as unknown as Record<string, unknown>)["effectiveDateTime"] as string) ??
      "Unknown date";

    return { testName, value, date };
  }

  private extractAllergy(
    allergy: fhirR4.AllergyIntolerance,
  ): AllergyData {
    const substance =
      allergy.code?.text ??
      allergy.code?.coding?.[0]?.display ??
      "Unknown substance";

    const reaction =
      allergy.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display ??
      allergy.reaction?.[0]?.manifestation?.[0]?.text ??
      "Not specified";

    const severity =
      allergy.reaction?.[0]?.severity ?? "Not specified";

    return { substance, reaction, severity };
  }

  private extractEncounter(encounter: fhirR4.Encounter): EncounterData {
    const type =
      encounter.type?.[0]?.text ??
      encounter.type?.[0]?.coding?.[0]?.display ??
      "Unknown encounter type";

    const rawDate = encounter.period?.start;
    const date = typeof rawDate === "string" ? rawDate : rawDate instanceof Date ? rawDate.toISOString() : "Unknown date";

    const status = encounter.status ?? "Unknown";

    return { type, date, status };
  }

  private buildMarkdown(
    demographics: DemographicsData,
    conditions: ConditionData[],
    medications: MedicationData[],
    allergies: AllergyData[],
    labResults: LabResultData[],
    encounters: EncounterData[],
    narrative: string | null,
  ): string {
    const sections: string[] = [];

    // Header
    sections.push("# Patient Clinical Summary");

    // Demographics
    sections.push(`## Demographics
- **Name:** ${demographics.name}
- **Date of Birth:** ${demographics.dob} (Age: ${demographics.age ?? "Unknown"})
- **Gender:** ${demographics.gender}
- **Contact:** ${demographics.contact}`);

    // Active Conditions
    sections.push(`## Active Conditions (${conditions.length})`);
    if (conditions.length > 0) {
      sections.push(
        conditions
          .map((c) => `- ${c.display} (Onset: ${c.onsetDate}, Status: ${c.clinicalStatus})`)
          .join("\n"),
      );
    } else {
      sections.push("- None documented");
    }

    // Current Medications
    sections.push(`## Current Medications (${medications.length})`);
    if (medications.length > 0) {
      sections.push(
        medications
          .map((m) => `- **${m.name}** — ${m.dosage} (Status: ${m.status})`)
          .join("\n"),
      );
    } else {
      sections.push("- None documented");
    }

    // Allergies
    sections.push(`## Allergies (${allergies.length})`);
    if (allergies.length > 0) {
      sections.push(
        allergies
          .map((a) => `- **${a.substance}** — Reaction: ${a.reaction}, Severity: ${a.severity}`)
          .join("\n"),
      );
    } else {
      sections.push("- None documented");
    }

    // Recent Lab Results
    sections.push("## Recent Lab Results");
    if (labResults.length > 0) {
      sections.push("| Test | Value | Date |");
      sections.push("|------|-------|------|");
      sections.push(
        labResults.map((l) => `| ${l.testName} | ${l.value} | ${l.date} |`).join("\n"),
      );
    } else {
      sections.push("- No recent lab results available");
    }

    // Recent Encounters
    sections.push(`## Recent Encounters (${encounters.length})`);
    if (encounters.length > 0) {
      sections.push(
        encounters
          .map((e) => `- **${e.type}** on ${e.date} (Status: ${e.status})`)
          .join("\n"),
      );
    } else {
      sections.push("- None documented");
    }

    // Clinical Narrative
    sections.push("## Clinical Narrative");
    if (narrative) {
      sections.push(narrative);
    } else {
      sections.push(
        "*AI synthesis temporarily unavailable. Please review the structured data above.*",
      );
    }

    return sections.join("\n\n");
  }
}

export const PatientSummaryGeneratorToolInstance =
  new PatientSummaryGeneratorTool();
