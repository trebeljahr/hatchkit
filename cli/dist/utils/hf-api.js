/** Query the HuggingFace Hub API to get model info. */
export async function getModelInfo(modelId) {
    const res = await fetch(`https://huggingface.co/api/models/${modelId}`);
    if (!res.ok) {
        if (res.status === 404) {
            throw new Error(`Model not found: ${modelId}`);
        }
        throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json());
    return {
        modelId: data.id,
        pipelineTag: data.pipeline_tag || "other",
        library: data.library_name || "unknown",
        tags: data.tags || [],
        private: data.private || false,
    };
}
/** Suggest GPU type based on model pipeline and tags. */
export function suggestGpu(info) {
    if (info.pipelineTag === "text-generation" ||
        info.tags.some((t) => t.includes("llama") || t.includes("70b"))) {
        return "A100";
    }
    if (info.pipelineTag === "text-to-image" ||
        info.pipelineTag === "image-segmentation") {
        return "A10G";
    }
    return "T4";
}
//# sourceMappingURL=hf-api.js.map