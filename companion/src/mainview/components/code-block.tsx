import { cn } from "../lib/utils.ts";

export function CodeBlock({
	label,
	children,
	variant = "default",
	className,
}: {
	label?: string;
	children: string;
	variant?: "default" | "error";
	className?: string;
}) {
	if (!children) return null;

	return (
		<div className={cn("relative rounded-lg border border-border overflow-hidden", className)}>
			{label && (
				<div className={cn(
					"px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider border-b border-border",
					variant === "error" ? "bg-red-50 text-red-600" : "bg-muted text-muted-foreground",
				)}>
					{label}
				</div>
			)}
			<pre className={cn(
				"p-2.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all overflow-y-auto max-h-48 custom-scrollbar",
				variant === "error" ? "bg-red-50/50 text-red-900" : "bg-muted/50 text-foreground",
			)}>
				{children}
			</pre>
		</div>
	);
}
