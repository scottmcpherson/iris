import * as React from "react"

import { cn } from "@/shared/ui/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-md border border-menu-border bg-secondary px-3 py-2 text-[13px] font-[650] leading-[1.45] text-menu-hover-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-menu-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
