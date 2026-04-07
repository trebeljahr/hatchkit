import { env } from "../config/env.js";
import { getPresignedUploadUrl, getPublicUrl } from "./storage.js";
import { randomUUID } from "crypto";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// ML endpoint configuration
// ---------------------------------------------------------------------------

function getEndpoint(service: string): string {
  const key = `ML_${service.toUpperCase().replace(/-/g, "_")}_ENDPOINT` as keyof typeof env;
  const endpoint = env[key] as string | undefined;
  if (!endpoint) {
    throw new Error(`ML service "${service}" is not configured. Set ${key} in environment variables.`);
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function callMlEndpoint(
  service: string,
  formData: FormData,
): Promise<Response> {
  const endpoint = getEndpoint(service);
  const res = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ML service "${service}" returned ${res.status}: ${text}`);
  }
  return res;
}

async function uploadResultToS3(
  data: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const s3 = new S3Client({
    region: env.AWS_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
      Body: data,
      ContentType: contentType,
    }),
  );

  return getPublicUrl(key);
}

// ---------------------------------------------------------------------------
// Background Removal
// ---------------------------------------------------------------------------

export async function removeBackground(
  imageBase64: string,
  model: string,
): Promise<{ imageUrl: string; width: number; height: number }> {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "input.png");
  formData.append("model", model);

  const res = await callMlEndpoint("background-removal", formData);

  const resultBuffer = Buffer.from(await res.arrayBuffer());
  const width = parseInt(res.headers.get("X-Image-Width") || "0", 10);
  const height = parseInt(res.headers.get("X-Image-Height") || "0", 10);

  const key = `ml/bg-removal/${randomUUID()}.png`;
  const imageUrl = await uploadResultToS3(resultBuffer, key, "image/png");

  return { imageUrl, width, height };
}

// ---------------------------------------------------------------------------
// Subtitle Generation
// ---------------------------------------------------------------------------

export async function generateSubtitles(
  audioBase64: string,
  language?: string,
  model: string = "large-v3",
  format: string = "json",
): Promise<{
  text: string;
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
}> {
  const audioBuffer = Buffer.from(audioBase64, "base64");
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer]), "input.mp3");
  if (language) formData.append("language", language);
  formData.append("model", model);
  formData.append("format", "json");

  const res = await callMlEndpoint("subtitles", formData);
  return res.json() as Promise<{
    text: string;
    language: string;
    segments: Array<{ start: number; end: number; text: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Image Recognition
// ---------------------------------------------------------------------------

export async function recognizeImage(
  imageBase64: string,
  labels?: string[],
  topK: number = 5,
): Promise<{ results: Array<{ label: string; score: number }> }> {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "input.png");
  if (labels) formData.append("labels", labels.join(","));
  formData.append("top_k", String(topK));

  const res = await callMlEndpoint("image-recognition", formData);
  return res.json() as Promise<{ results: Array<{ label: string; score: number }> }>;
}

// ---------------------------------------------------------------------------
// 3D Model Extraction
// ---------------------------------------------------------------------------

export async function generate3dModel(
  imageBase64: string,
  removeBg: boolean = true,
  resolution: number = 256,
): Promise<{ glbUrl: string; vertices: number }> {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "input.png");
  formData.append("remove_bg", String(removeBg));
  formData.append("resolution", String(resolution));

  const res = await callMlEndpoint("3d-extraction", formData);

  const glbBuffer = Buffer.from(await res.arrayBuffer());
  const vertices = parseInt(res.headers.get("X-Vertex-Count") || "0", 10);

  const key = `ml/3d-models/${randomUUID()}.glb`;
  const glbUrl = await uploadResultToS3(glbBuffer, key, "model/gltf-binary");

  return { glbUrl, vertices };
}
