import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";
import { type MethodMetric, metricsFor } from "./metrics.ts";

interface QualityConfig {
  readonly cognitiveMax: number;
  readonly crapMax: number;
  readonly cyclomaticMax: number;
  readonly duplication: {
    readonly minLines: number;
    readonly minTokens: number;
    readonly threshold: number;
  };
  readonly halsteadDifficultyMax: number;
  readonly linesPerFileMax: number;
  readonly mutation: {
    readonly break: number;
    readonly high: number;
    readonly low: number;
    readonly mutate: readonly string[];
  };
  readonly paths: readonly string[];
  readonly suppressions: readonly string[];
  readonly unitTests: readonly string[];
}

const config = JSON.parse(
  readFileSync("quality.config.json", "utf8")
) as QualityConfig;
const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
};

const skippedDirectory = (name: string) =>
  name === "node_modules" || name === "coverage" || name === ".alchemy";

const filesUnder = (root: string): string[] => {
  if (!statSync(root).isDirectory()) {
    return [root];
  }
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    if (skippedDirectory(name)) {
      continue;
    }
    found.push(...filesUnder(path.join(root, name)));
  }
  return found;
};

const sourceFilePattern = /\.(ts|mjs|mts)$/;

const sourceFiles = config.paths
  .flatMap(filesUnder)
  .filter((file) => sourceFilePattern.test(file));

const lineOf = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;

const keywordName = (token: SyntaxKind) => {
  if (token === SyntaxKind.AnyKeyword) {
    return "any";
  }
  if (token === SyntaxKind.UnknownKeyword) {
    return "unknown";
  }
  return "";
};

const advance = (scanner: ReturnType<typeof createScanner>) => {
  const start = scanner.getTokenStart();
  // A heading `#` inside a template is a zero-width private identifier.
  if (scanner.getTokenEnd() <= start) {
    scanner.resetTokenState(start + 1);
  }
  return scanner.scan();
};

const namedKeywords = (file: string, text: string) => {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    const name = keywordName(token);
    if (name.length > 0) {
      fail(`${file}:${lineOf(text, scanner.getTokenStart())} names ${name}`);
    }
    token = advance(scanner);
  }
};

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.endsWith("\n")
    ? text.split("\n").length - 1
    : text.split("\n").length;
  if (lines > config.linesPerFileMax) {
    fail(`${file} has ${lines} lines`);
  }
  for (const phrase of config.suppressions) {
    if (text.includes(phrase)) {
      fail(`${file} contains ${phrase}`);
    }
  }
  namedKeywords(file, text);
  if (text.includes(["Schema", "Unknown"].join("."))) {
    console.log(`boundary value: ${file} uses the schema open value`);
  }
}

const biome = readFileSync("biome.jsonc", "utf8");
if (!biome.includes(`"maxAllowedComplexity": ${config.cognitiveMax}`)) {
  fail("biome cognitive complexity drifted from quality.config.json");
}
if (!biome.includes(`"maxLines": ${config.linesPerFileMax}`)) {
  fail("biome line cap drifted from quality.config.json");
}

const metrics: MethodMetric[] = [];
for (const file of sourceFiles) {
  metrics.push(...metricsFor(file));
}
const byCyclomatic = [...metrics].sort(
  (left, right) => right.cyclomatic - left.cyclomatic
);
const byDifficulty = [...metrics].sort(
  (left, right) => right.difficulty - left.difficulty
);
const [worstCyclomatic] = byCyclomatic;
const [worstDifficulty] = byDifficulty;
console.log(
  `complexity worst ${worstCyclomatic ? worstCyclomatic.cyclomatic : 0} ${worstCyclomatic ? worstCyclomatic.file : ""}:${worstCyclomatic ? worstCyclomatic.line : 0}`
);
console.log(
  `halstead worst ${worstDifficulty ? worstDifficulty.difficulty.toFixed(1) : "0"} ${worstDifficulty ? worstDifficulty.file : ""}:${worstDifficulty ? worstDifficulty.line : 0}`
);
for (const method of metrics) {
  if (method.cyclomatic > config.cyclomaticMax) {
    fail(`${method.file}:${method.line} cyclomatic ${method.cyclomatic}`);
  }
  if (method.difficulty > config.halsteadDifficultyMax) {
    fail(
      `${method.file}:${method.line} halstead ${method.difficulty.toFixed(1)}`
    );
  }
}

