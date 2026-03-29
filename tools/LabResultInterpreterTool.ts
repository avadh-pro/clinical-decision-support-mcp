import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { fhirR4 } from "@smile-cdr/fhirts";

import { FhirDataServiceInstance } from "../services/fhir-data-service";
import { ClaudeServiceInstance } from "../services/claude-service";
import { ResponseFormatter } from "../services/response-formatter";

type LabFlag =
  | "critical-high"
  | "critical-low"
  | "abnormal-high"
  | "abnormal-low"
  | "normal"
  | "unknown";

interface LabResult {
  testName: string;
  loincCode: string | null;
  value: number | null;
  valueString: string | null;
  unit: string | null;
  referenceRange: {
    low: number | null;
    high: number | null;
    text: string | null;
  } | null;
  effectiveDate: string;
  flag: LabFlag;
}

interface TrendInfo {
  testName: string;
  loincCode: string;
  values: { date: string; value: number }[];
  direction: "increasing" | "decreasing" | "stable";
}

interface ClaudeInterpretation {
  interpretation: string;
  criticalFindings: string[];
  panelSummaries: { panel: string; summary: string }[];
  trendAnalysis: string[];
}

const KNOWN_THRESHOLDS: Record<
  string,
  {
    criticalLow?: number;
    low: number;
    high: number;
    criticalHigh?: number;
    unit: string;
  }
> = {
  "2951-2": {
    criticalLow: 120,
    low: 136,
    high: 145,
    criticalHigh: 155,
    unit: "mEq/L",
  }, // Sodium
  "2823-3": {
    criticalLow: 2.5,
    low: 3.5,
    high: 5.0,
    criticalHigh: 6.5,
    unit: "mEq/L",
  }, // Potassium
  "2160-0": { low: 0.7, high: 1.3, criticalHigh: 10.0, unit: "mg/dL" }, // Creatinine
  "718-7": { criticalLow: 7.0, low: 12.0, high: 17.5, unit: "g/dL" }, // Hemoglobin
  "2345-7": {
    criticalLow: 40,
    low: 70,
    high: 100,
    criticalHigh: 500,
    unit: "mg/dL",
  }, // Glucose
  "1975-2": { low: 0.1, high: 1.2, criticalHigh: 15.0, unit: "mg/dL" }, // Bilirubin
  "6301-6": { low: 0.8, high: 1.2, criticalHigh: 4.5, unit: "INR" }, // INR
  "6598-7": { low: 0, high: 0.04, criticalHigh: 0.4, unit: "ng/mL" }, // Troponin
  "4544-3": { criticalLow: 20, low: 36, high: 46, unit: "%" }, // Hematocrit
  "26464-8": {
    criticalLow: 1000,
    low: 4500,
    high: 11000,
    criticalHigh: 30000,
    unit: "/uL",
  }, // WBC
  "777-3": { criticalLow: 50000, low: 150000, high: 400000, unit: "/uL" }, // Platelets
};

function computeFlag(
  value: number | null,
  refRange: { low: number | null; high: number | null; text: string | null } | null,
  loincCode: string | null,
): LabFlag {
  if (value === null) return "unknown";

  // Use FHIR reference range first, then known thresholds
  let low: number | null = refRange?.low ?? null;
  let high: number | null = refRange?.high ?? null;
  let critLow: number | undefined;
  let critHigh: number | undefined;

  if (loincCode && KNOWN_THRESHOLDS[loincCode]) {
    const known = KNOWN_THRESHOLDS[loincCode]!;
    if (low === null) low = known.low;
    if (high === null) high = known.high;
    critLow = known.criticalLow;
    critHigh = known.criticalHigh;
  }

  if (low === null && high === null) return "unknown";

  if (critHigh !== undefined && value >= critHigh) return "critical-high";
  if (critLow !== undefined && value <= critLow) return "critical-low";
  if (high !== null && value > high) return "abnormal-high";
  if (low !== null && value < low) return "abnormal-low";
  return "normal";
}

