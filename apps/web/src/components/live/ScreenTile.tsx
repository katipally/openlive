"use client";

import { useEffect, useRef, useState } from "react";
import { MonitorUp } from "lucide-react";

// A floating shared-screen tile — like the camera PiP but wider (16:9) and
// object-contain so text stays readable. Draggable, corner-resizable, clamped to
// the stage.
export function ScreenTile({ stream }: { stream: MediaStream | null }) {
  const vidRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: -1, y: -1 });
  const [w, setW] = useState(560);
  const h = Math.round(w * 9 / 16);

  useEffect(() => { if (vidRef.current) vidRef.current.srcObject = stream; }, [stream]);

  // Spotlight on first mount: upper-centre of the stage.
  useEffect(() => {
    if (pos.x >= 0 || !boxRef.current?.parentElement) return;
    const p = boxRef.current.parentElement.getBoundingClientRect();
    const width = Math.min(w, Math.round(p.width * 0.6));
    if (width !== w) setW(width);
    setPos({ x: Math.max(8, (p.width - width) / 2 + 60), y: Math.max(8, p.height * 0.14) });
  }, [pos.x, w]);

  const clamp = (x: number, y: number, ww: number, hh: number) => {
    const p = boxRef.current?.parentElement?.getBoundingClientRect();
    if (!p) return { x, y };
    return { x: Math.max(8, Math.min(x, p.width - ww - 8)), y: Math.max(8, Math.min(y, p.height - hh - 8)) };
  };

  const onDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.resize) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
    const move = (ev: PointerEvent) => setPos(clamp(ox + (ev.clientX - sx), oy + (ev.clientY - sy), w, h));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const onResize = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, ow = w;
    const move = (ev: PointerEvent) => setW(Math.max(240, Math.min(920, ow + (ev.clientX - sx))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  return (
    <div ref={boxRef} onPointerDown={onDrag}
      style={{ left: pos.x < 0 ? undefined : pos.x, top: pos.x < 0 ? 72 : pos.y, width: w, height: h, right: pos.x < 0 ? 16 : undefined, opacity: pos.x < 0 ? 0 : 1 }}
      className="group absolute z-30 cursor-grab touch-none overflow-hidden rounded-xl border border-border/60 bg-black shadow-2xl shadow-black/40 active:cursor-grabbing">
      {stream
        ? <video ref={vidRef} autoPlay muted playsInline className="h-full w-full object-contain" />
        : <div className="grid h-full place-items-center text-muted-foreground"><MonitorUp className="size-6" /></div>}
      <span data-resize onPointerDown={onResize}
        className="absolute bottom-0 right-0 size-5 cursor-nwse-resize opacity-0 transition group-hover:opacity-100"
        style={{ background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,.5) 50%)" }} />
    </div>
  );
}
