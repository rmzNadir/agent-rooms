import { numberField, readPayload, textField } from "./snapshot-diff.ts";

export const healthOk = (status: number, text: string) =>
  status === 200 && text.includes('"ok":true');

export const viewerReady = (html: string) =>
  html.includes("agent-rooms") && html.includes("Bearer token");

export const accepted = (status: number, text: string) =>
  status === 200 && !text.includes('"isError":true');

export const mentionRejected = (text: string) =>
  text.includes("MentionRequired") && text.includes('"isError":true');

export const paused = (text: string) => text.includes("paused after 20");

export const pauseCount = (texts: readonly string[]) =>
  texts.filter((text) => paused(text)).length;

const cursorPattern = /lastReadSeq\\":[1-9]/u;

export const cursorAdvanced = (text: string) => cursorPattern.test(text);

export const wakeBodies = (text: string) => {
  const parsed = readPayload(text);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => (typeof item === "string" ? [item] : []));
};

export const wakeNumber = (body: string, key: string) => {
  const value = numberField(readPayload(body), key);
  return value;
};

export const wakeText = (body: string, key: string) =>
  textField(readPayload(body), key);

export const openedAtZero = (body: string) => wakeNumber(body, "fromSeq") === 0;

export const deliveryOk = (body: string) =>
  wakeText(body, "deliveryId")?.startsWith("dlv_") === true;

export const continuesAt = (body: string, fromSeq: number) =>
  wakeNumber(body, "fromSeq") === fromSeq;

export const liveNames = (seed: string) => {
  const cleaned = seed.replaceAll(/[^a-f0-9]/giu, "").slice(0, 6);
  const stem = cleaned.length === 0 ? "run" : cleaned;
  return {
    hook: `w${stem}`,
    human: `h${stem}`,
    left: `a${stem}`,
    relay: `relay${stem}`,
    right: `b${stem}`,
    wake: `wake${stem}`,
  };
};

export const waitUntil = (
  read: () => Promise<readonly string[]>,
  count: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
) => {
  const deadline = now() + 20_000;
  const poll = async (attempt: number): Promise<readonly string[]> => {
    const seen = await read();
    if (seen.length >= count || now() >= deadline || attempt >= 99) {
      return seen;
    }
    await sleep(200);
    return poll(attempt + 1);
  };
  return poll(0);
};

export const untilStatus = (
  probe: () => Promise<number>,
  want: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
) => {
  const deadline = now() + 20_000;
  const poll = async (attempt: number): Promise<boolean> => {
    if ((await probe()) === want) {
      return true;
    }
    if (now() >= deadline || attempt >= 99) {
      return false;
    }
    await sleep(200);
    return poll(attempt + 1);
  };
  return poll(0);
};
