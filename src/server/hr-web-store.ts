import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import { writeJsonFile } from "../state/json-store.js";

const DOCUMENT_VERSION = 1;
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS = 10_000;
const TOUCH_INTERVAL_MS = 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type HrWebSettings = {
  enabled: boolean;
  entryToken: string;
  entryRevision: number;
  publicBaseUrl?: string;
  candidateName?: string;
  createdAt: string;
  updatedAt: string;
};

export type UpdateHrWebSettingsInput = {
  enabled?: boolean;
  publicBaseUrl?: string | null;
  candidateName?: string | null;
};

export type HrWebSession = {
  id: string;
  tokenHash: string;
  csrfTokenHash: string;
  entryRevision: number;
  visitorId?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
};

type HrWebDocument = {
  version: 1;
  settings: HrWebSettings;
  sessions: HrWebSession[];
};

export type CreatedHrWebSession = {
  session: HrWebSession;
  sessionToken: string;
  csrfToken: string;
};

export type HrWebStoreErrorCode = "AUTH" | "DISABLED" | "VALIDATION" | "CAPACITY" | "STORAGE";

export class HrWebStoreError extends Error {
  constructor(message: string, readonly code: HrWebStoreErrorCode) {
    super(message);
    this.name = "HrWebStoreError";
  }
}

