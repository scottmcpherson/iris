import * as React from "react"

import { cn } from "@/shared/ui/utils"

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  controlSize?: "sm" | "default"
}

function Input({ className, controlSize = "default", type, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={controlSize}
      className={cn(
        "flex w-full min-w-0 rounded-md border border-menu-border bg-secondary px-3 py-1 text-[13px] font-[650] leading-none text-menu-hover-foreground shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-[700] file:text-menu-foreground placeholder:text-menu-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[38px] data-[size=sm]:h-8",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
