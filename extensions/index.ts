/**
 * pi-minimodel-ocr — Local OCR via Ollama for Pi Coding Agent
 *
 * Registers a `minimodel_ocr` tool that the LLM can call to read images and PDFs
 * using any locally running Ollama vision model (default: glm-ocr 0.9B).
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
 *   2. Pull a model:  ollama pull glm-ocr
 *   3. For multi-page PDF on macOS: brew install poppler
 *      For Linux: apt install poppler-utils
 *
 * Install:
 *   pi install npm:pi-minimodel-ocr
 *   # or locally:
 *   pi -e ./extensions/index.ts
 *
 * Configuration (optional, in settings.json):
 *   { "minimodelOcr": { "ollamaHost": "http://localhost:11434", "model": "glm-ocr" } }
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

interface OcrConfig {
	ollamaHost: string;
	model: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Detect if a file is a PDF by extension or magic bytes */
function isPdf(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return true;
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

/** Execute a command and capture stdout. Stderr is captured in the error message. */
function execCmdCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (d) => outChunks.push(d));
		child.stderr.on("data", (d) => errChunks.push(d));
		child.on("error", (e) => {
			reject(new Error(`${cmd}: ${(e as any).code === "ENOENT" ? "command not found" : e.message}`));
		});
		child.on("close", (code) => {
			const stderr = Buffer.concat(errChunks).toString("utf8").trim();
			if (code === 0) {
				resolve(Buffer.concat(outChunks).toString("utf8"));
			} else {
				reject(new Error(`${cmd} exited with code ${code}${stderr ? ": " + stderr : ""}`));
			}
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

/** Build the prompt string for OCR task */
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

const ocrSchema = Type.Object({
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

const ocrTool = defineTool({
	name: "minimodel_ocr",
	label: "Minimodel OCR",
	description:
		"Extract text, math formulas (LaTeX), and tables from images or PDFs using local Ollama vision models. " +
		"Use this when you need to read text from an image or PDF, especially mathematical formulas that need LaTeX output. " +
		"This is the tool to use when working with non-vision LLMs like DeepSeek that cannot process images directly.",
	promptSnippet:
		"Extract text/formulas/tables from images and PDFs using local Ollama OCR",
	promptGuidelines: [
		"When the user asks about the content of an image or PDF, use minimodel_ocr to extract the text first.",
		"For mathematical documents, use minimodel_ocr with task='formula' or task='auto' to get LaTeX output.",
		"Use minimodel_ocr with task='auto' for general document OCR to extract all text, formulas, tables, and figures.",
	],
	parameters: ocrSchema,
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

				tmpDir = mkdtempSync(join(tmpdir(), "pi-ocr-"));

				// Count pages and convert
				const pageCount = await getPdfPageCount(filePath);

				// Proactive check: multi-page PDF on macOS without extra tools
				if (pageCount > 1 && process.platform === "darwin") {
					const hasMultiPage = await checkMacMultiPageSupport();
					if (!hasMultiPage) {
						onUpdate?.({
							content: [{
								type: "text",
								text:
									`⚠️ Multi-page PDF detected (${pageCount} pages) but pdftoppm is not installed.\n` +
									`Only page 1 will be processed with built-in sips.\n` +
									`\nTo OCR all pages:\n` +
									`  brew install poppler`,
							}],
							details: {},
						});
					}
				}

				const pageResults: string[] = [];

				for (let i = 0; i < pageCount; i++) {
					if (signal?.aborted) throw new Error("Aborted");

					const pageOut = join(tmpDir, `page_${i + 1}.png`);

					try {
						await convertPdfPage(filePath, i, pageOut);
					} catch (e: any) {
						// Multi-page without tools → skip this page with a note
						pageResults.push(`## Page ${i + 1}\n\n> ⚠️ Skipped: ${e.message}`);
						continue;
					}

					onUpdate?.({
						content: [
							{ type: "text", text: `🔍 OCR page ${i + 1}/${pageCount}…` },
						],
						details: {},
					});

					const pageText = await callOcr(config, pageOut, resolvedTask, signal, resolvedModel);
					if (!pageText.trim()) {
						pageResults.push(`## Page ${i + 1}\n\n> ⚠️ OCR returned empty result for this page.`);
					} else {
						pageResults.push(`## Page ${i + 1}\n\n${pageText}`);
					}
				}

				resultText = pageResults.join("\n\n");
			} else {
				// ── Image: process directly ───────────────────────────────
				resultText = await callOcr(config, filePath, resolvedTask, signal, resolvedModel);
			}

			// Build summary
			const preview = resultText.length > 5000 ? resultText.slice(0, 5000) + "\n\n… (truncated)" : resultText;

			return {
				content: [
					{
						type: "text",
						text: `## OCR Result (${resolvedTask})\n\n**File:** \`${basename(filePath)}\`\n\n${preview}`,
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

let currentModel: string | null = null;
let ollamaHost: string | null = null;

function getConfig(_ctx?: ExtensionContext): OcrConfig {
	if (ollamaHost === null) {
		ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
	}
	if (currentModel === null) {
		currentModel = process.env.OCR_MODEL || "glm-ocr";
	}
	return { ollamaHost, model: currentModel };
}

function setModel(model: string): void {
	currentModel = model;
}

// ── Ollama API ──────────────────────────────────────────────────────────────

async function callOcr(
	config: OcrConfig,
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
		throw new Error(`OCR error: ${data.error}`);
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

	if (process.platform === "linux") {
		try {
			const out = await execCmdCapture("pdfinfo", [pdfPath]);
			const m = out.match(/Pages:\s+(\d+)/);
			if (m) return parseInt(m[1], 10) || 1;
		} catch { /* fall through */ }
	}

	return 1;
}

/**
 * Convert a single PDF page to PNG.
 * - macOS: tries sips (built-in), then pdftoppm (brew)
 * - Linux: uses pdftoppm (poppler-utils)
 */
async function convertPdfPage(pdfPath: string, pageIndex: number, outPath: string): Promise<void> {
	if (process.platform === "darwin") {
		await convertPdfPageMac(pdfPath, pageIndex, outPath);
	} else {
		await execCmdCapture("pdftoppm", [
			"-png", "-r", "150",
			"-f", String(pageIndex + 1),
			"-l", String(pageIndex + 1),
			"-singlefile",
			pdfPath,
			outPath.replace(/\.png$/, ""),
		]);
	}
}

/** Check if macOS has multi-page PDF support (pdftoppm). Cached. */
let macMultiPageCheck: { done: boolean; available: boolean } | null = null;

async function checkMacMultiPageSupport(): Promise<boolean> {
	if (macMultiPageCheck?.done) return macMultiPageCheck.available;

	try {
		await execCmdCapture("pdftoppm", ["-v"]);
		macMultiPageCheck = { done: true, available: true };
		return true;
	} catch {}

	macMultiPageCheck = { done: true, available: false };
	return false;
}

/** macOS PDF page → PNG: tries multiple methods in priority order */
async function convertPdfPageMac(pdfPath: string, pageIndex: number, outPath: string): Promise<void> {
	if (pageIndex === 0) {
		try {
			await execCmdCapture("sips", [
				"-s", "format", "png",
				pdfPath,
				"--out", outPath,
			]);
			return;
		} catch (e: any) {
			throw new Error(`sips PDF conversion failed: ${e.message}`);
		}
	}

	// Page > 0: use pdftoppm
	try {
		await execCmdCapture("pdftoppm", [
			"-png", "-r", "150",
			"-f", String(pageIndex + 1),
			"-l", String(pageIndex + 1),
			"-singlefile",
			pdfPath,
			outPath.replace(/\.png$/, ""),
		]);
		// Verify the output file actually exists
		if (!existsSync(outPath) || readFileSync(outPath).length === 0) {
			throw new Error(`pdftoppm produced no output for page ${pageIndex + 1}`);
		}
		return;
	} catch (e: any) {
		const msg = e.message || String(e);
		if (msg.includes("command not found") || msg.includes("ENOENT")) {
			throw new Error(
				`pdftoppm not found. Install with: brew install poppler. ` +
				`Only page 1 was processed with sips.`,
			);
		}
		throw new Error(`PDF page ${pageIndex + 1} conversion failed: ${msg}`);
	}
}

// ── Extension Entry ─────────────────────────────────────────────────────────

export default function ocrExtension(pi: ExtensionAPI) {
	// Register the minimodel_ocr tool
	pi.registerTool(ocrTool);

	// Register /ocr command for user convenience
	pi.registerCommand("ocr", {
		description: "OCR an image or PDF file using a local Ollama vision model",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /ocr <file-path> [task] [model]", "info");
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
			const result = await ocrTool.execute("", { path: filePath, task, model }, undefined as any, undefined, ctx);

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

	// Register /ocr-model command to view/change the default OCR model
	pi.registerCommand("ocr-model", {
		description: "View or change the default OCR model (persists for the session)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const config = getConfig(ctx);

			if (!trimmed) {
				// Show current model
				ctx.ui.notify(`Current OCR model: ${config.model}`, "info");
				ctx.ui.notify("To change: /ocr-model <model-name>", "info");
				ctx.ui.notify('Examples: /ocr-model glm-ocr:q8_0, /ocr-model llama3.2-vision', "info");
				return;
			}

			// Change model
			const newModel = trimmed.split(/\s+/)[0];
			setModel(newModel);

			ctx.ui.setStatus(
				"minimodel-ocr",
				`OCR: ${newModel} @ ${config.ollamaHost}`,
			);
			ctx.ui.notify(`OCR model changed to: ${newModel}`, "success");
		},
	});

	// Notify on startup
	pi.on("session_start", async (_event, ctx) => {
		const config = getConfig(ctx);
		ctx.ui.setStatus(
			"minimodel-ocr",
			`OCR: ${config.model} @ ${config.ollamaHost}`,
		);

		// Proactive check: warn if macOS multi-page PDF support is missing
		if (process.platform === "darwin") {
			checkMacMultiPageSupport().then((available) => {
				if (!available) {
					ctx.ui.notify(
						"💡 Multi-page PDF OCR needs pdftoppm (brew install poppler). Page 1 uses built-in sips.",
						"warning",
					);
				}
			});
		}
	});

	console.log("[pi-minimodel-ocr] Extension loaded. Tool: minimodel_ocr, Commands: /ocr, /ocr-model");
}
