export type ModelPipelineTag =
  | "text-generation"
  | "text-classification"
  | "token-classification"
  | "image-classification"
  | "object-detection"
  | "image-segmentation"
  | "text-to-image"
  | "image-to-text"
  | "automatic-speech-recognition"
  | "translation"
  | "summarization"
  | "feature-extraction"
  | "other";

export interface HfModelInfo {
  modelId: string;
  pipelineTag: ModelPipelineTag;
  library: string;
  tags: string[];
  private: boolean;
}

/** Query the HuggingFace Hub API to get model info. */
export async function getModelInfo(modelId: string): Promise<HfModelInfo> {
  const res = await fetch(`https://huggingface.co/api/models/${modelId}`);

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Model not found: ${modelId}`);
    }
    throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    id: string;
    pipeline_tag?: string;
    library_name?: string;
    tags?: string[];
    private?: boolean;
  };

  return {
    modelId: data.id,
    pipelineTag: (data.pipeline_tag as ModelPipelineTag) || "other",
    library: data.library_name || "unknown",
    tags: data.tags || [],
    private: data.private || false,
  };
}

/** Suggest GPU type based on model pipeline and tags. */
export function suggestGpu(info: HfModelInfo): string {
  if (
    info.pipelineTag === "text-generation" ||
    info.tags.some((t) => t.includes("llama") || t.includes("70b"))
  ) {
    return "A100";
  }
  if (
    info.pipelineTag === "text-to-image" ||
    info.pipelineTag === "image-segmentation"
  ) {
    return "A10G";
  }
  return "T4";
}
