/**
 * pi-minimodel-ocr — Multi-backend OCR for Pi Coding Agent
 *
 * Registers a `minimodel_ocr` tool that the LLM can call to read images and PDFs
 * using one of three backends:
 *   - Ollama (local vision models like glm-ocr)
 *   - MinerU API (free Agent API, ≤10MB, ≤20 pages)
 *   - PaddleOCR (local Python library)
 *
 * Single command:
 *   /ocr                    → open settings UI (backend, model, split toggle)
 *   /ocr <file> [task]      → OCR file with current settings
 *
 * Settings persisted to ~/.pi/agent/settings.json.
 *
 * Prerequisites:
 *   Ollama:     brew install ollama && ollama pull glm-ocr
 *   MinerU:     no setup (free API, IP rate-limited)
 *   PaddleOCR:  pip install paddleocr paddlepaddle pypdfium2
 *   PDF tools:  brew install poppler (macOS multi-page PDF for Ollama)
 *
 * Install: pi install npm:pi-minimodel-ocr
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type SettingItem,
  SettingsList,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Backend, Task, OcrConfig } from "./types";
import { TASKS, BACKENDS } from "./types";
import { isImage, isPdf, getPdfPageCount, ollamaOcr, ollamaCheckModel, ollamaPullModel } from "./ollama";
import { mineruOcr } from "./mineru";
import { paddleOcr } from "./paddleocr";

// ── Config persistence ───────────────────────────────────────────────────────

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function loadOcrConfig(): Partial<OcrConfig> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return (JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as any).minimodelOcr || {};
  } catch { return {}; }
}

function saveOcrConfig(updates: Partial<OcrConfig>) {
  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const settings = existsSync(SETTINGS_PATH)
      ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8"))
      : {};
    settings.minimodelOcr = { ...(settings.minimodelOcr || {}), ...updates };
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch { /* best effort */ }
}

function getConfig(): OcrConfig {
  const s = loadOcrConfig();
  return {
    backend: (BACKENDS.includes(s.backend as Backend) ? s.backend : "ollama") as Backend,
    ollamaHost: process.env.OLLAMA_HOST || s.ollamaHost || "http://localhost:11434",
    model: process.env.OCR_MODEL || s.model || "glm-ocr",
    mineruSplitPdf: s.mineruSplitPdf !== false,
  };
}

// ── Recommended models ───────────────────────────────────────────────────────

const RECOMMENDED_MODELS = [
  { name: "glm-ocr:q8_0", desc: "balanced — smallest (1.6GB), fast" },
  { name: "glm-ocr", desc: "best formula OCR (2.2GB, 94.6 OmniDocBench)" },
  { name: "minicpm-v", desc: "strong all-around vision + OCR (8B, 5.5GB)" },
  { name: "llama3.2-vision", desc: "Meta's vision model (11B)" },
];

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
  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    const { path: filePath, task = "auto", model: modelOverride } = params as {
      path: string; task?: string; model?: string;
    };
    const resolvedTask = (TASKS.includes(task as Task) ? task : "auto") as Task;
    const config = getConfig();
    const resolvedModel = modelOverride || config.model;

    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    if (!isImage(filePath) && !isPdf(filePath)) {
      throw new Error(`Unsupported file type "${extname(filePath)}". Supported: PNG, JPG, GIF, WEBP, BMP, TIFF, PDF.`);
    }

    const backendLabel = { ollama: "🦙 Ollama", mineru: "☁️ MinerU", paddleocr: "🐍 PaddleOCR" }[config.backend];
    onUpdate?.({ content: [{ type: "text", text: `🔍 OCR ${basename(filePath)} via ${backendLabel} (${resolvedTask})…` }], details: {} });

    const onProgress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });

    try {
      let result: { text: string; details: Record<string, unknown> };

      switch (config.backend) {
        case "ollama":
          result = await ollamaOcr(filePath, resolvedTask, config.ollamaHost, resolvedModel, signal, onProgress);
          break;
        case "mineru": {
          const { stat } = await import("node:fs/promises");
          const stats = await stat(filePath);
          if (stats.size > 10 * 1024 * 1024) {
            onProgress(`⚠️ File is ${(stats.size / 1024 / 1024).toFixed(1)}MB. MinerU free tier limit is 10MB.\n💡 Compress at https://ilovepdf.com/compress_pdf or switch backend with /ocr.`);
          }
          result = await mineruOcr(filePath, resolvedTask, config.mineruSplitPdf, signal, onProgress);
          break;
        }
        case "paddleocr":
          result = await paddleOcr(filePath, resolvedTask, signal, onProgress);
          break;
        default:
          throw new Error(`Unknown backend "${config.backend}"`);
      }

      const preview = result.text.length > 5000 ? result.text.slice(0, 5000) + "\n\n… (truncated)" : result.text;
      return {
        content: [{ type: "text", text: `## OCR Result (${resolvedTask})\n\n**File:** \`${basename(filePath)}\`\n**Backend:** ${config.backend}\n\n${preview}` }],
        details: { task: resolvedTask, path: filePath, fullText: result.text, truncated: result.text.length > 5000, backend: config.backend, ...result.details },
      };
    } catch (e: any) {
      const msg = e.message || String(e);
      let hint = "";
      if (config.backend === "ollama" && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED"))) hint = "\n\n💡 Is Ollama running? Start: `ollama serve`";
      else if (config.backend === "paddleocr" && msg.includes("python3")) hint = "\n\n💡 Install: `pip install paddleocr paddlepaddle pypdfium2`";
      else if (config.backend === "mineru" && msg.includes("429")) hint = "\n\n💡 MinerU rate limit. Wait a minute or switch backend with /ocr.";
      else if (config.backend === "mineru" && msg.includes("too large")) hint = "\n\n💡 Compress at https://ilovepdf.com/compress_pdf or switch backend.";
      throw new Error(`OCR error (${config.backend}): ${msg}${hint}`);
    }
  },
});

