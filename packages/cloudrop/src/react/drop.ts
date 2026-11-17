// getDropProps(): drag-and-drop on any element (spec §6.1, M4-B2).

import type { DropProps } from "./types.ts";

/**
 * Handlers that report whether files are dragged over the element and pass dropped files on. Enters and leaves are
 * counted rather than toggled: moving onto a child fires dragenter on the child before dragleave on the element, so a
 * toggle would flicker off over every child.
 */
export function createDropHandlers(setDragOver: (isOver: boolean) => void, onDrop: (files: File[]) => void): DropProps {
  let depth = 0;
  return {
    onDragEnter(event) {
      event.preventDefault();
      depth += 1;
      setDragOver(true);
    },
    // A browser drops only on an element whose dragover was cancelled.
    onDragOver: (event) => event.preventDefault(),
    onDragLeave() {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    },
    onDrop(event) {
      // Without it the browser opens the file in place of the page.
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      onDrop(Array.from(event.dataTransfer.files));
    },
  };
}
