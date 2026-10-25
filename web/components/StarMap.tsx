"use client";

import { useEffect, useRef } from "react";
import { Engine, type Hover } from "@/lib/engine";
import type { WayMap } from "@/lib/types";

type Props = {
  map: WayMap | null;
  threads: Map<number, string>;
  selected: number | null;
  selectedSlice: number | null;
  panelOpen: boolean;
  panelWide: boolean;
  match: Set<number> | null;
  minimap: HTMLCanvasElement | null;
  fitSignal: number;
  tip: HTMLElement | null;
  onSelect: (num: number | null) => void;
  onFog: (index: number) => void;
  onMoon: (num: number) => void;
  onHover: (h: Hover | null) => void;
  onSlice: (num: number) => void;
};

// The space the floating panel takes from the right edge: its width (globals.css #panel and
// #panel.wide) plus its margin on both sides.
const panelSpace = (wide: boolean) => (wide ? Math.min(760, innerWidth * 0.6) : Math.min(440, innerWidth - 32)) + 32;

// The canvas and its engine. The engine owns the render loop and the camera; React only hands
// it data and selection.
export function StarMap({ map, threads, selected, selectedSlice, panelOpen, panelWide, match, minimap, fitSignal, tip, onSelect, onFog, onMoon, onHover, onSlice }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const events = useRef({ onSelect, onFog, onMoon, onHover, onSlice });

  useEffect(() => {
    events.current = { onSelect, onFog, onMoon, onHover, onSlice };
  });

  useEffect(() => {
    const e = new Engine(canvas.current!, {
      onSelect: (n) => events.current.onSelect(n),
      onFog: (i) => events.current.onFog(i),
      onMoon: (n) => events.current.onMoon(n),
      onHover: (h) => events.current.onHover(h),
      onSlice: (n) => events.current.onSlice(n),
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
    engine.current?.setMatch(match);
  }, [match]);

  useEffect(() => {
    if (minimap) return engine.current?.attachMinimap(minimap);
  }, [minimap]);

  useEffect(() => {
    engine.current?.attachTip(tip);
  }, [tip]);

  useEffect(() => {
    if (fitSignal) engine.current?.fit();
  }, [fitSignal]);

  useEffect(() => {
    engine.current?.select(selected, panelOpen ? panelSpace(panelWide) : 0);
  }, [selected, panelOpen, panelWide, map]);

  useEffect(() => {
    engine.current?.selectSlice(selectedSlice, panelOpen ? panelSpace(panelWide) : 0);
  }, [selectedSlice, panelOpen, panelWide, map]);

  return <canvas id="sky" ref={canvas} />;
}
