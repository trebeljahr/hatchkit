"use client";

import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { FileDropzone } from "@/components/ml/file-dropzone";
import { SubtitleViewer } from "@/components/ml/result-viewer-subtitles";

export default function SubtitlesPage() {
  const [model, setModel] = useState<"large-v3" | "medium" | "small" | "base">("large-v3");
  const [language, setLanguage] = useState("");

  const mutation = trpc.ml.generateSubtitles.useMutation();

  const handleFile = useCallback(
    (_file: File, base64: string) => {
      mutation.mutate({
        audioBase64: base64,
        model,
        language: language || undefined,
        format: "json",
      });
    },
    [model, language, mutation],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <FileDropzone
            accept={["audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm"]}
            maxSizeMb={100}
            onFile={handleFile}
            label="Drop an audio or video file to generate subtitles"
            disabled={mutation.isPending}
          />
        </div>
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as typeof model)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
              disabled={mutation.isPending}
            >
              <option value="large-v3">Whisper Large v3 (best)</option>
              <option value="medium">Whisper Medium (faster)</option>
              <option value="small">Whisper Small</option>
              <option value="base">Whisper Base (fastest)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Language (auto-detect if empty)
            </label>
            <input
              type="text"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="e.g. en, es, de"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={mutation.isPending}
            />
          </div>
        </div>
      </div>

      {mutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Transcribing... (this may take a minute for longer files)
        </div>
      )}

      {mutation.error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {mutation.error.message}
        </div>
      )}

      {mutation.data && (
        <SubtitleViewer
          segments={mutation.data.segments}
          language={mutation.data.language}
        />
      )}
    </div>
  );
}
