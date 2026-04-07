"use client";

import { useCallback, useState, useRef } from "react";

type FileDropzoneProps = {
  accept: string[];
  maxSizeMb: number;
  onFile: (file: File, base64: string) => void;
  label?: string;
  disabled?: boolean;
};

export function FileDropzone({
  accept,
  maxSizeMb,
  onFile,
  label = "Drop a file here or click to upload",
  disabled = false,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);

      if (!accept.some((type) => file.type.startsWith(type.replace("*", "")) || file.type === type)) {
        setError(`Invalid file type. Accepted: ${accept.join(", ")}`);
        return;
      }

      if (file.size > maxSizeMb * 1024 * 1024) {
        setError(`File too large. Max size: ${maxSizeMb} MB`);
        return;
      }

      setFileName(file.name);

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        onFile(file, base64);
      };
      reader.readAsDataURL(file);
    },
    [accept, maxSizeMb, onFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile, disabled],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`
          flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8
          transition-colors cursor-pointer
          ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
        `}
        data-testid="file-dropzone"
      >
        <svg
          className="mb-3 h-10 w-10 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
          />
        </svg>
        <p className="text-sm text-muted-foreground">
          {fileName || label}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Max {maxSizeMb} MB
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={accept.join(",")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          className="hidden"
          disabled={disabled}
        />
      </div>
      {error && (
        <p className="mt-2 text-sm text-destructive" data-testid="dropzone-error">
          {error}
        </p>
      )}
    </div>
  );
}
