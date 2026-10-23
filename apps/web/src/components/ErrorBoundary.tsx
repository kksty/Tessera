import { Component, type ErrorInfo, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, info: ErrorInfo) {
    console.error("Workspace rendering failed", { componentStack: info.componentStack });
  }
  render() {
    if (this.state.failed)
      return (
        <main role="alert" className="boot-screen">
          <h1>工作区加载失败</h1>
          <p>已保存的数据仍可在重新加载后查看。</p>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </main>
      );
    return this.props.children;
  }
}
