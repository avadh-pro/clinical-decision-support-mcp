import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCHA2DS2VASc,
  calculateHEART,
  calculateMELD,
  patientHasCondition,
  getMostRecentLab,
} from "../tools/ClinicalRiskScorerTool";
import { computeFlag } from "../tools/LabResultInterpreterTool";

// ── Mock helpers ────────────────────────────────────────────────────

function mockCondition(opts: {
  system?: string;
  code: string;
  display?: string;
  text?: string;
}) {
  return {
    resourceType: "Condition",
    code: {
      coding: [
        {
          system: opts.system ?? "http://snomed.info/sct",
          code: opts.code,
          display: opts.display ?? opts.text ?? "",
        },
      ],
      text: opts.text ?? opts.display ?? "",
    },
    clinicalStatus: {
      coding: [{ code: "active" }],
    },
  } as any;
}

function mockObservation(opts: {
  loincCode: string;
  display?: string;
  value: number;
  unit?: string;
  date: string;
}) {
  return {
    resourceType: "Observation",
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: opts.loincCode,
          display: opts.display ?? "",
        },
      ],
    },
    valueQuantity: { value: opts.value, unit: opts.unit ?? "" },
    effectiveDateTime: opts.date,
  } as any;
}

// ── Condition target maps (mirror the source) ───────────────────────

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
  HYPERLIPIDEMIA: {
    snomedCodes: ["55822004"],
    icd10Prefixes: ["E78"],
    keywords: ["hyperlipidemia", "hypercholesterolemia", "dyslipidemia"],
  },
} as const;

// ══════════════════════════════════════════════════════════════════════
// CHA2DS2-VASc Score Calculation
// ══════════════════════════════════════════════════════════════════════

describe("calculateCHA2DS2VASc", () => {
  it("score 0: male, age 50, no conditions", () => {
    const result = calculateCHA2DS2VASc(50, "male", []);
    assert.equal(result.score, 0);
    assert.equal(result.riskCategory, "Low");
    assert.equal(result.recommendation, "No antithrombotic therapy recommended.");
  });

  it("score 5: Margaret Chen — 67F with CHF + HTN + DM", () => {
    const conditions = [
      mockCondition({ code: "42343007", text: "Congestive heart failure" }),
      mockCondition({ code: "38341003", text: "Hypertension" }),
      mockCondition({ code: "73211009", text: "Diabetes mellitus" }),
    ];
    const result = calculateCHA2DS2VASc(67, "female", conditions);
    // CHF=1, HTN=1, DM=1, Age 65-74=1, Female=1 => 5
    assert.equal(result.score, 5);
    assert.equal(result.riskCategory, "Moderate-high");
    assert.equal(result.recommendation, "Oral anticoagulation is recommended.");
  });

  it("score 9: maximum score — 76F with CHF + HTN + DM + Stroke + Vascular disease", () => {
    const conditions = [
      mockCondition({ code: "42343007", text: "Heart failure" }),         // CHF = 1
      mockCondition({ code: "38341003", text: "Hypertension" }),          // HTN = 1
      mockCondition({ code: "73211009", text: "Diabetes mellitus" }),     // DM = 1
      mockCondition({ code: "230690007", text: "Stroke" }),               // Stroke = 2
      mockCondition({ code: "22298006", text: "Myocardial infarction" }), // Vascular = 1
    ];
    const result = calculateCHA2DS2VASc(76, "female", conditions);
    // CHF=1, HTN=1, Age>=75=2, DM=1, Stroke=2, Vascular=1, Age65-74=0 (>=75 overrides), Female=1 => 9
    assert.equal(result.score, 9);
    assert.equal(result.maxScore, 9);
  });

  it("age scoring: 64 -> 0 age points", () => {
    const result = calculateCHA2DS2VASc(64, "male", []);
    const ageA2 = result.components.find((c) => c.name === "Age >= 75 (A2)");
    const ageA = result.components.find((c) => c.name === "Age 65-74 (A)");
    assert.equal(ageA2!.points, 0);
    assert.equal(ageA!.points, 0);
    assert.equal(result.score, 0);
  });

  it("age scoring: 67 -> 1 age point (age 65-74 bracket)", () => {
    const result = calculateCHA2DS2VASc(67, "male", []);
    const ageA2 = result.components.find((c) => c.name === "Age >= 75 (A2)");
    const ageA = result.components.find((c) => c.name === "Age 65-74 (A)");
    assert.equal(ageA2!.points, 0);
    assert.equal(ageA!.points, 1);
    assert.equal(result.score, 1);
  });

  it("age scoring: 76 -> 2 age points (age >= 75 bracket)", () => {
    const result = calculateCHA2DS2VASc(76, "male", []);
    const ageA2 = result.components.find((c) => c.name === "Age >= 75 (A2)");
    const ageA = result.components.find((c) => c.name === "Age 65-74 (A)");
    assert.equal(ageA2!.points, 2);
    assert.equal(ageA!.points, 0);
    assert.equal(result.score, 2);
  });

  it("sex scoring: female -> +1 point", () => {
    const result = calculateCHA2DS2VASc(50, "female", []);
    const sexComponent = result.components.find((c) => c.name === "Sex category female (Sc)");
    assert.equal(sexComponent!.points, 1);
    assert.equal(result.score, 1);
  });

  it("sex scoring: male -> +0 points", () => {
    const result = calculateCHA2DS2VASc(50, "male", []);
    const sexComponent = result.components.find((c) => c.name === "Sex category female (Sc)");
    assert.equal(sexComponent!.points, 0);
    assert.equal(result.score, 0);
  });

  it("score 1 -> Low-moderate risk category", () => {
    const result = calculateCHA2DS2VASc(50, "female", []);
    assert.equal(result.score, 1);
    assert.equal(result.riskCategory, "Low-moderate");
  });

  it("score 2+ -> Moderate-high risk category", () => {
    const result = calculateCHA2DS2VASc(67, "female", []);
    // Age 65-74=1, Female=1 => 2
    assert.equal(result.score, 2);
    assert.equal(result.riskCategory, "Moderate-high");
  });
});

