import type { DiagramPlugin, MermaidInstance } from "@streamdown/mermaid";

type MermaidConfig = Parameters<MermaidInstance["initialize"]>[0];

/**
 * Streamdown diagram plugin that loads Mermaid (hundreds of KB with d3/dagre)
 * only when a diagram actually renders, keeping it off the chat's critical path.
 */
let config: MermaidConfig = { startOnLoad: false };
let loaded: MermaidInstance | undefined;
let pending: Promise<MermaidInstance> | undefined;

function load(): Promise<MermaidInstance> {
  pending ??= import("@streamdown/mermaid").then(({ mermaid }) => (loaded = mermaid.getMermaid(config)));
  return pending;
}

const instance: MermaidInstance = {
  initialize(next) {
    config = { ...config, ...next, startOnLoad: false };
    loaded?.initialize(config);
  },
  async render(id, source) {
    return (await load()).render(id, source);
  },
};

export const lazyMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(next) {
    if (next) instance.initialize(next);
    return instance;
  },
};