export class HrWebStore {
  private document: HrWebDocument;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.document = this.readOrCreate();
  }

  getSettings(): HrWebSettings {
    return structuredClone(this.document.settings);
  }

  getSessionCount(): number {
    const now = this.now().getTime();
    return this.document.sessions.filter((session) => isActive(session, now)).length;
  }

  updateSettings(input: UpdateHrWebSettingsInput): HrWebSettings {
    if (input.enabled === undefined && input.publicBaseUrl === undefined && input.candidateName === undefined) {
      throw new HrWebStoreError("Web chat settings update is empty", "VALIDATION");
    }
    const timestamp = this.now().toISOString();
    this.document.settings = {
      ...this.document.settings,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.publicBaseUrl === undefined
        ? {}
        : input.publicBaseUrl === null || !input.publicBaseUrl.trim()
          ? { publicBaseUrl: undefined }
          : { publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl) }),
      ...(input.candidateName === undefined
        ? {}
        : input.candidateName === null || !input.candidateName.trim()
          ? { candidateName: undefined }
          : { candidateName: normalizeCandidateName(input.candidateName) }),
      updatedAt: timestamp
    };
    this.persist();
    return this.getSettings();
  }

  rotateEntryToken(): HrWebSettings {
    this.document.settings.entryToken = randomToken();
    this.document.settings.entryRevision += 1;
    this.document.settings.updatedAt = this.now().toISOString();
    this.persist();
    return this.getSettings();
  }

  createSession(entryToken: string, ttlMs = DEFAULT_SESSION_TTL_MS): CreatedHrWebSession {
    if (!this.document.settings.enabled) {
      throw new HrWebStoreError("Web chat is disabled", "DISABLED");
    }
    if (!safeTokenEqual(entryToken, this.document.settings.entryToken)) {
      throw new HrWebStoreError("Invalid entry token", "AUTH");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
      throw new HrWebStoreError("Session lifetime is invalid", "VALIDATION");
    }
    this.pruneExpiredSessions();
    if (this.document.sessions.length >= MAX_SESSIONS) {
      throw new HrWebStoreError("Web chat session capacity reached", "CAPACITY");
    }
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const timestamp = this.now();
    const session: HrWebSession = {
      id: crypto.randomUUID(),
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      entryRevision: this.document.settings.entryRevision,
      createdAt: timestamp.toISOString(),
      lastSeenAt: timestamp.toISOString(),
      expiresAt: new Date(timestamp.getTime() + ttlMs).toISOString()
    };
    this.document.sessions.push(session);
    this.persist();
    return { session: publicSession(session), sessionToken, csrfToken };
  }

  authenticateSession(sessionToken: string, touch = true): HrWebSession {
    if (!this.document.settings.enabled) {
      throw new HrWebStoreError("Web chat is disabled", "DISABLED");
    }
    if (!TOKEN_PATTERN.test(sessionToken)) {
      throw new HrWebStoreError("Invalid web chat session", "AUTH");
    }
    const tokenHash = hashToken(sessionToken);
    const session = this.document.sessions.find((candidate) => safeHashEqual(candidate.tokenHash, tokenHash));
    const timestamp = this.now();
    if (!session || !isActive(session, timestamp.getTime())) {
      throw new HrWebStoreError("Web chat session expired", "AUTH");
    }
    if (touch && timestamp.getTime() - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
      session.lastSeenAt = timestamp.toISOString();
      this.persist();
    }
    return publicSession(session);
  }

  verifyCsrf(sessionId: string, csrfToken: string): void {
    if (!TOKEN_PATTERN.test(csrfToken)) {
      throw new HrWebStoreError("Invalid CSRF token", "AUTH");
    }
    const session = this.requireActiveSession(sessionId);
    if (!safeHashEqual(session.csrfTokenHash, hashToken(csrfToken))) {
      throw new HrWebStoreError("Invalid CSRF token", "AUTH");
    }
  }

  rotateCsrfToken(sessionId: string): string {
    const session = this.requireActiveSession(sessionId);
    const csrfToken = randomToken();
    session.csrfTokenHash = hashToken(csrfToken);
    session.lastSeenAt = this.now().toISOString();
    this.persist();
    return csrfToken;
  }

  bindVisitor(sessionId: string, visitorId: string): HrWebSession {
    const normalizedVisitorId = visitorId.trim();
    if (!normalizedVisitorId || normalizedVisitorId.length > 256 || /[\r\n\0]/u.test(normalizedVisitorId)) {
      throw new HrWebStoreError("Visitor identity is invalid", "VALIDATION");
    }
    const session = this.requireActiveSession(sessionId);
    if (session.visitorId && session.visitorId !== normalizedVisitorId) {
      throw new HrWebStoreError("Web chat session is already bound", "AUTH");
    }
    if (!session.visitorId) {
      session.visitorId = normalizedVisitorId;
      this.persist();
    }
    return publicSession(session);
  }

  revokeSession(sessionId: string): void {
    const session = this.document.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.revokedAt) return;
    session.revokedAt = this.now().toISOString();
    this.persist();
  }

  private requireActiveSession(sessionId: string): HrWebSession {
    const session = this.document.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !isActive(session, this.now().getTime())) {
      throw new HrWebStoreError("Web chat session expired", "AUTH");
    }
    return session;
  }

  private pruneExpiredSessions(): void {
    const now = this.now().getTime();
    const retained = this.document.sessions.filter((session) => {
      if (isActive(session, now)) return true;
      const terminalAt = Date.parse(session.revokedAt ?? session.expiresAt);
      return Number.isFinite(terminalAt) && now - terminalAt < 7 * 24 * 60 * 60 * 1_000;
    });
    if (retained.length !== this.document.sessions.length) this.document.sessions = retained;
  }

  private readOrCreate(): HrWebDocument {
    if (!fs.existsSync(this.filePath)) {
      const timestamp = this.now().toISOString();
      const document: HrWebDocument = {
        version: DOCUMENT_VERSION,
        settings: {
          enabled: false,
          entryToken: randomToken(),
          entryRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp
        },
        sessions: []
      };
      try {
        writeJsonFile(this.filePath, document);
      } catch {
        throw new HrWebStoreError("Unable to initialize web chat storage", "STORAGE");
      }
      return document;
    }
    try {
      return normalizeDocument(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof HrWebStoreError) throw error;
      throw new HrWebStoreError("Web chat storage is invalid", "STORAGE");
    }
  }

  private persist(): void {
    try {
      writeJsonFile(this.filePath, this.document);
    } catch {
      throw new HrWebStoreError("Unable to save web chat storage", "STORAGE");
    }
  }
}

