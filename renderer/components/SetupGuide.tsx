interface Props {
  bun: string;
  error: string;
}

export function SetupGuide({ bun, error }: Props) {
  return (
    <div className="setup-guide">
      <div className="setup-card">
        <h1>⚠️ 环境未就绪</h1>
        <p className="setup-error">{error}</p>

        <div className="setup-section">
          <h2>1. 安装 Bun</h2>
          <p>ocv 依赖 Bun 运行时。在终端执行：</p>
          <pre>curl -fsSL https://bun.sh/install | bash</pre>
          <p className="muted">macOS 也可以用 <code>brew install bun</code></p>
        </div>

        <div className="setup-section">
          <h2>2. 安装项目依赖</h2>
          <p>在项目目录下执行：</p>
          <pre>bun install</pre>
        </div>

        <div className="setup-section">
          <h2>3. 验证</h2>
          <p>确认 CLI 可用：</p>
          <pre>bun run src/cli.ts --help</pre>
        </div>

        <p className="setup-hint">
          完成后重新打开此窗口，或点击下方按钮重试。
        </p>
        <button className="primary" onClick={() => location.reload()}>重新检查</button>
      </div>
    </div>
  );
}
