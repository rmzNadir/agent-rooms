import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type Env,
  envFrom,
  envValue,
  profileProblems,
  verifyAgentsFromEnv,
} from "../scripts/deploy-profile.ts";
import {
  existingSecretsOrEmpty,
  githubCommands,
  mintAdminToken,
  packedVerifyTokens,
  redact,
  requestFromEnv,
  runSetup,
  type SetupIo,
  type SetupRequest,
  secretNames,
  spawnCommand,
  stillMissing,
} from "../scripts/setup-account.ts";

const environmentExpression =
  /environment: \$\{\{ vars\.AGENT_ROOMS_GITHUB_ENVIRONMENT \}\}/u;
const stageGroup = /group: agent-rooms-\$\{\{ vars\.AGENT_ROOMS_STAGE \}\}/u;

const profile = {
  AGENT_ROOMS_BACKUP_BUCKET: "room-backups",
  AGENT_ROOMS_GITHUB_ENVIRONMENT: "rooms",
  AGENT_ROOMS_STAGE: "rooms",
};

const request = (patch: Partial<SetupRequest> = {}): SetupRequest => ({
  accountId: "account-id-1234",
  adminToken: undefined,
  agentTokens: {},
  apiToken: "cloudflare-token-value",
  bucket: "room-backups",
  domain: undefined,
  environment: "rooms",
  existingSecrets: [],
  repo: "example/agent-rooms",
  stage: "rooms",
  url: undefined,
  verifyAgents: undefined,
  verifyTokens: undefined,
  workerName: undefined,
  ...patch,
});

const recording = () => {
  const lines: string[] = [];
  const commands: string[] = [];
  const io: SetupIo = {
    bootstrap: () => {
      lines.push("bootstrap");
      return Promise.resolve();
    },
    bucket: (_account, name) => {
      lines.push(`bucket ${name}`);
      return Promise.resolve();
    },
    exec: (command) => {
      commands.push(
        `${command.command} ${command.args.join(" ")} input=${command.input === undefined ? "" : "set"}`
      );
      return Promise.resolve(
        command.input === undefined ? "" : `stored ${command.input}`
      );
    },
    log: (line) => {
      lines.push(line);
    },
    mintAdmin: () => "minted-admin-token-value",
    zone: (_account, hostname) => {
      lines.push(`zone ${hostname}`);
      return Promise.resolve();
    },
  };
  return { commands, io, lines };
};

describe("deploy profile", () => {
  test("requires stage, environment, and bucket", () => {
    expect(profileProblems({})).toEqual([
      "missing AGENT_ROOMS_BACKUP_BUCKET",
      "missing AGENT_ROOMS_GITHUB_ENVIRONMENT",
      "missing AGENT_ROOMS_STAGE",
    ]);
    expect(profileProblems({ ...profile, AGENT_ROOMS_STAGE: "Nadir" })).toEqual(
      ["bad AGENT_ROOMS_STAGE"]
    );
    expect(profileProblems(profile)).toEqual([]);
  });

  test("reads verify agents from a list or from packed tokens", () => {
    expect(verifyAgentsFromEnv(profile)).toEqual([]);
    expect(
      verifyAgentsFromEnv({
        ...profile,
        AGENT_ROOMS_ADA_TOKEN: "ada-token",
        AGENT_ROOMS_VERIFY_AGENTS: "ada",
      })
    ).toEqual([{ label: "ada", token: "ada-token" }]);
    expect(
      verifyAgentsFromEnv({
        AGENT_ROOMS_VERIFY_AGENTS: "ada",
        AGENT_ROOMS_VERIFY_TOKENS: "gus=gus-token",
      })
    ).toEqual([{ label: "gus", token: "gus-token" }]);
    expect(() =>
      verifyAgentsFromEnv({ AGENT_ROOMS_VERIFY_AGENTS: "Ada" })
    ).toThrow("bad verify agent entry");
    const bearer = "a".repeat(64);
    let packedProblem = "";
    try {
      verifyAgentsFromEnv({
        AGENT_ROOMS_VERIFY_TOKENS: `${bearer}=ada`,
      });
    } catch (error) {
      packedProblem = error instanceof Error ? error.message : "";
    }
    expect(packedProblem).toBe("bad verify agent entry");
    const values: Env = {
      AGENT_ROOMS_ADA_TOKEN: "ada-token",
      AGENT_ROOMS_VERIFY_AGENTS: "ada",
    };
    expect(
      envValue(
        envFrom((key) => values[key]),
        "AGENT_ROOMS_ADA_TOKEN"
      )
    ).toBe("ada-token");
  });
});

