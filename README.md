# pi-minimodel-ocr

Local OCR for [Pi Coding Agent](https://pi.dev) — extract text, LaTeX math formulas, and tables from images and PDFs using small vision models via [Ollama](https://ollama.com).

> Bridges the multimodal gap for non-vision LLMs like **DeepSeek**. When your model can't see images, `glm_ocr` acts as its eyes — with state-of-the-art formula recognition outputting LaTeX.

## Features

| | |
|---|---|
| 🔤 **Text** | General text recognition → Markdown |
| 🧮 **Formulas** | Math formulas → LaTeX with high accuracy |
| 📊 **Tables** | Table structure → Markdown tables |
| 🖼️ **Figures** | Diagrams and illustrations → descriptions |
| 📄 **PDF** | Full PDF support with per-page conversion (macOS / Linux / WSL) |
| 🎛️ **Any model** | Defaults to `glm-ocr` (0.9B) but works with any Ollama vision model |
| 🔒 **100% local** | No API keys, no cloud, no data ever leaves your machine |

## Quickstart

### 1. Prerequisites

```bash
# Install Ollama
brew install ollama                     # macOS
curl -fsSL https://ollama.com/install.sh | sh  # Linux

# Pull the default OCR model (~2.2 GB)
ollama pull glm-ocr

# Linux/WSL PDF support
sudo apt install poppler-utils
```

> macOS uses built-in `sips` for single-page PDFs — zero extra deps.  
> Multi-page PDFs on macOS need `brew install poppler` or `pip install pyobjc-framework-Quartz`.

### 2. Install

```bash
pi install npm:pi-minimodel-ocr
```

Or try it without installing:

```bash
pi -e npm:pi-minimodel-ocr
```

## Usage

### LLM-invoked (automatic)

The extension registers a `glm_ocr` tool. The agent invokes it automatically when it needs to read an image or PDF. Just ask:

```
> What formula is written in this screenshot?
```

The model calls `glm_ocr` with `task="formula"` and gets back LaTeX. Works the same way for text, tables, figures, or full documents.

### Command-line (manual)

```
/glm-ocr <file> [task] [model]
```

| Example | Result |
|---|---|
| `/glm-ocr ./scan.png` | Auto-detect all content |
| `/glm-ocr ./equation.jpg formula` | LaTeX formula output |
| `/glm-ocr ./receipt.pdf text` | Text-only extraction |
| `/glm-ocr ./table.png table` | Markdown table |
| `/glm-ocr ./paper.pdf auto llama3.2-vision` | Use a different model |

### Tasks

| Task | Description | Output format |
|---|---|---|
| `auto` | Full document OCR (default) | Markdown + LaTeX mixed |
| `text` | Plain text recognition | Markdown |
| `formula` | Math formula recognition | LaTeX |
| `table` | Table structure recognition | Markdown tables |
| `figure` | Figure / diagram description | Natural language |

## Supported Models

Defaults to **`glm-ocr`** (Zhipu AI, 0.9B, 94.62 OmniDocBench) — the best open-source small OCR model. Works with any Ollama vision model:

```bash
# Smaller quantized variant (~1.6 GB)
/glm-ocr ./img.png auto glm-ocr:q8_0

# Or any vision model you have pulled
/glm-ocr ./doc.pdf auto llama3.2-vision
/glm-ocr ./chart.png figure minicpm-v
```

Set a custom default via environment variable:

```bash
export GLM_OCR_MODEL="glm-ocr:q8_0"
```

## PDF Support

| Platform | Single-page | Multi-page |
|---|---|---|
| **macOS** | `sips` (built-in, zero-deps) | `brew install poppler` |
| **Linux / WSL** | `pdftoppm` (poppler-utils) | `pdftoppm` (poppler-utils) |

The extension auto-detects multi-page PDFs and shows install instructions if the required tools are missing — it won't silently drop pages.

## Configuration

### Environment variables

```bash
export OLLAMA_HOST="http://localhost:11434"   # default
export GLM_OCR_MODEL="glm-ocr"                 # default model
```

### settings.json

```json
{
  "glmOcr": {
    "ollamaHost": "http://localhost:11434",
    "model": "glm-ocr"
  }
}
```

## How It Works

```
┌──────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  pi (DeepSeek)   │────▶│  glm_ocr (tool)  │────▶│  Ollama Server      │
│  (no vision)     │     │  pi extension    │     │  (any vision model) │
└──────────────────┘     └──────────────────┘     └─────────────────────┘
        │                         │                           │
        │  "read this image"      │  POST /api/generate       │
        │────────────────────────▶│  base64 image + prompt    │
        │                         │──────────────────────────▶│
        │                         │  OCR text response        │
        │  LaTeX / Markdown       │◀──────────────────────────│
        │◀────────────────────────│                           │
```

For PDFs, the extension converts each page to PNG using `sips` (macOS) or `pdftoppm` (Linux) before sending to Ollama.

## License

MIT
