# opencode-auto-effort

An [opencode](https://opencode.ai) plugin that sets the effort (opencode's model variant) for each
prompt you send. [Jev](https://docs.typesafe.ai), TypeSafe's System One model, rates how much
careful reasoning the request needs, in about 200 ms before the turn starts. The port of
[pi-auto-effort](https://github.com/justmytwospence/pi-auto-effort) and
[claude-auto-effort](https://github.com/justmytwospence/claude-auto-effort), with the same questions
and policy.

| Score | Request | Level |
|---|---|---|
| 0 | a lookup, trivial answer, or mechanical change | low |
| 1 | a routine single-file change or clear question | medium |
| 2 | a multi-step change, debugging with clear symptoms, design in a known pattern | high |
| 3 | subtle design, cross-cutting refactor, hard debugging, correctness-critical work | xhigh |

Jev sees the request, the two before it, the last answer, and what the last run did (tool errors,
files edited, tool calls).

**Smoothing.** A running average `e = 0.5·score + 0.5·e_prev` moves the level up when it is at least
0.6 above it, and down when at least 0.6 below and the level has held for 2 prompts. A confident
(>= 0.6) score 1.5 or more above the level jumps straight to it. A go-ahead ("yes", "continue", "do
it") keeps the level.

**Bounds.** The variant the prompt would have used (your pick with the variant cycle, or the
agent's `variant`) is the ceiling; `low` is the floor. A level the model has no variant for falls to
the next one down. Prompts without a variant, or to agents not in `agents` (default `build`, so
planners and scouts keep their own), are left alone.

**Cache-safe.** The level is set on the user message in `chat.message`, before it is saved, and
every model request of that turn reads it from there, so tool follow-ups never change it. Without
`TYPESAFE_API_KEY`, or when Jev fails or takes over 1.5 s, the level holds.

A toast shows `effort: low (auto)` when the level changes; each decision is logged under the
`auto-effort` service (`opencode run --print-logs`).

## Install

In `opencode.jsonc`, pinned to a commit:

```jsonc
"plugin": [
  ["opencode-auto-effort@github:justmytwospence/opencode-auto-effort#<commit>", {
    // all optional; defaults shown
    "agents": ["build"],
    "toast": true,
    "jev": { "model": "jev-latest", "timeoutMs": 1500 },
    "policy": { "floor": "low", "alpha": 0.5, "margin": 0.6, "jump": 1.5, "jumpConfidence": 0.6, "minDwell": 2, "ackThreshold": 0.7 }
  }]
]
```

Needs `TYPESAFE_API_KEY` in opencode's environment. Tested with opencode 1.18.29.

## Development

```sh
npm install
npm run check   # typecheck and tests
```

Try a local checkout in place of the pin: opencode dedupes plugins by package name and the later
config wins, so

```sh
printf '{"plugin":["opencode-auto-effort@file:'"$PWD"'"]}' > /tmp/try.json
OPENCODE_CONFIG=/tmp/try.json opencode
```

links this checkout instead of the pinned commit.
