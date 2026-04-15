import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ModelLogoProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  provider: string;
};

export const ModelLogo = ({ provider, className, ...props }: ModelLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 dark:invert", className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
);
