/**
 * LazyDev AI Service
 * Coordinates bounded prompt assembly, Ollama local model inference,
 * strict response parsing, isolated cancellation, and proposal staging.
 * All file modifications pass through the permission-gated EditorService.
 */

import * as path from 'node:path';
import { OllamaClient, RequestCancellationManager } from '../ollama.js';
import { ProjectService } from '../project/project-service.js';
import { EditorService } from '../editor/editor-service.js';
import { FileEditProposal } from '../editor/types.js';
import { PromptBuilder } from './prompt-builder.js';
import { ResponseParser, AiParserError } from './response-parser.js';

export interface AiTaskRequest {
  readonly taskId?: string;
  readonly model: string;
  readonly taskPrompt: string;
  readonly targetFilePath: string;
}

export interface AiTaskResult {
  readonly taskId: string;
  readonly proposal: FileEditProposal;
  readonly explanation: string;
  readonly model: string;
  readonly totalDurationMs?: number;
}

export class AiServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`[LazyDev AI Service] ${message}`);
    this.name = 'AiServiceError';
  }
}

export class AiService {
  private readonly ollamaClient: OllamaClient;
  private readonly projectService: ProjectService;
  private readonly editorService: EditorService;
  private readonly cancellationManager: RequestCancellationManager;
  private readonly aiMode: 'ollama' | 'demo';

  constructor(
    ollamaClient: OllamaClient,
    projectService: ProjectService,
    editorService: EditorService,
    cancellationManager?: RequestCancellationManager,
    aiMode: 'ollama' | 'demo' = 'ollama'
  ) {
    this.ollamaClient = ollamaClient;
    this.projectService = projectService;
    this.editorService = editorService;
    this.cancellationManager = cancellationManager ?? new RequestCancellationManager();
    this.aiMode = aiMode;
  }

  get mode(): 'ollama' | 'demo' {
    return this.aiMode;
  }

  get cancellation(): RequestCancellationManager {
    return this.cancellationManager;
  }

  /**
   * Get list of locally available models. In demo mode, returns deterministic demo provider
   * without contacting Ollama.
   */
  async getAvailableModels(): Promise<readonly string[]> {
    if (this.aiMode === 'demo') {
      return Object.freeze(['demo-sample-model (offline sample)']);
    }
    const status = await this.ollamaClient.checkStatus();
    return status.models;
  }

  /**
   * Cancel an active AI generation task by task ID.
   */
  cancelTask(taskId: string): boolean {
    return this.cancellationManager.cancel(taskId);
  }

  /**
   * Check if a task ID is actively running.
   */
  isTaskActive(taskId: string): boolean {
    return this.cancellationManager.isActive(taskId);
  }

  /**
   * Execute an AI task under isolated cancellation tracking,
   * query Ollama, parse the structured output, and stage a permission-gated proposal.
   */
  async executeTask(request: AiTaskRequest): Promise<AiTaskResult> {
    const taskId = request.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return this.cancellationManager.runTracked(taskId, async (signal) => {
      return this.generateEditProposal(taskId, request, signal);
    });
  }

  /**
   * Core workflow: context building -> inference -> response parsing -> proposal staging.
   */
  private async generateEditProposal(
    taskId: string,
    request: AiTaskRequest,
    signal?: AbortSignal
  ): Promise<AiTaskResult> {
    const canonicalRoot = this.projectService.getProjectRoot();
    const ignoreEngine = this.projectService.getIgnoreEngine();

    if (!canonicalRoot || !ignoreEngine) {
      throw new AiServiceError('No active project root set. Please select and scan a project root first.');
    }

    if (!request.taskPrompt || typeof request.taskPrompt !== 'string' || !request.taskPrompt.trim()) {
      throw new AiServiceError('Task prompt must be a non-empty string.');
    }

    if (!request.targetFilePath || typeof request.targetFilePath !== 'string' || !request.targetFilePath.trim()) {
      throw new AiServiceError('Target file path must be a non-empty string.');
    }

    if (!request.model || typeof request.model !== 'string' || !request.model.trim()) {
      throw new AiServiceError('Model name must be a non-empty string.');
    }

    const normalizedTarget = request.targetFilePath.trim().replace(/\\/g, '/');

    // 1. Read existing file content if available, enforcing path boundary and secret filters
    let currentContent = '';
    try {
      const readResult = await this.projectService.readFile(normalizedTarget);
      currentContent = readResult.content;
    } catch (err: unknown) {
      // If error was secret or binary or traversal, fail immediately
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes('secret') ||
        errMsg.includes('binary') ||
        errMsg.includes('traversal') ||
        errMsg.includes('Access denied')
      ) {
        throw new AiServiceError(`Cannot target file "${normalizedTarget}": ${errMsg}`);
      }
      // If file does not exist yet (new file creation), that's acceptable
      currentContent = '';
    }

