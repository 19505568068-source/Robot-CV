import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const HR_KNOWLEDGE_LIMITS = Object.freeze({
  maxRoots: 50,
  maxDepth: 5,
  maxFiles: 100,
  maxDirectoryEntries: 1_000,
  maxFileBytes: 512 * 1024,
  maxStructuredFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxExtractedCharsPerFile: 512 * 1024,
  maxTotalExtractedChars: 4 * 1024 * 1024,
  maxPdfPages: 100,
  maxDocxEntries: 2_000,
  maxDocxUncompressedBytes: 50 * 1024 * 1024,
  maxChunks: 8,
  maxChunkChars: 1_200,
  maxContextChars: 12_000,
  parseTimeoutMs: 10_000
});

export const HR_KNOWLEDGE_SUPPORTED_EXTENSIONS = Object.freeze([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".pdf", ".docx"
]);

const SUPPORTED_EXTENSIONS = new Set<string>(HR_KNOWLEDGE_SUPPORTED_EXTENSIONS);
const STRUCTURED_EXTENSIONS = new Set([".pdf", ".docx"]);
const MAX_EXTRACTION_CACHE_ENTRIES = HR_KNOWLEDGE_LIMITS.maxFiles * 2;

export type HrKnowledgeChunk = {
  citationId: string;
  document: string;
  locator?: string;
  source: string;
  text: string;
  score: number;
};

export type HrKnowledgeRetrieval = {
  chunks: HrKnowledgeChunk[];
  sources: string[];
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  warnings: string[];
};

type ExtractedChunk = { text: string; locator?: string };
type ExtractionResult = { chunks: ExtractedChunk[]; extractedChars: number; warnings: string[] };
type LoadedDocument = { source: string; chunks: ExtractedChunk[] };

const extractionCache = new Map<string, Promise<ExtractionResult>>();

export function clearHrKnowledgeCache(): void {
  extractionCache.clear();
}

export function readConfiguredKnowledgeRoots(hrStatePath: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(hrStatePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Unable to read the HR knowledge-base configuration");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const materials = (raw as { materials?: unknown }).materials;
  if (!materials || typeof materials !== "object" || Array.isArray(materials)) return [];
  const record = materials as {
    currentResumeId?: unknown;
    resumeVersions?: unknown;
    knowledgeBaseDocuments?: unknown;
  };
  const roots: string[] = [];
  if (typeof record.currentResumeId === "string" && Array.isArray(record.resumeVersions)) {
    const currentResume = record.resumeVersions.find((candidate) => candidate
      && typeof candidate === "object"
      && !Array.isArray(candidate)
      && (candidate as { id?: unknown }).id === record.currentResumeId);
    const resumePath = currentResume && typeof currentResume === "object" && !Array.isArray(currentResume)
      ? (currentResume as { path?: unknown }).path
      : undefined;
    if (typeof resumePath === "string" && resumePath.trim()) roots.push(resumePath);
  }
  if (Array.isArray(record.knowledgeBaseDocuments)) {
    roots.push(...record.knowledgeBaseDocuments
      .map((document) => document && typeof document === "object" && !Array.isArray(document)
        ? (document as { path?: unknown }).path
        : undefined)
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim())));
  }
  return [...new Set(roots.map((root) => root.trim()))].slice(0, HR_KNOWLEDGE_LIMITS.maxRoots);
}

