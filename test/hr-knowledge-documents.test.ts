import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  readConfiguredKnowledgeRoots,
  retrieveHrKnowledge
} from "../src/server/hr-knowledge.js";

test("extracts searchable PDF pages and returns bounded citation metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-pdf-kb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "candidate-resume.pdf");
  fs.writeFileSync(pdfPath, minimalPdf("TypeScript payment idempotency project"));

  const result = await retrieveHrKnowledge([pdfPath], "TypeScript idempotency");

  assert.equal(result.scannedFiles, 1);
  assert.match(result.chunks[0]?.text ?? "", /TypeScript payment idempotency/);
  assert.equal(result.chunks[0]?.citationId, "S1");
  assert.equal(result.chunks[0]?.document, "candidate-resume.pdf");
  assert.equal(result.chunks[0]?.locator, "第 1 页");
  assert.match(result.chunks[0]?.source ?? "", /第 1 页/);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("extracts DOCX paragraphs, redacts secrets and invalidates the hash cache after updates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-docx-kb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const docxPath = path.join(root, "project-notes.docx");
  await writeDocx(docxPath, ["Backend platform", "api_key=must-not-leak", "Kafka migration reduced latency"]);

  const first = await retrieveHrKnowledge([docxPath], "Kafka latency");

  assert.equal(first.scannedFiles, 1);
  assert.match(first.chunks[0]?.text ?? "", /Kafka migration/);
  assert.match(first.chunks[0]?.source ?? "", /段落/);
  assert.equal(JSON.stringify(first).includes("must-not-leak"), false);
  assert.match(JSON.stringify(first), /已移除敏感值/);

  await writeDocx(docxPath, ["Backend platform", "Pulsar migration reduced queue time"]);
  const updated = await retrieveHrKnowledge([docxPath], "Pulsar queue");

  assert.match(updated.chunks[0]?.text ?? "", /Pulsar migration/);
  assert.equal(JSON.stringify(updated).includes("Kafka migration"), false);
});

test("automatically adds the current immutable resume to configured knowledge roots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-resume-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resumePath = path.join(root, "managed-resume.pdf");
  const notesPath = path.join(root, "notes.docx");
  const statePath = path.join(root, "hr.json");
  fs.writeFileSync(resumePath, minimalPdf("candidate profile"));
  fs.writeFileSync(statePath, JSON.stringify({
    materials: {
      currentResumeId: "resume-current",
      resumeVersions: [{ id: "resume-current", path: resumePath }],
      knowledgeBaseDocuments: [{ path: notesPath }]
    }
  }));

  assert.deepEqual(readConfiguredKnowledgeRoots(statePath), [resumePath, notesPath]);
});

async function writeDocx(filePath: string, paragraphs: string[]): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    "</Types>"
  ].join(""));
  zip.folder("_rels")!.file(".rels", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    "</Relationships>"
  ].join(""));
  const body = paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("");
  zip.folder("word")!.file("document.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${body}<w:sectPr/></w:body>`,
    "</w:document>"
  ].join(""));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/gu, "\\$1");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}
