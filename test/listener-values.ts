import type { ListenerConfig, WakeCall } from "../listeners/listener-io.mjs";

export const adaConfig = (webhookSecret?: string) => ({
  agentName: "ada",
  bearerToken: "tok",
  mcpUrl: "http://127.0.0.1:9/mcp",
  ...(webhookSecret === undefined ? {} : { webhookSecret }),
});

export const rememberSeq =
  (marks: number[]) => (_config: ListenerConfig, payload: WakeCall) => {
    marks.push(wakeSeq(payload.toSeq));
    return Promise.resolve();
  };

const wakeText = (value: string | undefined): string => {
  if (value === undefined) {
    throw new Error("wake field missing");
  }
  return value;
};

const wakeSeq = (value: number | undefined): number => {
  if (value === undefined) {
    throw new Error("wake seq missing");
  }
  return value;
};

export const untilStarted = (started: readonly string[], want: number) => {
  const spin = (seen: number): Promise<void> => {
    if (seen >= 8 || started.length >= want) {
      return Promise.resolve();
    }
    return Promise.resolve().then(() => spin(seen + 1));
  };
  return spin(0);
};

export { wakeSeq, wakeText };
