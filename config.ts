export const Config = {
  claudeModel: process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6-20250514",
  maxFhirResults: 200,
  defaultLabDaysBack: 90,
  requestTimeoutMs: 25000,
};
