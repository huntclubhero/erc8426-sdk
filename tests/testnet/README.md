# Public testnet run

`erc1155.testnet.test.ts` runs the ERC-1155 binding (working draft) against a public testnet: a real contract, real blocks, a public RPC and real transfer logs. The issuer runs on your machine; only the chain is public. It is not part of `pnpm test`, because it sends transactions and needs funded keys.

## What it does

Each run deploys a fresh `SwapOnRedeemTicket`, mints id 77 to two accounts, and walks the binding:

1. the contract answers the ERC-8426 interface id (`0xef5f1e71`) and is ERC-1155
2. the client signs a challenge in the `erc1155` namespace
3. two holders of one id each get their own pass, with pass files
4. an account that holds none is refused
5. capability links and a signed action, per account
6. sending one of three leaves the sender's links alone
7. sending the last unit: the fresh read refuses the link at once, and the watcher retires it from the transfer log
8. buying back is a first claim with new links
9. a balance that left and came back between two reads is caught from the block of the log
10. a log older than the node's state changes nothing
11. with no watcher, a read over the issued accounts finds who no longer holds
12. a holder rotates its own links and nobody else's

## Run it

Make a key file outside the repository (never commit it) with five funded throwaway keys:

```sh
RPC_URL=https://rpc.testnet.chain.robinhood.com
CHAIN_ID=46630
DEPLOYER_KEY=0x...
ALICE_KEY=0x...
BOB_KEY=0x...
CAROL_KEY=0x...
STRANGER_KEY=0x...
```

`cast wallet new` makes a key. Each account needs a little gas: the whole run spent under 0.0001 ETH on Robinhood Chain testnet.

```sh
TESTNET_ENV_FILE=/path/to/keys.env TESTNET_REPORT=/path/to/report.json \
  pnpm exec vitest run --config vitest.testnet.config.ts
```

The report lists the contract and every transaction hash, so the run can be checked on a block explorer.

## What a public chain showed that a local one did not

- A public node keeps old state for a limited time (a few hours on the node used here). The read at the block of a transfer log only works inside that window. A log that arrives later changes nothing and the issuer reports a failed read; the fresh read stays the boundary either way.
- A read taken right after a receipt can be answered by a node that has not seen that block yet. The run waits for balances to settle and does not read them once.
