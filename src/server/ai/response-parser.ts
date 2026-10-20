/**
 * LazyDev Model Response Parser
 * Robustly parses structured edit proposals from open-weight model outputs.
 * Handles markdown fences, preamble/postamble conversational text, and JSON extraction.
 */

export interface ParsedModelEdit {
  readonly file: string;
  readonly explanation: string;
  readonly content: string;
}

export class AiParserError extends Error {
  constructor(message: string, public readonly rawText?: string) {
    super(`[LazyDev AI Parser] ${message}`);
    this.name = 'AiParserError';
  }
}

export class ResponseParser {
  /**
   * Parse model completion into a verified edit proposal.
   */
  static parseEditResponse(rawResponse: string, fallbackFilePath?: string): ParsedModelEdit {
    if (!rawResponse || typeof rawResponse !== 'string' || !rawResponse.trim()) {
      throw new AiParserError('Model returned empty response.');
    }

    const trimmed = rawResponse.trim();

    // Strategy 1: Look for markdown code fence with JSON (```json ... ``` or ``` ...)
    const fencedJsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let candidateJson = fencedJsonMatch && fencedJsonMatch[1] ? fencedJsonMatch[1].trim() : '';

    // Strategy 2: If no fence or fence didn't look like JSON object, find outermost { ... }
    if (!candidateJson.startsWith('{') || !candidateJson.endsWith('}')) {
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        candidateJson = trimmed.slice(firstBrace, lastBrace + 1).trim();
      }
    }

    if (!candidateJson) {
      throw new AiParserError(
        'Failed to locate structured JSON in model response. Expected JSON object with "file", "explanation", and "content".'
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateJson);
    } catch {
      // Try cleaning common trailing commas before failing
      try {
        const cleaned = candidateJson.replace(/,\s*([}\]])/g, '$1');
        parsed = JSON.parse(cleaned);
      } catch (err: unknown) {
        throw new AiParserError(
          'Model response contained malformed JSON.',
          undefined
        );
      }
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new AiParserError('Expected JSON object from model response.');
    }

    const obj = parsed as Record<string, unknown>;

    // Content is mandatory
    if (typeof obj.content !== 'string') {
      throw new AiParserError('Model response is missing mandatory "content" string field.');
    }

    // Explanation is optional, default to a safe generic message
    const explanation = typeof obj.explanation === 'string' && obj.explanation.trim()
      ? obj.explanation.trim()
      : 'AI proposed file change';

    // File path: use model provided or fallback
    let file = typeof obj.file === 'string' && obj.file.trim()
      ? obj.file.trim()
      : (fallbackFilePath ?? '');

    // Normalize slashes
    file = file.replace(/\\/g, '/');

    if (!file) {
      throw new AiParserError('Model response does not specify a target file path.');
    }

    return Object.freeze({
      file,
      explanation,
      content: obj.content
    });
  }
}
