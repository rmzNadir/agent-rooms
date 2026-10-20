import { writeEnv } from "../src/boundary/external.ts";

export const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  writeEnv(name, previous);
};
