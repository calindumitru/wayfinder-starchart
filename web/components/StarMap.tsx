"use client";

import { useEffect, useRef } from "react";
import { Engine } from "@/lib/engine";
import type { WayMap } from "@/lib/types";

type Props = {
  map: WayMap | null;
  threads: Map<number, string>;
  selected: number | null;
  panelOpen: boolean;
  onSelect: (num: number | null) => void;
  onFog: (index: number) => void;
};

// The canvas and its engine. The engine owns the render loop and the camera; React only hands
// it data and selection.
export function StarMap({ map, threads, selected, panelOpen, onSelect, onFog }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const events = useRef({ onSelect, onFog });

  useEffect(() => {
    events.current = { onSelect, onFog };
  });

  useEffect(() => {
    const e = new Engine(canvas.current!, {
      onSelect: (n) => events.current.onSelect(n),
      onFog: (i) => events.current.onFog(i),
    });
    engine.current = e;
    return () => e.destroy();
  }, []);

  useEffect(() => {
    if (map) engine.current?.setMap(map);
  }, [map]);

  useEffect(() => {
    engine.current?.setThreads(threads);
  }, [threads]);

  useEffect(() => {
    const panel = panelOpen ? Math.min(440, innerWidth * 0.86) : 0;
    engine.current?.select(selected, panel);
  }, [selected, panelOpen, map]);

  return <canvas id="sky" ref={canvas} />;
}
