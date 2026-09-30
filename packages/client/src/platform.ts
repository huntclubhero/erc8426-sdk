import { FORMAT_APPLE, FORMAT_GOOGLE } from "@erc8426/core";

/// A manifest format key. `apple` and `google` are the ones the standard
///  names; the string escape hatch keeps future platforms addressable.
export type WalletPlatform = typeof FORMAT_APPLE | typeof FORMAT_GOOGLE;
export type FormatKey = WalletPlatform | (string & {});

/// Guess the wallet platform from a user agent. iPhone, iPad and iPod (any
///  browser, since they all hand .pkpass to Wallet) and Safari on macOS map to
///  Apple; Android maps to Google; anything else is null, meaning "ask the
///  user or offer both". Never reads `navigator` itself so it is safe to call
///  during server rendering.
export function detectPlatform(userAgent: string | null | undefined): WalletPlatform | null {
  if (!userAgent) return null;
  const ua = userAgent;
  if (/Android/i.test(ua)) return FORMAT_GOOGLE;
  if (/iPhone|iPad|iPod/i.test(ua)) return FORMAT_APPLE;
  // iPadOS 13+ presents a desktop Macintosh user agent; Mobile/ gives it away
  // in Safari. Plain macOS Safari can also add passes to Wallet.
  if (/Macintosh/i.test(ua)) {
    const otherBrowser = /Chrome|Chromium|CriOS|FxiOS|Firefox|Edg\/|EdgA|OPR\/|Opera/i.test(ua);
    if (/Safari/i.test(ua) && !otherBrowser) return FORMAT_APPLE;
  }
  return null;
}

/// Pick a platform from what a manifest offers. An explicit choice wins; a
///  detected platform is used when the manifest has it; otherwise Google is
///  preferred because a Save to Google Wallet link works from any browser,
///  while a .pkpass on a non-Apple device is just a download.
export function choosePlatform(
  available: readonly string[],
  detected: WalletPlatform | null,
): FormatKey | null {
  if (detected && available.includes(detected)) return detected;
  if (available.includes(FORMAT_GOOGLE)) return FORMAT_GOOGLE;
  if (available.includes(FORMAT_APPLE)) return FORMAT_APPLE;
  return null;
}
