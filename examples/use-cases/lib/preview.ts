// SPDX-License-Identifier: MIT
import type { PassContent, PassContext, PassFileProvider } from "@erc8426/core";

/// A stand-in wallet platform for local demos. Apple and Google passes need
///  issuer certificates and platform accounts, so the demos plug in this
///  provider instead: it serves the rendered `PassContent` as JSON under the
///  manifest key `preview`, from the issuer's own rotating capability
///  download URL, and prints every push a real platform would deliver to an
///  installed pass. Swap in `@erc8426/apple` and `@erc8426/google` providers
///  for production; nothing else in an issuer changes.
export interface PreviewProvider extends PassFileProvider {
  /// Every push, in order, as the device would receive it.
  readonly pushes: Array<{ tokenId: string; content: PassContent }>;
}

export function previewProvider(onPush?: (tokenId: string, content: PassContent) => void): PreviewProvider {
  const pushes: Array<{ tokenId: string; content: PassContent }> = [];
  return {
    format: "preview",
    pushes,
    async passFile(ctx: PassContext) {
      return { body: JSON.stringify(ctx.content), contentType: "application/json", filename: "pass.json" };
    },
    async notifyUpdate(ctx: PassContext) {
      pushes.push({ tokenId: ctx.token.tokenId, content: ctx.content });
      onPush?.(ctx.token.tokenId, ctx.content);
    },
  };
}

/// What a pass "installed" from a preview download looks like on device.
export async function downloadPreview(url: string): Promise<PassContent> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pass download refused: ${res.status} ${await res.text()}`);
  return (await res.json()) as PassContent;
}
