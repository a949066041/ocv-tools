import "./setup-root.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPr } from "../src/pr.js";
import { configSchema } from "../src/schema.js";
import { TEST_ROOT } from "./setup-root.js";

const remote = { host: "gitee.com", owner: "o", repo: "r" };
const ghRemote = { host: "github.com", owner: "o", repo: "r" };
const cfg = configSchema.parse({});

interface Call { path: string; body: Record<string, unknown> | null; auth: string | null }
const calls: Call[] = [];
let server: Server<undefined>;
let api = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      calls.push({
        path: url.pathname,
        body: text ? JSON.parse(text) : null,
        auth: req.headers.get("authorization"),
      });
      if (calls.at(-1)!.body?.access_token === "bad") {
        return Response.json({ message: "bad token" }, { status: 401 });
      }
      return Response.json({ html_url: `https://mock${url.pathname}/1` });
    },
  });
  api = `http://127.0.0.1:${server.port}`;
  delete process.env.GITEE_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

afterAll(() => {
  server.stop(true);
});

describe("createPr 降级与 API 路径", () => {
  test("local remote 不提 PR", async () => {
    const r = await createPr("manual", { host: "local", owner: "", repo: "x" }, cfg, "f", "b", "t", "body");
    expect(r.url).toBe("");
    expect(r.note).toContain("本地 remote");
  });

  test("manual:给手动链接", async () => {
    const r = await createPr("manual", remote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.url).toBe("https://gitee.com/o/r/compare/feat/x...fix/x?expand=1");
    expect(r.note).toContain("手动创建 PR");
    expect(calls).toHaveLength(0);
  });

  test("缺 token:降级手动链接并点名变量", async () => {
    const r = await createPr("gitee", remote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.note).toContain("缺少 GITEE_TOKEN");
    expect(r.url).toContain("compare");
    expect(calls).toHaveLength(0);
  });

  test("env token 走 API,请求体带 access_token/head/base", async () => {
    process.env.GITEE_TOKEN = "tok";
    process.env.OCV_GITEE_API = api;
    const r = await createPr("gitee", remote, cfg, "fix/x", "feat/x", "标题", "正文");
    expect(r.url).toBe("https://mock/repos/o/r/pulls/1");
    expect(r.note).toBeUndefined();
    const call = calls.at(-1)!;
    expect(call.path).toBe("/repos/o/r/pulls");
    expect(call.body).toMatchObject({ access_token: "tok", head: "fix/x", base: "feat/x", title: "标题", body: "正文" });
    delete process.env.GITEE_TOKEN;
    delete process.env.OCV_GITEE_API;
  });

  test("API 401:降级并带状态码与原因", async () => {
    process.env.GITEE_TOKEN = "bad";
    process.env.OCV_GITEE_API = api;
    const r = await createPr("gitee", remote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.note).toContain("gitee PR 创建失败(401): bad token");
    expect(r.url).toContain("compare");
    delete process.env.GITEE_TOKEN;
    delete process.env.OCV_GITEE_API;
  });

  test("secrets 文件兜底读 token", async () => {
    writeFileSync(join(TEST_ROOT, ".ocv.secrets.json"), JSON.stringify({ GITEE_TOKEN: "sectok" }));
    process.env.OCV_GITEE_API = api;
    const r = await createPr("gitee", remote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.url).toContain("/pulls/1");
    expect(calls.at(-1)!.body!.access_token).toBe("sectok");
    delete process.env.OCV_GITEE_API;
  });

  test("github:Bearer 头 + 独立 API base", async () => {
    writeFileSync(join(TEST_ROOT, ".ocv.secrets.json"), JSON.stringify({ GITHUB_TOKEN: "ghtok" }));
    process.env.OCV_GITHUB_API = api;
    const r = await createPr("github", ghRemote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.url).toContain("/pulls/1");
    const call = calls.at(-1)!;
    expect(call.auth).toBe("Bearer ghtok");
    expect(call.body!.head).toBe("fix/x");
    delete process.env.OCV_GITHUB_API;
  });

  test("网络异常:降级不抛", async () => {
    process.env.GITEE_TOKEN = "tok";
    process.env.OCV_GITEE_API = "http://127.0.0.1:1";
    const r = await createPr("gitee", remote, cfg, "fix/x", "feat/x", "t", "body");
    expect(r.note).toContain("创建 PR 异常");
    expect(r.url).toContain("compare");
    delete process.env.GITEE_TOKEN;
    delete process.env.OCV_GITEE_API;
  });
});
