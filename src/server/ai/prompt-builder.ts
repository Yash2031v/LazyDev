/**
 * LazyDev Prompt Builder
 * Assembles bounded, structured prompts for local Ollama models.
 * Strictly limits context size to preserve local model context windows and memory.
 */

import { OllamaChatMessage } from '../ollama.js';

export interface BuildPromptParams {
  readonly targetFilePath: string;
  readonly fileContent?: string;
  readonly taskPrompt: string;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 16 * 1024; // 16 KB file budget
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024; // 32 KB prompt budget

export class PromptBuilder {
  /**
   * Build bounded chat messages for an edit task.
   */
  static buildEditPrompt(params: BuildPromptParams): readonly OllamaChatMessage[] {
    const maxFileBytes = params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = params.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const systemPrompt = [
      'You are LazyDev, a precise and safe local AI coding assistant.',
      'The user wants you to propose an edit for a project file.',
      'You MUST respond with a JSON object containing EXACTLY these keys:',
      '{',
      '  "file": "<relative file path>",',
      '  "explanation": "<brief summary of what you changed and why>",',
      '  "content": "<complete updated file content>"',
      '}',
      '',
      'CRITICAL RULES:',
      '1. Your response MUST contain the JSON object. You may wrap it in a ```json code fence.',
      '2. The "content" field MUST contain the COMPLETE updated file content, NOT a partial snippet or diff.',
      '3. Maintain existing formatting, comments, and style of the file.',
      '4. Do not include markdown or explanations outside the JSON object.'
    ].join('\n');

    let preparedContent = params.fileContent ?? '';
    const fileBytes = Buffer.byteLength(preparedContent, 'utf8');

    if (fileBytes > maxFileBytes) {
      // Truncate file content cleanly to budget
      const buffer = Buffer.from(preparedContent, 'utf8').subarray(0, maxFileBytes);
      preparedContent = buffer.toString('utf8') + '\n\n// [... file truncated to fit local context budget ...]';
    }

    const userPromptParts: string[] = [
      `Target File: ${params.targetFilePath}`,
      '',
      'Task Instruction:',
      params.taskPrompt.trim(),
      ''
    ];

    if (preparedContent) {
      userPromptParts.push('Current File Content:');
      userPromptParts.push('```');
      userPromptParts.push(preparedContent);
      userPromptParts.push('```');
      userPromptParts.push('');
    } else {
      userPromptParts.push('(Note: This is a new or empty file.)');
      userPromptParts.push('');
    }

    userPromptParts.push('Respond ONLY with the JSON object containing "file", "explanation", and "content".');

    let userPrompt = userPromptParts.join('\n');
    let totalBytes = Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(userPrompt, 'utf8');

    if (totalBytes > maxTotalBytes) {
      // Emergency truncation of user prompt if task prompt was massive
      const allowedUserBytes = Math.max(1024, maxTotalBytes - Buffer.byteLength(systemPrompt, 'utf8') - 512);
      userPrompt = Buffer.from(userPrompt, 'utf8').subarray(0, allowedUserBytes).toString('utf8') +
        '\n\n[... prompt truncated to fit context budget ...]';
    }

    return Object.freeze([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
  }
}
