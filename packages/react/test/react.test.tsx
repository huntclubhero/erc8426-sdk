// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WALLET_PASS_INTERFACE_ID } from "@erc8426/core";
import { createWalletPassClient } from "@erc8426/client";
import {
  AddToWalletButton,
  WalletPassProvider,
  defaultNavigate,
  usePassUpdates,
  useSupportsWalletPass,
  useWalletPass,
} from "@erc8426/react";
import type { ReactNode } from "react";

import { fakeChain, fakeIssuer } from "../../client/test/fixtures.js";

const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");

afterEach(cleanup);

function setup(mode: "public" | "gated", extra: Partial<Parameters<typeof fakeIssuer>[0]> = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const issuer = fakeIssuer({ contract: CONTRACT, mode, ownerOf: () => owner.address, ...extra });
  const chain = fakeChain({ contracts: { [CONTRACT]: { interfaces: [WALLET_PASS_INTERFACE_ID], passURI: (id) => issuer.passUri(id) } } });
  const client = createWalletPassClient({ publicClient: chain.client, fetch: issuer.fetch });
  const wrapper = ({ children }: { children: ReactNode }) => <WalletPassProvider client={client}>{children}</WalletPassProvider>;
  return { owner, issuer, chain, client, wrapper };
}

describe("AddToWalletButton", () => {
  it("renders an accessible button with the issuing contract and fetches nothing until clicked", async () => {
    const { issuer, wrapper } = setup("public");
    const navigate = vi.fn();
    render(<AddToWalletButton contract={CONTRACT} tokenId={7} platform="apple" navigate={navigate} />, { wrapper });
    const button = screen.getByRole("button", { name: "Add to Apple Wallet" });
    expect(button.getAttribute("type")).toBe("button");
    expect(screen.getByText("Issued by contract 0x5F9B...c2e1").getAttribute("title")).toBe(CONTRACT);
    expect(button.getAttribute("aria-describedby")).toContain(screen.getByText(/Issued by/).id);
    expect(issuer.requests).toHaveLength(0);

    fireEvent.click(button);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate.mock.calls[0]![0]).toMatch(/^https:\/\/issuer\.test\/files\/7-0\.pkpass$/);
    expect(issuer.requests.length).toBeGreaterThan(0);
  });

  it("labels Google with Google's wording and hides the issuer when asked", () => {
    const { wrapper } = setup("public");
    render(<AddToWalletButton contract={CONTRACT} tokenId={7} platform="google" showIssuer={false} />, { wrapper });
    expect(screen.getByRole("button", { name: "Save to Google Wallet" })).toBeTruthy();
    expect(screen.queryByText(/Issued by/)).toBeNull();
  });

  it("uses children (for an official badge) while keeping an accessible name", () => {
    const { wrapper } = setup("public");
    render(
      <AddToWalletButton contract={CONTRACT} tokenId={7} platform="apple">
        {({ platform }) => <img alt="" src={`/badges/${platform}.svg`} />}
      </AddToWalletButton>,
      { wrapper },
    );
    const button = screen.getByRole("button", { name: "Add to Apple Wallet" });
    expect(button.querySelector("img")?.getAttribute("src")).toBe("/badges/apple.svg");
  });

  it("detects the platform after mount from the user agent", async () => {
    const spy = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    const { wrapper } = setup("public");
    render(<AddToWalletButton contract={CONTRACT} tokenId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Save to Google Wallet" });
    spy.mockRestore();
  });

  it("shows a loading state, then an alert and calls onError on refusal", async () => {
    const { wrapper } = setup("gated");
    const stranger = privateKeyToAccount(generatePrivateKey());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const signer = { address: stranger.address, signMessage: async (a: { message: string }) => (await gate, stranger.signMessage(a)) };
    const onError = vi.fn();
    const navigate = vi.fn();
    render(<AddToWalletButton contract={CONTRACT} tokenId={7} platform="apple" signer={signer} onError={onError} navigate={navigate} />, { wrapper });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true"));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The connected wallet does not own this token.");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "not_owner" }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks for a wallet when a gated pass is clicked without a signer", async () => {
    const { wrapper } = setup("gated");
    render(<AddToWalletButton contract={CONTRACT} tokenId={7} platform="google" />, { wrapper });
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Connect the wallet/);
  });

  it("signs and navigates for the owner of a gated pass", async () => {
    const { wrapper, owner } = setup("gated");
    const navigate = vi.fn();
    const onAdded = vi.fn();
    render(<AddToWalletButton contract={CONTRACT} tokenId={7} platform="google" signer={owner} navigate={navigate} onAdded={onAdded} />, { wrapper });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0]![0]).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ configuration: "gated", platform: "google" }));
  });
});

describe("hooks", () => {
  it("useSupportsWalletPass checks ERC-165 in an effect", async () => {
    const { wrapper } = setup("public");
    const { result } = renderHook(() => useSupportsWalletPass(CONTRACT), { wrapper });
    expect(result.current.supported).toBeUndefined();
    await waitFor(() => expect(result.current).toMatchObject({ status: "success", supported: true }));
  });

  it("useWalletPass exposes status, platform and addToWallet", async () => {
    const { wrapper } = setup("public");
    const navigate = vi.fn();
    const { result } = renderHook(() => useWalletPass({ contract: CONTRACT, tokenId: 2, platform: "apple", checkSupport: true, navigate }), { wrapper });
    expect(result.current.status).toBe("idle");
    await waitFor(() => expect(result.current.supported).toBe(true));
    let out: Awaited<ReturnType<typeof result.current.addToWallet>> = null;
    await act(async () => {
      out = await result.current.addToWallet();
    });
    expect(out).toMatchObject({ platform: "apple" });
    expect(result.current.status).toBe("added");
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("usePassUpdates reports updates covering the watched token", async () => {
    const { wrapper, chain } = setup("public");
    const { result } = renderHook(() => usePassUpdates(CONTRACT, { tokenId: 5, pollingInterval: 10 }), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    chain.mine({ address: CONTRACT, event: "PassUpdate", args: [4n] });
    chain.mine({ address: CONTRACT, event: "BatchPassUpdate", args: [1n, 10n] });
    await waitFor(() => expect(result.current.count).toBe(1), { timeout: 2000 });
    expect(result.current.lastUpdate?.kind).toBe("batch");
  });

  it("throws a clear error outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSupportsWalletPass(CONTRACT))).toThrow(/WalletPassProvider/);
  });
});

describe("audit #2: navigation is https only", () => {
  it("defaultNavigate refuses javascript:, data: and non-local http", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "http://issuer.example/p.pkpass"]) {
      expect(() => defaultNavigate(url)).toThrow(/not https/);
    }
  });

  it("the hook never hands an unsafe URL to a custom navigate", async () => {
    const { client } = setup("public");
    const hostile = { ...client, addToWallet: async () => ({ url: "javascript:alert(1)", platform: "apple", configuration: "public", manifest: { formats: {} } }) } as unknown as typeof client;
    const navigate = vi.fn();
    const onError = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <WalletPassProvider client={hostile}>{children}</WalletPassProvider>;
    const { result } = renderHook(() => useWalletPass({ contract: CONTRACT, tokenId: 1, platform: "apple", navigate, onError }), { wrapper });
    await act(async () => {
      await result.current.addToWallet();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_manifest" }));
  });
});
