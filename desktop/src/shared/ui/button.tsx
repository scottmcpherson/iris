import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/shared/ui/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        composerIcon:
          "rounded-full border-0 bg-transparent text-composer-icon-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-hover hover:text-foreground aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62]",
        composerAccess:
          "max-w-[min(360px,40vw)] rounded-full border-0 bg-transparent text-composer-pill-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-hover hover:text-foreground aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62] [&_span]:min-w-0 [&_span]:truncate",
        composerModel:
          "max-w-[min(170px,34vw)] rounded-full border-0 bg-transparent text-composer-pill-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-active hover:text-foreground aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62] [&_span]:min-w-0 [&_span]:truncate",
        composerSend:
          "rounded-full border-0 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] font-extrabold shadow-none hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--button-primary-bg)] disabled:text-[var(--button-primary-fg)] disabled:opacity-50",
        composerRecordingCancel:
          "rounded-full border-0 bg-transparent text-composer-icon-foreground shadow-none transition-[color,background,opacity] duration-150 hover:bg-composer-button-hover hover:text-foreground disabled:bg-transparent disabled:text-composer-icon-foreground disabled:opacity-[0.46]",
        composerRecordingConfirm:
          "rounded-full border-0 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] shadow-none transition-[background,opacity] duration-150 hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--button-primary-bg)] disabled:text-[var(--button-primary-fg)] disabled:opacity-[0.46]",
        attachmentRemove:
          "rounded-full border-0 bg-transparent text-composer-attachment-remove shadow-none hover:bg-composer-attachment-remove-hover hover:text-composer-attachment-remove-hover-foreground focus-visible:bg-composer-attachment-remove-hover focus-visible:text-composer-attachment-remove-hover-foreground",
        appNeutral:
          "border border-white/10 bg-white/[0.08] text-[#eef1f6] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:bg-white/[0.12]",
        appGhost:
          "border border-white/[0.075] bg-white/[0.045] text-[#dce0e8] hover:bg-white/[0.085]",
        appDanger:
          "border border-[#ff8372]/25 bg-[#ff8372]/10 text-[#ffe9e6] hover:bg-[#ff8372]/20",
        appIcon:
          "border border-white/[0.075] bg-white/[0.045] text-[#dce0e8] hover:bg-white/[0.085]",
        appIconDanger:
          "border border-white/[0.075] bg-white/[0.045] text-[#f2b9ac] hover:bg-white/[0.085]",
        appIconConfirm:
          "border border-[#f2b9ac] bg-[#f2b9ac] text-[#1c1110] hover:bg-[#f2b9ac]/90",
        appLink:
          "h-auto border-0 bg-transparent p-0 text-inherit shadow-none hover:bg-transparent hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        appSmall: "h-8 gap-2 px-[11px] text-xs font-[750] whitespace-nowrap [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-md": "size-[34px]",
        "icon-lg": "size-10",
        composerIcon: "size-8 p-0 [&_svg:not([class*='size-'])]:size-4",
        composerAccess: "h-8 gap-[7px] px-2.5 text-[13px] font-[750]",
        composerModel: "h-8 gap-[7px] px-2.5 text-[13px] font-[750]",
        composerSend: "size-9 p-0 [&_svg:not([class*='size-'])]:size-4",
        composerRecording: "size-7 p-0 [&_svg:not([class*='size-'])]:size-4",
        attachmentRemove: "size-[22px] p-0 [&_svg:not([class*='size-'])]:size-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }
>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}, ref) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Button, buttonVariants };
