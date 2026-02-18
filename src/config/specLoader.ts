import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Ajv and ajv-formats are CJS; use require for reliable interop
// Use Ajv2020 to support draft/2020-12 $schema used in spec schemas
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = require("ajv-formats").default ?? require("ajv-formats");

// ---------- paths ----------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = resolve(ROOT, "spec");

function specPath(...segments: string[]): string {
  return resolve(SPEC, ...segments);
}

// ---------- helpers ----------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf-8"));
}

function readTemplate(path: string): string {
  return readFileSync(path, "utf-8");
}

// ---------- validation ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createAjv(): any {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validate(ajv: any, schemaPath: string, data: unknown, label: string): void {
  const schema = readJson(schemaPath);
  const valid = ajv.validate(schema, data);
  if (!valid) {
    const errors = ajv.errorsText(ajv.errors, { separator: "\n  " });
    throw new Error(`[spec-validation] ${label} failed:\n  ${errors}`);
  }
}

// ---------- public ----------

export interface MekikiSpec {
  channels: Record<string, unknown>;
  runtime: Record<string, unknown>;
  posting: Record<string, unknown>;
  library: Record<string, unknown>;
  components: Record<string, unknown>;
  stateMachine: Record<string, unknown>;
  rssSources: { sources: Array<Record<string, unknown>> };
  llmConfig: Record<string, unknown>;
  modelRegistry: Record<string, unknown>;
  taskRouting: Record<string, unknown>;
  learningConfig: Record<string, unknown>;
  signals: { signals: string[] };
  tagMap: Record<string, unknown>;
  forumTags: { tags: Array<Record<string, unknown>> };
  templates: {
    feedCard: string;
    libraryPost: string;
  };
  tasteProfileSeed: string;
  profileUpdatePrompt: string;
  profileUpdateConfig: Record<string, unknown>;
}

export function loadAndValidateSpec(): MekikiSpec {
  const ajv = createAjv();

  // --- Load data ---
  const channelsYaml = readYaml(specPath("ux", "channels.yaml")) as Record<string, unknown>;
  const components = readYaml(specPath("ux", "components.yaml")) as Record<string, unknown>;
  const stateMachine = readYaml(specPath("ux", "state_machine.yaml")) as Record<string, unknown>;
  const rssSources = readJson(specPath("rss", "rss_sources.json")) as { sources: Array<Record<string, unknown>> };
  const llmConfig = readJson(specPath("llm", "llm_config.json")) as Record<string, unknown>;
  const modelRegistry = readJson(specPath("llm", "model_registry.json")) as Record<string, unknown>;
  const taskRouting = readJson(specPath("llm", "task_routing.json")) as Record<string, unknown>;
  const learningConfig = readYaml(specPath("learning", "learning_config.yaml")) as Record<string, unknown>;
  const signals = readYaml(specPath("learning", "signals.yaml")) as { signals: string[] };
  const tagMap = readYaml(specPath("learning", "tag_map.yaml")) as Record<string, unknown>;
  const forumTags = readYaml(specPath("forum", "forum_tags.yaml")) as { tags: Array<Record<string, unknown>> };

  // --- Templates ---
  const feedCard = readTemplate(specPath("templates", "feed_card.template.md"));
  const libraryPost = readTemplate(specPath("templates", "library_post.template.md"));

  // --- Learning / Taste Profile ---
  const tasteProfileSeed = readTemplate(specPath("learning", "taste_profile_seed.md"));
  const profileUpdatePrompt = readTemplate(specPath("learning", "profile_update_prompt.md"));
  const profileUpdateConfig = readYaml(specPath("learning", "profile_update.yaml")) as Record<string, unknown>;

  // --- Validate against schemas ---
  validate(ajv, specPath("schemas", "rss_sources.schema.json"), rssSources, "rss_sources.json");
  validate(ajv, specPath("schemas", "llm_config.schema.json"), llmConfig, "llm_config.json");
  validate(ajv, specPath("schemas", "model_registry.schema.json"), modelRegistry, "model_registry.json");
  validate(ajv, specPath("schemas", "task_routing.schema.json"), taskRouting, "task_routing.json");
  validate(ajv, specPath("schemas", "learning.schema.json"), learningConfig, "learning_config.yaml");
  validate(ajv, specPath("schemas", "ux_components.schema.json"), components, "components.yaml");
  validate(ajv, specPath("schemas", "state_machine.schema.json"), stateMachine, "state_machine.yaml");

  console.log("[spec] All 7 schema validations passed.");

  // Extract channel config
  const channels = (channelsYaml as { channels: Record<string, unknown> }).channels;
  const runtime = (channelsYaml as { runtime: Record<string, unknown> }).runtime;
  const posting = (channelsYaml as { posting: Record<string, unknown> }).posting;
  const libraryConf = (channelsYaml as { library: Record<string, unknown> }).library;

  return {
    channels,
    runtime,
    posting,
    library: libraryConf,
    components,
    stateMachine,
    rssSources,
    llmConfig,
    modelRegistry,
    taskRouting,
    learningConfig,
    signals,
    tagMap,
    forumTags,
    templates: { feedCard, libraryPost },
    tasteProfileSeed,
    profileUpdatePrompt,
    profileUpdateConfig,
  };
}
