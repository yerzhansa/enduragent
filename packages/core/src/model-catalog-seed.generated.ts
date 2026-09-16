export const GENERATED_MODEL_CATALOG_SEED = {
  "schemaVersion": 1,
  "revision": 2,
  "provenance": {
    "kind": "bundled-seed",
    "establishedAt": "2026-09-13T00:00:00.000Z"
  },
  "providers": [
    {
      "providerId": "anthropic",
      "label": "Anthropic (Claude)",
      "order": 0,
      "recommendedModelId": "claude-sonnet-5",
      "models": [
        {
          "modelId": "claude-sonnet-5",
          "label": "Claude Sonnet 5",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "anthropic-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 2,
            "outputUsdPerMillion": 10,
            "cacheReadUsdPerMillion": 0.2,
            "cacheWriteUsdPerMillion": 2.5
          }
        },
        {
          "modelId": "claude-haiku-4-5-20251001",
          "label": "Claude Haiku 4.5",
          "order": 1,
          "hint": "fast & cheap",
          "compatibilityProfile": "anthropic-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 5,
            "cacheReadUsdPerMillion": 0.1,
            "cacheWriteUsdPerMillion": 1.25
          }
        },
        {
          "modelId": "claude-opus-5",
          "label": "Claude Opus 5",
          "order": 2,
          "hint": "most capable",
          "compatibilityProfile": "anthropic-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 5,
            "outputUsdPerMillion": 25,
            "cacheReadUsdPerMillion": 0.5,
            "cacheWriteUsdPerMillion": 6.25
          }
        },
        {
          "modelId": "claude-fable-5-1",
          "label": "Claude Fable 5.1",
          "order": 3,
          "compatibilityProfile": "anthropic-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "openai",
      "label": "OpenAI (GPT)",
      "order": 1,
      "recommendedModelId": "gpt-5.6-sol",
      "models": [
        {
          "modelId": "gpt-5.6-sol",
          "label": "GPT-5.6 Sol",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "openai-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 5,
            "outputUsdPerMillion": 30,
            "cacheReadUsdPerMillion": 0.5,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gpt-5.6-terra",
          "label": "GPT-5.6 Terra",
          "order": 1,
          "hint": "balanced",
          "compatibilityProfile": "openai-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 2.5,
            "outputUsdPerMillion": 15,
            "cacheReadUsdPerMillion": 0.25,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gpt-5.6-luna",
          "label": "GPT-5.6 Luna",
          "order": 2,
          "hint": "cheapest",
          "compatibilityProfile": "openai-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 6,
            "cacheReadUsdPerMillion": 0.1,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gpt-6-astra",
          "label": "GPT-6 Astra",
          "order": 3,
          "compatibilityProfile": "openai-astra-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "google",
      "label": "Google (Gemini)",
      "order": 2,
      "recommendedModelId": "gemini-3.6-flash",
      "models": [
        {
          "modelId": "gemini-3.6-flash",
          "label": "Gemini 3.6 Flash",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "google-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1048576
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1.5,
            "outputUsdPerMillion": 7.5,
            "cacheReadUsdPerMillion": 0.15,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gemini-3.1-pro-preview",
          "label": "Gemini 3.1 Pro",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "google-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1048576
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 2,
            "outputUsdPerMillion": 12,
            "cacheReadUsdPerMillion": 0.2,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gemini-3.5-flash-lite",
          "label": "Gemini 3.5 Flash Lite",
          "order": 2,
          "hint": "cheapest",
          "compatibilityProfile": "google-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1048576
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 0.3,
            "outputUsdPerMillion": 2.5,
            "cacheReadUsdPerMillion": 0.03,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gemini-3.8-flash",
          "label": "Gemini 3.8 Flash",
          "order": 3,
          "compatibilityProfile": "google-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1048576
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "gemini-3.7-flash",
          "label": "Gemini 3.7 Flash",
          "order": 4,
          "compatibilityProfile": "google-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1048576
          },
          "imageInput": "supported",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "openai-codex",
      "label": "OpenAI Codex (ChatGPT subscription)",
      "order": 3,
      "hint": "experimental",
      "recommendedModelId": "gpt-5.6-sol",
      "models": [
        {
          "modelId": "gpt-5.6-sol",
          "label": "GPT-5.6 Sol",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "openai-codex-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 5,
            "outputUsdPerMillion": 30,
            "cacheReadUsdPerMillion": 0.5,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "gpt-5.6-luna",
          "label": "GPT-5.6 Luna",
          "order": 1,
          "hint": "faster",
          "compatibilityProfile": "openai-codex-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 6,
            "cacheReadUsdPerMillion": 0.1,
            "cacheWriteUsdPerMillion": 0
          }
        }
      ]
    },
    {
      "providerId": "claude-cli",
      "label": "Claude subscription (Claude Code CLI)",
      "order": 4,
      "hint": "experimental",
      "recommendedModelId": "sonnet",
      "models": [
        {
          "modelId": "sonnet",
          "label": "Claude Sonnet",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "claude-cli-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 2,
            "outputUsdPerMillion": 10,
            "cacheReadUsdPerMillion": 0.2,
            "cacheWriteUsdPerMillion": 2.5
          }
        },
        {
          "modelId": "opus",
          "label": "Claude Opus",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "claude-cli-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 5,
            "outputUsdPerMillion": 25,
            "cacheReadUsdPerMillion": 0.5,
            "cacheWriteUsdPerMillion": 6.25
          }
        },
        {
          "modelId": "haiku",
          "label": "Claude Haiku",
          "order": 2,
          "hint": "fast",
          "compatibilityProfile": "claude-cli-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 5,
            "cacheReadUsdPerMillion": 0.1,
            "cacheWriteUsdPerMillion": 1.25
          }
        },
        {
          "modelId": "fable",
          "label": "Claude Fable",
          "order": 3,
          "compatibilityProfile": "claude-cli-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 2,
            "outputUsdPerMillion": 10,
            "cacheReadUsdPerMillion": 0.2,
            "cacheWriteUsdPerMillion": 2.5
          }
        }
      ]
    },
    {
      "providerId": "deepseek",
      "label": "DeepSeek",
      "order": 5,
      "recommendedModelId": "deepseek-v4-flash",
      "models": [
        {
          "modelId": "deepseek-v4-flash",
          "label": "DeepSeek V4 Flash",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "deepseek-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "deepseek-v4-pro",
          "label": "DeepSeek V4 Pro",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "deepseek-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "deepseek-flash",
          "label": "DeepSeek V4.1 Flash",
          "order": 2,
          "compatibilityProfile": "deepseek-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "qwen",
      "label": "Qwen (Alibaba Model Studio)",
      "order": 6,
      "recommendedModelId": "qwen3.7-plus",
      "models": [
        {
          "modelId": "qwen3.7-plus",
          "label": "Qwen3.7 Plus",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "alibaba-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "qwen3.7-max",
          "label": "Qwen3.7 Max",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "alibaba-ai-sdk-v1",
          "contextWindow": {
            "kind": "unknown"
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "qwen3.8-max",
          "label": "Qwen3.8 Max",
          "order": 2,
          "compatibilityProfile": "alibaba-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "qwen3.8-flash",
          "label": "Qwen3.8 Flash",
          "order": 3,
          "compatibilityProfile": "alibaba-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "minimax",
      "label": "MiniMax",
      "order": 7,
      "recommendedModelId": "MiniMax-M3",
      "models": [
        {
          "modelId": "MiniMax-M3",
          "label": "MiniMax M3",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "MiniMax-M2.7",
          "label": "MiniMax M2.7",
          "order": 1,
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 204800
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "MiniMax-M2.7-highspeed",
          "label": "MiniMax M2.7 Highspeed",
          "order": 2,
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 204800
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "kimi",
      "label": "Kimi (Moonshot AI)",
      "order": 8,
      "recommendedModelId": "kimi-k3",
      "models": [
        {
          "modelId": "kimi-k3",
          "label": "Kimi K3",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "kimi-k2.6",
          "label": "Kimi K2.6",
          "order": 1,
          "hint": "cheaper",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 262144
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "kimi-k2.7-code",
          "label": "Kimi K2.7 Code",
          "order": 2,
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 262144
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "zai",
      "label": "Z.AI (GLM)",
      "order": 9,
      "recommendedModelId": "glm-4.7",
      "models": [
        {
          "modelId": "glm-4.7",
          "label": "GLM-4.7",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 0.6,
            "outputUsdPerMillion": 2.2,
            "cacheReadUsdPerMillion": 0.11,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "glm-5.2",
          "label": "GLM-5.2",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1.4,
            "outputUsdPerMillion": 4.4,
            "cacheReadUsdPerMillion": 0.26,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "glm-4.7-flashx",
          "label": "GLM-4.7 FlashX",
          "order": 2,
          "hint": "cheapest",
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 0.07,
            "outputUsdPerMillion": 0.4,
            "cacheReadUsdPerMillion": 0.01,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "glm-5.3-flash",
          "label": "GLM-5.3 Flash",
          "order": 3,
          "compatibilityProfile": "openai-compatible-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "openrouter",
      "label": "OpenRouter",
      "order": 10,
      "hint": "one key, many models",
      "recommendedModelId": "deepseek/deepseek-v4-flash",
      "models": [
        {
          "modelId": "deepseek/deepseek-v4-flash",
          "label": "DeepSeek V4 Flash (via OpenRouter)",
          "order": 0,
          "hint": "cheap",
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 0.09,
            "outputUsdPerMillion": 0.18,
            "cacheReadUsdPerMillion": 0,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "z-ai/glm-5.2",
          "label": "GLM-5.2 (via OpenRouter)",
          "order": 1,
          "hint": "most capable",
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 1.2,
            "outputUsdPerMillion": 4.1,
            "cacheReadUsdPerMillion": 0,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "qwen/qwen3.7-plus",
          "label": "Qwen3.7 Plus (via OpenRouter)",
          "order": 2,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 0.32,
            "outputUsdPerMillion": 1.28,
            "cacheReadUsdPerMillion": 0,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "moonshotai/kimi-k3",
          "label": "Kimi K3 (via OpenRouter)",
          "order": 3,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 3,
            "outputUsdPerMillion": 15,
            "cacheReadUsdPerMillion": 0.3,
            "cacheWriteUsdPerMillion": 0
          }
        },
        {
          "modelId": "openai/gpt-6-astra",
          "label": "GPT-6 Astra (via OpenRouter)",
          "order": 4,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "anthropic/claude-fable-5.1",
          "label": "Claude Fable 5.1 (via OpenRouter)",
          "order": 5,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "deepseek/deepseek-v4.1-flash",
          "label": "DeepSeek V4.1 Flash (via OpenRouter)",
          "order": 6,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "qwen/qwen3.8-max",
          "label": "Qwen3.8 Max (via OpenRouter)",
          "order": 7,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1000000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "z-ai/glm-5.3-flash",
          "label": "GLM-5.3 Flash (via OpenRouter)",
          "order": 8,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 200000
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        },
        {
          "modelId": "moonshotai/kimi-k2.7-code",
          "label": "Kimi K2.7 Code (via OpenRouter)",
          "order": 9,
          "compatibilityProfile": "openrouter-ai-sdk-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 262144
          },
          "imageInput": "provider-metadata",
          "pricing": {
            "kind": "unknown"
          }
        }
      ]
    },
    {
      "providerId": "codex-agent",
      "label": "Codex agent (ChatGPT subscription)",
      "order": 11,
      "hint": "hidden",
      "recommendedModelId": "gpt-5.6-sol",
      "models": [
        {
          "modelId": "gpt-5.6-sol",
          "label": "GPT-5.6 Sol",
          "order": 0,
          "hint": "recommended",
          "compatibilityProfile": "codex-agent-v1",
          "contextWindow": {
            "kind": "known",
            "tokens": 1050000
          },
          "imageInput": "incompatible",
          "pricing": {
            "kind": "token-rates",
            "inputUsdPerMillion": 5,
            "outputUsdPerMillion": 30,
            "cacheReadUsdPerMillion": 0.5,
            "cacheWriteUsdPerMillion": 0
          }
        }
      ]
    }
  ]
} as const;
