import { McpUtilities } from "../mcp-utilities";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";

const DISCLAIMER = `\n\n---\n*AI-generated clinical decision support. This analysis requires validation by a qualified healthcare professional and is not a substitute for professional clinical judgment. Generated using synthetic data only.*`;

export const ResponseFormatter = {
  success(markdown: string): CallToolResult {
    return McpUtilities.createTextResponse(markdown + DISCLAIMER);
  },

  error(message: string): CallToolResult {
    return McpUtilities.createTextResponse(message, { isError: true });
  },

  partialSuccess(markdown: string, warnings: string[]): CallToolResult {
    const warningBlock =
      warnings.length > 0
        ? `\n\n> **Note:** ${warnings.join(" | ")}`
        : "";
    return McpUtilities.createTextResponse(
      markdown + warningBlock + DISCLAIMER,
    );
  },
};
