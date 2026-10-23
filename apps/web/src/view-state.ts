import { useState, type Dispatch, type SetStateAction } from "react";

// Browser-session presentation state only; never part of the graph or model context.
const pageState = new Map<string, unknown>();
export const pageScroll = new Map<string, number>();
export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => pageState.has(key) ? pageState.get(key) as T :
    typeof initial === "function" ? (initial as () => T)() : initial);
  const update: Dispatch<SetStateAction<T>> = action => setValue(previous => {
    const next = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
    pageState.set(key, next); return next;
  });
  return [value, update];
}

export interface BoardViewport {
  zoom: number;
  width?: number;
  height?: number;
  pan: { x: number; y: number };
  positions: Record<string, { x: number; y: number }>;
  layout: string;
  focusSeq: number;
  elementSignature?: string;
}
export const boardViewports = new Map<string, BoardViewport>();