export async function retrieveHrKnowledge(roots: string[], query: string): Promise<HrKnowledgeRetrieval> {
  const warnings: string[] = [];
  const documents: LoadedDocument[] = [];
  const seenRealPaths = new Set<string>();
  let scannedFiles = 0;
  let scannedBytes = 0;
  let extractedChars = 0;
  let skippedFiles = 0;
  let scannedDirectoryEntries = 0;
  const visitedDirectories = new Set<string>();

  const warn = (warning: string) => {
    if (warnings.length < 20) warnings.push(warning);
  };
  const skip = (warning?: string) => {
    skippedFiles += 1;
    if (warning) warn(warning);
  };

  const loadFile = async (filePath: string, source: string, allowedRoot?: string) => {
    if (scannedFiles >= HR_KNOWLEDGE_LIMITS.maxFiles) {
      skip("已达到知识库文件数量上限");
      return;
    }
    let stat: fs.Stats;
    let realPath: string;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink()) {
        skip(`已跳过符号链接：${safeSourceLabel(source)}`);
        return;
      }
      stat = fs.statSync(filePath);
      realPath = fs.realpathSync.native(filePath);
    } catch {
      skip(`无法读取：${safeSourceLabel(source)}`);
      return;
    }
    if (!stat.isFile()) return;
    if (allowedRoot && !isWithin(allowedRoot, realPath)) {
      skip(`已跳过目录边界外文件：${safeSourceLabel(source)}`);
      return;
    }
    const extension = path.extname(realPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      skip(`不支持的文件类型：${safeSourceLabel(source)}`);
      return;
    }
    const maxFileBytes = STRUCTURED_EXTENSIONS.has(extension)
      ? HR_KNOWLEDGE_LIMITS.maxStructuredFileBytes
      : HR_KNOWLEDGE_LIMITS.maxFileBytes;
    if (stat.size <= 0 || stat.size > maxFileBytes) {
      skip(`文件大小不符合限制：${safeSourceLabel(source)}`);
      return;
    }
    if (scannedBytes + stat.size > HR_KNOWLEDGE_LIMITS.maxTotalBytes) {
      skip("已达到知识库总读取量上限");
      return;
    }
    const canonical = canonicalPath(realPath);
    if (seenRealPaths.has(canonical)) return;
    seenRealPaths.add(canonical);
    let data: Buffer;
    try {
      data = fs.readFileSync(realPath);
    } catch {
      skip(`无法读取：${safeSourceLabel(source)}`);
      return;
    }
    if (data.length > maxFileBytes || scannedBytes + data.length > HR_KNOWLEDGE_LIMITS.maxTotalBytes) {
      skip(`文件在读取时超过限制：${safeSourceLabel(source)}`);
      return;
    }
    scannedFiles += 1;
    scannedBytes += data.length;
    const sourceLabel = safeSourceLabel(source);
    let extraction: ExtractionResult;
    try {
      extraction = await cachedExtraction(canonical, extension, data);
    } catch {
      skip(`无法解析：${sourceLabel}`);
      return;
    }
    for (const extractionWarning of extraction.warnings) warn(`${extractionWarning}：${sourceLabel}`);
    const remainingChars = HR_KNOWLEDGE_LIMITS.maxTotalExtractedChars - extractedChars;
    if (remainingChars <= 0) {
      skip("已达到知识库文本抽取上限");
      return;
    }
    const limitedChunks = limitExtractedChunks(extraction.chunks, remainingChars);
    if (!limitedChunks.length) {
      skip(`文件没有可用文本：${sourceLabel}`);
      return;
    }
    const includedChars = limitedChunks.reduce((total, chunk) => total + chunk.text.length, 0);
    extractedChars += includedChars;
    if (includedChars < extraction.extractedChars) warn(`文本已按总抽取上限截断：${sourceLabel}`);
    documents.push({ source: sourceLabel, chunks: limitedChunks });
  };

  const walkDirectory = async (directory: string, rootRealPath: string, rootLabel: string, depth: number): Promise<void> => {
    if (depth > HR_KNOWLEDGE_LIMITS.maxDepth
      || scannedFiles >= HR_KNOWLEDGE_LIMITS.maxFiles
      || scannedDirectoryEntries >= HR_KNOWLEDGE_LIMITS.maxDirectoryEntries) return;
    const canonicalDirectory = canonicalPath(directory);
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    let directoryHandle: fs.Dir;
    try {
      directoryHandle = fs.opendirSync(directory);
    } catch {
      skip(`无法读取目录：${safeSourceLabel(rootLabel)}`);
      return;
    }
    try {
      while (scannedFiles < HR_KNOWLEDGE_LIMITS.maxFiles
        && scannedDirectoryEntries < HR_KNOWLEDGE_LIMITS.maxDirectoryEntries) {
        const entry = directoryHandle.readSync();
        if (!entry) break;
        scannedDirectoryEntries += 1;
        const entryPath = path.join(directory, entry.name);
        const relative = path.relative(rootRealPath, entryPath);
        const source = path.join(rootLabel, relative);
        if (entry.isSymbolicLink()) {
          skip(`已跳过符号链接：${safeSourceLabel(source)}`);
          continue;
        }
        if (entry.isDirectory()) {
          if (depth < HR_KNOWLEDGE_LIMITS.maxDepth) {
            let realDirectory: string;
            try {
              realDirectory = fs.realpathSync.native(entryPath);
            } catch {
              skip(`无法读取目录：${safeSourceLabel(source)}`);
              continue;
            }
            if (isWithin(rootRealPath, realDirectory)) {
              await walkDirectory(realDirectory, rootRealPath, rootLabel, depth + 1);
            } else {
              skip(`已跳过目录边界外目录：${safeSourceLabel(source)}`);
            }
          }
          continue;
        }
        if (entry.isFile()) await loadFile(entryPath, source, rootRealPath);
      }
      if (scannedDirectoryEntries >= HR_KNOWLEDGE_LIMITS.maxDirectoryEntries) warn("已达到知识库目录枚举上限");
    } finally {
      try {
        directoryHandle.closeSync();
      } catch {
        // The directory may already have been closed after readSync reached EOF.
      }
    }
  };

  for (const configuredRoot of roots.slice(0, HR_KNOWLEDGE_LIMITS.maxRoots)) {
    const resolvedRoot = path.resolve(configuredRoot);
    let stat: fs.Stats;
    let realRoot: string;
    try {
      const linkStat = fs.lstatSync(resolvedRoot);
      if (linkStat.isSymbolicLink()) {
        skip(`已跳过符号链接根路径：${path.basename(resolvedRoot)}`);
        continue;
      }
      stat = fs.statSync(resolvedRoot);
      realRoot = fs.realpathSync.native(resolvedRoot);
    } catch {
      skip(`知识库路径不可用：${path.basename(resolvedRoot) || "未命名路径"}`);
      continue;
    }
    if (stat.isFile()) await loadFile(realRoot, path.basename(realRoot));
    else if (stat.isDirectory()) await walkDirectory(realRoot, realRoot, path.basename(realRoot), 0);
    else skip(`知识库路径类型不受支持：${path.basename(realRoot)}`);
  }
  pruneExtractionCache(seenRealPaths);

  const queryTokens = tokenize(query).slice(0, 100);
  const candidates = documents.flatMap((document) => document.chunks.map((chunk, index) => {
    const source = chunk.locator ? `${document.source} · ${chunk.locator}` : document.source;
    return {
      document: document.source,
      ...(chunk.locator ? { locator: chunk.locator } : {}),
      source,
      text: chunk.text,
      index,
      score: scoreChunk(source, chunk.text, queryTokens)
    };
  }));
  candidates.sort((left, right) => right.score - left.score
    || left.source.localeCompare(right.source)
    || left.index - right.index);
  const selected: HrKnowledgeChunk[] = [];
  let contextChars = 0;
  for (const candidate of candidates) {
    if (selected.length >= HR_KNOWLEDGE_LIMITS.maxChunks) break;
    if (queryTokens.length && candidate.score <= 0 && selected.length >= 3) break;
    const cost = candidate.text.length + candidate.source.length + 20;
    if (contextChars + cost > HR_KNOWLEDGE_LIMITS.maxContextChars) continue;
    selected.push({
      citationId: `S${selected.length + 1}`,
      document: candidate.document,
      ...(candidate.locator ? { locator: candidate.locator } : {}),
      source: candidate.source,
      text: candidate.text,
      score: candidate.score
    });
    contextChars += cost;
  }

  return {
    chunks: selected,
    sources: [...new Set(selected.map((chunk) => chunk.source))],
    scannedFiles,
    scannedBytes,
    skippedFiles,
    warnings
  };
}

