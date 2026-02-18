import { execSync } from "node:child_process";

interface OllamaModel {
  id: string;
  label: string;
  size: string;
}

/** Embedding / reranker model name patterns to exclude */
const EXCLUDE_PATTERNS = [
  /embed/i,
  /rerank/i,
  /mxbai-embed/i,
];

/**
 * Probe locally installed Ollama models via `ollama list`.
 * Returns the list of text-generation models (excludes embedding/reranker).
 * Returns null if Ollama is not available.
 */
export function probeOllamaModels(): OllamaModel[] | null {
  try {
    const output = execSync("ollama list", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = output.trim().split("\n");
    // Skip header line (NAME ID SIZE MODIFIED)
    if (lines.length < 2) return [];

    const models: OllamaModel[] = [];

    for (const line of lines.slice(1)) {
      const cols = line.trim().split(/\s{2,}/);
      if (cols.length < 3) continue;

      const name = cols[0].trim();
      const size = cols[2]?.trim() ?? "";

      // Skip embedding/reranker models
      if (EXCLUDE_PATTERNS.some((p) => p.test(name))) continue;

      // Build a readable label from the model name
      const label = name
        .replace(/:latest$/, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

      models.push({ id: name, label: `${label} (${size})`, size });
    }

    return models;
  } catch {
    return null;
  }
}

/**
 * Update the model registry's ollama section with probed models.
 */
export function updateRegistryWithOllama(
  registry: { providers: Record<string, { label: string; models: Array<{ id: string; label: string }> }> },
): void {
  const models = probeOllamaModels();

  if (models === null) {
    console.log("[ollama] Ollama not available — skipping model probe.");
    // Remove ollama from registry if not available
    if (registry.providers.ollama) {
      registry.providers.ollama.models = [];
      console.log("[ollama] Cleared ollama models from registry.");
    }
    return;
  }

  if (models.length === 0) {
    console.log("[ollama] Ollama available but no models installed.");
    if (registry.providers.ollama) {
      registry.providers.ollama.models = [];
    }
    return;
  }

  // Ensure ollama provider exists
  if (!registry.providers.ollama) {
    registry.providers.ollama = { label: "Ollama (Local)", models: [] };
  }

  registry.providers.ollama.models = models.map((m) => ({
    id: m.id,
    label: m.label,
  }));

  console.log(`[ollama] Detected ${models.length} models: ${models.map((m) => m.id).join(", ")}`);
}
