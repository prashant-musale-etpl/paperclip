import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_TEMPLATE_PRESETS } from "@paperclipai/shared";
import { readPhasesSource, registerLifecycleCommands } from "../commands/client/lifecycle.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const API = ["--api-base", "http://localhost:3100", "--api-key", "board-token"];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerLifecycleCommands(program);
  return program;
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("lifecycle commands", () => {
  let tempDir: string;
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-lifecycle-"));
    process.env.PAPERCLIP_CONTEXT = path.join(tempDir, "context.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_CONTEXT;
  });

  it("sets a project lifecycle from a built-in preset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ projectId: PROJECT_ID, mode: "enforced", version: 1, templateId: null, phases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync(["lifecycle", "set", PROJECT_ID, ...API, "--mode", "enforced", "--preset", "bugfix", "--json"], { from: "user" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}/lifecycle`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.mode).toBe("enforced");
    expect(body.phases.map((phase: { key: string }) => phase.key)).toEqual(["triage", "fix", "verify", "ship"]);
    expect(body.phases.at(-1).kind).toBe("terminal");
  });

  it("changes only the mode, with an expected version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ projectId: PROJECT_ID, mode: "advisory", version: 3, templateId: null, phases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync(["lifecycle", "set", PROJECT_ID, ...API, "--mode", "advisory", "--expected-version", "2", "--json"], { from: "user" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ mode: "advisory", expectedVersion: 2 });
  });

  it("creates a company template from a phases file", async () => {
    const file = path.join(tempDir, "phases.json");
    fs.writeFileSync(file, JSON.stringify({ phases: [{ key: "draft", name: "Draft" }, { key: "publish", name: "Publish", kind: "terminal" }] }));
    const fetchMock = vi.fn().mockResolvedValue(respond({ id: "t1", key: "content", name: "Content", phases: [] }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync([
      "lifecycle", "templates", "create", ...API, "--company-id", COMPANY_ID,
      "--key", "content", "--name", "Content", "--phases-file", file, "--json",
    ], { from: "user" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/lifecycle-templates`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      key: "content", name: "Content", phases: [{ key: "draft" }, { key: "publish", kind: "terminal" }],
    });
  });

  it("sends a task back for rework", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ issueId: ISSUE_ID, phaseKey: "fix", phaseVersion: 4, status: "todo" }));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync([
      "lifecycle", "move", ISSUE_ID, ...API, "--kind", "rework", "--to", "fix", "--reason", "Still reproduces", "--expected-phase-version", "3", "--json",
    ], { from: "user" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/issues/${ISSUE_ID}/phase-transitions`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "rework", toPhaseKey: "fix", reason: "Still reproduces", expectedPhaseVersion: 3,
    });
  });

  it("validates phase sources", () => {
    expect(readPhasesSource({ preset: "sdlc" })).toEqual(LIFECYCLE_TEMPLATE_PRESETS.find((preset) => preset.key === "sdlc")!.phases);
    expect(() => readPhasesSource({ preset: "waterfall" })).toThrow(/Unknown preset "waterfall". Available: sdlc, bugfix/);
    expect(() => readPhasesSource({ preset: "sdlc", phasesFile: "x.json" })).toThrow(/not both/);
    expect(readPhasesSource({})).toBeUndefined();
  });
});
