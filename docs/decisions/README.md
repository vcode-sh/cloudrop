# Decisions

Every non-obvious choice behind cloudrop's code: what was decided, why, what it costs if it is wrong, and whether it
still holds. Written for a reader who was not in the session where it was made.

## Prefixes

The milestones numbered their decisions in separate series, and the bare numbers collide: ruling 5 of M1 (`M1-R5`, Node
types) and ruling 5 of M2 (`M2-X5`, deferred backend lanes) were written the same way. Every reference in the repository
uses one of these prefixes instead.

| Prefix | Series | File |
| --- | --- | --- |
| `M1-R<n>` | Rulings made during M1 (the storage layer) and handed to the M2 plan. `M1-C<n>` are two numbered constraints from the same hand-over. | [m1-rulings.md](m1-rulings.md) |
| `M2-D<n>` | The M2 plan's design decisions 1 to 32, as amended by the plan audit and by execution. | [m2-plan-decisions.md](m2-plan-decisions.md) |
| `M2-X<n>` | Rulings made while executing M2 (owner, controller and review rulings), numbered 1 to 41 in the execution ledger. `M2-P<n>` are four rulings the ledger gave no number. | [m2-execution-rulings.md](m2-execution-rulings.md) |

What the M2 reviews found and what changed: [reviews-m2.md](reviews-m2.md).

Reading older text:

- In `docs/superpowers/plans/2026-11-15-m2-server.md`, a bare `R<n>` is an M1 ruling (`M1-R<n>`) and `D<n>` is
  `M2-D<n>`.
- In the M2 execution ledger, the M2 reviews and the M3 plan before this index existed, a bare `R<n>` is `M2-X<n>`.
- `T10-1`, `X-3` and similar names are finding ids in `docs/superpowers/plans/2026-11-15-m2-server.audit.md`.

## Authority

The code, the design spec (`docs/superpowers/specs/2026-11-15-cloudrop-design.md`) and these entries are the authority.
The plan files in `docs/superpowers/plans/` and the M2 audit are history: they record what was intended before execution
and stay unchanged as evidence (`M2-X9`). Where a plan disagrees with an entry here, the entry and the code win.

## Statuses

- **In force**: the code or the docs follow it today.
- **Amended**: it holds with the changes the entry names.
- **Superseded by** another entry: read that one.
- **Closed** by a commit: a one-time action that is done.

## Adding an entry

A ruling that changes behaviour or a public contract gets an entry in the same change. New entries continue the series
of the milestone they belong to (`M3-…` for M3), with the decision, the reason, the cost if wrong, the status and where
it is visible. When a new entry changes an old one, say so on both.

## Gaps

The M1 execution ledger was not kept. Only the M1 rulings that the M2 planning brief restated survive (see
[m1-rulings.md](m1-rulings.md)); M1 rulings 3, 4, 6, 7, 8, 10, 12, 13 and 19 are not recoverable, and nothing in the
repository cites them.
