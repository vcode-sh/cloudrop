// getDropProps(): drag-and-drop on any element (spec §6.1, M4-B2).

import type { DragEvent } from "react";
import type { DropProps } from "./types.ts";

/**
 * Handlers that report whether files are dragged over the element and pass dropped files on. Enters and leaves are
 * counted rather than toggled: moving onto a child fires dragenter on the child before dragleave on the element, so a
 * toggle would flicker off over every child. Only drags that carry files count: dragged text or a link keeps the
 * browser's own behaviour, such as dropping text into an input inside the element.
 */
export function createDropHandlers(setDragOver: (isOver: boolean) => void, onDrop: (files: File[]) => void): DropProps {
  let depth = 0;
  const hasFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");
  return {
    onDragEnter(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragOver(true);
    },
    // A browser drops only on an element whose dragover was cancelled.
    onDragOver(event) {
      if (hasFiles(event)) event.preventDefault();
    },
    onDragLeave(event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    },
    onDrop(event) {
      if (!hasFiles(event)) return;
      // Without it the browser opens the file in place of the page.
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      onDrop(Array.from(event.dataTransfer.files));
    },
  };
}
