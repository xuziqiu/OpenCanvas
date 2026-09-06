import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null; }

export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('OpenCanvas render failure', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="app-crash-screen">
      <div className="app-crash-card"><AlertTriangle size={28} /><h1>界面遇到错误</h1><p>本地文件没有因此被删除。可以重新载入应用；若问题再次出现，请先备份知识库目录。</p><code>{this.state.error.message}</code><button onClick={() => window.location.reload()}><RefreshCw size={15} />重新载入</button></div>
    </main>;
  }
}
