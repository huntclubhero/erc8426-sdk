# event-ticket: scan to check in, keepsake after the show

```sh
pnpm --filter @erc8426-examples/use-cases demo:event-ticket
```

`EventTicketPass.sol` reserves a consecutive id range per show. Door staff scan the pass barcode to check a ticket in, once. When the show ends, one `BatchPassUpdate` over the show's range turns every ticket into a keepsake. Resales pay a 5% royalty through ERC-2981.

## What the pass shows

Status (Upcoming, Checked in, Keepsake), the show, doors time, admission, and the admitted time once scanned. The pass uses the eventTicket style with a relevant date. The barcode is the check-in capability, and it disappears on the keepsake.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Check in (door scans the barcode) | **Capability link**, executed by the door account (DOOR_ROLE) | It is bounded by construction: once per ticket, and only before the show ends. It cannot transfer, burn or approve the ticket. |
| End the show | **Anyone's transaction** after the end time | It changes no ticket state (the keepsake phase is already implied by time). It only emits the freshness signal, once. |
| Rotate the barcode | **Signed** (`rotatePassLinks`) | For a ticket whose photo leaked before the show. |
| Resell | **Owner transaction** | The indexer sees the transfer and rotates; the seller's barcode returns 404. |

## Spec conditions

- Gated configuration, and the capability configuration for check-in.
- **Documented bound:** checks the ticket in at most once, and only before the show ends; moves no value; cannot transfer, approve or burn the ticket.
- **Disclosed residual:** a leaked barcode can admit whoever presents it first, once. The owner's remedy is rotation before the show, which the demo shows for Ben.
- The fresh `ownerOf` read runs on every scan.
- `BatchPassUpdate` covers an inclusive range, and one event refreshes every issued pass in it.
