/**
 * pi-glm-ocr — Local GLM-OCR Extension for Pi Coding Agent
 *
 * Registers a `glm_ocr` tool that the LLM can call to read images and PDFs
 * using the locally running GLM-OCR model via Ollama (0.9B).
 *
 * Supported tasks:
 *   - text    → Markdown text recognition
 *   - formula → LaTeX math formula recognition
 *   - table   → Markdown table recognition
 *   - figure  → Figure description
 *   - auto    → Full document OCR (auto-detects content)
 *
 * Prerequisites:
 *   1. Install Ollama: https://ollama.com/download
 *   2. Pull the model:  ollama pull glm-ocr
 *   3. For PDF support on macOS: built-in sips
 *      For Linux: apt install poppler-utils (pdftoppm)
 *
 * Install:
 *   pi install npm:pi-glm-ocr
 *   # or locally:
 *   pi -e ./extensions/index.ts
 *
 * Configuration (optional, in settings.json):
 *   { "glmOcr": { "ollamaHost": "http://localhost:11434", "model": "glm-ocr" } }
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

const TASKS = ["text", "formula", "table", "figure", "auto"] as const;
type Task = (typeof TASKS)[number];

interface GlmOcrConfig {
	ollamaHost: string;
	model: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Detect if a file is a PDF by extension or magic bytes */
function isPdf(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return true;
	// Check magic bytes
	try {
		const buf = readFileSync(filePath).subarray(0, 4);
		return buf.toString() === "%PDF";
	} catch {
		return false;
	}
}

/** Detect if a file is an image by extension */
function isImage(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"].includes(ext);
}

// Note: execCmd is unused; kept for reference. Use execCmdCapture for all cases.

/** Execute a command and capture stdout */
function execCmdCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
			else reject(new Error(`${cmd} exited with code ${code}: ${Buffer.concat(chunks).toString("utf8")}`));
		});
	});
}

function cleanupDir(dir: string) {
	try {
		for (const f of readdirSync(dir)) {
			unlinkSync(join(dir, f));
		}
		rmdirSync(dir);
	} catch {
		// best effort
	}
}

/** Build the prompt string for GLM-OCR task */
function buildPrompt(task: Task): string {
	switch (task) {
		case "text":
			return "Text Recognition";
		case "formula":
			return "Formula Recognition";
		case "table":
			return "Table Recognition";
		case "figure":
			return "Figure Recognition";
		case "auto":
			return "Recognize all text, formulas, tables, and figures in this document. Output formulas in LaTeX format, tables in Markdown format.";
	}
}

// ── Tool Definition ──────────────────────────────────────────────────────────

const glmOcrSchema = Type.Object({
	path: Type.String({
		description:
			"Absolute or relative path to the image or PDF file to OCR. Supported formats: PNG, JPG, GIF, WEBP, BMP, TIFF, PDF.",
	}),
	task: Type.Optional(
		Type.String({
			description:
				'OCR task type. "text" for Markdown text, "formula" for LaTeX math, "table" for Markdown tables, "figure" for description, "auto" for full document OCR (default).',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Ollama model to use for OCR. Defaults to 'glm-ocr'. You can use any Ollama vision model, e.g. 'glm-ocr:q8_0' for the 8-bit quantized version, 'llama3.2-vision', 'minicpm-v', etc.",
		}),
	),
});

