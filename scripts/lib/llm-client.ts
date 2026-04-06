/**
 * llm-client.ts — 共享 LLM 客户端抽象
 *
 * 提供统一的 LLM 调用接口，支持：
 * - AnthropicLlmClient: 通过 native fetch 调用 Anthropic Messages API
 * - MockLlmClient: 测试用 mock，返回预设响应
 *
 * 使用方式:
 *   const client = createLlmClient();           // 自动选择（需要 ANTHROPIC_API_KEY）
 *   const client = createMockLlmClient(resp);   // 测试用
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LlmResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(systemPrompt: string, userPrompt: string): Promise<LlmResponse>;
}

export interface LlmClientOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ── Anthropic Implementation ─────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicLlmClient implements LlmClient {
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(apiKey: string, options?: LlmClientOptions) {
    this.apiKey = apiKey;
    this.model = options?.model ?? process.env.MISSION_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options?.temperature ?? 0.3;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<LlmResponse> {
    const messages: AnthropicMessage[] = [{ role: 'user', content: userPrompt }];

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((c) => c.type === 'text');

    return {
      content: textBlock?.text ?? '',
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }
}

// ── Mock Implementation ──────────────────────────────────────────────────────

export class MockLlmClient implements LlmClient {
  private responses: string[];
  private callIndex = 0;
  public calls: Array<{ systemPrompt: string; userPrompt: string }> = [];

  constructor(responses: string | string[]) {
    this.responses = Array.isArray(responses) ? responses : [responses];
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<LlmResponse> {
    this.calls.push({ systemPrompt, userPrompt });
    const content = this.responses[this.callIndex % this.responses.length];
    this.callIndex++;
    return {
      content,
      model: 'mock-model',
      inputTokens: 100,
      outputTokens: 200,
    };
  }
}

// ── Error Client (throws on call) ───────────────────────────────────────────

export class ErrorLlmClient implements LlmClient {
  private error: Error;

  constructor(message = 'LLM call failed') {
    this.error = new Error(message);
  }

  async complete(_systemPrompt: string, _userPrompt: string): Promise<LlmResponse> {
    throw this.error;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * 创建 LLM 客户端。需要 ANTHROPIC_API_KEY 环境变量。
 * 如果 API key 不存在，返回 null（调用方应回退到规则型逻辑）。
 */
export function createLlmClient(options?: LlmClientOptions): LlmClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new AnthropicLlmClient(apiKey, options);
}

/**
 * 创建 mock LLM 客户端，用于测试。
 */
export function createMockLlmClient(responses: string | string[]): MockLlmClient {
  return new MockLlmClient(responses);
}
