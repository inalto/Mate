import { invoke } from "@tauri-apps/api/core";
import { invokeAi } from "./aiCall";

export interface SummaryResult {
  summary: string;
  /** True when the stored summary was reused (the page text has not changed). */
  cached: boolean;
}

export interface TitleResult {
  title: string;
  cached: boolean;
}

export interface RelatedPage {
  pageId: string;
  /** Cosine similarity of the recognised text, 0.2 to 1. */
  score: number;
}

export interface GraphNode {
  pageId: string;
  title: string;
}

export interface GraphEdge {
  a: string;
  b: string;
  score: number;
}

export interface PageGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Summary of the page's recognised text. Needs AI consent and a key: rejects with a readable
 * message otherwise. Never automatic; call only on an explicit request.
 */
export const summarizePage = (pageId: string): Promise<SummaryResult> => invokeAi("summarize_page", { pageId });

/** A short title for the page, with the same gating and caching as `summarizePage`. */
export const suggestTitle = (pageId: string): Promise<TitleResult> => invokeAi("suggest_title", { pageId });

/** Pages with similar recognised text (local TF-IDF, no network), best first. */
export const relatedPages = (pageId: string, limit = 8): Promise<RelatedPage[]> =>
  invoke("related_pages", { pageId, limit });

/** Pages as nodes and edges between pages scoring at least `minScore` (local, no network). */
export const pageGraph = (minScore = 0.2): Promise<PageGraph> => invoke("page_graph", { minScore });
