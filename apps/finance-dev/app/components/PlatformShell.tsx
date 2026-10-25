"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, GitBranch, Landmark, PanelLeftClose, PanelLeftOpen, CircleHelp, ArrowUpRight, FlaskConical, Activity, Workflow, Bot, Wallet, BookOpen, MessageSquare } from "lucide-react";
import "../platform.css";
import {openWorkspaceChat} from "../../../visual-audit-dev/lib/workspace-chat";

export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(()=>{if(window.innerWidth<760)document.querySelector(".platform-nav [aria-current=page]")?.scrollIntoView({block:"nearest",inline:"center"});},[pathname]);
  const links = [
    { href: "/desk", label: "Overview", icon: LayoutDashboard, active: pathname === "/desk" || pathname === "/" },
    { href: "/activity", label: "Agent activity", icon: Activity, active: pathname === "/activity" },
    { href: "/workflows", label: "Workflows", icon: Workflow, active: pathname === "/workflows" },
    { href: "/agents", label: "Agents", icon: Bot, active: pathname === "/agents" },
    { href: "/cash", label: "Cash", icon: Wallet, active: pathname === "/cash" },
    { href: "/ledgers", label: "Ledgers", icon: Landmark, active: pathname === "/ledgers" },
    { href: "/escalations", label: "Escalations", icon: GitBranch, active: pathname.startsWith("/escalations") || pathname.startsWith("/runs/") },
    { href: "/bookkeeping", label: "Records", icon: BookOpen, active: pathname === "/bookkeeping" },
  ];
  return <div className={`platform-shell ${collapsed ? "nav-collapsed" : ""}`}>
    <aside className="platform-nav" aria-label="Main navigation">
      <Link className="platform-brand" href="/desk"><img src="/mangekyo-logo.png" width={40} height={40} alt=""/><strong>Mangekyo</strong></Link>
      <div className="workspace-nav-row">
      <div className="workspace-label"><span className="workspace-initial">H</span><span>Harbor Trust<small>ERP workspace</small></span></div>
      <button className="nav-collapse" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={()=>setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button>
      </div>
      <nav>{links.map(({href,label,icon:Icon,active})=><Link key={href} href={href} title={label} aria-label={label} className={active ? "active" : ""} aria-current={active ? "page" : undefined}><Icon size={18}/><span>{label}</span></Link>)}<button className="platform-chat-button" aria-label="Chat" title="Chat" onClick={()=>openWorkspaceChat()}><MessageSquare size={18}/><span>Chat</span></button></nav>
      <div className="nav-bottom"><Link href="/examples"><FlaskConical size={17}/><span>Local examples</span><ArrowUpRight size={13}/></Link><details><summary><CircleHelp size={17}/><span>About this workspace</span></summary><p>Review recorded evidence, correct agent decisions, and approve financial actions on the overview.</p></details><div className="workspace-user"><span>OP</span><div>Operator<small>Trust operations</small></div></div></div>
    </aside>
    <div className="platform-content">{children}</div>
  </div>;
}
