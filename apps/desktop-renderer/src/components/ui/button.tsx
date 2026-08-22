import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils.js";

const buttonBaseClasses =
  "group/button inline-flex shrink-0 items-center justify-center rounded-ctl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors outline-none select-none";
const buttonFocusClasses =
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20";
const buttonDisabledClasses =
  "disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:cursor-default aria-disabled:opacity-64";
const buttonInvalidClasses =
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";
const buttonMotionClasses = "motion-reduce:transition-none";
const buttonIconClasses =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const buttonVariants = cva(
  cn(
    buttonBaseClasses,
    buttonFocusClasses,
    buttonDisabledClasses,
    buttonInvalidClasses,
    buttonMotionClasses,
    buttonIconClasses,
  ),
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary)_88%,var(--background))]",
        outline:
          "border-input bg-background text-foreground hover:bg-muted aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-muted aria-expanded:text-secondary-foreground",
        ghost:
          "text-foreground hover:bg-muted aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive focus-visible:ring-destructive/20",
        "destructive-solid":
          "border-destructive bg-destructive text-background hover:bg-[color-mix(in_srgb,var(--destructive)_88%,var(--foreground))] focus-visible:border-destructive focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-ctl gap-1.5 px-ctl-px has-data-[icon=inline-end]:pr-ctl-px-sm has-data-[icon=inline-start]:pl-ctl-px-sm",
        xs: "h-ctl-sm gap-1 px-ctl-px-sm text-xs has-data-[icon=inline-end]:pr-inset has-data-[icon=inline-start]:pl-inset [&_svg:not([class*='size-'])]:size-3",
        sm: "h-ctl-sm gap-1 px-ctl-px-sm text-sm has-data-[icon=inline-end]:pr-inset has-data-[icon=inline-start]:pl-inset [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-ctl-lg gap-2 px-ctl-px-lg has-data-[icon=inline-end]:pr-ctl-px has-data-[icon=inline-start]:pl-ctl-px",
        icon: "size-ctl",
        "icon-xs": "size-ctl-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-ctl-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-ctl-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
