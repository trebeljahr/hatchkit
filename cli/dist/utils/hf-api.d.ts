export type ModelPipelineTag = "text-generation" | "text-classification" | "token-classification" | "image-classification" | "object-detection" | "image-segmentation" | "text-to-image" | "image-to-text" | "automatic-speech-recognition" | "translation" | "summarization" | "feature-extraction" | "other";
export interface HfModelInfo {
    modelId: string;
    pipelineTag: ModelPipelineTag;
    library: string;
    tags: string[];
    private: boolean;
}
/** Query the HuggingFace Hub API to get model info. */
export declare function getModelInfo(modelId: string): Promise<HfModelInfo>;
/** Suggest GPU type based on model pipeline and tags. */
export declare function suggestGpu(info: HfModelInfo): string;
//# sourceMappingURL=hf-api.d.ts.map