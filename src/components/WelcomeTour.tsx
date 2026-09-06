import { ArrowLeft, ArrowRight, BookOpen, FolderOpen, LayoutDashboard, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useWorkspaceStore } from '../store';
import { isNativeVault } from '../vault';

type WelcomeTourProps = {
  onDismiss: () => void;
};

const steps = [
  {
    icon: ShieldCheck,
    eyebrow: '第 1 步，共 3 步',
    title: '资料始终属于你',
    body: '卡片保存为 Markdown，附件保持原文件，白板使用开放 JSON。知识库与程序安装位置分开，卸载应用不会把它当作程序文件删除。',
    points: ['桌面版默认保存到“文档/OpenCanvas Vault”', '可以随时切换到自己的文件夹', '重要操作前使用 OpenCanvas ZIP 完整备份'],
  },
  {
    icon: LayoutDashboard,
    eyebrow: '第 2 步，共 3 步',
    title: '内容与空间分开组织',
    body: '一张卡片只有一份正文，却可以出现在多个白板。文件夹负责真实归档，白板负责视觉关系，两套结构互不绑死。',
    points: ['点击正文直接编辑，拖动顶栏移动卡片', 'Ctrl 点击顶栏复选，Ctrl G 建立 Section', '滚轮缩放；选中且正文溢出时滚动卡片内容'],
  },
  {
    icon: BookOpen,
    eyebrow: '第 3 步，共 3 步',
    title: '从第一块白板开始',
    body: '打开欢迎白板试着新建卡片、建立连线和 Section。左下角帮助中有完整离线手册，遇到保存或引用问题可进入“恢复与完整性”。',
    points: ['N 卡片 · C 连线 · G Section · W 嵌套白板', 'Shift 增强吸附，Alt 临时关闭吸附', '先确认“已保存”，再退出或升级应用'],
  },
] as const;

export default function WelcomeTour({ onDismiss }: WelcomeTourProps) {
  const [step, setStep] = useState(0);
  const [choosingVault, setChoosingVault] = useState(false);
  const chooseVault = useWorkspaceStore((state) => state.chooseVault);
  const current = steps[step];
  const Icon = current.icon;

  const selectVault = async () => {
    setChoosingVault(true);
    try { await chooseVault(); } finally { setChoosingVault(false); }
  };

  return <div className="welcome-tour-backdrop">
    <section className="welcome-tour-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-tour-title">
      <div className="welcome-tour-progress" aria-label={`首次引导第 ${step + 1} 步，共 3 步`}>{steps.map((_, index) => <span key={index} className={index <= step ? 'active' : ''} />)}</div>
      <div className="welcome-tour-content">
        <span className="welcome-tour-icon"><Icon size={28} /></span>
        <p className="welcome-tour-eyebrow">{current.eyebrow}</p>
        <h2 id="welcome-tour-title">{current.title}</h2>
        <p className="welcome-tour-body">{current.body}</p>
        <ul>{current.points.map((point) => <li key={point}>{point}</li>)}</ul>
        {step === 0 && isNativeVault && <button className="welcome-tour-vault" disabled={choosingVault} onClick={() => void selectVault()}><FolderOpen size={15} />{choosingVault ? '正在选择…' : '打开其他知识库…'}</button>}
      </div>
      <footer>
        <button className="welcome-tour-later" data-modal-close onClick={onDismiss}>稍后自己探索</button>
        <div>{step > 0 && <button onClick={() => setStep((value) => value - 1)}><ArrowLeft size={15} />上一步</button>}{step < steps.length - 1 ? <button className="primary" onClick={() => setStep((value) => value + 1)}>下一步<ArrowRight size={15} /></button> : <button className="primary" onClick={onDismiss}>开始使用</button>}</div>
      </footer>
    </section>
  </div>;
}
