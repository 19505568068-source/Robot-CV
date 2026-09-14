import crypto from "node:crypto";
import path from "node:path";

import type { SecretProtector } from "../security/dpapi.js";
import type { HrDraftType } from "./hr.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

const DOCUMENT_VERSION = 1;
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_DRAFT_CONTENT = 20_000;

type HrAiSettingsRecord = {
  enabled: boolean;
  endpoint: string;
  model: string;
  encryptedApiKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type HrAiSettingsSummary = {
  provider: "responses-compatible";
  enabled: boolean;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  configured: boolean;
  toolsAllowed: false;
  createdAt: string;
  updatedAt: string;
};

export type UpdateHrAiSettingsInput = {
  enabled?: boolean;
  endpoint?: string | null;
  model?: string | null;
  apiKey?: string | null;
};

export type HrAiDraft = {
  id: string;
  opportunityId: string;
  type: HrDraftType;
  status: "draft" | "reviewed" | "approved" | "rejected";
  generator: "codex" | "responses-api";
  isAiGenerated: true;
  model: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type HrAiDocument = {
  version: 1;
  settings: HrAiSettingsRecord;
  drafts: HrAiDraft[];
};

export type HrAiStoreErrorCode = "NOT_FOUND" | "VALIDATION" | "STORAGE" | "NOT_CONFIGURED";

export class HrAiStoreError extends Error {
  constructor(message: string, readonly code: HrAiStoreErrorCode) {
    super(message);
    this.name = "HrAiStoreError";
  }
}

export class HrAiStore {
  readonly filePath: string;
  private document: HrAiDocument;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    paths: Pick<StatePaths, "root">,
    private readonly protector: SecretProtector,
    private readonly now: () => Date = () => new Date()
  ) {
    this.filePath = path.join(paths.root, "hr-ai.json");
    const fallback = emptyDocument(this.now());
    this.document = normalizeDocument(readJsonFile<unknown>(this.filePath, fallback), fallback);
    if (!path.isAbsolute(this.filePath)) {
      throw new HrAiStoreError("HR AI state path must be absolute", "STORAGE");
    }
    if (!readJsonFile<unknown>(this.filePath, undefined)) this.persist();
  }

  getSettings(): HrAiSettingsSummary {
    return settingsSummary(this.document.settings);
  }

  updateSettings(input: UpdateHrAiSettingsInput): Promise<HrAiSettingsSummary> {
    return this.enqueueMutation(async () => {
      const current = this.document.settings;
      const encryptedApiKey = await this.updatedApiKey(current.encryptedApiKey, input.apiKey);
      const next: HrAiSettingsRecord = {
        ...current,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        endpoint: input.endpoint === undefined
          ? current.endpoint
          : normalizeEndpoint(input.endpoint),
        model: input.model === undefined
          ? current.model
          : normalizeModel(input.model),
        encryptedApiKey,
        updatedAt: this.now().toISOString()
      };
      if (next.enabled && !isConfigured(next)) {
        throw new HrAiStoreError("AI replies require an HTTPS Responses endpoint, model and API key", "NOT_CONFIGURED");
      }
      const previous = this.document;
      this.document = { ...structuredClone(this.document), settings: next };
      try {
        this.persist();
      } catch (error) {
        this.document = previous;
        throw error;
      }
      return settingsSummary(next);
    });
  }

  async readProviderCredentials(): Promise<{ endpoint: string; model: string; apiKey: string }> {
    const settings = this.document.settings;
    if (!settings.enabled || !isConfigured(settings) || !settings.encryptedApiKey) {
      throw new HrAiStoreError("HR AI provider is disabled or incomplete", "NOT_CONFIGURED");
    }
    try {
      return {
        endpoint: settings.endpoint,
        model: settings.model,
        apiKey: await this.protector.unprotect(settings.encryptedApiKey)
      };
    } catch (error) {
      if (error instanceof HrAiStoreError) throw error;
      throw new HrAiStoreError("Unable to decrypt the HR AI API key", "STORAGE");
    }
  }

  listDrafts(opportunityId: string): HrAiDraft[] {
    const normalizedId = required(opportunityId, "opportunityId", 256);
    return structuredClone(this.document.drafts)
      .filter((draft) => draft.opportunityId === normalizedId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  createDraft(
    opportunityId: string,
    type: HrDraftType,
    content: string,
    model: string,
    generator: HrAiDraft["generator"] = "responses-api"
  ): Promise<HrAiDraft> {
    return this.enqueueMutation(() => {
      const timestamp = this.now().toISOString();
      const draft: HrAiDraft = {
        id: crypto.randomUUID(),
        opportunityId: required(opportunityId, "opportunityId", 256),
        type,
        status: "draft",
        generator,
        isAiGenerated: true,
        model: required(model, "model", 200),
        content: required(content, "content", MAX_DRAFT_CONTENT),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.document.drafts.push(draft);
      this.persist();
      return structuredClone(draft);
    });
  }

  setDraftStatus(
    draftId: string,
    status: "reviewed" | "approved" | "rejected"
  ): Promise<HrAiDraft | undefined> {
    return this.enqueueMutation(() => {
      const normalizedId = required(draftId, "draftId", 256);
      const draft = this.document.drafts.find((candidate) => candidate.id === normalizedId);
      if (!draft) return undefined;
      draft.status = status;
      draft.updatedAt = this.now().toISOString();
      this.persist();
      return structuredClone(draft);
    });
  }

  private async updatedApiKey(current: string | undefined, input: string | null | undefined): Promise<string | undefined> {
    if (input === undefined) return current;
    if (input === null || !input.trim()) return undefined;
    if (input.length > 8_192) throw new HrAiStoreError("apiKey is too long", "VALIDATION");
    try {
      return await this.protector.protect(input.trim());
    } catch {
      throw new HrAiStoreError("Unable to encrypt the HR AI API key", "STORAGE");
    }
  }

  private enqueueMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist(): void {
    try {
      writeJsonFile(this.filePath, this.document);
    } catch {
      throw new HrAiStoreError("Unable to persist HR AI settings", "STORAGE");
    }
  }
}

function emptyDocument(now: Date): HrAiDocument {
  const timestamp = now.toISOString();
  return {
    version: DOCUMENT_VERSION,
    settings: {
      enabled: false,
      endpoint: DEFAULT_ENDPOINT,
      model: "",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    drafts: []
  };
}

function normalizeDocument(value: unknown, fallback: HrAiDocument): HrAiDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Partial<HrAiDocument>;
  const settings = source.settings && typeof source.settings === "object"
    ? source.settings as Partial<HrAiSettingsRecord>
    : {};
  const endpoint = typeof settings.endpoint === "string"
    ? safelyNormalizeEndpoint(settings.endpoint, fallback.settings.endpoint)
    : fallback.settings.endpoint;
  const model = typeof settings.model === "string" ? settings.model.trim().slice(0, 200) : "";
  const createdAt = validTimestamp(settings.createdAt) ?? fallback.settings.createdAt;
  const updatedAt = validTimestamp(settings.updatedAt) ?? createdAt;
  return {
    version: DOCUMENT_VERSION,
    settings: {
      enabled: settings.enabled === true,
      endpoint,
      model,
      ...(typeof settings.encryptedApiKey === "string" && settings.encryptedApiKey ? {
        encryptedApiKey: settings.encryptedApiKey
      } : {}),
      createdAt,
      updatedAt
    },
    drafts: Array.isArray(source.drafts) ? source.drafts.filter(isStoredDraft).map((draft) => structuredClone(draft)) : []
  };
}

function isStoredDraft(value: unknown): value is HrAiDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Partial<HrAiDraft>;
  return typeof draft.id === "string"
    && typeof draft.opportunityId === "string"
    && ["invitation-analysis", "interview-advice", "resume-improvements", "follow-up"].includes(String(draft.type))
    && ["draft", "reviewed", "approved", "rejected"].includes(String(draft.status))
    && (draft.generator === "codex" || draft.generator === "responses-api")
    && draft.isAiGenerated === true
    && typeof draft.model === "string"
    && typeof draft.content === "string"
    && typeof draft.createdAt === "string"
    && typeof draft.updatedAt === "string";
}

function settingsSummary(settings: HrAiSettingsRecord): HrAiSettingsSummary {
  return {
    provider: "responses-compatible",
    enabled: settings.enabled,
    endpoint: settings.endpoint,
    model: settings.model,
    hasApiKey: Boolean(settings.encryptedApiKey),
    configured: isConfigured(settings),
    toolsAllowed: false,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt
  };
}

function isConfigured(settings: HrAiSettingsRecord): boolean {
  return Boolean(settings.endpoint && settings.model && settings.encryptedApiKey);
}

function normalizeEndpoint(value: string | null): string {
  const normalized = value?.trim() || DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HrAiStoreError("AI endpoint must be a valid HTTPS URL", "VALIDATION");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new HrAiStoreError("AI endpoint must be an HTTPS URL without credentials, query or fragment", "VALIDATION");
  }
  return parsed.toString();
}

function safelyNormalizeEndpoint(value: string, fallback: string): string {
  try {
    return normalizeEndpoint(value);
  } catch {
    return fallback;
  }
}

function normalizeModel(value: string | null): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 200 || /[\r\n\0]/u.test(normalized)) {
    throw new HrAiStoreError("AI model is invalid", "VALIDATION");
  }
  return normalized;
}

function required(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new HrAiStoreError(`${field} is required`, "VALIDATION");
  if (normalized.length > max) throw new HrAiStoreError(`${field} is too long`, "VALIDATION");
  return normalized;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}
