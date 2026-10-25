"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Tooltip.Provider delayDuration={350}><Tooltip.Root><Tooltip.Trigger asChild><button type="button" aria-label={label} className={`review-icon-button ${className}`} {...props}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="review-tooltip" sideOffset={6}>{label}<Tooltip.Arrow/></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
}

export function ReviewMenu({ items }: { items: Array<{ label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean }> }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="review-icon-button" aria-label="Case actions"><MoreHorizontal size={18}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="review-dropdown" align="end" sideOffset={8}>{items.map(item => <DropdownMenu.Item key={item.label} disabled={item.disabled} onSelect={item.onSelect} className="review-dropdown-item">{item.icon}{item.label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}
