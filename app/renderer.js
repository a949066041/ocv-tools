// 渲染层：按 ocv config 返回的有效配置生成表单，保存时按 data-path 收回。
// 字段是从配置对象推导的，ocv.ts 加新配置项后界面自动出现，不需要同步改这里。
let cfg = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const logPane = () => document.getElementById("log");

function say(text) {
  const p = logPane();
  p.textContent += text + "\n";
  p.scrollTop = p.scrollHeight;
}

function fieldHtml(path, kind, value, label) {
  if (kind === "bool") {
    return `<div class="field"><label>${esc(label)}</label><label class="chk"><input type="checkbox" data-path="${esc(path)}" data-kind="bool" ${value ? "checked" : ""}/> 启用</label></div>`;
  }
  const shown = kind === "list" ? (value ?? []).join(", ") : (value ?? "");
  const type = kind === "num" ? "number" : "text";
  return `<div class="field"><label>${esc(label)}</label><input type="${type}" data-path="${esc(path)}" data-kind="${kind}" value="${esc(shown)}"/></div>`;
}

function kindOf(v) {
  if (typeof v === "number") return "num";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "list";
  return "str";
}

function settingsHtml(c) {
  let html = "";
  for (const [k, v] of Object.entries(c)) {
    if (k.startsWith("_") || k === "repos") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      html += `<div class="group">${esc(k)}</div>`;
      for (const [sk, sv] of Object.entries(v)) html += fieldHtml(`${k}.${sk}`, kindOf(sv), sv, sk);
    } else if (v !== undefined) {
      html += fieldHtml(k, kindOf(v), v, k);
    }
  }
  return html;
}