const run = (command: string, args: readonly string[]) => {
  const result = spawnSync(command, [...args], { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${command} ${args[0] ?? ""} exited ${result.status}`);
  }
};

run("bun", ["run", "knip", "--", "--no-progress"]);

run("bun", [
  "run",
  "duplicates",
  "--",
  ...config.paths,
  "--threshold",
  String(config.duplication.threshold),
  "--min-lines",
  String(config.duplication.minLines),
  "--min-tokens",
  String(config.duplication.minTokens),
  "--reporters",
  "console",
  "--silent",
  "--absolute",
]);

const unitOnly = process.argv.includes("--unit");

const cover = (directory: string, tests: readonly string[]) => {
  run("bun", [
    "test",
    ...tests,
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${directory}`,
  ]);
};

cover("coverage/unit", config.unitTests);

const coverage = new Map<string, Map<number, number>>();

const rememberFile = (current: string) => {
  if (!coverage.has(current)) {
    coverage.set(current, new Map());
  }
  return current;
};

const rememberHit = (
  current: string,
  listed: string | undefined,
  hits: string | undefined
) => {
  if (listed === undefined || hits === undefined) {
    return;
  }
  const rows = coverage.get(current);
  const lineNumber = Number(listed);
  rows?.set(lineNumber, (rows.get(lineNumber) ?? 0) + Number(hits));
};

const takeCoverageLine = (current: string, line: string) => {
  if (line.startsWith("SF:")) {
    return rememberFile(line.slice(3));
  }
  if (line.startsWith("DA:")) {
    const [listed, hits] = line.slice(3).split(",");
    rememberHit(current, listed, hits);
  }
  return current;
};

const absorbCoverage = (text: string) => {
  let current = "";
  for (const line of text.split("\n")) {
    current = takeCoverageLine(current, line);
  }
};

const readLcov = (file: string) => {
  if (!existsSync(file)) {
    fail(`${file} is missing`);
    return;
  }
  absorbCoverage(readFileSync(file, "utf8"));
};

readLcov("coverage/unit/lcov.info");

const hitsIn = (
  lines: ReadonlyMap<number, number>,
  start: number,
  end: number
) => {
  let executable = 0;
  let hit = 0;
  for (const [line, count] of lines) {
    if (line >= start && line <= end) {
      executable += 1;
      if (count > 0) {
        hit += 1;
      }
    }
  }
  return { executable, hit };
};

const crapOf = (method: MethodMetric) => {
  const rows = [...coverage.entries()].find(([file]) =>
    file.endsWith(method.file)
  );
  const lines = rows?.[1];
  const counted =
    lines === undefined
      ? { executable: 0, hit: 0 }
      : hitsIn(lines, method.line, method.end);
  const covered =
    lines === undefined || counted.executable === 0
      ? 0
      : counted.hit / counted.executable;
  const missed = 1 - covered;
  return method.cyclomatic ** 2 * missed ** 3 + method.cyclomatic;
};

const byCrap = metrics
  .map((method) => ({ crap: crapOf(method), method }))
  .sort((left, right) => right.crap - left.crap);
const [worstCrap] = byCrap;
console.log(
  `crap worst ${worstCrap ? worstCrap.crap.toFixed(1) : "0"} ${worstCrap ? worstCrap.method.file : ""}:${worstCrap ? worstCrap.method.line : 0}`
);
for (const row of byCrap) {
  if (row.crap > config.crapMax) {
    fail(
      `${row.method.file}:${row.method.line} crap ${row.crap.toFixed(1)} cyclomatic ${row.method.cyclomatic}`
    );
  }
}

if (!unitOnly && failures.length === 0) {
  const stryker = {
    commandRunner: {
      command: `bun test --bail ${config.unitTests.join(" ")}`,
    },
    concurrency: 4,
    coverageAnalysis: "off",
    mutate: config.mutation.mutate,
    reporters: ["clear-text", "json", "progress"],
    testRunner: "command",
    thresholds: {
      break: config.mutation.break,
      high: config.mutation.high,
      low: config.mutation.low,
    },
    timeoutMS: 60_000,
    // TypeScript 7 does not export parseConfigFileTextToJson, and Stryker skips
    // its config rewrite when this path is absent.
    tsconfigFile: "stryker-no-tsconfig.json",
  };
  writeFileSync("/tmp/stryker.config.json", JSON.stringify(stryker));
  run("bun", ["run", "mutate", "--", "run", "/tmp/stryker.config.json"]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("quality gates passed");
