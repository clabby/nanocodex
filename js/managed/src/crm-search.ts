/** Search keys only: never rewrite names, identities, or source evidence. */
const greek: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th",
  ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p",
  ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
}
function transliterate(value: string): string {
  return value.replace(/ου/g, "ou").replace(/αυ/g, "av").replace(/ευ/g, "ev").replace(/γγ/g, "ng").replace(/[α-ω]/g, letter => greek[letter] ?? letter)
    // Common gamma spellings, applied at word boundaries, not contact aliases.
    .replace(/(^|[^a-z])yi/g, "$1gi").replace(/(^|[^a-z])y(?=[aeou])/g, "$1gi").replace(/kh/g, "ch").replace(/y/g, "i");
}
export function crmSearchMatcher(query: string): (value: string) => boolean {
  const folded = fold(query), latin = transliterate(folded);
  return value => {
    const candidate = fold(value), romanized = transliterate(candidate);
    // Combining marks alone must not match every record.
    return folded.length > 0 && (candidate.includes(folded) || romanized.includes(latin)
      // Greeklish x can stand for either chi (ch) or xi (x). Preserve both.
      || romanized.replace(/ch/g, "x").includes(latin.replace(/ch/g, "x")));
  };
}

/** Merge expanded name matches with the existing SQL results before pagination.
 * Only narrow candidates cross the DB boundary. If SQL already found a full
 * page, candidates after its lookahead cannot change that page and aren't read.
 * No scan cap: a sparse late match must not silently disappear. */
export async function crmExpandedSearch<T extends { id: string }>(options: {
  exact: T[];
  size: number;
  batchSize: number;
  read(after: T | undefined, through: T | undefined, count: number): Promise<T[]>;
  matches(row: T): boolean;
  compare(a: T, b: T): number;
}): Promise<T[]> {
  const found = new Map(options.exact.map(row => [row.id, row]));
  let after: T | undefined;
  const through = options.exact.length > options.size ? options.exact.at(-1) : undefined;
  const batchSize = options.batchSize;
  let expanded = 0;
  while (expanded <= options.size) {
    const rows = await options.read(after, through, batchSize);
    for (const row of rows) {
      if (options.matches(row)) { found.set(row.id, row); expanded++; }
      if (expanded > options.size) break;
    }
    if (rows.length < batchSize) break;
    after = rows.at(-1);
  }
  return [...found.values()].sort(options.compare).slice(0, options.size + 1);
}
