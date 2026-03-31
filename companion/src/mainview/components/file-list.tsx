import { useState } from "react";
import { cn } from "../lib/utils.ts";

interface TreeNode {
	name: string;
	path: string;
	children: Map<string, TreeNode>;
	isFile: boolean;
}

function buildTree(files: Array<{ path: string }>): TreeNode {
	const root: TreeNode = { name: "", path: "", children: new Map(), isFile: false };
	for (const file of files) {
		const parts = file.path.split("/");
		let current = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					path: parts.slice(0, i + 1).join("/"),
					children: new Map(),
					isFile: isLast,
				});
			}
			current = current.children.get(part)!;
		}
	}
	return root;
}

function FolderNode({ node, depth }: { node: TreeNode; depth: number }) {
	const [open, setOpen] = useState(depth < 1);
	const children = [...node.children.values()].sort((a, b) => {
		if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
		return a.name.localeCompare(b.name);
	});

	return (
		<>
			<button
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 w-full text-left hover:bg-accent py-1.5 px-2"
				style={{ paddingLeft: `${depth * 12 + 6}px` }}
			>
				<svg
					width="10" height="10" viewBox="0 0 10 10"
					fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"
					className={cn("shrink-0 text-muted-foreground", open && "rotate-90")}
				>
					<path d="M3.5 2L6.5 5L3.5 8" />
				</svg>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-muted-foreground">
					<path d="M1.5 3C1.5 2.44772 1.94772 2 2.5 2H4.79289C5.05811 2 5.31246 2.10536 5.5 2.29289L6 2.79289C6.18754 2.98043 6.44189 3.08579 6.70711 3.08579H9.5C10.0523 3.08579 10.5 3.5335 10.5 4.08579V9C10.5 9.55228 10.0523 10 9.5 10H2.5C1.94772 10 1.5 9.55228 1.5 9V3Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="0.8" />
				</svg>
				<span className="text-[11px] font-mono truncate">{node.name}</span>
				<span className="text-[9px] text-muted-foreground ml-auto shrink-0">{node.children.size}</span>
			</button>
			{open && children.map((child) =>
				child.isFile ? (
					<FileNode key={child.path} node={child} depth={depth + 1} />
				) : (
					<FolderNode key={child.path} node={child} depth={depth + 1} />
				)
			)}
		</>
	);
}

function FileNode({ node, depth }: { node: TreeNode; depth: number }) {
	return (
		<div
			className="flex items-center gap-2 py-1.5 px-2"
			style={{ paddingLeft: `${depth * 12 + 18}px` }}
		>
			<svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-muted-foreground">
				<path d="M3 1.5H7.17157C7.43679 1.5 7.69114 1.60536 7.87868 1.79289L9.70711 3.62132C9.89464 3.80886 10 4.06321 10 4.32843V10C10 10.2761 9.77614 10.5 9.5 10.5H3C2.72386 10.5 2.5 10.2761 2.5 10V2C2.5 1.72386 2.72386 1.5 3 1.5Z" stroke="currentColor" strokeWidth="0.8" />
			</svg>
			<span className="text-[11px] font-mono truncate flex-1 min-w-0">{node.name}</span>
		</div>
	);
}

export function FileList({
	files,
	className,
}: {
	files: Array<{ path: string }>;
	className?: string;
}) {
	if (files.length === 0) return null;

	const tree = buildTree(files);
	const topLevel = [...tree.children.values()].sort((a, b) => {
		if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
		return a.name.localeCompare(b.name);
	});

	return (
		<div className={cn("rounded-lg border border-border bg-card overflow-hidden", className)}>
			{topLevel.map((child) =>
				child.isFile ? (
					<FileNode key={child.path} node={child} depth={0} />
				) : (
					<FolderNode key={child.path} node={child} depth={0} />
				)
			)}
		</div>
	);
}