const glmOcrTool = defineTool({
	name: "glm_ocr",
	label: "GLM OCR",
	description:
		"Extract text, math formulas (LaTeX), and tables from images or PDFs using local GLM-OCR via Ollama. " +
		"Use this when you need to read text from an image or PDF, especially mathematical formulas that need LaTeX output. " +
		"This is the tool to use when working with non-vision LLMs like DeepSeek that cannot process images directly.",
	promptSnippet:
		"Extract text/formulas/tables from images and PDFs using local GLM-OCR (Ollama)",
	promptGuidelines: [
		"When the user asks about the content of an image or PDF, use glm_ocr to extract the text first.",
		"For mathematical documents, use glm_ocr with task='formula' or task='auto' to get LaTeX output.",
		"Use glm_ocr with task='auto' for general document OCR to extract all text, formulas, tables, and figures.",
	],
	parameters: glmOcrSchema,
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const { path: filePath, task = "auto", model: modelOverride } = params as {
			path: string;
			task?: string;
			model?: string;
		};
		const resolvedTask = (TASKS.includes(task as Task) ? task : "auto") as Task;

		// Resolve config (modelOverride takes priority over env/config)
		const config = getConfig(ctx);
		const resolvedModel = modelOverride || config.model;

		// Validate file
		if (!existsSync(filePath)) {
			return {
				content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
				details: { error: "file_not_found", path: filePath },
				isError: true,
			};
		}

		if (!isImage(filePath) && !isPdf(filePath)) {
			const ext = extname(filePath).toLowerCase();
			return {
				content: [
					{
						type: "text",
						text: `Error: Unsupported file type "${ext}". Supported: PNG, JPG, GIF, WEBP, BMP, TIFF, PDF.`,
					},
				],
				details: { error: "unsupported_format", ext, path: filePath },
				isError: true,
			};
		}

		// Progress update
		onUpdate?.({
			content: [{ type: "text", text: `🔍 Reading ${basename(filePath)} with ${resolvedModel} (${resolvedTask})…` }],
			details: {},
		});

		let resultText = "";
		let tmpDir: string | null = null;

		try {
			if (isPdf(filePath)) {
				// ── PDF: convert to images first ──────────────────────────
				onUpdate?.({
					content: [{ type: "text", text: `📄 Converting PDF pages to images…` }],
					details: {},
				});

				tmpDir = mkdtempSync(join(tmpdir(), "pi-glm-ocr-"));

				// Count pages and convert
				const pageCount = await getPdfPageCount(filePath);
				const pageResults: string[] = [];

				for (let i = 0; i < pageCount; i++) {
					if (signal?.aborted) throw new Error("Aborted");

					const pageOut = join(tmpDir, `page_${i + 1}.png`);
					await convertPdfPage(filePath, i, pageOut);

					onUpdate?.({
						content: [
							{ type: "text", text: `🔍 OCR page ${i + 1}/${pageCount}…` },
						],
						details: {},
					});

					const pageText = await callGlmOcr(config, pageOut, resolvedTask, signal, resolvedModel);
					pageResults.push(`## Page ${i + 1}\n\n${pageText}`);
				}

				resultText = pageResults.join("\n\n");
			} else {
				// ── Image: process directly ───────────────────────────────
				resultText = await callGlmOcr(config, filePath, resolvedTask, signal, resolvedModel);
			}

			// Build summary
			const preview = resultText.length > 5000 ? resultText.slice(0, 5000) + "\n\n… (truncated)" : resultText;

			return {
				content: [
					{
						type: "text",
						text: `## GLM-OCR Result (${resolvedTask})\n\n**File:** \`${basename(filePath)}\`\n\n${preview}`,
					},
				],
				details: {
					task: resolvedTask,
					path: filePath,
					fullText: resultText,
					truncated: resultText.length > 5000,
					model: resolvedModel,
				},
			};
		} catch (e: any) {
			return {
				content: [
					{ type: "text", text: `Error during OCR: ${e.message || String(e)}` },
				],
				details: { error: "ocr_failed", message: e.message, path: filePath },
				isError: true,
			};
		} finally {
			if (tmpDir) cleanupDir(tmpDir);
		}
	},
});

// ── Config ───────────────────────────────────────────────────────────────────

let cachedConfig: GlmOcrConfig | null = null;

function getConfig(_ctx?: ExtensionContext): GlmOcrConfig {
	if (cachedConfig) return cachedConfig;

	// Try to read from pi settings or environment variables
	const envHost = process.env.OLLAMA_HOST || "http://localhost:11434";
	const envModel = process.env.GLM_OCR_MODEL || "glm-ocr";

	cachedConfig = {
		ollamaHost: envHost,
		model: envModel,
	};
	return cachedConfig;
}

// ── Ollama API ──────────────────────────────────────────────────────────────

async function callGlmOcr(
	config: GlmOcrConfig,
	imagePath: string,
	task: Task,
	signal?: AbortSignal,
	modelOverride?: string,
): Promise<string> {
	const imageBase64 = readFileSync(imagePath).toString("base64");
	const prompt = buildPrompt(task);
	const model = modelOverride || config.model;

	const body = JSON.stringify({
		model,
		prompt,
		images: [imageBase64],
		stream: false,
	});

	const response = await fetch(`${config.ollamaHost}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`Ollama API error ${response.status}: ${text.slice(0, 200)}. Is Ollama running and is the ${model} model pulled?`,
		);
	}

	const data = (await response.json()) as { response?: string; error?: string };

	if (data.error) {
		throw new Error(`GLM-OCR error: ${data.error}`);
	}

	return data.response?.trim() || "";
}

// ── PDF Helpers ─────────────────────────────────────────────────────────────

async function getPdfPageCount(pdfPath: string): Promise<number> {
	if (process.platform === "darwin") {
		try {
			const out = await execCmdCapture("mdls", ["-name", "kMDItemNumberOfPages", "-raw", pdfPath]);
			const n = parseInt(out.trim(), 10);
			if (!isNaN(n) && n > 0) return n;
		} catch { /* fall through */ }
	}

	// Generic fallback using python with PyPDF2 or pdfplumber
	try {
		const py = await execCmdCapture("python3", [
			"-c",
			`import sys
try:
    from PyPDF2 import PdfReader
    r = PdfReader("${pdfPath.replace(/"/g, '\\"')}")
    print(len(r.pages))
except ImportError:
    try:
        import pdfplumber
        with pdfplumber.open("${pdfPath.replace(/"/g, '\\"')}") as pdf:
            print(len(pdf.pages))
    except ImportError:
        print(1)`,
		]);
		return parseInt(py.trim(), 10) || 1;
	} catch {
		return 1;
	}
}

async function convertPdfPage(pdfPath: string, pageIndex: number, outPath: string): Promise<void> {
	if (process.platform === "darwin") {
		// Use python3 + Quartz (CoreGraphics) for macOS
		const script = `
