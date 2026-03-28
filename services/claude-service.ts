import Anthropic from "@anthropic-ai/sdk";

class ClaudeService {
  private client: Anthropic;
  private model: string;
  private maxRetries: number = 3;

  constructor() {
    this.client = new Anthropic(); // Uses ANTHROPIC_API_KEY env var
    this.model = process.env["CLAUDE_MODEL"] || "claude-sonnet-4-6-20250514";
  }

  async analyze(systemPrompt: string, userPrompt: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });

        const textBlock = response.content.find(
          (block) => block.type === "text",
        );
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("No text content in Claude response");
        }

        return textBlock.text;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const isRetryable =
          (error instanceof Anthropic.APIError &&
            (error.status === 429 || error.status >= 500)) ||
          (error instanceof Error && error.message.includes("timeout"));

        if (!isRetryable || attempt === this.maxRetries - 1) {
          break;
        }

        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(
          `Claude API attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`,
          lastError.message,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(
      `Claude analysis failed after ${this.maxRetries} attempts: ${lastError?.message ?? "Unknown error"}`,
    );
  }

  parseJSON<T>(response: string): T | null {
    // Try direct JSON.parse
    try {
      return JSON.parse(response) as T;
    } catch {
      // Ignore and try extracting from code fences
    }

    // Try extracting from ```json ... ``` blocks
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as T;
      } catch {
        // Ignore
      }
    }

    return null;
  }
}

export const ClaudeServiceInstance = new ClaudeService();
