/**
 * pi-minimodel-ocr — MinerU API backend
 *
 * Uses the free Agent Lightweight API (no token required):
 *   - File ≤10MB, ≤20 pages → one free request
 *   - File ≤10MB, >20 pages → auto-splits into ≤20-page chunks (if mineruSplitPdf enabled)
 *   - File >10MB → warns and suggests compression at ilovepdf.com
 *
 * API flow (file mode) — each chunk is a SEPARATE request (not batch):
 *   1. POST /api/v1/agent/parse/file → task_id + signed OSS upload URL
 *   2. PUT file bytes to signed URL
 *   3. Poll GET /api/v1/agent/parse/{task_id} until state=done
 *   4. GET markdown_url → download final Markdown
 *
 * PDF splitting uses pypdfium2 (same dep as PaddleOCR backend).
 */

import { readFileSync, mkdtempSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Task, OcrResult, OcrProgressCallback } from "./types";

const BASE_URL = "https://mineru.net/api/v1/agent";

// ── Python PDF splitter (uses pypdfium2) ─────────────────────────────────────

const PDF_SPLIT_SCRIPT = `
import sys, json, os
import pypdfium2 as pdfium

input_path = sys.argv[1]
chunk_size = int(sys.argv[2])
output_dir = sys.argv[3]

src = pdfium.PdfDocument(input_path)
total = len(src)

results = []
for start in range(0, total, chunk_size):
    end = min(start + chunk_size, total)

    # Create a new PDF with pages [start, end)
    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, list(range(start, end)))
    out_path = os.path.join(output_dir, f"chunk_{start // chunk_size + 1}.pdf")
    dst.save(out_path)
    dst.close()

    results.append({"path": out_path, "firstPage": start + 1, "lastPage": end})

src.close()
print(json.dumps({"total": total, "chunks": results}))
`;

async function execPy(code: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", code, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", () => reject(new Error(
      "python3 not found. Install Python 3 and pypdfium2:\n  pip install pypdfium2"
    )));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `python3 exited with code ${code}`));
    });
  });
}

function rmdirSafe(dir: string) {
  try {
    for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
    rmdirSync(dir);
  } catch { /* best effort */ }
}

// ── MinerU API helpers ───────────────────────────────────────────────────────

async function apiPost(url: string, body: Record<string, unknown>): Promise<{ task_id: string; file_url?: string }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (resp.status === 429) throw new Error("MinerU rate limit (429). Wait a minute and retry, or switch backend with /ocr.");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`MinerU API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { code: number; msg: string; data: { task_id: string; file_url?: string } };
  if (data.code !== 0 || !data.data?.task_id) {
    throw new Error(`MinerU API error: ${data.msg || "no task_id returned"}`);
  }

  return { task_id: data.data.task_id, file_url: data.data.file_url };
}

async function putFile(uploadUrl: string, filePath: string): Promise<void> {
  const fileData = readFileSync(filePath);
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    body: fileData,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`File upload failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

