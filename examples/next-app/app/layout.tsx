import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Providers } from "@/components/Providers";
import { ConnectButton } from "@/components/wallet";
import { loadConfig, publicConfig } from "@/lib/config";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ERC-8426 Pet Pass example",
  description: "A full example app for ERC-8426, the Wallet Pass Extension for NFTs.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const loaded = loadConfig();
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {loaded.ok ? (
          <Providers config={publicConfig(loaded.config)}>
            <Header />
            <main id="main" className="container">
              {children}
            </main>
          </Providers>
        ) : (
          <main id="main" className="container">
            <SetupNeeded message={loaded.error} />
          </main>
        )}
        <footer className="container footer">
          <p>
            Example app for <a href="https://ethereum-magicians.org/t/erc-8426-wallet-pass-extension-for-nfts/29358">ERC-8426</a>, built with the{" "}
            <code>@erc8426/*</code> SDK. Teaching code: review before production use.
          </p>
        </footer>
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="header">
      <div className="container header-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Pet Pass
        </Link>
        <nav aria-label="Main">
          <ul className="nav">
            <li>
              <Link href="/mint">Hatch</Link>
            </li>
            <li>
              <Link href="/passes">My passes</Link>
            </li>
          </ul>
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}

function SetupNeeded({ message }: { message: string }) {
  return (
    <section className="card">
      <h1>Almost there</h1>
      <p>{message}</p>
      <ol className="steps-list">
        <li>
          <code>pnpm --filter @erc8426-examples/next-app chain</code> starts a local chain, deploys PetPass and writes <code>.env.local</code>.
        </li>
        <li>
          <code>pnpm --filter @erc8426-examples/next-app dev</code> starts this app on <code>http://localhost:3000</code>.
        </li>
      </ol>
    </section>
  );
}
