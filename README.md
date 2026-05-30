# pi-minimodel-ocr

Multi-backend OCR for [Pi Coding Agent](https://pi.dev) — extract text, LaTeX math formulas, and tables from images and PDFs. Choose the backend that fits your needs: local GPU, free cloud API, or pure Python.

> Bridges the multimodal gap for non-vision LLMs like **DeepSeek**. When your model can't see images, `minimodel_ocr` acts as its eyes — with state-of-the-art formula recognition outputting LaTeX.

## Three Backends — One Tool

| Backend | Type | Best For |
|---|---|---|
| 🦙 **Ollama** | Local GPU | Math formulas (LaTeX), privacy, offline |
| ☁️ **MinerU** | Free cloud API | Complex PDFs, no GPU, zero setup |
| 🐍 **PaddleOCR** | Local Python | Chinese/English text, no GPU, lightweight |

Switch anytime with `/ocr` (no args) — a visual `SettingsList` menu lets you pick and configure everything without editing JSON:

```
/ocr     → opens settings: backend, model, PDF split toggle
/ocr <file> [task]   → OCR a file
```

## Features

| | |
|---|---|
| 🔤 **Text** | General text recognition → Markdown |
| 🧮 **Formulas** | Math formulas → LaTeX (Ollama glm-ocr: 94.6 OmniDocBench) |
| 📊 **Tables** | Table structure → Markdown tables |
| 🖼️ **Figures** | Diagrams and illustrations → descriptions |
| 📄 **PDF** | Full PDF support across all backends |
| 🎛️ **Any model** | Ollama works with glm-ocr, llama3.2-vision, minicpm-v, etc. |
| ☁️ **Free cloud** | MinerU Agent API: no token, ≤10MB, ≤20 pages free |
| 📦 **Auto-split** | MinerU splits PDFs >20 pages into free-tier chunks |

---

## Quickstart

### 1. Install the extension

```bash
pi install npm:pi-minimodel-ocr
```

### 2. Choose and set up your backend

Run `/ocr` in pi (no arguments) to open the settings menu. Pick a backend. Follow the platform-specific setup below for your choice:

---

### 🦙 Ollama setup

#### macOS

```bash
# 1. Install Ollama
brew install ollama

# 2. Pull the default OCR model (~2.2 GB)
ollama pull glm-ocr

# 3. Multi-page PDF support (optional but recommended)
brew install poppler
```

> macOS uses built-in `sips` for single-page PDFs — zero extra deps for those.  
> Multi-page PDFs need `poppler` for the `pdftoppm` tool.

#### Linux

```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull the default OCR model (~2.2 GB)
ollama pull glm-ocr

# 3. PDF support (required on Linux)
sudo apt install poppler-utils        # Debian/Ubuntu
sudo dnf install poppler-utils        # Fedora
sudo pacman -S poppler                # Arch
```

#### Verify

```bash
# Check Ollama is running and model is pulled
ollama list | grep glm-ocr
```

---

### 🐍 PaddleOCR setup

PaddleOCR runs entirely in Python. It converts PDF pages to images via `pypdfium2` (pure Python, no system tools needed).

#### Step 1: Make sure you have Python 3.9+

| System | Check |
|---|---|
| macOS/Linux | `python3 --version` |

> ⚠️ **Important:** Know which Python you're using. Run `which python3` — if it shows `conda`, `brew`, or `/usr/bin/python3`, your `pip install` must target the same Python:
> ```bash
> # Conda Python
> pip install paddleocr paddlepaddle pypdfium2
> 
> # System Python (may need --user or sudo)
> pip install --user paddleocr paddlepaddle pypdfium2
> 
> # Brew Python (macOS)
> /opt/homebrew/bin/pip3 install paddleocr paddlepaddle pypdfium2
> ```
> If unsure, use `python3 -m pip install ...` — this always installs for the active `python3`.

#### Step 2: Install packages

```bash
python3 -m pip install paddleocr paddlepaddle pypdfium2
```

> **macOS with Apple Silicon (M1/M2/M3):** PaddlePaddle does not provide native arm64 wheels. It installs x86_64 binaries which run fine under Rosetta 2 — no extra steps needed.

#### Step 3: Verify

```bash
python3 -c "from paddleocr import PaddleOCR; print('OK')"
```

> First run downloads model weights (~100MB) to `~/.paddlex/`.

#### Optional: GPU acceleration (Linux)

```bash
# NVIDIA GPU
pip install paddlepaddle-gpu
```

---

### ☁️ MinerU setup

**No setup required.** The free Agent API works immediately. No token, no account.

Free tier limits:
- ≤ 10 MB per file
- ≤ 20 pages per request
- IP-based rate limiting

For files >10MB, compress first at [ilovepdf.com/compress_pdf](https://ilovepdf.com/compress_pdf).

---

## Usage

### Settings UI

```
/ocr
```

Opens an interactive `SettingsList` with keyboard navigation:

```
┌─ OCR Settings ─────────────────────────────────┐
│  OCR Backend         [ollama / mineru / paddleocr]  │
│  MinerU: Split PDF   [ON / OFF]                     │
│  Ollama Model         [glm-ocr]                     │
│  ↑↓ navigate • ← → toggle • enter select • esc close    │
└──────────────────────────────────────────────────┘
```

- **Backend**: ← → to cycle ollama/mineru/paddleocr — saves immediately
- **MinerU Split**: ← → to toggle ON/OFF — when ON, PDFs >20 pages are auto-split
- **Model**: Enter opens a sub-menu with recommended models + custom input

### OCR a file

```
/ocr <file> [task] [model]
```

| Example | Result |
|---|---|
| `/ocr ./scan.png` | Auto-detect all content |
| `/ocr ./equation.jpg formula` | LaTeX formula output |
| `/ocr ./contract.pdf text` | Text-only extraction |
| `/ocr ./paper.pdf auto glm-ocr:q8_0` | Use specific model |

### Tasks

| Task | Description | Output format |
|---|---|---|
| `auto` | Full document OCR (default) | Markdown + LaTeX mixed |
| `text` | Plain text recognition | Markdown |
| `formula` | Math formula recognition | LaTeX |
| `table` | Table structure recognition | Markdown tables |
| `figure` | Figure / diagram description | Natural language |

### LLM-invoked (automatic)

The extension registers a `minimodel_ocr` tool. The agent invokes it automatically:

```
> What formula is written in this screenshot?
> OCR this 50-page PDF into markdown.
```

---

## MinerU PDF Splitting

When `MinerU: Split PDF >20 pages` is ON (default), large PDFs are automatically split into ≤20-page chunks. Each chunk is submitted as a **separate individual request** (not batch) with 3-second spacing to respect the per-minute IP rate limit:

```
📦 PDF has 85 pages — splitting into ≤20-page chunks…
🔪 Splitting PDF with pypdfium2…
📦 Split into 5 chunk(s). Each will be a SEPARATE MinerU request:

── Request 1/5 (pages 1-20) ──
📤 MinerU: requesting upload URL for doc_p1-20.pdf…
✅ MinerU: pages 1-20 complete

── Request 2/5 (pages 21-40) ──
  ⏸️  Waiting 3s for rate limit…
...
```

---

## Backend Comparison

| | 🦙 Ollama | ☁️ MinerU | 🐍 PaddleOCR |
|---|---|---|---|
| **Setup** | Install Ollama + pull model | None | `pip install` 3 packages |
| **GPU needed** | Recommended | No | No |
| **Internet** | No | Yes | No (first run: yes) |
| **Math formulas** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐ |
| **Complex PDFs** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **Chinese text** | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **File size limit** | None | 10MB (free) | None |
| **Page limit** | None | 20/request (free) | None |
| **Cost** | Free (local) | Free (rate-limited) | Free (local) |

---

## Supported File Types

| Format | Ollama | MinerU | PaddleOCR |
|---|---|---|---|
| PNG, JPG, GIF, WEBP, BMP, TIFF | ✅ | ✅ | ✅ |
| PDF | ✅ | ✅ | ✅ |
| Docx, PPTx, Xlsx | ❌ | ✅ | ❌ |

---

## PDF Support Details

| Backend | Conversion method | System deps |
|---|---|---|
| **Ollama** | `sips` (macOS page 1) / `pdftoppm` (multi-page, Linux) | `poppler` (multi-page only) |
| **MinerU** | Direct PDF upload — no conversion | None |
| **PaddleOCR** | `pypdfium2` (Python) — no system deps | None |

---

## Configuration

All settings are persisted to `~/.pi/agent/settings.json`:

```json
{
  "minimodelOcr": {
    "backend": "ollama",
    "model": "glm-ocr",
    "ollamaHost": "http://localhost:11434",
    "mineruSplitPdf": true
  }
}
```

Change settings via `/ocr` (interactive) or edit directly. Environment variables override file settings:

```bash
export OLLAMA_HOST="http://localhost:11434"
export OCR_MODEL="glm-ocr"
```

---

## Troubleshooting

### Ollama: "fetch failed" / "ECONNREFUSED"

```bash
# Start Ollama in the background
ollama serve
```

### Ollama: "model not found"

```bash
ollama pull glm-ocr
```

### PaddleOCR: "python3 not found"

```bash
# Check your python:
which python3 && python3 --version

# If using conda:
conda activate base && pip install paddleocr paddlepaddle pypdfium2

# If using system python:
python3 -m pip install --user paddleocr paddlepaddle pypdfium2
```

### PaddleOCR: "No module named 'paddleocr'"

You likely installed with a different `pip` than your active `python3`:

```bash
# Always use -m pip to ensure correct target:
python3 -m pip install paddleocr paddlepaddle pypdfium2
```

### MinerU: "429 Too Many Requests"

IP rate limit hit. Wait 1-2 minutes, or switch to Ollama/PaddleOCR with `/ocr`.

### MinerU: "file page count exceeds lightweight API limit"

Enable PDF splitting: `/ocr` → toggle "MinerU: Split PDF" to ON.

### MinerU: "File too large for free MinerU API"

Compress the PDF at [ilovepdf.com/compress_pdf](https://ilovepdf.com/compress_pdf) or switch to a local backend with `/ocr`.

### macOS multi-page PDF: "pdftoppm not found"

```bash
brew install poppler
```

### Linux multi-page PDF: "pdftoppm not found"

```bash
# Debian/Ubuntu
sudo apt install poppler-utils

# Fedora
sudo dnf install poppler-utils

# Arch
sudo pacman -S poppler
```

---

## How It Works

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  pi (DeepSeek)   │────▶│  minimodel_ocr   │────▶│  Ollama / MinerU    │
│  (no vision)     │     │  pi extension    │     │  / PaddleOCR        │
└──────────────────┘     └──────────────────┘     └──────────────────────┘
        │                         │                           │
        │  "read this image"      │  POST /api/generate       │
        │────────────────────────▶│  (Ollama)                 │
        │                         │  or POST /api/v1/agent    │
        │                         │  (MinerU)                 │
        │                         │  or python3 subprocess    │
        │                         │  (PaddleOCR)              │
        │                         │──────────────────────────▶│
        │                         │  OCR text response        │
        │  LaTeX / Markdown       │◀──────────────────────────│
        │◀────────────────────────│                           │
```

The tool dispatches to your selected backend. Switch anytime with `/ocr` — no restart needed.

## License

MIT