describe("account setup", () => {
  test("plans github writes without putting secrets on the command line", () => {
    const minted = mintAdminToken();
    expect(minted).toHaveLength(64);
    const commands = githubCommands(
      request({ agentTokens: { ada: "ada-token-value" }, verifyAgents: "ada" }),
      minted
    );
    const rendered = commands
      .map((command) => command.args.join(" "))
      .join("\n");
    expect(rendered).toContain("AGENT_ROOMS_STAGE");
    expect(rendered).toContain("rooms");
    expect(rendered).toContain("repos/example/agent-rooms/environments/rooms");
    expect(rendered).not.toContain(minted);
    expect(rendered).not.toContain("cloudflare-token-value");
    expect(rendered).not.toContain("ada-token-value");
    const admin = commands.find((command) =>
      command.args.includes("AGENT_ROOMS_ADMIN_TOKEN")
    );
    expect(admin?.input).toBe(minted);
    expect(
      packedVerifyTokens(
        request({
          agentTokens: { ada: "ada-token-value" },
          verifyAgents: "ada",
        })
      )
    ).toBe("ada=ada-token-value");
    expect(secretNames("CLOUDFLARE_API_TOKEN\t2026-10-26\n")).toEqual([
      "CLOUDFLARE_API_TOKEN",
    ]);
    expect(
      stillMissing(
        request({
          existingSecrets: ["AGENT_ROOMS_BROBERT_TOKEN"],
          verifyAgents: "brobert,ada",
        })
      )
    ).toEqual(["AGENT_ROOMS_URL", "AGENT_ROOMS_VERIFY_TOKENS"]);
    expect(
      stillMissing(
        request({
          existingSecrets: [
            "AGENT_ROOMS_BROBERT_TOKEN",
            "AGENT_ROOMS_CODEX_TOKEN",
            "AGENT_ROOMS_URL",
          ],
          verifyAgents: "brobert,codex",
        })
      )
    ).toEqual([]);
    const kept = githubCommands(
      request({
        adminToken: "existing-admin-token",
        existingSecrets: ["AGENT_ROOMS_ADMIN_TOKEN", "CLOUDFLARE_API_TOKEN"],
      }),
      "minted-admin-token-value"
    );
    expect(
      kept.some((command) => command.args.includes("AGENT_ROOMS_ADMIN_TOKEN"))
    ).toBe(false);
    expect(
      kept.some((command) => command.args.includes("CLOUDFLARE_API_TOKEN"))
    ).toBe(false);
    const blank = githubCommands(
      request({ accountId: "", apiToken: "" }),
      undefined
    );
    expect(
      blank.some((command) => command.args.includes("CLOUDFLARE_ACCOUNT_ID"))
    ).toBe(false);
    expect(
      blank.some((command) => command.args.includes("CLOUDFLARE_API_TOKEN"))
    ).toBe(false);
  });

  test("runs bootstrap and the bucket create, and redacts command output", async () => {
    const { commands, io, lines } = recording();
    await runSetup(request(), io);
    expect(lines[0]).toBe("bootstrap");
    expect(lines[1]).toBe("bucket room-backups");
    expect(lines.join("\n")).not.toContain("minted-admin-token-value");
    expect(lines.join("\n")).not.toContain("cloudflare-token-value");
    expect(lines).toContain("still needed: AGENT_ROOMS_URL");
    expect(commands.some((line) => line.includes("input=set"))).toBe(true);
    expect(
      redact("token cloudflare-token-value", ["cloudflare-token-value"])
    ).toBe("token [redacted]");
    await expect(runSetup(request({ stage: "Nadir" }), io)).rejects.toThrow(
      "bad AGENT_ROOMS_STAGE"
    );
    const skipped = recording();
    await expect(
      runSetup(request({ accountId: "" }), skipped.io)
    ).rejects.toThrow("missing CLOUDFLARE_ACCOUNT_ID");
    expect(skipped.lines).toEqual([]);
    const partial = recording();
    await expect(
      runSetup(
        request({
          agentTokens: { ada: "ada-token-value" },
          verifyAgents: "ada,gus",
        }),
        partial.io
      )
    ).rejects.toThrow("AGENT_ROOMS_VERIFY_TOKENS was not stored");
    expect(partial.lines).toEqual([]);
    const leaked = recording();
    await expect(
      runSetup(request(), {
        ...leaked.io,
        exec: () => Promise.reject(new Error("denied cloudflare-token-value")),
      })
    ).rejects.toThrow("denied [redacted]");
    await expect(
      existingSecretsOrEmpty(() =>
        Promise.reject(new Error("failed to get secrets: HTTP 404: Not Found"))
      )
    ).resolves.toEqual([]);
    await expect(
      existingSecretsOrEmpty(() => Promise.reject(new Error("HTTP 401")))
    ).rejects.toThrow("HTTP 401");
    const again = recording();
    await runSetup(
      request({
        existingSecrets: ["AGENT_ROOMS_URL"],
        url: "https://rooms.example",
      }),
      again.io
    );
    expect(again.lines.join("\n")).not.toContain("still needed");
    const named = recording();
    await runSetup(request({ domain: "rooms.example.com" }), named.io);
    expect(named.lines[0]).toBe("zone rooms.example.com");
    expect(named.lines[1]).toBe("bootstrap");
    expect(
      named.commands.some((line) => line.includes("AGENT_ROOMS_DOMAIN"))
    ).toBe(true);
    const badDomain = recording();
    await expect(
      runSetup(request({ domain: "https://rooms.example.com" }), badDomain.io)
    ).rejects.toThrow("AGENT_ROOMS_DOMAIN must be a bare hostname");
    expect(badDomain.lines).toEqual([]);
  });

  test("spawns a command and keeps its output", async () => {
    const text = await spawnCommand({
      args: ["-e", "console.log('ok')"],
      command: "bun",
      input: undefined,
    });
    expect(text).toBe("ok\n");
    await expect(
      spawnCommand({
        args: ["-e", "process.exit(1)"],
        command: "bun",
        input: undefined,
      })
    ).rejects.toThrow();
  });

  test("requestFromEnv copies only the names it was given", () => {
    const built = requestFromEnv(
      {
        AGENT_ROOMS_BACKUP_BUCKET: "room-backups",
        AGENT_ROOMS_GITHUB_ENVIRONMENT: "rooms",
        AGENT_ROOMS_STAGE: "rooms",
        AGENT_ROOMS_VERIFY_AGENTS: "ada",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "tok",
      },
      "example/agent-rooms",
      []
    );
    expect(built.stage).toBe("rooms");
    expect(built.domain).toBeUndefined();
    expect(Object.hasOwn(built.agentTokens, "ada")).toBe(true);
    expect(built.repo).toBe("example/agent-rooms");
  });
});

