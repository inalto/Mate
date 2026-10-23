// Page graph: pages as nodes, edges between pages with similar recognised text (local TF-IDF).
import {
  forceCenter,
  type ForceLink,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { showToast } from "../components/Toast";
import { pageGraph, type GraphNode, type PageGraph } from "../ipc/semantics";

const WIDTH = 1000;
const HEIGHT = 700;
const DEFAULT_CUTOFF = 0.2;
/** Fetch down to here once; the slider then filters locally. */
const FETCH_FLOOR = 0.05;

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { score: number };

export default function Graph() {
  const navigate = useNavigate();
  const [graph, setGraph] = useState<PageGraph | null>(null);
  const [cutoff, setCutoff] = useState(DEFAULT_CUTOFF);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());

  useEffect(() => {
    let live = true;
    pageGraph(FETCH_FLOOR)
      .then((g) => {
        if (live) setGraph(g);
      })
      .catch((e) => {
        if (live) setGraph({ nodes: [], edges: [] });
        showToast(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const edges = useMemo(() => (graph?.edges ?? []).filter((e) => e.score >= cutoff), [graph, cutoff]);

  // The simulation (and so every node position) lives as long as the graph; a new cutoff only
  // swaps the links and reheats it.
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const linksRef = useRef<SimLink[]>([]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>([])
          .id((n) => n.pageId)
          .distance((l) => 140 - 90 * l.score)
          .strength((l) => 0.2 + 0.6 * l.score),
      )
      .force("charge", forceManyBody().strength(-160))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("collide", forceCollide(18))
      .on("tick", () => {
        for (const n of nodes) {
          nodeEls.current.get(n.pageId)?.setAttribute("transform", `translate(${n.x ?? 0} ${n.y ?? 0})`);
        }
        for (const l of linksRef.current) {
          const s = l.source as SimNode;
          const t = l.target as SimNode;
          const el = edgeEls.current.get(`${s.pageId}|${t.pageId}`);
          el?.setAttribute("x1", String(s.x ?? 0));
          el?.setAttribute("y1", String(s.y ?? 0));
          el?.setAttribute("x2", String(t.x ?? 0));
          el?.setAttribute("y2", String(t.y ?? 0));
        }
      });
    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const links: SimLink[] = edges.map((e) => ({ source: e.a, target: e.b, score: e.score }));
    linksRef.current = links;
    sim.force<ForceLink<SimNode, SimLink>>("link")?.links(links);
    sim.alpha(0.3).restart();
  }, [graph, edges]);

  const empty = graph !== null && graph.nodes.length === 0;
  return (
    <div className="graph-page">
      <header className="graph-header">
        <h1>Graph</h1>
        <label className="graph-cutoff">
          Similarity cutoff
          <input
            type="range"
            min={0.05}
            max={0.9}
            step={0.05}
            value={cutoff}
            onChange={(e) => setCutoff(Number(e.target.value))}
            aria-valuetext={`${Math.round(cutoff * 100)}%`}
          />
          <output>{Math.round(cutoff * 100)}%</output>
        </label>
      </header>
      {graph === null && <p className="muted">Loading…</p>}
      {empty && (
        <p className="graph-empty">
          Nothing to connect yet. Pages appear here once the tutor has read your handwriting, and similar pages are
          linked.
        </p>
      )}
      {graph && !empty && (
        <>
          {edges.length === 0 && (
            <p className="muted">No pages are this similar. Lower the similarity cutoff to see weaker links.</p>
          )}
          <svg
            className="graph-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label={`Page graph, ${graph.nodes.length} pages and ${edges.length} links`}
          >
            <g>
              {edges.map((e) => (
                <line
                  key={`${e.a}|${e.b}`}
                  ref={(el) => {
                    if (el) edgeEls.current.set(`${e.a}|${e.b}`, el);
                    else edgeEls.current.delete(`${e.a}|${e.b}`);
                  }}
                  className="graph-edge"
                  strokeWidth={1 + 3 * e.score}
                />
              ))}
            </g>
            <g>
              {graph.nodes.map((n) => (
                <g
                  key={n.pageId}
                  ref={(el) => {
                    if (el) nodeEls.current.set(n.pageId, el);
                    else nodeEls.current.delete(n.pageId);
                  }}
                  className="graph-node"
                  tabIndex={0}
                  role="link"
                  aria-label={n.title || "Untitled"}
                  transform={`translate(${WIDTH / 2} ${HEIGHT / 2})`}
                  onClick={() => navigate(`/edit/${n.pageId}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/edit/${n.pageId}`)}
                >
                  <circle r={9} />
                  <text x={14} y={4}>
                    {n.title || "Untitled"}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </>
      )}
    </div>
  );
}
