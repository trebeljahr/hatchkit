import { z } from "zod";

// ---------------------------------------------------------------------------
// ML Service Types
// ---------------------------------------------------------------------------

export type MlServiceName =
  | "background-removal"
  | "subtitles"
  | "image-recognition"
  | "3d-extraction"
  | "3d-sam-objects"
  | "3d-sam-body"
  | "3d-hunyuan"
  | "3d-trellis";

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
// SAM 3D Objects (Meta) — single image → textured 3D mesh
// ---------------------------------------------------------------------------

export const samObjectsInputSchema = z.object({
  imageBase64: z.string(),
  removeBg: z.boolean().default(true),
});

export type SamObjectsInput = z.infer<typeof samObjectsInputSchema>;

// ---------------------------------------------------------------------------
// SAM 3D Body (Meta) — single image → posed body mesh
// ---------------------------------------------------------------------------

export const samBodyInputSchema = z.object({
  imageBase64: z.string(),
});

export type SamBodyInput = z.infer<typeof samBodyInputSchema>;

// ---------------------------------------------------------------------------
// Hunyuan3D (Tencent) — open-weight high-quality with PBR textures
// ---------------------------------------------------------------------------

export const hunyuan3dInputSchema = z.object({
  imageBase64: z.string(),
  removeBg: z.boolean().default(true),
  withTexture: z.boolean().default(true),
});

export type Hunyuan3dInput = z.infer<typeof hunyuan3dInputSchema>;

// ---------------------------------------------------------------------------
// TRELLIS 2 (Microsoft) — sparse-voxel geometry with strong topology
// ---------------------------------------------------------------------------

export const trellis3dInputSchema = z.object({
  imageBase64: z.string(),
  removeBg: z.boolean().default(true),
});

export type Trellis3dInput = z.infer<typeof trellis3dInputSchema>;

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
    name: "3d-sam-objects",
    label: "SAM 3D Objects",
    description: "Meta's SOTA single-image-to-3D for real product photos (textured mesh)",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "3d-sam-body",
    label: "SAM 3D Body",
    description: "Meta's posed-body reconstruction from a single image (apparel / try-on)",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "3d-hunyuan",
    label: "Hunyuan3D",
    description: "Tencent's open-weight model with up to 8K PBR textures",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "3d-trellis",
    label: "TRELLIS 2",
    description: "Microsoft's sparse-voxel 3D generation — strong topology, MIT-licensed",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
  {
    name: "3d-extraction",
    label: "TripoSR (legacy)",
    description: "Fast but lower quality. Kept for back-compat — prefer SAM 3D Objects.",
    acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFileSizeMb: 20,
  },
];
