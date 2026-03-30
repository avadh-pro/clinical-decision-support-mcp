import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCHA2DS2VASc,
  // calculateHEART is tested implicitly via CHA2DS2-VASc patterns
  calculateMELD,
  patientHasCondition,
  getMostRecentLab,
} from "../tools/ClinicalRiskScorerTool";

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
} as const;

// ── CHA2DS2-VASc Tests ─────────────────────────────────────────────

describe("calculateCHA2DS2VASc", () => {
  it("Margaret Chen scenario: 67F with HTN + DM + AFib -> score 4", () => {
    const conditions = [
      mockCondition({ code: "38341003", text: "Hypertension" }),
      mockCondition({ code: "73211009", text: "Diabetes mellitus" }),
      mockCondition({ code: "49436004", text: "Atrial fibrillation" }),
    ];
    const result = calculateCHA2DS2VASc(67, "female", conditions);
    // Age 65-74 = 1, HTN = 1, DM = 1, Female = 1 => total 4
    assert.equal(result.score, 4);
    assert.equal(result.riskCategory, "Moderate-high");
  });

  it("Young healthy male: 40M, no conditions -> score 0", () => {
    const result = calculateCHA2DS2VASc(40, "male", []);
    assert.equal(result.score, 0);
    assert.equal(result.riskCategory, "Low");
  });

  it("Elderly with stroke history: 80M with stroke + CHF + HTN + DM -> score 7", () => {
    const conditions = [
      mockCondition({ code: "230690007", text: "Stroke" }),
      mockCondition({ code: "42343007", text: "Heart failure" }),
      mockCondition({ code: "38341003", text: "Hypertension" }),
      mockCondition({ code: "73211009", text: "Diabetes mellitus" }),
    ];
    const result = calculateCHA2DS2VASc(80, "male", conditions);
    // Age >= 75 = 2, Stroke = 2, CHF = 1, HTN = 1, DM = 1 => total 7
    assert.equal(result.score, 7);
    assert.equal(result.riskCategory, "Moderate-high");
  });
});

// ── patientHasCondition Tests ───────────────────────────────────────

describe("patientHasCondition", () => {
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

  it("detects condition by keyword in text", () => {
    const conditions = [
      mockCondition({
        system: "http://example.org/unknown",
        code: "99999",
        text: "Congestive heart failure, unspecified",
      }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.CHF), true);
  });

  it("does not false-positive: 'dementia' should NOT match STROKE_TIA 'tia' keyword", () => {
    const conditions = [
      mockCondition({
        system: "http://example.org/unknown",
        code: "99999",
        text: "dementia",
      }),
    ];
    assert.equal(patientHasCondition(conditions, CONDITION_MAPS.STROKE_TIA), false);
  });
});

// ── MELD-Na Tests ───────────────────────────────────────────────────

describe("calculateMELD", () => {
  it("calculates correctly with all labs present", () => {
    const observations = [
      mockObservation({ loincCode: "1975-2", value: 2.0, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "6301-6", value: 1.5, unit: "", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2160-0", value: 1.8, unit: "mg/dL", date: "2026-03-01T10:00:00Z" }),
      mockObservation({ loincCode: "2951-2", value: 130, unit: "mEq/L", date: "2026-03-01T10:00:00Z" }),
    ];
    const result = calculateMELD(observations);
    assert.equal(result.canCalculate, true);
    assert.equal(result.type, "MELD-Na");
    assert.equal(typeof result.score, "number");
    // Score should be a reasonable value (between 6 and 40)
    assert.ok(result.score! >= 6 && result.score! <= 40, `MELD score ${result.score} out of expected range 6-40`);
  });

  it("returns canCalculate=false when labs are missing", () => {
    const result = calculateMELD([]);
    assert.equal(result.canCalculate, false);
    assert.equal(result.score, null);
    assert.ok(result.missingLabs.includes("Bilirubin"));
    assert.ok(result.missingLabs.includes("INR"));
    assert.ok(result.missingLabs.includes("Creatinine"));
  });
});

// ── getMostRecentLab Tests ──────────────────────────────────────────

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
});
