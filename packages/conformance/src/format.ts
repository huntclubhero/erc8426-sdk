import type { CheckResult, ConformanceReport } from "./types.js";

/// PASS, FAIL (a MUST failed), WARN (a SHOULD failed) or SKIP.
export function statusLabel(check: CheckResult): "PASS" | "FAIL" | "WARN" | "SKIP" {
  if (check.status === "pass") return "PASS";
  if (check.status === "skip") return "SKIP";
  return check.level === "MUST" ? "FAIL" : "WARN";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/// A plain-text report: a header, one row per check, and the summary line.
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`ERC-8426 conformance: contract ${report.contract} token ${report.tokenId} on chain ${report.chainId ?? "?"}`);
  if (report.passUri) lines.push(`passURI: ${report.passUri}`);
  lines.push(`configuration: ${report.configuration}${report.ownerAddress ? ` (owner key for ${report.ownerAddress})` : ""}`);
  lines.push("");
  const idWidth = Math.max(2, ...report.checks.map((c) => c.id.length));
  lines.push(`${pad("RESULT", 6)}  ${pad("LEVEL", 6)}  ${pad("CHECK", idWidth)}  DESCRIPTION`);
  for (const c of report.checks) {
    lines.push(`${pad(statusLabel(c), 6)}  ${pad(c.level, 6)}  ${pad(c.id, idWidth)}  ${c.title} [${c.section}]`);
    if (c.detail && c.status !== "pass") lines.push(`${" ".repeat(16 + idWidth)}${c.detail}`);
  }
  lines.push("");
  const s = report.summary;
  lines.push(`${s.pass} passed, ${s.fail} failed (MUST), ${s.warn} warnings (SHOULD), ${s.skip} skipped`);
  lines.push(report.ok ? "Result: CONFORMS to every MUST checked" : "Result: DOES NOT CONFORM");
  return lines.join("\n");
}
