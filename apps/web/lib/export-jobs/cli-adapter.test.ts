import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliPlannerExportAdapter } from "./cli-adapter";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CliPlannerExportAdapter", () => {
  it("passes the planner URL as a safe argument and packages command output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "platsa-adapter-test-"));
    temporaryDirectories.push(root);
    const cliPath = path.join(root, "fake-cli.cjs");
    const workspaceDir = path.join(root, "workspace");
    const artifactDir = path.join(root, "artifacts");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      cliPath,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "preview") {',
        '  const outIndex = args.indexOf("--out");',
        "  const output = args[outIndex + 1];",
        "  fs.mkdirSync(output, { recursive: true });",
        '  fs.writeFileSync(path.join(output, "model-iso.png"), "preview");',
        '  console.log("Rendered preview");',
        "  process.exit(0);",
        "}",
        'const outIndex = args.indexOf("--out");',
        'const nameIndex = args.indexOf("--name");',
        "const output = args[outIndex + 1];",
        "fs.mkdirSync(output, { recursive: true });",
        'fs.writeFileSync(path.join(output, "invocation.json"), JSON.stringify(args));',
        'fs.writeFileSync(path.join(output, `${args[nameIndex + 1]}.obj`), "v 0 0 0\\n");',
        'fs.writeFileSync(path.join(output, `${args[nameIndex + 1]}.mtl`), "newmtl material\\n");',
        'console.log("Captured planner project");',
        'console.log("Downloaded 2 assets");',
        'console.log("Exported OBJ bundle");',
      ].join("\n"),
      "utf8",
    );

    const phases: string[] = [];
    const logs: string[] = [];
    const plannerUrl = "https://www.ikea.com/planner/share?id=abc&mode=room";
    const adapter = new CliPlannerExportAdapter({ repoRoot: root, cliPath });
    const result = await adapter.export({
      jobId: "c0a8012e-c5a6-4af1-8f00-b945c081867a",
      plannerType: "platsa",
      plannerUrl,
      workspaceDir,
      artifactDir,
      onProgress: async (update) => {
        phases.push(update.phase);
      },
      onLog: async (line) => {
        logs.push(line);
      },
    });

    const invocation = JSON.parse(
      await readFile(path.join(workspaceDir, "export", "invocation.json"), "utf8"),
    ) as string[];
    expect(invocation.slice(0, 2)).toEqual(["platsa-export", plannerUrl]);
    expect(invocation).toContain("--out");
    expect(invocation).toContain("--name");
    expect(phases).toEqual(["capturing", "downloading", "exporting", "packaging"]);
    expect(logs).toContain("Exported OBJ bundle");
    expect(result.artifactName).toBe("platsa-room-c0a8012e-obj-bundle.zip");
    expect((await stat(result.artifactPath)).size).toBeGreaterThan(100);
    expect(result.previewPath).toBeDefined();
    expect((await stat(result.previewPath!)).size).toBeGreaterThan(0);

    const methodWorkspaceDir = path.join(root, "method-workspace");
    const methodArtifactDir = path.join(root, "method-artifacts");
    const methodResult = await adapter.export({
      jobId: "7a1cfe8c-0dce-41dd-b6d8-7e0a7d53cf92",
      plannerType: "method",
      plannerUrl,
      workspaceDir: methodWorkspaceDir,
      artifactDir: methodArtifactDir,
      onProgress: async () => {},
      onLog: async () => {},
    });
    const methodInvocation = JSON.parse(
      await readFile(path.join(methodWorkspaceDir, "export", "invocation.json"), "utf8"),
    ) as string[];
    expect(methodInvocation.slice(0, 2)).toEqual(["method-export", plannerUrl]);
    expect(methodResult.artifactName).toBe("method-room-7a1cfe8c-obj-bundle.zip");

    const paxWorkspaceDir = path.join(root, "pax-workspace");
    const paxArtifactDir = path.join(root, "pax-artifacts");
    const paxUrl = "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/?vpcSource=clipboard#/vpc/337LMDY";
    const paxResult = await adapter.export({
      jobId: "1ca145b1-b0e9-4b1c-9659-d7687950d78e",
      plannerType: "pax",
      plannerUrl: paxUrl,
      workspaceDir: paxWorkspaceDir,
      artifactDir: paxArtifactDir,
      onProgress: async () => {},
      onLog: async () => {},
    });
    const paxInvocation = JSON.parse(
      await readFile(path.join(paxWorkspaceDir, "export", "invocation.json"), "utf8"),
    ) as string[];
    expect(paxInvocation.slice(0, 2)).toEqual(["pax-export", paxUrl]);
    expect(paxResult.artifactName).toBe("pax-room-1ca145b1-obj-bundle.zip");
  });
});