function normalizeDocument(value: unknown): HrWebDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid document");
  const source = value as Partial<HrWebDocument>;
  if (source.version !== DOCUMENT_VERSION || !source.settings || !Array.isArray(source.sessions)) {
    throw new Error("invalid document");
  }
  const settings = source.settings;
  if (typeof settings.enabled !== "boolean" || !TOKEN_PATTERN.test(settings.entryToken)
    || !Number.isInteger(settings.entryRevision) || settings.entryRevision < 1
    || !validTimestamp(settings.createdAt) || !validTimestamp(settings.updatedAt)) {
    throw new Error("invalid settings");
  }
  const normalizedSettings: HrWebSettings = {
    enabled: settings.enabled,
    entryToken: settings.entryToken,
    entryRevision: settings.entryRevision,
    ...(settings.publicBaseUrl ? { publicBaseUrl: normalizePublicBaseUrl(settings.publicBaseUrl) } : {}),
    ...(settings.candidateName ? { candidateName: normalizeCandidateName(settings.candidateName) } : {}),
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt
  };
  const ids = new Set<string>();
  const tokenHashes = new Set<string>();
  const sessions = source.sessions.map((session) => normalizeSession(session));
  for (const session of sessions) {
    if (ids.has(session.id) || tokenHashes.has(session.tokenHash)) throw new Error("duplicate session");
    ids.add(session.id);
    tokenHashes.add(session.tokenHash);
  }
  if (sessions.length > MAX_SESSIONS) throw new Error("too many sessions");
  return { version: DOCUMENT_VERSION, settings: normalizedSettings, sessions };
}

function normalizeSession(value: unknown): HrWebSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session");
  const session = value as Partial<HrWebSession>;
  if (typeof session.id !== "string" || !session.id || session.id.length > 256
    || typeof session.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(session.tokenHash)
    || typeof session.csrfTokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(session.csrfTokenHash)
    || !Number.isInteger(session.entryRevision) || Number(session.entryRevision) < 1
    || !validTimestamp(session.createdAt) || !validTimestamp(session.lastSeenAt)
    || !validTimestamp(session.expiresAt) || (session.revokedAt !== undefined && !validTimestamp(session.revokedAt))) {
    throw new Error("invalid session");
  }
  if (session.visitorId !== undefined
    && (typeof session.visitorId !== "string" || !session.visitorId || session.visitorId.length > 256)) {
    throw new Error("invalid visitor binding");
  }
  return {
    id: session.id,
    tokenHash: session.tokenHash,
    csrfTokenHash: session.csrfTokenHash,
    entryRevision: Number(session.entryRevision),
    ...(session.visitorId ? { visitorId: session.visitorId } : {}),
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    ...(session.revokedAt ? { revokedAt: session.revokedAt } : {})
  };
}

function normalizePublicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new HrWebStoreError("Public base URL is invalid", "VALIDATION");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new HrWebStoreError("Public base URL must be an origin without credentials, path, query or fragment", "VALIDATION");
  }
  const localHttp = parsed.protocol === "http:" && isLocalOrPrivateHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new HrWebStoreError("Public web chat requires HTTPS outside a local network", "VALIDATION");
  }
  return parsed.origin;
}

function normalizeCandidateName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 100 || /[\r\n\0]/u.test(normalized)) {
    throw new HrWebStoreError("Candidate name is invalid", "VALIDATION");
  }
  return normalized;
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  }
  return version === 6 && (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd"));
}

function randomToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTokenEqual(left: string, right: string): boolean {
  if (!TOKEN_PATTERN.test(left) || !TOKEN_PATTERN.test(right)) return false;
  return safeHashEqual(hashToken(left), hashToken(right));
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isActive(session: HrWebSession, now: number): boolean {
  return !session.revokedAt && Date.parse(session.expiresAt) > now;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function publicSession(session: HrWebSession): HrWebSession {
  return structuredClone(session);
}

export const HR_WEB_SESSION_DEFAULT_TTL_MS = DEFAULT_SESSION_TTL_MS;
