# makefun-sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Bruskots/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Bruskots/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty. One run answers all five instances of a set, writing each level's move sequence to `/output/<id>/solution.txt`.

## How it works

The generator builds every level as one hallway with independent rooms opening off it through a single door, and a box pushed into the hallway can never come back — so each room is solved on its own:

- **Room splitting** — the level is split into connected floor components outside the hallway row; each room's door is the cell touching the hallway, and the player starts from the hallway cell next to it (pushing a box that starts on the door inward first, when needed).
- **Push-based A\*** — the search state is the player position plus the box positions; only pushes branch the search, and the player walks between pushes with plain BFS.
- **Admissible heuristic** — the cheapest assignment of boxes to goals by shortest-path distance (every box-to-goal pairing tried), so the first solution A\* returns uses the fewest pushes possible.
- **Deadlock pruning** — dead squares found by pulling boxes backwards out of the goals, plus 2x2 blocks of boxes and walls with no goal inside.
- **Deterministic** — fixed neighbour order, fixed tie-breaking, and node-count budgets instead of wall-clock cutoffs, so two runs produce byte-identical answers.

## Practice results

On the kit's practice set the solver finds the push-optimal solution for every level (13, 16, 29, 47 and 60 pushes), scoring **1,000,000** — against the house baseline plain-astar 1.0.0's 200,000 — in about 0.7 seconds for the whole set.

## Run it

```sh
node main.ts
```

It reads levels from `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`. (When the local grader runs it, it honours `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` instead.) Requires Node 22; no dependencies, no network.

## License

MIT — see [LICENSE](LICENSE).