async function cachedExtraction(canonical: string, extension: string, data: Buffer): Promise<ExtractionResult> {
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  const key = `${canonical}\0${hash}`;
  const existing = extractionCache.get(key);
  if (existing) {
    extractionCache.delete(key);
    extractionCache.set(key, existing);
    return existing;
  }
  for (const cachedKey of extractionCache.keys()) {
    if (cachedKey.startsWith(`${canonical}\0`)) extractionCache.delete(cachedKey);
  }
  const pending = extractDocument(extension, data).catch((error) => {
    extractionCache.delete(key);
    throw error;
  });
  extractionCache.set(key, pending);
  while (extractionCache.size > MAX_EXTRACTION_CACHE_ENTRIES) {
    const oldest = extractionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    extractionCache.delete(oldest);
  }
  return pending;
}

function pruneExtractionCache(activePaths: Set<string>): void {
  for (const cachedKey of extractionCache.keys()) {
    const separator = cachedKey.indexOf("\0");
    if (separator < 0 || !activePaths.has(cachedKey.slice(0, separator))) extractionCache.delete(cachedKey);
  }
}

async function extractDocument(extension: string, data: Buffer): Promise<ExtractionResult> {
  if (extension === ".pdf") return extractPdf(data);
  if (extension === ".docx") return extractDocx(data);
  return extractUtf8Text(data);
}

function extractUtf8Text(data: Buffer): ExtractionResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("Knowledge document is not UTF-8 text");
  }
  if (text.includes("\0")) throw new Error("Knowledge document appears to be binary");
  return finalizeExtraction(chunkParagraphs(text.replace(/^\uFEFF/u, ""), "段落"), []);
}

