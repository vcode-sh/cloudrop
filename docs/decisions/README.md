# Decisions

Every non-obvious choice behind cloudrop's code: what was decided, why, what it costs if it is wrong, and whether it
still holds. Written for a reader who was not in the session where it was made.

## Prefixes

The milestones numbered their decisions in separate series, and the bare numbers collide: ruling 5 of M1 (`M1-R5`, Node
types) and ruling 5 of M2 (`M2-X5`, deferred backend lanes) were written the same way. Every reference in the repository
uses one of these prefixes instead.

| Prefix | Series | File |
| --- | --- | --- |
| `M1-R<n>` | Rulings made during M1 (the storage layer) and handed to the M2 plan. `M1-C<n>` are two numbered constraints from the same hand-over; `M1-N<n>` are its rulings without a number. | [m1-rulings.md](m1-rulings.md) |
| `M2-D<n>` | The M2 plan's design decisions 1 to 32, as amended by the plan audit and by execution. | [m2-plan-decisions.md](m2-plan-decisions.md) |
| `M2-X<n>` | Rulings made while executing M2 (owner, controller and review rulings), numbered 1 to 41 in the execution ledger. `M2-P<n>` are four rulings the ledger gave no number. | [m2-execution-rulings.md](m2-execution-rulings.md) |
| `M3-O<n>` | The owner's decisions of the hardening phase before the M3 slice. `M3-H<n>` are the controller's rulings of the same phase, numbered as in its ledger. | [m3-hardening.md](m3-hardening.md) |
| `M3-S<n>` | The M3 vertical slice (`cloudrop/client`, the Next.js example, the browser lanes): the plan's decisions S1 to S27 under their own numbers, then the controller's execution rulings from 28 upward. | [m3-slice.md](m3-slice.md) |
| `M3-U<n>` | The M3 uploader (progress, the shared pool, several files per job, pause and resume, automatic concurrency, stalls, offline, retry, resume after a reload): plan A's rulings P1 to P9 as `M3-U1` to `M3-U9`, the design's decisions from 10, plan A's execution rulings 14 to 22, plan B's rulings Q1 to Q17 as `M3-U23` to `M3-U39`, plan B's outcomes and execution rulings 40 to 59, the resume design's decisions 60 to 69, the resume plan's rulings R1 to R10 as `M3-U70` to `M3-U79`, then its execution rulings and owner decisions from 80 upward. | [m3-uploader.md](m3-uploader.md) |
| `M3-K<n>` | The M3 chaos work (the fault-injecting proxy, the `test:chaos` lane, the browser chaos rows, the nightly soak): the plan's rulings K1 to K8 under their own numbers, then its execution rulings from 9 upward. | [m3-chaos.md](m3-chaos.md) |
| `M4-F<n>` | M4a: the fixes from the 2026-11-17 client and server audits, the `route()` and configuration changes, and the developer-experience work from the cold-developer tests (`docs/superpowers/specs/2026-11-17-m4-dx-and-react-design.md` §3 to §5), and later size and build rulings (`M4-F24`, `M4-F25`). `M4-B<n>` are the same milestone's React bindings (§6). | [m4-dx.md](m4-dx.md) |
| `M4-E<n>` | M4b: the examples and the guidance for building an upload UI on the hooks (no shadcn registry). `M4-E1` to `M4-E19` are the Next example's home page and the "Build your upload UI" guide; the Hono and Vite React examples number from `M4-E20`. | [m4-dx.md](m4-dx.md) |
| `M5-T<n>` | M5, the database store: the design's decisions `M5-T1` to `M5-T15` under their own numbers, then execution rulings from 16 upward; after M5, the `/upload` idempotency key from `M5-T100` and `tables.schema` from `M5-T120`. | [m5-store.md](m5-store.md) |

What the M2 reviews found and what changed: [reviews-m2.md](reviews-m2.md).

Reading older text:

- In `docs/superpowers/plans/2026-11-15-m2-server.md`, a bare `R<n>` is an M1 ruling (`M1-R<n>`).
- Executed plans are short stubs since 2026-11-16; a section a ruling cites is in the full text at commit `415198a`
  (`git show 415198a:docs/superpowers/plans/<file>`).
- In the M2 plan, the M2 audit and the M2 reviews, a bare `D<n>` is `M2-D<n>`.
- In the M2 execution ledger, the M2 reviews and the M3 plan before this index existed, a bare `R<n>` is `M2-X<n>`.
- In the hardening ledger and its lane briefs, a bare `O<n>` is `M3-O<n>` and `H<n>` is `M3-H<n>`.
- In the M3 slice plan, a bare `S<n>` is `M3-S<n>`. In the slice's execution ledger, `S-<n>` (with a hyphen) is a
  controller ruling of a different list: the entries in [m3-slice.md](m3-slice.md) from `M3-S28` upward name the
  ledger id they carry, `M3-S18` records `S-8`, and the rest of that list changed no behaviour or public contract.
- In the M3 progress plan A and its audit, a bare `P<n>` is `M3-U<n>`. Its execution notes name rulings `R1`, `R5-1`,
  `R6-1` and so on; the entries in [m3-uploader.md](m3-uploader.md) from `M3-U14` upward name the ones they record.
- In the M3 progress plan B and its audit, a bare `Q<n>` is `M3-U<n + 22>` (`Q1` is `M3-U23`, `Q17` is `M3-U39`). Its
  execution notes name rulings such as `task 2 R1` and `task 4 ruling 1`; the entries from `M3-U40` upward name the
  ones they record.
- In the M3 resume plan, a bare `R<n>` is `M3-U<n + 69>` (`R1` is `M3-U70`, `R10` is `M3-U79`).
- In the M3 chaos plan and its design, a bare `K<n>` is `M3-K<n>`.
- `T10-1`, `X-3` and similar names are finding ids in `docs/superpowers/plans/2026-11-15-m2-server.audit.md`.

## Authority

The code, the design spec (`docs/superpowers/specs/2026-11-15-cloudrop-design.md`) and these entries are the authority.
The M1 and M2 plans (`2026-11-15-*.md`) and the M2 audit are history: they record what was intended before execution and
stay unchanged as evidence (`M2-X9`). The M3 plan is active until M3 is executed and is revised in place. Where a plan
disagrees with an entry here, the entry and the code win.

## Statuses

- **In force**: the code or the docs follow it today.
- **Decided**: made, and the work that carries it out is named but not merged yet.
- **Amended**: it holds with the changes the entry names.
- **Superseded by** another entry: read that one.
- **Closed** by a commit: a one-time action that is done.

## Adding an entry

A ruling that changes behaviour or a public contract gets an entry in the same change. Continue the series it belongs
to. A new series is named `M<milestone>-<letter>`, with a letter not yet used in that milestone, and gets a row in the
table above. Each entry has the decision, the reason, the cost if wrong, the status and where it is visible. When a new
entry changes an old one, say so on both.

## Gaps

The M1 execution ledger was not kept. Only the M1 rulings that the M2 planning brief restated survive (see
[m1-rulings.md](m1-rulings.md)); M1 rulings 3, 4, 6, 7, 8, 10, 12, 13 and 19 are not recoverable, and nothing in the
repository cites them.
