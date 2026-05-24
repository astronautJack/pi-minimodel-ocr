# pi-glm-ocr

**Local OCR for Pi Coding Agent** — extract text, LaTeX math formulas, and tables from images and PDFs using [GLM-OCR](https://ollama.com/library/glm-ocr) (0.9B) via Ollama.

> Bridges the multimodal gap for non-vision LLMs like **DeepSeek**. When your model can't see images or PDFs, `pi-glm-ocr` acts as its eyes — with high-accuracy formula recognition outputting LaTeX.

## Features

- 🔍 **Text Recognition** — Extracts text as Markdown from images and PDFs
- 🧮 **Formula Recognition** — Math formulas output in LaTeX with high accuracy
- 📊 **Table Recognition** — Tables extracted as Markdown tables
- 🖼️ **Figure Description** — Describes figures and diagrams
- 📄 **PDF Support** — Converts PDF pages to images automatically (macOS/Linux)
- 📦 **Fully local** — No API keys, no cloud, no data leaves your machine

## Prerequisites

1. **Install Ollama** (if not already):
   ```bash
   # macOS
   brew install ollama
   # or download from https://ollama.com/download

   # Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ```

2. **Pull the GLM-OCR model:**
   ```bash
   ollama pull glm-ocr
   ```
   Model size: ~2.2 GB (bf16) or ~1.6 GB (q8_0 variant)

3. **For PDF support on Linux:**
   ```bash
   sudo apt install poppler-utils
   ```
   macOS uses built-in CoreGraphics — no extra dependencies needed.

## Install

```bash
pi install npm:pi-glm-ocr
```

Or try it without installing:

```bash
pi -e npm:pi-glm-ocr
```

## Usage

### As a tool (LLM-invoked)

The extension registers a `glm_ocr` tool that the agent can call automatically. Just ask pi:

```
> What's the formula in this screenshot?
(attach image or mention path)

# The model will call glm_ocr with task="formula" and read the LaTeX
```

```
> Extract all text from paper.pdf
# Model calls glm_ocr with task="auto" and gets back Markdown + LaTeX
```

### As a command (user-invoked)

```bash
/glm-ocr ./screenshot.png formula
/glm-ocr ./document.pdf auto
/glm-ocr ./table.png table
/glm-ocr ./diagram.png figure
/glm-ocr ./page.jpg text
```

### Tasks

| Task | Prompt | Output |
|------|--------|--------|
| `text` | Text Recognition | Markdown |
| `formula` | Formula Recognition | LaTeX |
| `table` | Table Recognition | Markdown tables |
| `figure` | Figure Recognition | Description |
| `auto` | Full document OCR | Markdown + LaTeX (mixed) |

## Configuration

Optional environment variables:

```bash
export OLLAMA_HOST="http://localhost:11434"  # default
export GLM_OCR_MODEL="glm-ocr"                # default
```

Or in `~/.pi/agent/settings.json`:

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
┌──────────────┐     ┌─────────────┐     ┌─────────────────┐
│  pi (DeepSeek)│────▶│  glm_ocr    │────▶│  Ollama Server  │
│  (no vision)  │     │  (extension) │     │  (GLM-OCR 0.9B) │
└──────────────┘     └─────────────┘     └─────────────────┘
       │                    │                      │
       │   "read this pic"  │   POST /api/generate  │
       │───────────────────▶│──────────────────────▶│
       │                    │   base64 image + task  │
       │                    │◀──────────────────────│
       │   LaTeX formula    │   OCR text response   │
       │◀───────────────────│                       │
```

## License

MIT
