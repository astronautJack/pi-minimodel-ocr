/**
 * pi-minimodel-ocr — shared types for OCR backends
 */

export const TASKS = ["text", "formula", "table", "figure", "auto"] as const;
export type Task = (typeof TASKS)[number];

/** All supported OCR backends */
export const BACKENDS = ["ollama", "mineru", "paddleocr"] as const;
export type Backend = (typeof BACKENDS)[number];

export interface OcrConfig {
  backend: Backend;
  ollamaHost: string;
  model: string;
  /** MinerU: auto-split PDFs with >20 pages into free-tier chunks */
  mineruSplitPdf: boolean;
}

export interface OcrResult {
  text: string;
  details: Record<string, unknown>;
}

export interface OcrProgressCallback {
  (msg: string): void;
}