async function extractPdf(data: Buffer): Promise<ExtractionResult> {
  if (data.subarray(0, 1_024).indexOf(Buffer.from("%PDF-", "ascii")) < 0) {
    throw new Error("Knowledge PDF header is invalid");
  }
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0
  });
  const warnings: string[] = [];
  const chunks: ExtractedChunk[] = [];
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  const deadline = Date.now() + HR_KNOWLEDGE_LIMITS.parseTimeoutMs;
  try {
    pdf = await withTimeout(loadingTask.promise, HR_KNOWLEDGE_LIMITS.parseTimeoutMs);
    const pageCount = Math.min(pdf.numPages, HR_KNOWLEDGE_LIMITS.maxPdfPages);
    if (pdf.numPages > pageCount) warnings.push(`PDF 仅抽取前 ${pageCount} 页`);
    let pageTextChars = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (Date.now() > deadline) throw new Error("Knowledge PDF parsing timed out");
      const page = await withTimeout(pdf.getPage(pageNumber), Math.max(1, deadline - Date.now()));
      const content = await withTimeout(page.getTextContent(), Math.max(1, deadline - Date.now()));
      const remainingChars = HR_KNOWLEDGE_LIMITS.maxExtractedCharsPerFile - pageTextChars;
      const text = pdfText(content.items).slice(0, Math.max(0, remainingChars));
      pageTextChars += text.length;
      chunks.push(...chunkSingleSection(text, `第 ${pageNumber} 页`));
      page.cleanup();
      if (pageTextChars >= HR_KNOWLEDGE_LIMITS.maxExtractedCharsPerFile) {
        warnings.push("PDF 文本已按单文件抽取上限截断");
        break;
      }
    }
  } finally {
    if (pdf) await pdf.destroy().catch(() => undefined);
    else await loadingTask.destroy().catch(() => undefined);
  }
  if (!chunks.length) warnings.push("PDF 未检测到可搜索文本，请提供可搜索 PDF 或 DOCX");
  return finalizeExtraction(chunks, warnings);
}

async function extractDocx(data: Buffer): Promise<ExtractionResult> {
  preflightDocx(data);
  const result = await withTimeout(
    mammoth.extractRawText({ buffer: data }),
    HR_KNOWLEDGE_LIMITS.parseTimeoutMs
  );
  const warnings = result.messages.length ? ["DOCX 包含未读取的复杂内容"] : [];
  return finalizeExtraction(chunkParagraphs(result.value, "段落"), warnings);
}

function finalizeExtraction(chunks: ExtractedChunk[], warnings: string[]): ExtractionResult {
  const redacted = chunks
    .map((chunk) => ({ ...chunk, text: redactLikelySecrets(chunk.text).trim() }))
    .filter((chunk) => Boolean(chunk.text));
  const limited = limitExtractedChunks(redacted, HR_KNOWLEDGE_LIMITS.maxExtractedCharsPerFile);
  const extractedChars = limited.reduce((total, chunk) => total + chunk.text.length, 0);
  const originalChars = redacted.reduce((total, chunk) => total + chunk.text.length, 0);
  return {
    chunks: limited,
    extractedChars,
    warnings: extractedChars < originalChars ? [...warnings, "文本已按单文件抽取上限截断"] : warnings
  };
}

function limitExtractedChunks(chunks: ExtractedChunk[], maxChars: number): ExtractedChunk[] {
  const selected: ExtractedChunk[] = [];
  let remaining = maxChars;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const text = chunk.text.slice(0, remaining).trim();
    if (!text) continue;
    selected.push({ ...chunk, text });
    remaining -= text.length;
  }
  return selected;
}

function chunkSingleSection(text: string, locator: string): ExtractedChunk[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: ExtractedChunk[] = [];
  for (let offset = 0; offset < normalized.length; offset += HR_KNOWLEDGE_LIMITS.maxChunkChars) {
    chunks.push({ text: normalized.slice(offset, offset + HR_KNOWLEDGE_LIMITS.maxChunkChars), locator });
  }
  return chunks;
}

