import type { ImageSource } from "@erc8426/core";

/// Apple embeds image bytes in the signed bundle, so a URL source is fetched
///  at build time. The fetch is bounded in size and time: pass builds sit on
///  the device refresh path, and a slow or huge image must not park it.

export interface ImageFetchOptions {
  /// Defaults to the global fetch.
  fetch?: typeof fetch;
  /// Per image. Defaults to 5 seconds.
  timeoutMs?: number;
  /// Per image. Defaults to 2 MiB, well above any sane pass asset.
  maxBytes?: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(data: Uint8Array): boolean {
  return data.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => data[i] === b);
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`image ${url} is ${declared} bytes, over the ${maxBytes} byte cap`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  // Stream with a running count, because Content-Length can be absent or wrong.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`image ${url} exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function fetchImage(url: string, opts: ImageFetchOptions = {}): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`image url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`image url must be http(s): ${url}`);
  }
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000), redirect: "follow" });
  if (!res.ok) throw new Error(`image ${url} answered ${res.status}`);
  const data = await readCapped(res, opts.maxBytes ?? 2 * 1024 * 1024, url);
  // Wallet renders PNG only, and a wrong format fails silently on the device
  // (the pass installs with a blank slot), so refuse it here where it is visible.
  if (!isPng(data)) throw new Error(`image ${url} is not a PNG`);
  return data;
}

/// Resolve one image slot into bundle entries: `<name>.png`, and the @2x / @3x
///  variants when supplied. Bytes win over a URL for the base resolution.
export async function resolveImage(
  name: string,
  source: ImageSource,
  opts: ImageFetchOptions = {},
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const base = source.data ?? (source.url ? await fetchImage(source.url, opts) : undefined);
  if (base) out[`${name}.png`] = base;
  if (source.data2x) out[`${name}@2x.png`] = source.data2x;
  if (source.data3x) out[`${name}@3x.png`] = source.data3x;
  for (const [file, bytes] of Object.entries(out)) {
    if (!isPng(bytes)) throw new Error(`image ${file} is not a PNG`);
  }
  return out;
}
