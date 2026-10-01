import Link from "next/link";

import { loadConfig } from "@/lib/config";

export default function Home() {
  const loaded = loadConfig();
  const platforms = loaded.ok ? [loaded.config.apple ? "Apple Wallet" : null, loaded.config.google ? "Google Wallet" : null].filter(Boolean) : [];
  return (
    <>
      <section className="hero">
        <p className="eyebrow">ERC-8426 example</p>
        <h1>Your NFT, on the card you already carry.</h1>
        <p className="lede">
          ERC-8426 lets a token contract say &ldquo;this token has a wallet pass&rdquo; with one view function, <code>passURI</code>. Any wallet or marketplace can then offer Add to Apple Wallet or Save to Google Wallet for it, and the pass stays in step with the chain.
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/mint">
            Hatch a pet
          </Link>
          <Link className="btn" href="/passes">
            My passes
          </Link>
        </div>
      </section>

      <section aria-labelledby="how" className="section">
        <h2 id="how">How it works, in three steps</h2>
        <ol className="steps">
          <li className="card">
            <span className="step-n" aria-hidden="true">
              1
            </span>
            <h3>Discover</h3>
            <p>
              The client asks the contract <code>supportsInterface(0xef5f1e71)</code>, then reads <code>passURI(tokenId)</code>. That URI is the only thing the chain asserts about the pass.
            </p>
          </li>
          <li className="card">
            <span className="step-n" aria-hidden="true">
              2
            </span>
            <h3>Prove</h3>
            <p>
              This issuer runs the <strong>gated</strong> configuration: the manifest answers <code>401 proof_required</code> until you sign a short Sign-In with Ethereum challenge scoped to this token and the <code>acquire</code> action. Then it reads the owner on chain, fresh, before answering.
            </p>
          </li>
          <li className="card">
            <span className="step-n" aria-hidden="true">
              3
            </span>
            <h3>Carry</h3>
            <p>
              The manifest lists where to get the pass on each platform. Its links (feed, water, play) act for the pet through the issuer, bounded on chain, and rotate when the pet changes hands.
            </p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="mode" className="section card">
        <h2 id="mode">What this instance delivers</h2>
        {platforms.length > 0 ? (
          <p>
            Real wallet mode: {platforms.join(" and ")} delivery is configured, alongside the in-app preview. This is a test network: the pets have no value, the operator pays the gas, and the code is an unaudited example.
            {loaded.ok && loaded.config.burnerWallet && !loaded.config.devWallet ? " No wallet? Use a demo wallet: a throwaway key kept in this browser." : ""}
          </p>
        ) : (
          <p>
            Local mode: no Apple or Google credentials are configured, so passes are shown as a live in-app preview drawn from the exact content a wallet would get. Everything else (the gated manifest, signed actions, capability links, rotation, the 403 for a previous owner) is the real protocol. See the README to add credentials.
          </p>
        )}
      </section>
    </>
  );
}
