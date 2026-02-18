import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { MekikiSpec } from "../config/specLoader.js";

interface LlmConfig {
  activeProvider: string;
  activeModel: string;
  providers: Record<string, { type: string; apiKeyEnv?: string; baseURL?: string }>;
  defaults: { temperature: number; maxOutputTokens: number };
}

interface TaskRoute {
  provider: string;
  model: string;
}

/**
 * Create an AI SDK model instance for a given provider + model ID.
 */
function createModel(
  providerName: string,
  modelId: string,
  providers: LlmConfig["providers"],
) {
  const conf = providers[providerName];
  if (!conf) throw new Error(`[llm] Unknown provider: ${providerName}`);

  switch (conf.type) {
    case "openai": {
      const apiKey = conf.apiKeyEnv ? process.env[conf.apiKeyEnv] : undefined;
      if (!apiKey) throw new Error(`[llm] Missing env var ${conf.apiKeyEnv} for provider ${providerName}`);
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case "anthropic": {
      const apiKey = conf.apiKeyEnv ? process.env[conf.apiKeyEnv] : undefined;
      if (!apiKey) throw new Error(`[llm] Missing env var ${conf.apiKeyEnv} for provider ${providerName}`);
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }
    case "google": {
      const apiKey = conf.apiKeyEnv ? process.env[conf.apiKeyEnv] : undefined;
      if (!apiKey) throw new Error(`[llm] Missing env var ${conf.apiKeyEnv} for provider ${providerName}`);
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }
    case "ollama": {
      // Ollama uses OpenAI-compatible API
      const openai = createOpenAI({
        baseURL: conf.baseURL ?? "http://localhost:11434/api",
        apiKey: "ollama", // dummy
      });
      return openai(modelId);
    }
    default:
      throw new Error(`[llm] Unknown provider type: ${conf.type}`);
  }
}

export interface LlmClient {
  run(taskName: string, prompt: string): Promise<string>;
  runWithDefault(prompt: string): Promise<string>;
}

export function createLlmClient(spec: MekikiSpec): LlmClient {
  const config = spec.llmConfig as unknown as LlmConfig;
  const routing = spec.taskRouting as Record<string, TaskRoute>;

  return {
    async run(taskName: string, prompt: string): Promise<string> {
      const route = routing[taskName];
      if (!route) {
        throw new Error(`[llm] No routing for task: ${taskName}`);
      }

      // Try routed provider; fall back to activeProvider if API key is missing
      let providerName = route.provider;
      let modelId = route.model;
      const routedConf = config.providers[providerName];
      if (routedConf?.apiKeyEnv && !process.env[routedConf.apiKeyEnv]) {
        console.warn(
          `[llm] ${routedConf.apiKeyEnv} not set, falling back to ${config.activeProvider}/${config.activeModel} for task "${taskName}"`,
        );
        providerName = config.activeProvider;
        modelId = config.activeModel;
      }

      console.log(`[llm] Task "${taskName}" → ${providerName}/${modelId} (prompt: ${prompt.length} chars)`);

      const model = createModel(providerName, modelId, config.providers);
      const result = await generateText({
        model,
        prompt,
        temperature: config.defaults.temperature,
        maxTokens: config.defaults.maxOutputTokens,
      });

      console.log(`[llm] Task "${taskName}" response: ${result.text.length} chars`);
      return result.text;
    },

    async runWithDefault(prompt: string): Promise<string> {
      const model = createModel(config.activeProvider, config.activeModel, config.providers);
      const result = await generateText({
        model,
        prompt,
        temperature: config.defaults.temperature,
        maxTokens: config.defaults.maxOutputTokens,
      });
      return result.text;
    },
  };
}