// ══════════════════════════════════════════════════════════════════════
// MELD-Na Calculation
// ══════════════════════════════════════════════════════════════════════

describe("calculateMELD", () => {
  it("known case: bilirubin 1.2, INR 1.8, creatinine 1.4, sodium 136", () => {
    const observations = [
      mockObservation({ loincCode: "1975-2", value: 1.2, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "6301-6", value: 1.8, unit: "",       date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2160-0", value: 1.4, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2951-2", value: 136, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = calculateMELD(observations);
    assert.equal(result.canCalculate, true);
    assert.equal(result.type, "MELD-Na");
    assert.equal(typeof result.score, "number");
    // Manual calculation:
    // bili = max(1.2, 1) = 1.2, inr = max(1.8, 1) = 1.8, cr = clamp(1.4, 1, 4) = 1.4
    // meld(i) = round(10 * (0.957*ln(1.4) + 0.378*ln(1.2) + 1.12*ln(1.8) + 0.643))
    //         = round(10 * (0.957*0.3365 + 0.378*0.1823 + 1.12*0.5878 + 0.643))
    //         = round(10 * (0.3220 + 0.0689 + 0.6583 + 0.643))
    //         = round(10 * 1.6922)
    //         = round(16.922)
    //         = 17
    // sodium correction: na = clamp(136, 125, 137) = 136
    // meld = round(17 + 1.32*(137-136) - 0.033*17*(137-136))
    //      = round(17 + 1.32 - 0.561)
    //      = round(17.759)
    //      = 18
    // clamp(18, 6, 40) = 18
    assert.equal(result.score, 18);
    assert.equal(result.riskCategory, "Moderate mortality risk");
  });

  it("edge case: all minimum lab values (bilirubin < 1, INR < 1, creatinine < 1)", () => {
    const observations = [
      mockObservation({ loincCode: "1975-2", value: 0.3, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "6301-6", value: 0.5, unit: "",       date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2160-0", value: 0.4, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2951-2", value: 140, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = calculateMELD(observations);
    assert.equal(result.canCalculate, true);
    // All values clamped to 1, so ln(1)=0 for all, meld(i) = round(10*0.643) = 6
    // sodium 140 clamped to 137, so correction = 0
    // floor at 6
    assert.equal(result.score, 6);
    assert.equal(result.riskCategory, "Low mortality risk");
  });

  it("sodium correction: low sodium increases score", () => {
    const baseObs = [
      mockObservation({ loincCode: "1975-2", value: 3.0, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "6301-6", value: 2.0, unit: "",       date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2160-0", value: 2.0, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
    ];

    // Normal sodium (137 -> clamped to 137, no correction)
    const normalNa = [
      ...baseObs,
      mockObservation({ loincCode: "2951-2", value: 137, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const resultNormal = calculateMELD(normalNa);

    // Low sodium (125 -> correction adds points)
    const lowNa = [
      ...baseObs,
      mockObservation({ loincCode: "2951-2", value: 125, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const resultLow = calculateMELD(lowNa);

    assert.equal(resultNormal.canCalculate, true);
    assert.equal(resultLow.canCalculate, true);
    assert.ok(
      resultLow.score! > resultNormal.score!,
      `Low sodium score (${resultLow.score}) should be higher than normal sodium score (${resultNormal.score})`,
    );
  });

  it("returns canCalculate=false when all labs missing", () => {
    const result = calculateMELD([]);
    assert.equal(result.canCalculate, false);
    assert.equal(result.score, null);
    assert.ok(result.missingLabs.includes("Bilirubin"));
    assert.ok(result.missingLabs.includes("INR"));
    assert.ok(result.missingLabs.includes("Creatinine"));
  });

  it("returns canCalculate=false when only sodium present (still missing bilirubin, INR, creatinine)", () => {
    const observations = [
      mockObservation({ loincCode: "2951-2", value: 136, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = calculateMELD(observations);
    assert.equal(result.canCalculate, false);
    assert.equal(result.missingLabs.length, 3);
  });

  it("calculates without sodium (no sodium correction applied)", () => {
    const observations = [
      mockObservation({ loincCode: "1975-2", value: 2.0, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "6301-6", value: 1.5, unit: "",       date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2160-0", value: 1.2, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = calculateMELD(observations);
    assert.equal(result.canCalculate, true);
    assert.equal(typeof result.score, "number");
    assert.ok(result.score! >= 6 && result.score! <= 40);
  });
});

// ══════════════════════════════════════════════════════════════════════
// HEART Score Calculation
// ══════════════════════════════════════════════════════════════════════

describe("calculateHEART", () => {
  it("young patient with no conditions and no troponin -> score 0", () => {
    const result = calculateHEART(30, [], []);
    assert.equal(result.score, 0);
    assert.equal(result.type, "HEART");
    assert.equal(result.riskCategory, "Low");
    assert.equal(result.partial, true);
  });

  it("age scoring: < 45 -> 0, 45-64 -> 1, >= 65 -> 2", () => {
    const r1 = calculateHEART(30, [], []);
    const r2 = calculateHEART(55, [], []);
    const r3 = calculateHEART(70, [], []);
    const agePoints = (r: any) => r.components.find((c: any) => c.name === "Age").points;
    assert.equal(agePoints(r1), 0);
    assert.equal(agePoints(r2), 1);
    assert.equal(agePoints(r3), 2);
  });

  it("risk factors: HTN + DM + Hyperlipidemia -> 2 points", () => {
    const conditions = [
      mockCondition({ code: "38341003", text: "Hypertension" }),
      mockCondition({ code: "73211009", text: "Diabetes" }),
      mockCondition({ code: "55822004", text: "Hyperlipidemia" }),
    ];
    const result = calculateHEART(30, conditions, []);
    const rfComponent = result.components.find((c) => c.name === "Risk Factors");
    assert.equal(rfComponent!.points, 2);
  });

  it("risk factors: 1 condition -> 1 point", () => {
    const conditions = [
      mockCondition({ code: "38341003", text: "Hypertension" }),
    ];
    const result = calculateHEART(30, conditions, []);
    const rfComponent = result.components.find((c) => c.name === "Risk Factors");
    assert.equal(rfComponent!.points, 1);
  });

  it("troponin scoring: <= 0.04 -> 0, 0.04-0.12 -> 1, > 0.12 -> 2", () => {
    const makeTrop = (val: number) => [
      mockObservation({ loincCode: "6598-7", value: val, unit: "ng/mL", date: "2026-03-01T10:00:00Z" }),
    ];
    const tropPoints = (r: any) => r.components.find((c: any) => c.name === "Troponin").points;

    assert.equal(tropPoints(calculateHEART(30, [], makeTrop(0.02))), 0);
    assert.equal(tropPoints(calculateHEART(30, [], makeTrop(0.08))), 1);
    assert.equal(tropPoints(calculateHEART(30, [], makeTrop(0.50))), 2);
  });

  it("always includes warnings for History and ECG", () => {
    const result = calculateHEART(50, [], []);
    assert.ok(result.warnings.some((w) => w.includes("History")));
    assert.ok(result.warnings.some((w) => w.includes("ECG")));
  });

  it("risk categories: <= 3 Low, 4-6 Moderate, >= 7 High", () => {
    // Score 0 -> Low
    assert.equal(calculateHEART(30, [], []).riskCategory, "Low");

    // Build a case for moderate: age >= 65 (2) + 3 risk factors (2) = 4
    const conditions = [
      mockCondition({ code: "38341003", text: "Hypertension" }),
      mockCondition({ code: "73211009", text: "Diabetes" }),
      mockCondition({ code: "55822004", text: "Hyperlipidemia" }),
    ];
    assert.equal(calculateHEART(70, conditions, []).riskCategory, "Moderate");

    // Build a high case: age >= 65 (2) + 3 risk factors (2) + high troponin (2) = 6
    // plus troponin of 2 => 6 still moderate. Need 7.
    // But History and ECG are always 0. Max achievable = 2+2+2 = 6 => Moderate
    // So High requires > 6 which isn't achievable with History+ECG=0
    // Verify that score=6 is Moderate
    const highTrop = [
      mockObservation({ loincCode: "6598-7", value: 0.5, unit: "ng/mL", date: "2026-03-01T10:00:00Z" }),
    ];
    assert.equal(calculateHEART(70, conditions, highTrop).riskCategory, "Moderate");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Word Boundary Matching (patientHasCondition)
// ══════════════════════════════════════════════════════════════════════

describe("patientHasCondition — word boundary matching", () => {
  it("'dementia' should NOT match 'tia' keyword", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "dementia" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), false);
  });

  it("'tia' should match 'tia' keyword", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "tia" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), true);
  });

  it("'Transient ischemic attack' should match 'transient ischemic attack' (case insensitive)", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "Transient ischemic attack" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), true);
  });

  it("case insensitive: 'HYPERTENSION' matches 'hypertension' keyword", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "HYPERTENSION" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.HYPERTENSION), true);
  });

  it("'Patient has tia history' matches 'tia' as a whole word", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "Patient has tia history" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), true);
  });

  it("'antianginal' should NOT match 'tia' keyword (embedded partial)", () => {
    const conditions = [
      mockCondition({ system: "http://example.org", code: "99999", text: "antianginal" }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), false);
  });

  it("detects condition by SNOMED code", () => {
    const conditions = [mockCondition({ code: "38341003", text: "Hypertension" })];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.HYPERTENSION), true);
  });

  it("detects condition by ICD-10 prefix", () => {
    const conditions = [
      mockCondition({
        system: "http://hl7.org/fhir/sid/icd-10",
        code: "I48.91",
        text: "Unspecified atrial fibrillation",
      }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.ATRIAL_FIBRILLATION), true);
  });

  it("returns false for empty conditions array", () => {
    assert.equal(patientHasCondition([], CONDITION_MAPS.HYPERTENSION), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Lab Reference Range Flagging (computeFlag)
// ══════════════════════════════════════════════════════════════════════

describe("computeFlag — lab reference range flagging", () => {
  it("eGFR 38 with range 60-120 -> abnormal-low", () => {
    const flag = computeFlag(38, { low: 60, high: 120, text: null }, null);
    assert.equal(flag, "abnormal-low");
  });

  it("HbA1c 7.2 with range 4.0-5.6 -> abnormal-high", () => {
    const flag = computeFlag(7.2, { low: 4.0, high: 5.6, text: null }, null);
    assert.equal(flag, "abnormal-high");
  });

  it("normal value within range -> normal", () => {
    const flag = computeFlag(5.0, { low: 4.0, high: 6.0, text: null }, null);
    assert.equal(flag, "normal");
  });

  it("value exactly at low boundary -> normal (not abnormal-low)", () => {
    const flag = computeFlag(4.0, { low: 4.0, high: 6.0, text: null }, null);
    assert.equal(flag, "normal");
  });

  it("value exactly at high boundary -> normal (not abnormal-high)", () => {
    const flag = computeFlag(6.0, { low: 4.0, high: 6.0, text: null }, null);
    assert.equal(flag, "normal");
  });

  it("null value -> unknown", () => {
    const flag = computeFlag(null, { low: 4.0, high: 6.0, text: null }, null);
    assert.equal(flag, "unknown");
  });

  it("no reference range and no known threshold -> unknown", () => {
    const flag = computeFlag(5.0, null, null);
    assert.equal(flag, "unknown");
  });

  it("uses KNOWN_THRESHOLDS when FHIR range is missing", () => {
    // Sodium LOINC "2951-2": low=136, high=145, criticalLow=120, criticalHigh=155
    const flag = computeFlag(130, null, "2951-2");
    assert.equal(flag, "abnormal-low");
  });

  it("critical-high from KNOWN_THRESHOLDS", () => {
    // Sodium critical high = 155
    const flag = computeFlag(160, null, "2951-2");
    assert.equal(flag, "critical-high");
  });

  it("critical-low from KNOWN_THRESHOLDS", () => {
    // Sodium critical low = 120
    const flag = computeFlag(118, null, "2951-2");
    assert.equal(flag, "critical-low");
  });

  it("normal sodium via KNOWN_THRESHOLDS", () => {
    const flag = computeFlag(140, null, "2951-2");
    assert.equal(flag, "normal");
  });

  it("FHIR range takes precedence but known thresholds fill gaps", () => {
    // Provide FHIR low but no high; known thresholds should fill in high
    // Creatinine LOINC "2160-0": low=0.7, high=1.3, criticalHigh=10.0
    const flag = computeFlag(5.0, { low: 0.5, high: null, text: null }, "2160-0");
    // high comes from known threshold (1.3), but 5.0 > 1.3 => abnormal-high
    // Actually criticalHigh is 10.0, so 5.0 < 10.0 => abnormal-high (not critical)
    assert.equal(flag, "abnormal-high");
  });

  it("critical-high overrides abnormal-high when value exceeds critical threshold", () => {
    // Creatinine critical high = 10.0
    const flag = computeFlag(12.0, null, "2160-0");
    assert.equal(flag, "critical-high");
  });
});

// ══════════════════════════════════════════════════════════════════════
// getMostRecentLab
// ══════════════════════════════════════════════════════════════════════

describe("getMostRecentLab", () => {
  it("returns the most recent matching lab", () => {
    const observations = [
      mockObservation({ loincCode: "2951-2", display: "Sodium", value: 135, unit: "mEq/L", date: "2026-01-01T10:00:00Z" }),
      mockObservation({ loincCode: "2951-2", display: "Sodium", value: 138, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = getMostRecentLab(observations, ["2951-2"]);
    assert.notEqual(result, null);
    assert.equal(result!.value, 138);
    assert.equal(result!.date, "2026-03-01T10:00:00Z");
  });

  it("returns null when no matching observations exist", () => {
    const result = getMostRecentLab([], ["2951-2"]);
    assert.equal(result, null);
  });

  it("ignores observations with non-matching LOINC codes", () => {
    const observations = [
      mockObservation({ loincCode: "1975-2", value: 1.0, date: "2026-03-01T10:00:00Z" }),
    ];
    const result = getMostRecentLab(observations, ["2951-2"]);
    assert.equal(result, null);
  });

  it("handles multiple LOINC codes in the search list", () => {
    const observations = [
      mockObservation({ loincCode: "6598-7", value: 0.03, date: "2026-03-01T10:00:00Z" }),
    ];
    const result = getMostRecentLab(observations, ["6598-7", "10839-9", "49563-0"]);
    assert.notEqual(result, null);
    assert.equal(result!.value, 0.03);
  });
});
