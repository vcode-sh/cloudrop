# Bounded test audit

[SKILL.md](SKILL.md) owns the decision rules. Use this procedure only for the requested area; it does not turn
ordinary implementation into a suite audit.

1. Check the diff and ownership before editing. Preserve unrelated and concurrent work. An audit alone does not
   authorize production repairs.
2. Read each candidate test, its production owner and immediate callers. Look for the smells in
   [anti-slop.md](references/anti-slop.md) and for existing protection in other lanes before declaring a gap. Counts
   and syntax are leads, not verdicts.
3. Decide **KEEP / REWRITE / DELETE / UNRESOLVED** per test. For each substantive decision, name the contract, the
   oracle, the failure it catches and what it adds over existing protection. A missing protection is a gap, not an
   automatic instruction to add a test.
4. Make only authorized changes. Before deleting, check fixtures, lanes and remaining protection. Use a regression
   RED or a targeted fault probe where it settles a doubt, not as a mandatory pass. Suspected production defects stay
   findings unless their repair is in scope.
5. Run the commands from [repository.md](references/repository.md) on the final tree, confirm which files were
   selected, check the time budgets, and release everything you started.

Report the changed files with reasons, unresolved decisions and the evidence that would settle them, the commands
actually run (with selections), any RED or probe actually observed, unproved boundaries and the cleanup state. A
green unit lane is not evidence for a backend-lane change.
