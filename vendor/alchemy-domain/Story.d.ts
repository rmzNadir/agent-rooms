import type { Effect } from "effect";

type Step = object;

export declare const Story: {
  readonly clock: (at: string) => Step;
  readonly expectCall: (...args: readonly object[]) => Step;
  readonly make: (
    model: object,
    options: object
  ) => (...steps: readonly Step[]) => Effect<void, never, never>;
  readonly rejected: (value: object) => Step;
  readonly replied: (value: object) => Step;
  readonly resolve: (...args: readonly object[]) => Step;
  readonly state: (
    ref: object,
    assert: (state: {
      readonly messages: readonly {
        readonly body: string;
        readonly redacted: boolean;
      }[];
    }) => void
  ) => Step;
  readonly streamed: (...args: readonly object[]) => Step;
  readonly then: (...args: readonly object[]) => Step;
  readonly view: (...args: readonly object[]) => Step;
  readonly when: (...args: readonly object[]) => Step;
};