// ── Extension Entry ─────────────────────────────────────────────────────────

export default function ocrExtension(pi: ExtensionAPI) {
  pi.registerTool(ocrTool);

  // ── /ocr command ─────────────────────────────────────────────────────────

  pi.registerCommand("ocr", {
    description: "OCR an image or PDF, or configure OCR settings",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      // No args → open settings UI
      if (!trimmed) {
        await showOcrSettings(ctx);
        return;
      }

      // Args → OCR a file
      const parts = trimmed.split(/\s+/);
      const filePath = parts[0];
      const task = parts[1] || "auto";
      const model = parts[2] || undefined;

      if (!existsSync(filePath)) {
        ctx.ui.notify(`File not found: ${filePath}`, "error");
        return;
      }

      try {
        const result = await ocrTool.execute("", { path: filePath, task, model }, undefined as any, undefined, ctx);
        const textLen = (result.details as any)?.fullText?.length || 0;
        ctx.ui.notify(`OCR complete — ${textLen} chars via ${(result.details as any)?.backend || "?"}`, "info");
      } catch (e: any) {
        ctx.ui.notify(e.message?.slice(0, 200) || "OCR failed", "error");
      }
    },
  });

  // ── Settings UI ────────────────────────────────────────────────────────────
  //
  // Shows a SettingsList with:
  //   1. Backend selector (toggle: ollama / mineru / paddleocr)
  //   2. MinerU: Split PDF >20 pages (toggle: ON / OFF)
  //   3. Ollama model (current value shown; Enter opens model picker submenu)
  //
  // Changes are saved immediately to ~/.pi/agent/settings.json.

  async function showOcrSettings(ctx: ExtensionContext) {
    const config = getConfig();

    const items: SettingItem[] = [
      {
        id: "backend",
        label: "OCR Backend",
        description: "Ollama=local GPU, MinerU=free cloud API, PaddleOCR=local Python",
        currentValue: config.backend,
        values: [...BACKENDS],
      },
      {
        id: "mineruSplitPdf",
        label: "MinerU: Split PDF >20 pages",
        description: "Auto-split large PDFs into ≤20-page free-tier chunks",
        currentValue: config.mineruSplitPdf ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      {
        id: "model",
        label: "Ollama Model",
        description: "Vision model used for OCR (only applies to Ollama backend)",
        currentValue: config.model,
        submenu: (_currentValue, done) => {
          return createModelSelector(config.model, ctx, (selected) => {
            if (selected) {
              saveOcrConfig({ model: selected });
              process.env.OCR_MODEL = selected;
              updateStatus(ctx);
              // Update the SettingsList item value in-place
              settingsListRef?.updateValue("model", selected);
            }
            done(selected);
          });
        },
      },
    ];

    let settingsListRef: SettingsList | null = null;

    await new Promise<void>((resolve) => {
      ctx.ui.custom((tui, theme, _kb, done) => {
        const settingsList = new SettingsList(
          items,
          8, // max visible items
          getSettingsListTheme(),
          (id, newValue) => {
            // onChange — save immediately
            switch (id) {
              case "backend": {
                const backend = BACKENDS.includes(newValue as Backend) ? newValue as Backend : "ollama";
                saveOcrConfig({ backend });
                updateStatus(ctx);
                // Show hints when switching
                if (backend === "mineru") {
                  ctx.ui.notify(
                    "☁️ MinerU: free for ≤10MB & ≤20 pages. Auto-split " +
                    (config.mineruSplitPdf ? "ON" : "OFF — enable in settings") +
                    ".\nLarge files? Compress at https://ilovepdf.com/compress_pdf",
                    "info",
                  );
                } else if (backend === "paddleocr") {
                  ctx.ui.notify("🐍 PaddleOCR: needs `pip install paddleocr paddlepaddle pypdfium2`", "warning");
                }
                break;
              }
              case "mineruSplitPdf":
                saveOcrConfig({ mineruSplitPdf: newValue === "ON" });
                break;
            }
          },
          () => done(undefined), // onCancel
        );

        settingsListRef = settingsList;

        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("OCR Settings")), 1, 0));
        container.addChild(settingsList);
        container.addChild(
          new Text(theme.fg("dim", "↑↓ navigate • ← → toggle • enter select • esc close"), 1, 0),
        );

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    });
  }

  // ── Model selector submenu ─────────────────────────────────────────────────

  function createModelSelector(
    currentModel: string,
    ctx: ExtensionContext,
    onDone: (selected: string | undefined) => void,
  ) {
    const items: SelectItem[] = RECOMMENDED_MODELS.map((m) => ({
      value: m.name,
      label: m.name === currentModel ? `${m.name} ✓` : m.name,
      description: m.desc,
    }));
    items.push({
      value: "__custom__",
      label: "Type a custom name…",
      description: "Enter any Ollama model name",
    });

    const container = new Container();
    container.addChild(new Text("Choose Ollama Model", 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (text) => ctx.ui.theme.fg("accent", text),
      selectedText: (text) => ctx.ui.theme.fg("accent", text),
      description: (text) => ctx.ui.theme.fg("muted", text),
      scrollInfo: (text) => ctx.ui.theme.fg("dim", text),
      noMatch: (text) => ctx.ui.theme.fg("warning", text),
    });

    selectList.onSelect = async (item) => {
      if (item.value === "__custom__") {
        const custom = await ctx.ui.input("Enter Ollama model name:", currentModel);
        if (custom?.trim()) {
          await ensureModelPulled(custom.trim(), ctx);
          onDone(custom.trim());
        } else {
          onDone(undefined);
        }
        return;
      }
      await ensureModelPulled(item.value, ctx);
      onDone(item.value);
    };

    selectList.onCancel = () => onDone(undefined);
    container.addChild(selectList);

    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) { selectList.handleInput(data); },
    };
  }

  async function ensureModelPulled(model: string, ctx: ExtensionContext) {
    const config = getConfig();
    const exists = await ollamaCheckModel(config.ollamaHost, model);
    if (!exists) {
      const pull = await ctx.ui.confirm(
        "Model not found",
        `"${model}" is not pulled locally.\n\nPull it now? (ollama pull ${model})`,
      );
      if (pull) {
        ctx.ui.notify(`Pulling ${model}…`, "info");
        ollamaPullModel(model)
          .then(() => ctx.ui.notify(`${model} ready`, "info"))
          .catch((e) => ctx.ui.notify(`Pull failed: ${e.message}`.slice(0, 200), "error"));
      }
    }
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    const config = getConfig();
    const text = config.backend === "ollama"
      ? `OCR: ollama ${config.model}`
      : `OCR: ${config.backend}`;
    ctx.ui.setStatus("minimodel-ocr", text);
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);

    // Proactive check: macOS multi-page PDF support
    if (process.platform === "darwin" && getConfig().backend === "ollama") {
      const { spawn } = await import("node:child_process");
      const hasPdftoppm = await new Promise<boolean>((resolve) => {
        const child = spawn("pdftoppm", ["-v"], { stdio: "ignore" });
        child.on("close", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
      });
      if (!hasPdftoppm) {
        ctx.ui.notify("💡 Multi-page PDF via Ollama needs pdftoppm: brew install poppler", "warning");
      }
    }
  });

  console.log("[pi-minimodel-ocr] Loaded — /ocr (file or settings), tool: minimodel_ocr");
}
