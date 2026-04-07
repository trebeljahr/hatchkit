import { z } from "zod";

// ---------------------------------------------------------------------------
// ML Service Types
// ---------------------------------------------------------------------------

export type MlServiceName =
  | "background-removal"
  | "subtitles"
  | "image-recognition"
  | "3d-extraction";

export type MlJobStatus = "pending" | "processing" | "complete" | "failed";

// ---------------------------------------------------------------------------
// Background Removal
// ---------------------------------------------------------------------------

export const bgRemovalInputSchema = z.object({
  imageBase64: z.string(),
  model: z.enum(["birefnet-general", "u2net", "isnet-general-use"]).default("birefnet-general"),
});

export type BgRemovalInput = z.infer<typeof bgRemovalInputSchema>;

export type BgRemovalResult = {
  imageUrl: string;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// Subtitle Generation
// ---------------------------------------------------------------------------

export const subtitleInputSchema = z.object({
  audioBase64: z.string(),
  language: z.string().optional(),
  model: z.enum(["large-v3", "medium", "small", "base"]).default("large-v3"),
  format: z.enum(["json", "srt", "vtt"]).default("json"),
});

export type SubtitleInput = z.infer<typeof subtitleInputSchema>;

export type SubtitleSegment = {
  start: number;
  end: number;
  text: string;
};

export type SubtitleResult = {
  text: string;
  language: string;
  segments: SubtitleSegment[];
  srt?: string;
  vtt?: string;
};

// ---------------------------------------------------------------------------
// Image Recognition (CLIP)
// ---------------------------------------------------------------------------

export const imageRecognitionInputSchema = z.object({
  imageBase64: z.string(),
  labels: z.array(z.string()).optional(),
  topK: z.number().int().min(1).max(20).default(5),
});

export type ImageRecognitionInput = z.infer<typeof imageRecognitionInputSchema>;

export type RecognitionLabel = {
  label: string;
  score: number;
};

export type ImageRecognitionResult = {
  results: RecognitionLabel[];
};

// ---------------------------------------------------------------------------
// 3D Model Extraction
// ---------------------------------------------------------------------------

export const model3dInputSchema = z.object({
  imageBase64: z.string(),
  removeBg: z.boolean().default(true),
  resolution: z.number().int().min(128).max(512).default(256),
});

export type Model3dInput = z.infer<typeof model3dInputSchema>;

export type Model3dResult = {
  glbUrl: string;
  vertices: number;
};

// ---------------------------------------------------------------------------
// ML Service Config (available services)
// ---------------------------------------------------------------------------

export type MlServiceConfig = {
  name: MlServiceName;
  label: string;
  description: string;
  acceptedTypes: string[];
  maxFileSizeMb: number;
};

export const ML_SERVICES: MlServiceConfig[] = [
  {
    name: "background-removal",
    label: "Background Removal",
    description: "Remove the background from any image using AI",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "subtitles",
    label: "Subtitle Generator",
    description: "Generate perfectly timed subtitles from audio or video",
    acceptedTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm"],
    maxFileSizeMb: 100,
  },
  {
    name: "image-recognition",
    label: "Image Recognition",
    description: "Classify images using zero-shot CLIP recognition",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "3d-extraction",
    label: "3D Model Extraction",
    description: "Generate a 3D model from a single product photo",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
];