function extractLabResult(obs: fhirR4.Observation): LabResult | null {
  // Skip entered-in-error observations
  if (obs.status === "entered-in-error") return null;

  const testName =
    obs.code?.text ||
    obs.code?.coding?.[0]?.display ||
    "Unknown Test";

  const loincCoding = obs.code?.coding?.find(
    (c) => c.system === "http://loinc.org",
  );
  const loincCode = loincCoding?.code ?? null;

  let value: number | null = null;
  let valueString: string | null = null;
  let unit: string | null = null;

  if (obs.valueQuantity?.value !== undefined) {
    value = obs.valueQuantity.value;
    unit = obs.valueQuantity.unit ?? null;
  } else if (obs.valueString) {
    valueString = obs.valueString;
  } else if (obs.valueCodeableConcept?.text) {
    valueString = obs.valueCodeableConcept.text;
  }

  let referenceRange: {
    low: number | null;
    high: number | null;
    text: string | null;
  } | null = null;

  if (obs.referenceRange && obs.referenceRange.length > 0) {
    const ref = obs.referenceRange[0]!;
    referenceRange = {
      low: ref.low?.value ?? null,
      high: ref.high?.value ?? null,
      text: ref.text ?? null,
    };
  }

  const effectiveDate =
    (obs as any).effectiveDateTime ||
    (obs as any).effectivePeriod?.start ||
    obs.issued ||
    "Unknown";

  const flag = computeFlag(value, referenceRange, loincCode);

  return {
    testName,
    loincCode,
    value,
    valueString,
    unit,
    referenceRange,
    effectiveDate,
    flag,
  };
}

function detectTrends(results: LabResult[]): TrendInfo[] {
  const grouped = new Map<string, LabResult[]>();

  for (const r of results) {
    if (r.loincCode && r.value !== null) {
      const existing = grouped.get(r.loincCode) ?? [];
      existing.push(r);
      grouped.set(r.loincCode, existing);
    }
  }

  const trends: TrendInfo[] = [];

  for (const [loincCode, group] of grouped.entries()) {
    if (group.length < 2) continue;

    // Sort by date ascending
    const sorted = [...group].sort(
      (a, b) =>
        new Date(a.effectiveDate).getTime() -
        new Date(b.effectiveDate).getTime(),
    );

    const values = sorted.map((r) => ({
      date: r.effectiveDate,
      value: r.value!,
    }));

    const first = values[0]!.value;
    const last = values[values.length - 1]!.value;
    const diff = last - first;
    const threshold = Math.abs(first) * 0.05; // 5% change threshold

    let direction: "increasing" | "decreasing" | "stable";
    if (diff > threshold) {
      direction = "increasing";
    } else if (diff < -threshold) {
      direction = "decreasing";
    } else {
      direction = "stable";
    }

    trends.push({
      testName: sorted[0]!.testName,
      loincCode,
      values,
      direction,
    });
  }

  return trends;
}

function flagEmoji(flag: LabFlag): string {
  switch (flag) {
    case "critical-high":
      return "🔴 CRITICAL HIGH";
    case "critical-low":
      return "🔴 CRITICAL LOW";
    case "abnormal-high":
      return "🟡 HIGH";
    case "abnormal-low":
      return "🟡 LOW";
    case "normal":
      return "🟢 Normal";
    case "unknown":
      return "⚪ Unknown";
  }
}

function flagSortOrder(flag: LabFlag): number {
  switch (flag) {
    case "critical-high":
      return 0;
    case "critical-low":
      return 1;
    case "abnormal-high":
      return 2;
    case "abnormal-low":
      return 3;
    case "unknown":
      return 4;
    case "normal":
      return 5;
  }
}

