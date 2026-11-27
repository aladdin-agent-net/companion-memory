import type {LlmMessage} from './types.js';

export interface LlmClient {
  complete(messages: LlmMessage[], options: {temperature: number; maxTokens: number}): Promise<string>;
}

/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint
 * (OpenAI, vLLM, Ollama, LM Studio, OpenRouter, LiteLLM, ...).
 */
export function openAICompatibleClient(config: {
  baseURL: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): LlmClient {
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseURL.replace(/\/$/, '')}/chat/completions`;
  return {
    async complete(messages, options) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? {authorization: `Bearer ${config.apiKey}`} : {}),
          ...config.headers,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {choices?: Array<{message?: {content?: string}}>};
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
