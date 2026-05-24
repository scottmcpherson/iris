import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/shared/ui/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-[13px] font-[650] leading-none whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-menu-border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        composerIcon:
          "rounded-full border-0 bg-transparent text-composer-icon-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-hover hover:text-foreground focus-visible:ring-0 aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62]",
        composerAccess:
          "max-w-[min(360px,40vw)] rounded-full border-0 bg-transparent text-composer-pill-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-hover hover:text-foreground focus-visible:ring-0 aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62] [&_span]:min-w-0 [&_span]:truncate",
        composerModel:
          "max-w-[min(170px,34vw)] rounded-full border-0 bg-transparent text-composer-pill-foreground shadow-none transition-[color,background] duration-150 hover:bg-composer-button-active hover:text-foreground focus-visible:ring-0 aria-expanded:bg-composer-button-active aria-expanded:text-foreground disabled:bg-transparent disabled:text-composer-button-disabled disabled:opacity-[0.62] [&_span]:min-w-0 [&_span]:truncate",
        composerSend:
          "rounded-full border-0 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] font-extrabold shadow-none hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--button-primary-bg)] disabled:text-[var(--button-primary-fg)] disabled:opacity-50",
        composerRecordingCancel:
          "rounded-full border-0 bg-transparent text-composer-icon-foreground shadow-none transition-[color,background,opacity] duration-150 hover:bg-composer-button-hover hover:text-foreground disabled:bg-transparent disabled:text-composer-icon-foreground disabled:opacity-[0.46]",
        composerRecordingConfirm:
          "rounded-full border-0 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] shadow-none transition-[background,opacity] duration-150 hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--button-primary-bg)] disabled:text-[var(--button-primary-fg)] disabled:opacity-[0.46]",
        attachmentRemove:
          "rounded-full border-0 bg-transparent text-composer-attachment-remove shadow-none hover:bg-composer-attachment-remove-hover hover:text-composer-attachment-remove-hover-foreground focus-visible:bg-composer-attachment-remove-hover focus-visible:text-composer-attachment-remove-hover-foreground",
        appNeutral:
          "border border-menu-border bg-secondary text-menu-foreground shadow-[inset_0_1px_0_var(--inset-highlight)] hover:bg-menu-hover hover:text-menu-hover-foreground",
        appGhost:
          "border border-menu-border bg-secondary text-menu-foreground hover:bg-menu-hover hover:text-menu-hover-foreground",
        appDanger:
          "border border-app-danger-base/25 bg-app-danger-base/10 text-app-danger-foreground hover:bg-app-danger-base/20",
        appIcon:
          "border border-menu-border bg-secondary text-menu-foreground hover:bg-menu-hover hover:text-menu-hover-foreground",
        appIconDanger:
          "border border-app-icon-danger-border bg-app-icon-danger-bg text-app-icon-danger-foreground hover:bg-app-icon-danger-bg-hover",
        appIconConfirm:
          "border border-app-icon-confirm-accent bg-app-icon-confirm-accent text-app-icon-confirm-foreground hover:bg-app-icon-confirm-accent/90",
        appLink:
          "h-auto border-0 bg-transparent p-0 text-inherit shadow-none hover:bg-transparent hover:underline",
      },
      size: {
        default: "h-8 px-3 py-1.5 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs font-[700] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs font-[700] has-[>svg]:px-2",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-8",
        appSmall: "h-[30px] gap-2 px-[11px] text-xs font-[750] whitespace-nowrap [&_svg:not([class*='size-'])]:size-3.5",
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
