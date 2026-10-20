import type {
  HarnessResult,
  Lane,
  ListenerConfig,
  WakeCall,
} from "./listener-io.mjs";

export interface WakeResultBody {
  readonly coalesced?: boolean;
  readonly duplicate?: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly ok?: boolean;
}

export function markDelivered(
  config: ListenerConfig,
  wake: WakeCall,
  fetchImpl?: (
    url: string,
    init: { body: string; headers: Record<string, string>; method: string }
  ) => Promise<{ readonly ok?: boolean }>
): Promise<void>;
export function resumeUnfinished(
  dir: string,
  deps: {
    config: ListenerConfig;
    lane: Lane;
    markRead?: (config: ListenerConfig, wake: WakeCall) => Promise<void>;
    pendingDir?: string;
    reportFailure?: (
      config: ListenerConfig,
      wake: WakeCall
    ) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    start: (
      wake: WakeCall,
      config: ListenerConfig,
      prompt: string
    ) => Promise<HarnessResult>;
  }
): Promise<void>;
export function handleWake(
  http: {
    body: string;
    method?: string;
    signature?: string;
    timestamp?: string;
  },
  deps: {
    accept?: (wake: WakeCall) => "duplicate" | "fresh" | "missing";
    config: ListenerConfig;
    lane: Lane;
    markRead?: (config: ListenerConfig, wake: WakeCall) => Promise<void>;
    now?: number;
    pendingDir?: string;
    reportFailure?: (
      config: ListenerConfig,
      wake: WakeCall
    ) => Promise<boolean>;
    seenDeliveries: Map<string, number>;
    seenSignatures: Map<string, number>;
    sleep?: (ms: number) => Promise<void>;
    start: (
      wake: WakeCall,
      config: ListenerConfig,
      prompt: string
    ) => Promise<HarnessResult>;
  }
): Promise<{
  body: WakeResultBody;
  done: Promise<void>;
  status: number;
}>;
export function serve(
  start: (
    wake: WakeCall,
    config: ListenerConfig,
    prompt: string
  ) => Promise<HarnessResult>
): void;
