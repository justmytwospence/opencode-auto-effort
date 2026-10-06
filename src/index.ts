// opencode-auto-effort: sets the effort (opencode's variant) for each prompt you send. Jev rates
// how demanding the request is (0-3) in chat.message, before the user message is saved; the
// policy smooths that into a level, and the message carries it, so every model request of that
// turn (tool follow-ups included) uses it and prompt caches survive. The variant the session
// would have used (your pick, or the agent's) is the ceiling.
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { askJev, noul, score } from "./jev.ts";
import { DEFAULT_POLICY, type EffortState, LEVELS, type Policy, decide, levelIndex } from "./policy.ts";
import { type MessageLike, QUESTIONS, effortState } from "./request.ts";

export interface Options {
  enabled: boolean;
  /** Agents whose prompts auto-effort sets; others (planners, scouts) keep their own variant. */
  agents: string[];
  /** Show a toast when the level changes. */
  toast: boolean;
  jev: { model: string; timeoutMs: number };
  policy: Policy;
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  agents: ["build"],
  toast: true,
  jev: { model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
};

interface SessionState extends EffortState {
  /** The level auto-effort set last in this session. */
  level?: string;
}

type Client = PluginInput["client"];

export function resolveOptions(raw: Record<string, unknown> | undefined): Options {
  const o = (raw ?? {}) as Partial<Options>;
  return {
    ...DEFAULT_OPTIONS,
    ...o,
    jev: { ...DEFAULT_OPTIONS.jev, ...(o.jev ?? {}) },
    policy: { ...DEFAULT_OPTIONS.policy, ...(o.policy ?? {}) },
  };
}

/** The highest of `available` at or below `level`; the ceiling when none is. */
export function fit(level: string, ceiling: string, available: readonly string[] | undefined): string {
  if (!available?.length) return level;
  for (let i = levelIndex(level); i >= 0; i--) {
    const name = LEVELS[i] as string;
    if (available.includes(name)) return name;
  }
  return ceiling;
}

export async function createHooks(client: Client, options: Options, fetchImpl?: typeof fetch): Promise<Hooks> {
  const sessions = new Map<string, SessionState>();
  const variants = new Map<string, string[] | undefined>();

  const variantsOf = async (providerID: string, modelID: string) => {
    const key = `${providerID}/${modelID}`;
    if (!variants.has(key)) {
      try {
        const { data } = await client.config.providers();
        const provider = (data as { providers?: { id: string; models?: Record<string, { variants?: Record<string, unknown> }> }[] })
          ?.providers?.find((p) => p.id === providerID);
        const found = provider?.models?.[modelID]?.variants;
        variants.set(key, found ? Object.keys(found) : undefined);
      } catch {
        variants.set(key, undefined);
      }
    }
    return variants.get(key);
  };

  const log = (message: string) =>
    client.app.log({ body: { service: "auto-effort", level: "info", message } }).catch(() => undefined);

  return {
    "chat.message": async (input, output) => {
      if (!options.enabled || !options.agents.includes(output.message.agent)) return;
      const model = output.message.model as { providerID: string; modelID: string; variant?: string };
      const ceiling = model.variant;
      if (!ceiling || levelIndex(ceiling) < 0) return;
      const text = output.parts
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n")
        .trim();
      if (!text) return;

      const s = sessions.get(input.sessionID) ?? { dwell: options.policy.minDwell };
      let messages: MessageLike[] = [];
      try {
        const { data } = await client.session.messages({ path: { id: input.sessionID } });
        messages = (data ?? []) as unknown as MessageLike[];
      } catch {
        // No history: Jev judges the request alone.
      }
      const outcome = await askJev(effortState(text, messages), QUESTIONS, {
        model: options.jev.model,
        timeoutMs: options.jev.timeoutMs,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      const depth = outcome.ok ? score(outcome.answers, "depth") : undefined;
      const ack = outcome.ok ? noul(outcome.answers, "ack") : undefined;
      const judgment = depth && ack !== undefined ? { ...depth, ack } : undefined;
      const current = s.level ?? ceiling;
      const decision = decide(current, ceiling, s, judgment, options.policy);
      const level = fit(decision.level, ceiling, await variantsOf(model.providerID, model.modelID));
      sessions.set(input.sessionID, { ...decision.state, level });
      model.variant = level;

      const reason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;
      const detail = judgment
        ? ` (score ${judgment.score.toFixed(2)}, confidence ${judgment.confidence.toFixed(2)}, go-ahead ${judgment.ack.toFixed(2)}${outcome.ok ? `, ${outcome.latencyMs} ms` : ""})`
        : "";
      await log(`${current} -> ${level} (ceiling ${ceiling}): ${reason}${detail}`);
      if (options.toast && level !== current) {
        await client.tui
          .showToast({ body: { message: `effort: ${level} (auto)`, variant: "info" } })
          .catch(() => undefined);
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") sessions.delete((event.properties as { info: { id: string } }).info.id);
    },
  };
}

const server: Plugin = async (input, options) => createHooks(input.client, resolveOptions(options));

export default { id: "auto-effort", server };
