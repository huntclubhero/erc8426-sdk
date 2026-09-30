/// Presentation shared by the server (pass rendering) and the browser (the
/// app's own views). Pure functions: no chain access, no Node APIs.

const NAMES = ["Biscuit", "Pixel", "Mochi", "Nimbus", "Pebble", "Juniper", "Waffle", "Comet", "Tofu", "Maple", "Ziggy", "Clover"];
const KINDS = ["Fox", "Owl", "Axolotl", "Otter", "Capybara", "Hedgehog", "Red panda", "Quokka"];

/// One background per token, all with white text at AA contrast.
const PALETTE = ["#1f4e79", "#6b2f8f", "#0f6b5c", "#8a3b12", "#2f3d8f", "#7a1f3d", "#35611f", "#5a3f2b"];

export function petName(tokenId: string | bigint): string {
  const n = Number(BigInt(tokenId) % 997n);
  return `${NAMES[n % NAMES.length]} the ${KINDS[Math.floor(n / NAMES.length) % KINDS.length]}`;
}

export function petColor(tokenId: string | bigint): string {
  return PALETTE[Number(BigInt(tokenId) % BigInt(PALETTE.length))]!;
}

export interface PetState {
  tokenId: string;
  owner: string;
  alive: boolean;
  hunger: number;
  thirst: number;
  boredom: number;
  cares: number;
  diesAt: number;
  lastFed: number;
  lastWatered: number;
  lastPlayed: number;
}

/// "in 2 days", "in 3 hours", "5 minutes ago".
export function relativeTime(unixSeconds: number, now: number = Date.now() / 1000): string {
  const diff = unixSeconds - now;
  const abs = Math.abs(diff);
  const [value, unit] =
    abs >= 86400 ? [Math.round(abs / 86400), "day"] : abs >= 3600 ? [Math.round(abs / 3600), "hour"] : abs >= 60 ? [Math.round(abs / 60), "minute"] : [Math.round(abs), "second"];
  const label = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

export function mood(state: Pick<PetState, "alive" | "hunger" | "thirst" | "boredom">): string {
  if (!state.alive) return "Lapsed";
  const worst = Math.max(state.hunger, state.thirst, state.boredom);
  if (worst < 34) return "Thriving";
  if (worst < 67) return "Needs care soon";
  return "Needs care now";
}

export function shortHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