function reposHtml(c) {
  const rows = (c.repos ?? [])
    .map(
      (r, i) => `<tr>
      <td class="on"><input type="checkbox" data-path="repos.${i}.enabled" data-kind="bool" ${r.enabled !== false ? "checked" : ""}/></td>
      <td class="name"><input data-path="repos.${i}.name" data-kind="str" value="${esc(r.name)}"/></td>
      <td class="path"><input data-path="repos.${i}.path" data-kind="str" value="${esc(r.path)}"/></td>
      <td class="base"><input data-path="repos.${i}.base" data-kind="optstr" value="${esc(r.base ?? "")}" placeholder="自动探测"/></td>
      <td class="pat"><input data-path="repos.${i}.branches" data-kind="optstr" value="${esc(r.branches ?? "")}" placeholder="${esc(c.branches)}"/></td>
      <td class="pr"><select data-path="repos.${i}.pr" data-kind="str">${["gitee", "github", "manual"]
        .map((x) => `<option ${r.pr === x ? "selected" : ""}>${x}</option>`)
        .join("")}</select></td>
      <td class="del"><button data-del="${i}">删除</button></td>
    </tr>`,
    )
    .join("");
  return `<thead><tr><th></th><th>名称</th><th>路径</th><th>基线</th><th>分支 glob</th><th>PR 平台</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">还没有仓库，点「添加仓库」</td></tr>`}</tbody>`;
}

/** 按 data-path 把界面上的值收回配置对象；opt* 留空表示删掉该键（走全局默认） */
function collect() {
  const next = structuredClone(cfg);
  for (const input of document.querySelectorAll("[data-path]")) {
    const parts = input.dataset.path.split(".");
    let node = next;
    for (const p of parts.slice(0, -1)) node = node[p];
    const key = parts.at(-1);
    const kind = input.dataset.kind;
    const raw = input.value.trim();
    if (kind === "bool") node[key] = input.checked;
    else if (kind === "num") node[key] = Number(input.value);
    else if (kind === "list") node[key] = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (kind === "optnum" || kind === "optstr") {
      if (raw === "") delete node[key];
      else node[key] = kind === "optnum" ? Number(raw) : raw;
    } else node[key] = input.value;
  }
  return next;
}

function render() {
  document.getElementById("repo-count").textContent = `${(cfg.repos ?? []).length} 个`;
  document.getElementById("repos").innerHTML = reposHtml(cfg);
  document.getElementById("settings").innerHTML = settingsHtml(cfg);
}

async function refreshStatus() {
  const st = await window.ocv.state();
  const rows = Object.entries(st.branches ?? {}).map(([k, b]) => {
    const [repo, branch] = k.split("|");
    const c = b.counts ?? {};
    const pr = b.prUrl
      ? `<a href="#" data-url="${esc(b.prUrl)}">打开 PR</a>`
      : b.error
        ? `<span class="err">${esc(b.error)}</span>`
        : b.note
          ? `<span class="muted">${esc(b.note)}</span>`
          : `<span class="muted">无</span>`;
    return `<tr><td>${esc(repo)}</td><td>${esc(branch)}</td><td>${c.critical ?? 0} / ${c.high ?? 0}</td><td>${c.medium ?? 0} / ${c.low ?? 0}</td><td>${pr}</td><td class="muted">${esc((b.reviewedAt ?? "").slice(0, 19).replace("T", " "))}</td></tr>`;
  });
  document.getElementById("status").innerHTML =
    `<thead><tr><th>仓库</th><th>分支</th><th>crit / high</th><th>med / low</th><th>PR / 错误</th><th>最近运行</th></tr></thead>
     <tbody>${rows.join("") || `<tr><td colspan="6" class="muted">还没有跑过任何分支</td></tr>`}</tbody>`;
}

function runArgs(extra) {
  const args = [...extra];
  const repo = document.getElementById("f-repo").value.trim();
  const branch = document.getElementById("f-branch").value.trim();
  if (repo) args.push("--repo", repo);
  if (branch) args.push("--branch", branch);
  if (document.getElementById("f-force").checked) args.push("--force");
  return args;
}

/** 跑起来的时候把按钮置灰 + 打运行态标记，避免"点了没反应"的错觉 */
function setRunning(on) {
  for (const id of ["dry", "run"]) document.getElementById(id).disabled = on;
  document.getElementById("run-state").textContent = on ? "运行中…" : "";
}

async function start(extra) {
  logPane().textContent = "";
  setRunning(true);
  const res = await window.ocv.run(runArgs(extra));
  if (!res.ok) {
    setRunning(false);
    say(res.error);
  }
}

window.ocv.onOutput((text) => say(text));
window.ocv.onDone(() => {
  setRunning(false);
  refreshStatus();
});

document.getElementById("save").onclick = async () => {
  const res = await window.ocv.save(collect());
  say(res.ok ? `配置已保存 → ${res.at}` : `保存失败：${res.error ?? ""}`);
};

document.getElementById("add-repo").onclick = () => {
  const next = collect();
  next.repos.push({ name: "new-repo", path: "", pr: "manual", enabled: false });
  cfg = next;
  render();
  say("已添加一行，填好路径后点「保存配置」。");
};

document.getElementById("repos").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-del]");
  if (!btn) return;
  const next = collect();
  next.repos.splice(Number(btn.dataset.del), 1);
  cfg = next;
  render();
});

document.getElementById("status").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-url]");
  if (!link) return;
  event.preventDefault();
  window.ocv.open(link.dataset.url);
});

document.getElementById("refresh").onclick = () => refreshStatus();
document.getElementById("open-reports").onclick = () => window.ocv.open("reports");

document.getElementById("dry").onclick = () => start(["--dry-run"]);

document.getElementById("run").onclick = () => {
  if (!confirm("立即运行会真实推修复分支并尝试创建 PR，继续？")) return;
  start([]);
};

document.getElementById("cancel").onclick = async () => {
  const res = await window.ocv.cancel();
  say(res.ok ? "已发送中止信号。" : res.error);
};

(async () => {
  cfg = await window.ocv.config();
  document.getElementById("paths").textContent = `配置 ${cfg._paths.config}  ·  报告 ${cfg._paths.reports}`;
  render();
  await refreshStatus();
  say("就绪。改完配置记得点「保存配置」；「试跑」只扫不改。");
})();