describe("workflows", () => {
  test("deploys from actions and keeps backups off the log", () => {
    const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
    const nightly = readFileSync(".github/workflows/backup.yml", "utf8");
    expect(deploy).not.toContain("upload-artifact");
    expect(deploy).not.toContain("AGENT_ROOMS_LOCAL_STATE");
    expect(deploy).not.toContain("cat ");
    expect(nightly).not.toContain("upload-artifact");
    expect(nightly).not.toContain("cat ");
    const order = [
      "deploy-guard.ts backup",
      "deploy-guard.ts pin",
      "deploy -- --yes --stage",
      "deploy-guard.ts verify",
      "deploy-guard.ts rollback",
      "conformance.ts",
      "live-e2e.ts",
      "wake-receiver.ts down",
    ];
    let at = -1;
    for (const step of order) {
      const next = deploy.indexOf(step);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(deploy).toContain("GITHUB_RUN_ATTEMPT");
    expect(deploy).toContain("live-e2e.ts --sweep");
    expect(deploy).toContain("workflow_dispatch:");
    expect(deploy).toContain("branches: [main]");
    expect(deploy).toMatch(environmentExpression);
    expect(deploy).toMatch(stageGroup);
    expect(deploy).toContain("AGENT_ROOMS_BROBERT_TOKEN");
    expect(deploy).toContain("AGENT_ROOMS_CODEX_TOKEN");
    expect(deploy).not.toContain("nadir");
    expect(deploy).not.toContain("4ccd22217c6f09a443b03d6f86df9708");
    expect(deploy).toContain("steps.deploy.outcome == 'failure'");
    expect(deploy).toContain("steps.verify.outcome == 'failure'");
    expect(deploy).toContain("Durable Object migration");
    expect(nightly).toContain('cron: "15 7 * * *"');
    expect(nightly).toContain("AGENT_ROOMS_BACKUP_PREFIX: nightly");
    expect(nightly).toMatch(stageGroup);
    expect(nightly).not.toContain("nadir");
    expect(nightly).not.toContain("bun run deploy");
    expect(deploy).toContain("scripts/public-url.ts");
    expect(deploy).toContain("env.AGENT_ROOMS_PUBLIC_URL != ''");
    expect(nightly).toContain("env.AGENT_ROOMS_PUBLIC_URL");
    const plan = readFileSync(".github/workflows/plan-prod.yml", "utf8");
    expect(plan).toContain(
      "alchemy plan --stage prod --adopt --no-input --env-file /dev/null"
    );
    expect(plan).toContain("environment: prod");
    expect(plan).toContain("cursor/stage-rename-plan-8d00");
    expect(plan).not.toContain("--yes");
    expect(plan).not.toContain("bun run deploy");
    expect(plan).toContain("scripts/show-plan.ts");
  });
});

interface WorkflowStep {
  readonly if?: string;
  readonly name?: string;
}

interface WorkflowJob {
  readonly env?: Record<string, string>;
  readonly steps: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs: {
    readonly deploy?: WorkflowJob;
    readonly [name: string]: WorkflowJob | undefined;
  };
}

const jobContextExpression = /\$\{\{\s*(runner|steps|job|env)\./;

const workflow = (file: string) =>
  Bun.YAML.parse(readFileSync(file, "utf8")) as Workflow;

describe("workflow contexts", () => {
  test("job env only uses contexts GitHub allows there", () => {
    for (const file of [
      ".github/workflows/deploy.yml",
      ".github/workflows/backup.yml",
      ".github/workflows/plan-prod.yml",
    ]) {
      const jobs = Object.values(workflow(file).jobs);
      const envs = jobs.map((job) => job?.env ?? {});
      for (const env of envs) {
        for (const value of Object.values(env)) {
          expect(value).not.toMatch(jobContextExpression);
        }
      }
    }
  });

  test("rollback still runs after a failed deploy or verify step", () => {
    const steps = workflow(".github/workflows/deploy.yml").jobs.deploy?.steps;
    const rollback = steps?.find((step) => step.name?.startsWith("Roll back"));
    expect(rollback?.if?.startsWith("failure() && (")).toBe(true);
    expect(rollback?.if).toContain("steps.pin.outcome == 'success'");
  });
});