function buildMarkdown(
  results: LabResult[],
  trends: TrendInfo[],
  daysBack: number,
  interpretation: ClaudeInterpretation | null,
): string {
  const totalResults = results.length;
  const criticalCount = results.filter(
    (r) => r.flag === "critical-high" || r.flag === "critical-low",
  ).length;
  const abnormalCount = results.filter(
    (r) =>
      r.flag === "abnormal-high" ||
      r.flag === "abnormal-low" ||
      r.flag === "critical-high" ||
      r.flag === "critical-low",
  ).length;

  const sections: string[] = [];

  // Header & summary
  sections.push(`# Laboratory Results Interpretation`);
  sections.push(
    `\n**Period:** Last ${daysBack} days | **Total Results:** ${totalResults} | **Abnormal:** ${abnormalCount} | **Critical:** ${criticalCount}`,
  );

  // Critical findings
  if (criticalCount > 0 || (interpretation?.criticalFindings?.length ?? 0) > 0) {
    sections.push(`\n## ⚠️ Critical Findings`);
    const criticalResults = results.filter(
      (r) => r.flag === "critical-high" || r.flag === "critical-low",
    );
    for (const r of criticalResults) {
      const displayValue = r.value !== null ? `${r.value} ${r.unit ?? ""}` : (r.valueString ?? "N/A");
      sections.push(`- **${r.testName}**: ${displayValue} — ${flagEmoji(r.flag)}`);
    }
    if (interpretation?.criticalFindings) {
      for (const finding of interpretation.criticalFindings) {
        sections.push(`- ${finding}`);
      }
    }
  }

  // Results table sorted: critical first, then abnormal, then normal
  const sorted = [...results].sort(
    (a, b) => flagSortOrder(a.flag) - flagSortOrder(b.flag),
  );

  sections.push(`\n## Lab Results`);
  sections.push(
    `\n| Test | Value | Reference Range | Flag | Date |`,
  );
  sections.push(`|------|-------|-----------------|------|------|`);

  for (const r of sorted) {
    const displayValue =
      r.value !== null
        ? `${r.value} ${r.unit ?? ""}`
        : r.valueString ?? "N/A";
    const refDisplay = r.referenceRange
      ? r.referenceRange.text ??
        `${r.referenceRange.low ?? "?"} - ${r.referenceRange.high ?? "?"}`
      : "—";
    const dateDisplay = r.effectiveDate !== "Unknown"
      ? r.effectiveDate.split("T")[0]
      : "Unknown";

    sections.push(
      `| ${r.testName} | ${displayValue} | ${refDisplay} | ${flagEmoji(r.flag)} | ${dateDisplay} |`,
    );
  }

  // Panel summaries
  if (interpretation?.panelSummaries && interpretation.panelSummaries.length > 0) {
    sections.push(`\n## Panel Summaries`);
    for (const panel of interpretation.panelSummaries) {
      sections.push(`\n### ${panel.panel}`);
      sections.push(panel.summary);
    }
  }

  // Trends
  if (trends.length > 0) {
    sections.push(`\n## Trends`);
    for (const trend of trends) {
      const arrow =
        trend.direction === "increasing"
          ? "📈"
          : trend.direction === "decreasing"
            ? "📉"
            : "➡️";
      const valueList = trend.values
        .map((v) => `${v.value} (${v.date.split("T")[0]})`)
        .join(" → ");
      sections.push(
        `- **${trend.testName}** ${arrow} ${trend.direction}: ${valueList}`,
      );
    }
    if (interpretation?.trendAnalysis) {
      sections.push("");
      for (const analysis of interpretation.trendAnalysis) {
        sections.push(`- ${analysis}`);
      }
    }
  }

  // AI interpretation narrative
  if (interpretation?.interpretation) {
    sections.push(`\n## Clinical Interpretation`);
    sections.push(interpretation.interpretation);
  }

  return sections.join("\n");
}

class LabResultInterpreterTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "interpret_lab_results",
      {
        description:
          "Retrieves and interprets a patient's recent laboratory results. Compares values against reference ranges, flags abnormalities, identifies trends, and provides AI-powered clinical interpretation.",
        inputSchema: {
          patientId: z
            .string()
            .optional()
            .describe(
              "The patient ID. Do NOT provide this parameter — it is automatically resolved from the patient context. Only provide if explicitly given a specific patient ID.",
            ),
          daysBack: z
            .number()
            .optional()
            .default(90)
            .describe(
              "Number of days to look back for lab results (default: 90)",
            ),
        },
      },
      async ({ patientId, daysBack }) => {
        try {
          // 1. Get patient ID
          const resolvedPatientId = FhirDataServiceInstance.getPatientId(
            req,
            patientId,
          );

          // 2. Calculate cutoff date
          const cutoffDate = new Date(
            Date.now() - daysBack * 24 * 60 * 60 * 1000,
          )
            .toISOString()
            .split("T")[0];

          // 3. FHIR query for lab observations
          const entries = await FhirDataServiceInstance.safeSearch(
            req,
            "Observation",
            [
              `patient=${resolvedPatientId}`,
              `category=laboratory`,
              `date=ge${cutoffDate}`,
              `_count=200`,
              `_sort=-date`,
            ],
          );

          // 4. Extract lab results
          const labResults: LabResult[] = [];
          for (const entry of entries) {
            const obs = entry.resource as fhirR4.Observation;
            if (!obs) continue;
            const result = extractLabResult(obs);
            if (result) labResults.push(result);
          }

          // No results found
          if (labResults.length === 0) {
            return ResponseFormatter.success(
              `# Laboratory Results Interpretation\n\nNo laboratory results found in the last ${daysBack} days. Consider ordering baseline labs.`,
            );
          }

          // 7. Trend detection
          const trends = detectTrends(labResults);

          // 8. AI interpretation
          let interpretation: ClaudeInterpretation | null = null;
          const warnings: string[] = [];

          try {
            const abnormalResults = labResults.filter(
              (r) => r.flag !== "normal" && r.flag !== "unknown",
            );

            const claudeSystemPrompt = `You are a clinical pathologist interpreting laboratory results. Provide evidence-based analysis. Always note when results need clinical correlation. Be concise but thorough.`;

            const claudeUserPrompt = `Interpret these laboratory results for a patient.

All results (${labResults.length} total, ${abnormalResults.length} abnormal):
${JSON.stringify(labResults, null, 2)}

Trends detected:
${JSON.stringify(trends, null, 2)}

Respond in JSON format:
{
  "interpretation": "Overall narrative interpretation of the lab results",
  "criticalFindings": ["Array of critical findings requiring immediate attention"],
  "panelSummaries": [{"panel": "Panel name (e.g., CBC, BMP, LFT)", "summary": "Summary of that panel's results"}],
  "trendAnalysis": ["Array of trend observations and their clinical significance"]
}`;

            const claudeResponse = await ClaudeServiceInstance.analyze(
              claudeSystemPrompt,
              claudeUserPrompt,
            );

            interpretation =
              ClaudeServiceInstance.parseJSON<ClaudeInterpretation>(
                claudeResponse,
              );
          } catch (error) {
            console.error(
              "Claude interpretation failed:",
              error instanceof Error ? error.message : error,
            );
            warnings.push(
              "AI interpretation unavailable — showing raw results only",
            );
          }

          // 9. Build markdown response
          const markdown = buildMarkdown(
            labResults,
            trends,
            daysBack,
            interpretation,
          );

          if (warnings.length > 0) {
            return ResponseFormatter.partialSuccess(markdown, warnings);
          }

          return ResponseFormatter.success(markdown);
        } catch (error) {
          return ResponseFormatter.error(
            `Failed to interpret lab results: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  }
}

export const LabResultInterpreterToolInstance = new LabResultInterpreterTool();
