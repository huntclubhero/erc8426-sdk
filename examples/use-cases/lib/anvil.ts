// SPDX-License-Identifier: MIT
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/// A throwaway local chain for one demo run.
export interface Anvil {
  rpcUrl: string;
  port: number;
  stop(): void;
}

function anvilPath(): string {
  if (process.env.ANVIL_PATH) return process.env.ANVIL_PATH;
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const local = join(homedir(), ".foundry", "bin", exe);
  return existsSync(local) ? local : exe;
}

/// Ask the OS for a free TCP port.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function rpcReady(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/// Spawn anvil on a random port (chain id 31337) and wait until it answers.
///  Anvil's prefunded dev accounts are never used: every actor gets a fresh
///  runtime key, funded with `anvil_setBalance`.
export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(anvilPath(), ["-p", String(port)], { stdio: "ignore", windowsHide: true });
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));

  const deadline = Date.now() + 20_000;
  while (!(await rpcReady(rpcUrl))) {
    if (exited) throw new Error(`anvil failed to start (looked for ${anvilPath()}; set ANVIL_PATH to override)`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("anvil did not answer within 20s");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = () => {
    if (!exited) child.kill();
  };
  process.once("exit", stop);
  return { rpcUrl, port, stop };
}
