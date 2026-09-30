import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Address } from "viem";
import { getAddress } from "viem";
import { WalletPassError } from "@erc8426/core";
import { shortAddress, type AddToWalletResult, type FormatKey, type WalletPassSigner } from "@erc8426/client";

import { useWalletPass } from "./hooks.js";

/// The button label for a platform, following each platform's own wording.
export function labelForPlatform(platform: FormatKey | null): string {
  if (platform === "apple") return "Add to Apple Wallet";
  if (platform === "google") return "Save to Google Wallet";
  return "Add to Wallet";
}

/// A short, user-facing sentence for a failure. The error object itself is
///  passed to `onError` for anything more specific.
export function describeError(error: Error): string {
  if (error instanceof WalletPassError) {
    switch (error.code) {
      case "proof_required":
        return "Connect the wallet that owns this token to get its pass.";
      case "not_owner":
        return "The connected wallet does not own this token.";
      case "read_failed":
        return "Ownership could not be verified right now. Try again shortly.";
      case "unsupported":
        return "This pass is not available for this wallet.";
      case "domain_mismatch":
      case "binding_mismatch":
      case "challenge_expired":
      case "invalid_message":
        return "The issuer asked for a signature that does not match this pass, so it was not signed.";
      case "invalid_manifest":
        return "The issuer returned an invalid pass manifest.";
      case "network":
        return "The pass server could not be reached.";
      case "server_error":
      case "internal_error":
        return "The pass server had a problem. Try again shortly.";
      case "action_refused":
        return "The issuer refused this request.";
      case "not_found":
        return "This token does not exist.";
      case "unsupported":
        return "This contract does not offer wallet passes.";
    }
  }
  if ((error as { name?: string }).name === "UserRejectedRequestError") return "Signature request was declined.";
  return "Could not get the pass.";
}

export interface AddToWalletButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onError" | "children" | "type"> {
  contract: Address | string;
  tokenId: bigint | number | string;
  /// Required for gated passes. Pass null while no wallet is connected.
  signer?: WalletPassSigner | null;
  /// Force a platform. Otherwise detected from the user agent after mount.
  platform?: FormatKey;
  onError?: (error: Error) => void;
  onAdded?: (result: AddToWalletResult) => void;
  /// Button content, for example an official Add to Apple Wallet badge. Gets
  ///  the resolved platform so one element can switch badges. Defaults to a
  ///  text label.
  children?: ReactNode | ((state: { platform: FormatKey | null; busy: boolean }) => ReactNode);
  /// Show the issuing contract under the button (Client requirements: SHOULD
  ///  present the issuing contract address alongside the action). Default true.
  showIssuer?: boolean;
  /// Class for the wrapping element.
  containerClassName?: string;
  navigate?: (url: string) => void;
}

/// An accessible Add to Wallet button. It fetches the manifest when clicked
///  and not before, so acquisition URLs are never fetched ahead of intent or
///  held in page state, and navigates to the chosen platform's URL. No styles
///  are bundled; every element takes a class name or is reachable by the
///  `data-wallet-pass` attributes.
export function AddToWalletButton(props: AddToWalletButtonProps) {
  const {
    contract,
    tokenId,
    signer,
    platform: forcedPlatform,
    onError,
    onAdded,
    children,
    showIssuer = true,
    containerClassName,
    navigate,
    disabled,
    ...buttonProps
  } = props;
  const pass = useWalletPass({
    contract,
    tokenId,
    ...(signer !== undefined ? { signer } : {}),
    ...(forcedPlatform !== undefined ? { platform: forcedPlatform } : {}),
    ...(navigate ? { navigate } : {}),
    ...(onAdded ? { onAdded } : {}),
    ...(onError ? { onError } : {}),
  });
  const issuerId = useId();
  const errorId = useId();
  const busy = pass.status === "adding";
  let checksummed: string;
  try {
    checksummed = getAddress(String(contract));
  } catch {
    checksummed = String(contract);
  }
  const label = labelForPlatform(pass.platform);
  const describedBy = [showIssuer ? issuerId : null, pass.error ? errorId : null].filter(Boolean).join(" ") || undefined;

  const onClick = () => {
    void pass.addToWallet();
  };

  const content =
    typeof children === "function" ? children({ platform: pass.platform, busy }) : children ?? (busy ? "Opening wallet..." : label);

  return (
    <span className={containerClassName} data-wallet-pass="container">
      <button
        {...buttonProps}
        type="button"
        data-wallet-pass="button"
        data-platform={pass.platform ?? undefined}
        aria-label={children !== undefined && buttonProps["aria-label"] === undefined ? label : buttonProps["aria-label"]}
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
        disabled={disabled || busy}
        onClick={onClick}
      >
        {content}
      </button>
      {showIssuer ? (
        <small id={issuerId} data-wallet-pass="issuer" title={checksummed}>
          Issued by contract {safeShort(checksummed)}
        </small>
      ) : null}
      {pass.error ? (
        <span id={errorId} role="alert" data-wallet-pass="error">
          {describeError(pass.error)}
        </span>
      ) : null}
    </span>
  );
}

function safeShort(address: string): string {
  try {
    return shortAddress(address);
  } catch {
    return address;
  }
}
