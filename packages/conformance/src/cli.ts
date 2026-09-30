#!/usr/bin/env node
import { runCli } from "./cliMain.js";

runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 2;
  },
);
