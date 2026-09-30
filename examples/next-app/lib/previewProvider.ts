import type { PassFileProvider } from "@erc8426/core";

/// The format that makes this app useful with no Apple or Google account: the
/// rendered PassContent as JSON, served by the issuer like any pass file (at
/// a rotating capability URL, behind the fresh ownership read). The app draws
/// it as a card. `preview` is not a key the standard defines; clients MUST
/// ignore format keys they do not recognize, so wallets simply skip it.
export function previewProvider(): PassFileProvider {
  return {
    format: "preview",
    async passFile(ctx) {
      return {
        body: JSON.stringify({ ...ctx.content, owner: ctx.owner, token: ctx.token }),
        contentType: "application/json",
        filename: "pass.json",
      };
    },
  };
}
