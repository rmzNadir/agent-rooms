export const adoptEnabled = (value: string | undefined) => value === "true";

export const stageArgs = (input: {
  readonly adopt: boolean;
  readonly command: "deploy" | "plan";
  readonly stage: string;
}): readonly string[] => {
  const adopt = input.adopt ? ["--adopt"] : [];
  if (input.command === "deploy") {
    return ["deploy", "--yes", "--stage", input.stage, ...adopt];
  }
  return [
    "plan",
    "--stage",
    input.stage,
    ...adopt,
    "--no-input",
    "--env-file",
    "/dev/null",
  ];
};
