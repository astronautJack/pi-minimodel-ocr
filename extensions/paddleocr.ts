/**
 * pi-minimodel-ocr — PaddleOCR backend
 *
 * Uses the PaddleOCR Python library (https://github.com/PaddlePaddle/PaddleOCR)
 * to perform OCR on images and PDFs locally. PDF pages are automatically
 * converted to images via Python (pypdfium2), no external tools needed.
 *
 * Prerequisites:
 *   pip install paddleocr paddlepaddle pypdfium2
 *   (or paddlepaddle-gpu for CUDA)
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Task, OcrResult, OcrProgressCallback } from "./types";
import { isImage, isPdf } from "./ollama";

// ── Embedded Python OCR engine ───────────────────────────────────────────────
//
// This single Python script handles:
//   1. PDF → PNG conversion via pypdfium2 (pure Python, no system deps)
//   2. Image OCR via PaddleOCR
//
// Usage: python3 -c SCRIPT <file_path> <task> <output_dir>
//   For PDFs: writes page_N.txt per page to output_dir, prints page count on stdout
//   For images: prints OCR result to stdout

const PADDLEOCR_ENGINE = `
import sys, json, os
from pathlib import Path

file_path = sys.argv[1]
task = sys.argv[2]       # text, formula, table, figure, auto
output_dir = sys.argv[3] # only used for PDF mode
ext = Path(file_path).suffix.lower()

# ── Initialize PaddleOCR (once) ──
ocr = None

def get_ocr():
    global ocr
    if ocr is None:
        from paddleocr import PaddleOCR
        try:
            ocr = PaddleOCR(lang='en', use_textline_orientation=True)
        except TypeError:
            try:
                ocr = PaddleOCR(lang='en', use_angle_cls=True)
            except TypeError:
                ocr = PaddleOCR(use_angle_cls=True, lang='en')
    return ocr

# ── OCR a single image, return text ──
def ocr_image(img_path):
    engine = get_ocr()
    result = engine.ocr(img_path)
    if not result or not result[0]:
        return ""
    lines = []
    for line_info in result[0]:
        if line_info and len(line_info) >= 2:
            text = line_info[1][0]
            lines.append(text)
    output = "\\n".join(lines)
    if task == "formula":
        output = "\`\`\`math\\n" + output + "\\n\`\`\`"
    return output

# ── Main ──
if ext == ".pdf":
    # PDF mode: convert pages to images via pypdfium2, then OCR each page
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(file_path)
    n_pages = len(pdf)

    for i in range(n_pages):
        page = pdf[i]
        # Render at 200 DPI for good OCR quality
        bitmap = page.render(scale=200/72)
        pil_image = bitmap.to_pil()
        png_path = os.path.join(output_dir, f"page_{i+1}.png")
        pil_image.save(png_path, "PNG")

        try:
            text = ocr_image(png_path)
        except Exception as e:
            text = f"[OCR error on page {i+1}: {e}]"

        txt_path = os.path.join(output_dir, f"page_{i+1}.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text)

    # Signal completion: print page count
    print(json.dumps({"pages": n_pages}))

elif ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"):
    # Image mode: OCR directly and print to stdout
    text = ocr_image(file_path)
    print(text)

else:
    print(f"ERROR: unsupported file type {ext}")
    sys.exit(1)
`;

// ── Subprocess runner ────────────────────────────────────────────────────────

async function execPython(code: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", code, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", () => resolve({
      stdout: "",
      stderr: "python3 not found. Install Python 3 with:\n  pip install paddleocr paddlepaddle pypdfium2",
      exitCode: 1,
    }));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        exitCode: code ?? 1,
      });
    });
  });
}

function cleanupDir(dir: string) {
  try {
    const { readdirSync, unlinkSync, rmdirSync } = require("node:fs");
    for (const f of readdirSync(dir)) unlinkSync(require("node:path").join(dir, f));
    rmdirSync(dir);
  } catch { /* best effort */ }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function paddleOcr(
  filePath: string, task: Task,
  signal: AbortSignal | undefined, onProgress: OcrProgressCallback,
): Promise<OcrResult> {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  let tmpDir: string | null = null;

  try {
    if (isPdf(filePath)) {
      // ── PDF mode: Python handles both conversion and OCR ──
      onProgress("📄 Converting PDF pages & running PaddleOCR…");
      tmpDir = mkdtempSync(join(tmpdir(), "pi-paddleocr-"));

      const { stdout, stderr, exitCode } = await execPython(PADDLEOCR_ENGINE, [filePath, task, tmpDir]);

      if (exitCode !== 0) {
        throw new Error(stderr || `PaddleOCR failed with exit code ${exitCode}`);
      }

      // Parse page count from stdout
      let pageCount = 1;
      try {
        const parsed = JSON.parse(stdout);
        pageCount = parsed.pages || 1;
      } catch {
        // stdout might be empty or contain warnings
      }

      // PaddleOCR stderr is typically model loading logs, not errors.
      // Only treat as error if it contains actual error keywords.
      if (stderr && (stderr.includes("Error:") || stderr.includes("Traceback") || stderr.includes("ModuleNotFoundError"))) {
        throw new Error(stderr.slice(0, 1000));
      }

      // Read per-page results
      const pageResults: string[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const txtPath = join(tmpDir, `page_${i}.txt`);
        let pageText = "";
        try {
          pageText = readFileSync(txtPath, "utf8").trim();
        } catch {
          pageText = `> ⚠️ No output for page ${i}`;
        }
        if (!pageText) {
          pageText = `> ⚠️ PaddleOCR returned empty result for page ${i}`;
        }
        pageResults.push(`## Page ${i}\n\n${pageText}`);
      }

      const fullText = pageResults.join("\n\n");
      return { text: fullText, details: { backend: "paddleocr", task, pages: pageCount } };
    }

    // ── Image mode ──
    if (!isImage(filePath)) {
      throw new Error(`Unsupported file type: ${basename(filePath)}`);
    }

    onProgress("🔍 Running PaddleOCR on image…");
    const { stdout, stderr, exitCode } = await execPython(PADDLEOCR_ENGINE, [filePath, task, "/tmp"]);

    if (exitCode !== 0) {
      throw new Error(stderr || `PaddleOCR failed with exit code ${exitCode}`);
    }

    if (stderr && (stderr.includes("Error:") || stderr.includes("Traceback") || stderr.includes("ModuleNotFoundError"))) {
      throw new Error(stderr.slice(0, 1000));
    }

    return { text: stdout, details: { backend: "paddleocr", task } };

  } finally {
    if (tmpDir) cleanupDir(tmpDir);
  }
}
