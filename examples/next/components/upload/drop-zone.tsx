"use client";

import { IconUpload } from "@tabler/icons-react";
import { useUpload } from "@/lib/upload";

/**
 * A label around a hidden file input: a click anywhere on it opens the file picker, Tab reaches the input and Enter or
 * Space opens the picker, and files dropped on it upload. The input stays in the page (sr-only, not display: none), so
 * it keeps its keyboard focus and its name for screen readers.
 */
export function DropZone() {
  const { isDragOver, getDropProps, getInputProps } = useUpload("files", { multiple: true });
  return (
    <label
      {...getDropProps()}
      data-drag-over={isDragOver || undefined}
      className="flex cursor-pointer flex-col items-center gap-2 rounded-3xl border border-dashed p-10 text-center transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/30 data-drag-over:border-primary data-drag-over:bg-muted"
    >
      <IconUpload aria-hidden className="size-6 text-muted-foreground" />
      <span className="font-medium">{isDragOver ? "Drop to upload" : "Drop files here, or click to choose"}</span>
      <span className="text-muted-foreground text-xs">
        Text, PDF, images, audio, video and other binary files, up to 100 MB each
      </span>
      <input {...getInputProps()} aria-label="Files to upload" className="sr-only" />
    </label>
  );
}
