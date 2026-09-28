"use client";

/**
 * ResizeHandle — drag-to-resize divider between panels (point 2: resize by
 * dragging edges). Smooth pointer-based dragging, Tailwind-styled.
 * ISOLATION: new file under components/ide/.
 */
import React from "react";

/* ========================================================================== *
 *  ResizeHandle — pointer-drag divider that reports a delta to the parent
 * ========================================================================== */
export function ResizeHandle({
  dir,
  onDelta,
}: {
  dir: "x" | "y";
  onDelta: (delta: number) => void;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    let last = dir === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = dir === "x" ? ev.clientX : ev.clientY;
      onDelta(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className={
        dir === "x"
          ? "w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-violet-500/40 transition-colors"
          : "h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-violet-500/40 transition-colors"
      }
    />
  );
}

export default ResizeHandle;
