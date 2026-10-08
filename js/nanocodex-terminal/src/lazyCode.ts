import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult, ThemeInput } from "@streamdown/code";

/**
 * Streamdown code-highlighter plugin that loads Shiki (its grammar registry,
 * TextMate runtime and JavaScript regex engine) only when a code block first
 * renders, keeping it off the chat's critical path. Streamdown renders the
 * plain block until the asynchronous highlight callback arrives, exactly as it
 * does while the real plugin loads a grammar.
 */
const themes: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
let loaded: CodeHighlighterPlugin | undefined;
let pending: Promise<CodeHighlighterPlugin> | undefined;

function load(): Promise<CodeHighlighterPlugin> {
  pending ??= import("@streamdown/code").then(({ code }) => (loaded = code)).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

export const lazyCode: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => themes,
  getSupportedLanguages: () => loaded?.getSupportedLanguages() ?? [],
  // Before Shiki loads, accept every language: the real plugin maps unknown
  // languages to plain text once it highlights.
  supportsLanguage: (language) => loaded?.supportsLanguage(language) ?? true,
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void) {
    if (loaded) return loaded.highlight(options, callback);
    load().then((plugin) => {
      const result = plugin.highlight(options, callback);
      if (result) callback?.(result);
    }).catch((error: unknown) => {
      console.error("[Streamdown Code] Failed to load highlighter:", error);
    });
    return null;
  },
};
