import type {
  AriaRole,
  ButtonHTMLAttributes,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

type SidebarContextMenuProps = {
  top: number;
  left: number;
  className?: string;
  children: ReactNode;
  onDismiss: () => void;
  onMouseLeave?: () => void;
  onPointerLeave?: () => void;
};

type SidebarContextMenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "type"> & {
  role?: AriaRole;
};

export function SidebarContextMenu({
  top,
  left,
  className,
  children,
  onDismiss,
  onMouseLeave,
  onPointerLeave,
}: SidebarContextMenuProps) {
  const menuClassName = ["sidebar-context-menu", className].filter(Boolean).join(" ");
  const style: CSSProperties = { top, left };

  function absorbPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  function dismiss(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  }

  return (
    <>
      <div
        aria-hidden="true"
        className="sidebar-context-menu-dismiss-layer"
        onClick={dismiss}
        onContextMenu={dismiss}
        onPointerDown={absorbPointer}
        onPointerUp={absorbPointer}
      />
      <div
        className={menuClassName}
        role="menu"
        style={style}
        onMouseLeave={onMouseLeave}
        onPointerLeave={onPointerLeave}
      >
        {children}
      </div>
    </>
  );
}

export function SidebarContextMenuHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sidebar-context-menu-header" role="presentation">
      {children}
    </div>
  );
}

export function SidebarContextMenuItem({
  children,
  role = "menuitem",
  ...props
}: SidebarContextMenuItemProps) {
  return (
    <button type="button" role={role} {...props}>
      {children}
    </button>
  );
}