async function pollTask(taskId: string, timeoutMs: number, onProgress: OcrProgressCallback): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`${BASE_URL}/parse/${taskId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await resp.json()) as {
      code: number;
      data: { state: string; markdown_url?: string; err_msg?: string; err_code?: number };
    };

    const state = data.data?.state || "unknown";

    if (state === "done") {
      const markdownUrl = data.data.markdown_url;
      if (!markdownUrl) throw new Error("MinerU returned done state but no markdown_url");
      const mdResp = await fetch(markdownUrl, { signal: AbortSignal.timeout(60_000) });
      if (!mdResp.ok) throw new Error(`Failed to download markdown: ${mdResp.status}`);
      return mdResp.text();
    }

    if (state === "failed") {
      throw new Error(`MinerU parsing failed: ${data.data.err_msg || "unknown error"} (code: ${data.data.err_code})`);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    onProgress(`⏳ MinerU: ${state} (${elapsed}s)…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`MinerU task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

// ── Single-file processing (one individual request, NOT batch) ───────────────

async function mineruProcessFile(
  filePath: string, fileName: string, pageLabel: string,
  onProgress: OcrProgressCallback,
): Promise<string> {
  const stats = await stat(filePath);
  const sizeMB = stats.size / (1024 * 1024);
  if (sizeMB > 10) {
    throw new Error(
      `File too large for free MinerU API: ${sizeMB.toFixed(1)}MB (limit: 10MB).\n` +
      `Compress at https://ilovepdf.com/compress_pdf or switch to Ollama/PaddleOCR backend with /ocr.`
    );
  }

  // Step 1: Get signed upload URL
  onProgress(`📤 MinerU: requesting upload URL for ${fileName}…`);
  const { task_id, file_url } = await apiPost(`${BASE_URL}/parse/file`, {
    file_name: fileName,
    language: "en",
    enable_table: true,
    enable_formula: true,
    is_ocr: false,
  });

  if (!file_url) {
    throw new Error("MinerU did not return a file upload URL — this endpoint may have changed.");
  }

  // Step 2: Upload file bytes
  onProgress(`📤 MinerU: uploading ${fileName} (${sizeMB.toFixed(1)}MB)…`);
  await putFile(file_url, filePath);

  // Step 3 + 4: Poll for result and download markdown
  onProgress(`⏳ MinerU: waiting for ${pageLabel}…`);
  const markdown = await pollTask(task_id, 300_000, (msg) => onProgress(`  ${msg}`));
  onProgress(`✅ MinerU: ${pageLabel} complete`);
  return markdown;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function mineruOcr(
  filePath: string, task: Task, splitPdf: boolean,
  signal: AbortSignal | undefined, onProgress: OcrProgressCallback,
): Promise<OcrResult> {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath);

  // For images (non-PDF): process as a single individual request
  if (ext !== ".pdf") {
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"].includes(ext)) {
      throw new Error(`MinerU does not support this file type: ${ext}. Use PDF, PNG, JPG, Docx, PPTx, or Xlsx.`);
    }
    onProgress(`📤 MinerU: submitting ${fileName} (image)…`);
    const markdown = await mineruProcessFile(filePath, fileName, "1 page", onProgress);
    return { text: markdown, details: { backend: "mineru", fileName, pages: 1 } };
  }

  // ── PDF handling ──
  const { getPdfPageCount } = await import("./ollama");
  const pageCount = await getPdfPageCount(filePath);

  const totalStats = await stat(filePath);
  const totalMB = totalStats.size / (1024 * 1024);

  if (totalMB > 10) {
    onProgress(
      `⚠️ PDF is ${totalMB.toFixed(1)}MB — MinerU free tier limit is 10MB.\n` +
      `💡 Compress at https://ilovepdf.com/compress_pdf first, or switch to a local backend with /ocr.`
    );
  }

  // Single chunk case: one individual request
  if (pageCount <= 20) {
    const markdown = await mineruProcessFile(filePath, fileName, `${pageCount} page(s)`, onProgress);
    return { text: markdown, details: { backend: "mineru", fileName, pages: pageCount } };
  }

  // ── Multi-chunk: split PDF and process each chunk as SEPARATE requests ──
  if (!splitPdf) {
    onProgress(
      `⚠️ PDF has ${pageCount} pages but PDF splitting is disabled.\n` +
      `MinerU free tier only accepts ≤20 pages. Enable splitting with /ocr settings.`
    );
    try {
      const markdown = await mineruProcessFile(filePath, fileName, `${pageCount} pages`, onProgress);
      return { text: markdown, details: { backend: "mineru", fileName, pages: pageCount } };
    } catch (e: any) {
      throw new Error(
        `${e.message}\n\n💡 Enable PDF splitting in /ocr settings → "MinerU: Split PDF >20 pages: ON"`
      );
    }
  }

  onProgress(`📦 PDF has ${pageCount} pages — splitting into ≤20-page chunks…`);

  const splitDir = mkdtempSync(join(tmpdir(), "pi-mineru-split-"));
  try {
    onProgress(`🔪 Splitting PDF with pypdfium2…`);
    const raw = await execPy(PDF_SPLIT_SCRIPT, [filePath, "20", splitDir]);
    const { chunks } = JSON.parse(raw) as {
      total: number;
      chunks: Array<{ path: string; firstPage: number; lastPage: number }>;
    };

    onProgress(`📦 Split into ${chunks.length} chunk(s). Each will be a SEPARATE MinerU request:`);

    const results: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error("Aborted");
      const chunk = chunks[i];

      onProgress(`\n── Request ${i + 1}/${chunks.length} (pages ${chunk.firstPage}-${chunk.lastPage}) ──`);

      // Respect MinerU IP rate limiting (per-minute submission limit).
      // Each chunk's processing (upload+poll+download) naturally takes 30-60s,
      // so 3s spacing is sufficient. MinerU's own examples use 3s polling.
      if (i > 0) {
        onProgress("  ⏸️  Waiting 3s for rate limit…");
        await new Promise((r) => setTimeout(r, 3_000));
      }

      const chunkName = `${fileName.replace(/\.pdf$/i, "")}_p${chunk.firstPage}-${chunk.lastPage}.pdf`;
      // Each chunk is submitted as its own individual POST/upload/poll cycle
      const markdown = await mineruProcessFile(
        chunk.path, chunkName,
        `pages ${chunk.firstPage}-${chunk.lastPage}`,
        onProgress,
      );
      results.push(`## Pages ${chunk.firstPage}-${chunk.lastPage}\n\n${markdown}`);
    }

    return {
      text: results.join("\n\n"),
      details: { backend: "mineru", fileName, pages: pageCount, chunks: chunks.length },
    };
  } finally {
    rmdirSafe(splitDir);
  }
}