    // 2. If in opt-in Demo Mode, execute deterministic sample transformation without contacting Ollama
    if (this.aiMode === 'demo') {
      const ext = path.extname(normalizedTarget).toLowerCase();
      const sanitizedTask = request.taskPrompt.trim().replace(/[\r\n]+/g, ' ');

      let sampleHeader: string;
      if (['.js', '.ts', '.jsx', '.tsx', '.c', '.cpp', '.h', '.java', '.go', '.rs', '.cs', '.php', '.swift', '.kt'].includes(ext)) {
        sampleHeader = `// [DEMO MODE SAMPLE] Task: ${sanitizedTask}\n// Note: Generated in offline demo mode without AI inference. Explicit user approval required to apply.\n`;
      } else if (['.py', '.sh', '.bash', '.rb', '.yml', '.yaml', '.toml', '.r'].includes(ext)) {
        sampleHeader = `# [DEMO MODE SAMPLE] Task: ${sanitizedTask}\n# Note: Generated in offline demo mode without AI inference. Explicit user approval required to apply.\n`;
      } else if (['.html', '.xml', '.svg', '.md'].includes(ext)) {
        sampleHeader = `<!-- [DEMO MODE SAMPLE] Task: ${sanitizedTask} -->\n<!-- Note: Generated in offline demo mode without AI inference. Explicit user approval required to apply. -->\n`;
      } else if (['.css', '.scss', '.less'].includes(ext)) {
        sampleHeader = `/* [DEMO MODE SAMPLE] Task: ${sanitizedTask} */\n/* Note: Generated in offline demo mode without AI inference. Explicit user approval required to apply. */\n`;
      } else {
        sampleHeader = `[DEMO MODE SAMPLE] Task: ${sanitizedTask}\nNote: Generated in offline demo mode without AI inference. Explicit user approval required to apply.\n`;
      }

      const newContent = currentContent.length > 0
        ? `${sampleHeader}${currentContent}`
        : `${sampleHeader}\n// Sample content generated in Demo Mode\n`;

      const explanation = `[DEMO MODE SAMPLE] Deterministic sample edit generated for task: "${sanitizedTask}". No AI model was contacted.`;

      const proposal = await this.editorService.createProposal(canonicalRoot, ignoreEngine, {
        relativePath: normalizedTarget,
        newContent
      });

      return {
        taskId,
        proposal,
        explanation,
        model: request.model.trim() || 'demo-sample-model (offline sample)',
        totalDurationMs: 1
      };
    }

    // 3. Assemble bounded prompt
    const messages = PromptBuilder.buildEditPrompt({
      targetFilePath: normalizedTarget,
      fileContent: currentContent,
      taskPrompt: request.taskPrompt
    });

    // 3. Query local Ollama chat
    const chatResponse = await this.ollamaClient.chat(
      {
        model: request.model.trim(),
        messages
      },
      signal
    );

    // 4. Parse model response
    let parsed;
    try {
      parsed = ResponseParser.parseEditResponse(chatResponse.message.content, normalizedTarget);
    } catch (err: unknown) {
      if (err instanceof AiParserError) {
        throw new AiServiceError(`Model output could not be parsed: ${err.message}`, err);
      }
      throw err;
    }

    // 5. Stage proposal through permission-gated EditorService
    const proposal = await this.editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: parsed.file,
      newContent: parsed.content
    });

    return {
      taskId,
      proposal,
      explanation: parsed.explanation,
      model: chatResponse.model,
      totalDurationMs: chatResponse.totalDurationMs
    };
  }
}
