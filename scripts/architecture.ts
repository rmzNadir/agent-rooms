import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";

const roots = ["src/model"];
const forbidden =
  /from ["'](?:alchemy\/Cloudflare|alchemy\/Http|node:fs|node:http|node:https|\.\.\/(?:api|directory|mcp|room|runtime|viewer)\/)/u;

const past = /(?:ed|Left|Taken|Line)$/u;
const imperative =
  /^(?:Open|Invite|Join|Leave|Post|Edit|Redact|React|Mark|Record|Expire|Register|Rotate|Reserve)/u;

const filesUnder = (root: string): string[] => {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = `${root}/${name}`;
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else if (name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
};

const classNames = (text: string, kind: "Command" | "Event") => {
  const names: string[] = [];
  const pattern = new RegExp(String.raw`class (\w+) extends ${kind}\(`, "gu");
  for (const match of text.matchAll(pattern)) {
    const [, name] = match;
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
};

const commandBlocks = (text: string) => {
  const blocks: string[] = [];
  const pattern = /class \w+ extends Command\([\s\S]*?\n\)/gu;
  for (const match of text.matchAll(pattern)) {
    blocks.push(match[0]);
  }
  return blocks;
};

const modelFailures = (file: string, text: string) => {
  const failures: string[] = [];
  if (!file.startsWith("src/model/")) {
    return failures;
  }
  for (const block of commandBlocks(text)) {
    if (!block.includes("rejects:")) {
      failures.push(`${file} has a command without rejects`);
    }
  }
  for (const name of classNames(text, "Event")) {
    if (!past.test(name)) {
      failures.push(`${file} event ${name} is not past tense`);
    }
  }
  for (const name of classNames(text, "Command")) {
    if (!imperative.test(name)) {
      failures.push(`${file} command ${name} is not imperative`);
    }
  }
  return failures;
};

const sameFile = (left: string, right: string) =>
  readFileSync(left).equals(readFileSync(right));

const linkFailures = () => {
  const failures: string[] = [];
  if (!sameFile("CLAUDE.md", "AGENTS.md")) {
    failures.push("CLAUDE.md does not match AGENTS.md");
  }
  if (existsSync(".git")) {
    const listed = execFileSync("git", ["ls-files", "-s", "CLAUDE.md"], {
      encoding: "utf8",
    });
    const recorded =
      listed.length === 0
        ? lstatSync("CLAUDE.md").isSymbolicLink()
        : listed.startsWith("120000");
    if (!recorded) {
      failures.push("CLAUDE.md is not a git symlink");
    }
  }
  for (const name of ["SKILL.md", "language.md", "layout.md", "checks.md"]) {
    for (const root of [
      ".claude/skills/domain-modeling",
      ".agents/skills/domain-modeling",
    ]) {
      if (!sameFile(`skills/domain-modeling/${name}`, `${root}/${name}`)) {
        failures.push(`${root}/${name} drifted from the skill`);
      }
    }
  }
  return failures;
};

export const architectureFailures = () => {
  const failures: string[] = [];
  for (const file of roots.flatMap(filesUnder)) {
    const text = readFileSync(file, "utf8");
    if (forbidden.test(text) || text.includes("fetch(")) {
      failures.push(`${file} reaches outside the domain`);
    }
    failures.push(...modelFailures(file, text));
  }
  const worker = readFileSync("src/api-worker.ts", "utf8");
  if (
    worker.includes("Domain/Cloudflare") ||
    worker.includes("roomsOnCloudflare")
  ) {
    failures.push("src/api-worker.ts imports the domain runtime");
  }
  failures.push(...linkFailures());
  return failures;
};

if (import.meta.main) {
  const failures = architectureFailures();
  for (const failure of failures) {
    console.error(failure);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
}