function chunkParagraphs(text: string, locatorLabel: string): ExtractedChunk[] {
  const paragraphs = text.split(/\n\s*\n/u)
    .map((part, index) => ({ text: part.trim(), index: index + 1 }))
    .filter((part) => Boolean(part.text));
  const chunks: ExtractedChunk[] = [];
  let current = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (current.trim()) {
      const locator = start === end ? `${locatorLabel} ${start}` : `${locatorLabel} ${start}-${end}`;
      chunks.push({ text: current.trim(), locator });
    }
    current = "";
    start = 0;
    end = 0;
  };
  for (const paragraph of paragraphs) {
    if (paragraph.text.length > HR_KNOWLEDGE_LIMITS.maxChunkChars) {
      flush();
      chunks.push(...chunkSingleSection(paragraph.text, `${locatorLabel} ${paragraph.index}`));
      continue;
    }
    const combined = current ? `${current}\n\n${paragraph.text}` : paragraph.text;
    if (combined.length > HR_KNOWLEDGE_LIMITS.maxChunkChars) flush();
    if (!current) start = paragraph.index;
    current = current ? `${current}\n\n${paragraph.text}` : paragraph.text;
    end = paragraph.index;
  }
  flush();
  return chunks;
}

function pdfText(items: Array<unknown>): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const record = item as { str?: unknown; hasEOL?: unknown };
    const text = typeof record.str === "string" ? record.str.trim() : "";
    if (text) {
      if (line && needsWordSpace(line, text)) line += " ";
      line += text;
    }
    if (record.hasEOL === true && line.trim()) {
      lines.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

function needsWordSpace(left: string, right: string): boolean {
  const leftCharacter = left.at(-1) ?? "";
  const rightCharacter = right.at(0) ?? "";
  if (/\p{Script=Han}/u.test(leftCharacter) || /\p{Script=Han}/u.test(rightCharacter)) return false;
  return /[\p{L}\p{N})\]]/u.test(leftCharacter) && /[\p{L}\p{N}([\]]/u.test(rightCharacter);
}

function preflightDocx(data: Buffer): void {
  const endOffset = findZipEndOfCentralDirectory(data);
  if (endOffset < 0) throw new Error("DOCX ZIP directory is missing");
  const entryCount = data.readUInt16LE(endOffset + 10);
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 DOCX files are not supported");
  }
  if (entryCount <= 0 || entryCount > HR_KNOWLEDGE_LIMITS.maxDocxEntries
    || centralOffset + centralSize > endOffset) {
    throw new Error("DOCX ZIP directory exceeds limits");
  }
  let offset = centralOffset;
  let uncompressedBytes = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("DOCX ZIP directory is invalid");
    }
    const flags = data.readUInt16LE(offset + 8);
    if (flags & 0x1) throw new Error("Encrypted DOCX files are not supported");
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.length || uncompressedSize === 0xffffffff) throw new Error("DOCX ZIP entry is invalid");
    const name = data.subarray(nameStart, nameEnd).toString(flags & 0x800 ? "utf8" : "latin1").replace(/\\/gu, "/");
    if (name.startsWith("/") || /^[a-z]:/iu.test(name) || name.split("/").includes("..")) {
      throw new Error("DOCX ZIP entry leaves the archive boundary");
    }
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > HR_KNOWLEDGE_LIMITS.maxDocxUncompressedBytes) {
      throw new Error("DOCX uncompressed content exceeds limits");
    }
    hasContentTypes ||= name === "[Content_Types].xml";
    hasDocument ||= name === "word/document.xml";
    offset = nameEnd + extraLength + commentLength;
  }
  if (!hasContentTypes || !hasDocument || offset > centralOffset + centralSize) {
    throw new Error("DOCX package is incomplete");
  }
}

function findZipEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function scoreChunk(source: string, text: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const haystack = `${source}\n${text}`.toLocaleLowerCase("zh-CN");
  let score = 0;
  for (const token of tokens) {
    let offset = 0;
    let occurrences = 0;
    while (occurrences < 5) {
      const found = haystack.indexOf(token, offset);
      if (found < 0) break;
      occurrences += 1;
      offset = found + token.length;
    }
    score += occurrences * Math.min(8, token.length);
  }
  return score;
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase("zh-CN");
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._+-]{1,}/gu)) tokens.add(match[0]);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const text = match[0];
    if (text.length <= 3) tokens.add(text);
    for (let index = 0; index < text.length - 1; index += 1) tokens.add(text.slice(index, index + 2));
  }
  return [...tokens].filter((token) => token.length >= 2);
}

function redactLikelySecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, "[已移除私钥]")
    .replace(/((?:^|\n)\s*["']?(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|密码|密钥)["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/giu, "$1[已移除敏感值]")
    .replace(/\bBearer\s+[a-z0-9._~+/-]{8,}={0,2}/giu, "Bearer [已移除敏感值]")
    .replace(/\bsk-[a-z0-9_-]{8,}/giu, "[已移除敏感值]");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function safeSourceLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .split(/[\\/]+/u)
    .filter(Boolean)
    .slice(-3)
    .join("/")
    .slice(0, 300) || "未命名资料";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Knowledge document parsing timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
