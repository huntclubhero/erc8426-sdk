import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";

/// Verifies that `signature` is a valid ERC-191 signature of `message` by
///  `address`. An interface so the deployment chooses how much of the account
///  model it supports; the floor itself does not change.
///
///  A verifier MAY throw on a signature it cannot decode (wrong length, bad
///  point, a failed contract call); `authorize` refuses a throw as
///  signature_invalid, never as a server error.
export interface SignatureVerifier {
  verify(input: { address: Address; message: string; signature: Hex }): Promise<boolean>;
}

/// Offline verifier for externally owned accounts: recover and compare. It
///  cannot validate contract accounts, which need a chain call; use it in
///  tests or for EOA-only products.
export function eoaSignatureVerifier(): SignatureVerifier {
  return {
    async verify({ address, message, signature }) {
      const recovered = await recoverMessageAddress({ message, signature });
      return isAddressEqual(recovered, address);
    },
  };
}

/// The part of a viem PublicClient the verifier uses, typed structurally.
export interface VerifyMessageClient {
  verifyMessage(parameters: any): Promise<boolean>;
}

/// Production verifier: viem's `verifyMessage` recovers EOA signatures and
///  otherwise calls ERC-1271 `isValidSignature` on the account, including
///  ERC-6492 wrapped signatures from contract accounts not yet deployed (the
///  email-onboarded smart accounts the spec mentions). This is why a
///  challenge names the claimed account: a contract signature does not
///  identify its signer by itself.
export function publicClientSignatureVerifier(client: VerifyMessageClient): SignatureVerifier {
  return {
    async verify({ address, message, signature }) {
      return client.verifyMessage({ address, message, signature });
    },
  };
}
