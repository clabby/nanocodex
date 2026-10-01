/** A complete, deterministic supplied-text operation, not a general research verifier.
 * Everything after the exact header is literal data. No model, CRM or external I/O.
 */
export const TODO_TEXT_PROPOSAL_SCOPE = "Verified line-preserving bullet formatting only; supplied text is not fact-checked. No research or external actions.";
const header = /^format this as bullet points:\r?\n/i;
function suppliedLines(request: string, changes: string): string[] | null {
  // Change is a new owner instruction: never silently reuse the old contract.
  if (changes !== "" || !request.isWellFormed() || new TextEncoder().encode(request).length > 4096) return null;
  const match = header.exec(request);
  if (!match) return null;
  const text = request.slice(match[0].length);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text.replaceAll("\r\n", "\n"))) return null;
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  // Ambiguous blank lines/whitespace are not normalized or silently dropped.
  if (!lines.length || lines.length > 100 || lines.some(line => !line.trim() || line !== line.trim())) return null;
  return lines;
}
/** Independent completion check: one prefix per source line, exact bytes/order/count. */
export function verifyTodoTextProposal(request: string, changes: string, proposal: string): boolean {
  const source = suppliedLines(request, changes);
  if (!source || typeof proposal !== "string") return false;
  const output = proposal.split("\n");
  return output.length === source.length && output.every((line, index) => line.startsWith("- ") && line.slice(2) === source[index]);
}
export function prepareTodoTextProposal(request: string, changes: string): string | null {
  const lines = suppliedLines(request, changes);
  if (!lines) return null;
  const proposal = lines.map(line => `- ${line}`).join("\n");
  return verifyTodoTextProposal(request, changes, proposal) ? proposal : null;
}
