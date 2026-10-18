import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface HalsteadReport {
  readonly difficulty?: number;
}

interface MethodReport {
  readonly cyclomatic?: number;
  readonly halstead?: HalsteadReport;
  readonly lineEnd?: number;
  readonly lineStart?: number;
  readonly name?: string;
}

interface ModuleReport {
  readonly classes?: readonly { readonly methods?: readonly MethodReport[] }[];
  readonly methods?: readonly MethodReport[];
}

interface EscomplexModule {
  readonly analyzeModule: (source: string) => ModuleReport;
}

const escomplex = require("typhonjs-escomplex") as EscomplexModule;

export interface MethodMetric {
  readonly cyclomatic: number;
  readonly difficulty: number;
  readonly end: number;
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

const prepare = (source: string) =>
  source.replaceAll(
    "...requestFields,",
    "message: Schema.String, requestId: RequestId,"
  );

const listed = (report: ModuleReport) => {
  const methods = [...(report.methods ?? [])];
  for (const item of report.classes ?? []) {
    methods.push(...(item.methods ?? []));
  }
  return methods;
};

export const metricsFor = (file: string): MethodMetric[] => {
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts")) {
    return [];
  }
  const report = escomplex.analyzeModule(prepare(readFileSync(file, "utf8")));
  return listed(report).map((method) => ({
    cyclomatic: method.cyclomatic ?? 1,
    difficulty: method.halstead?.difficulty ?? 0,
    end: method.lineEnd ?? method.lineStart ?? 1,
    file,
    line: method.lineStart ?? 1,
    name: method.name ?? "anonymous",
  }));
};