import sys
from Quartz import (
    CGPDFDocumentCreateWithURL,
    CGPDFPageGetBoxRect,
    kCGPDFMediaBox,
    CGColorSpaceCreateDeviceRGB,
    CGBitmapContextCreate,
    CGBitmapContextCreateImage,
    CGContextDrawPDFPage,
    CGImageDestinationCreateWithURL,
    CGImageDestinationAddImage,
    CGImageDestinationFinalize,
)
from Foundation import NSURL

pdf_url = NSURL.fileURLWithPath_("${pdfPath.replace(/"/g, '\\"')}")
doc = CGPDFDocumentCreateWithURL(pdf_url)
if not doc:
    sys.exit(1)

page = doc.getPage(${pageIndex + 1})
if not page:
    sys.exit(1)

rect = CGPDFPageGetBoxRect(page, kCGPDFMediaBox)
scale = 2.5
width = int(rect.size.width * scale)
height = int(rect.size.height * scale)

cs = CGColorSpaceCreateDeviceRGB()
ctx = CGBitmapContextCreate(
    None, width, height, 8, width * 4,
    cs, 0x2002  # kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little
)
ctx.scaleCTM(scale, scale)
CGContextDrawPDFPage(ctx, page)

cg_img = CGBitmapContextCreateImage(ctx)

out_url = NSURL.fileURLWithPath_("${outPath.replace(/"/g, '\\"')}")
dest = CGImageDestinationCreateWithURL(out_url, "public.png", 1, None)
if dest:
    CGImageDestinationAddImage(dest, cg_img, None)
    CGImageDestinationFinalize(dest)
`;
		await execCmdCapture("python3", ["-c", script]);
	} else {
		// Linux: pdftoppm - single page
		await execCmdCapture("pdftoppm", [
			"-png",
			"-r",
			"200",
			"-f",
			String(pageIndex + 1),
			"-l",
			String(pageIndex + 1),
			"-singlefile",
			pdfPath,
			outPath.replace(/\.png$/, ""),
		]);
	}
}

// ── Extension Entry ─────────────────────────────────────────────────────────

export default function glmOcrExtension(pi: ExtensionAPI) {
	// Register the glm_ocr tool
	pi.registerTool(glmOcrTool);

	// Register /glm-ocr command for user convenience
	pi.registerCommand("glm-ocr", {
		description: "OCR an image or PDF file using local GLM-OCR",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /glm-ocr <file-path> [task] [model]", "info");
				ctx.ui.notify("Tasks: text, formula, table, figure, auto (default)", "info");
				ctx.ui.notify("Model: any Ollama vision model (default: glm-ocr)", "info");
				return;
			}

			const parts = trimmed.split(/\s+/);
			const filePath = parts[0];
			const task = parts[1] || "auto";
			const model = parts[2] || undefined;

			if (!existsSync(filePath)) {
				ctx.ui.notify(`File not found: ${filePath}`, "error");
				return;
			}

			// Call the tool directly
			const result = await glmOcrTool.execute("", { path: filePath, task, model }, undefined as any, undefined, ctx);

			if (result.isError) {
				const msg =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "Unknown error";
				ctx.ui.notify(msg.slice(0, 200), "error");
			} else {
				const text =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "";
				ctx.ui.notify(`OCR complete (${(result.details as any)?.fullText?.length || text.length} chars)`, "success");
			}
		},
	});

	// Notify on startup
	pi.on("session_start", async (_event, ctx) => {
		const config = getConfig(ctx);
		ctx.ui.setStatus(
			"glm-ocr",
			`GLM-OCR: ${config.model} @ ${config.ollamaHost}`,
		);
	});

	// Log registration
	console.log("[pi-glm-ocr] Extension loaded. Tool: glm_ocr, Command: /glm-ocr");
}
