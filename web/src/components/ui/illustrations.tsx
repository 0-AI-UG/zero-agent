import { cn } from "@/lib/utils";

interface IllustrationProps {
  className?: string;
}

export function EmptyProjectsIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-24", className)}
    >
      <rect x="20" y="30" width="80" height="60" rx="8" className="fill-primary/10 stroke-primary/30" strokeWidth="1.5" />
      <rect x="30" y="42" width="40" height="4" rx="2" className="fill-primary/20" />
      <rect x="30" y="52" width="55" height="3" rx="1.5" className="fill-primary/15" />
      <rect x="30" y="60" width="45" height="3" rx="1.5" className="fill-primary/10" />
      <rect x="30" y="68" width="35" height="3" rx="1.5" className="fill-primary/10" />
      <circle cx="85" cy="45" r="8" className="fill-primary/15 stroke-primary/25" strokeWidth="1" />
      <path d="M82 45h6M85 42v6" className="stroke-primary/40" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyChatIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-24", className)}
    >
      <rect x="15" y="25" width="65" height="45" rx="10" className="fill-primary/10 stroke-primary/30" strokeWidth="1.5" />
      <rect x="25" y="38" width="35" height="3" rx="1.5" className="fill-primary/20" />
      <rect x="25" y="46" width="45" height="3" rx="1.5" className="fill-primary/15" />
      <rect x="25" y="54" width="25" height="3" rx="1.5" className="fill-primary/10" />
      <rect x="40" y="50" width="65" height="45" rx="10" className="fill-primary/8 stroke-primary/20" strokeWidth="1.5" />
      <rect x="50" y="63" width="35" height="3" rx="1.5" className="fill-primary/15" />
      <rect x="50" y="71" width="45" height="3" rx="1.5" className="fill-primary/10" />
      <rect x="50" y="79" width="28" height="3" rx="1.5" className="fill-primary/8" />
    </svg>
  );
}

export function EmptyFilesIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-24", className)}
    >
      <path
        d="M25 35C25 31.6863 27.6863 29 31 29H55L63 37H89C92.3137 37 95 39.6863 95 43V85C95 88.3137 92.3137 91 89 91H31C27.6863 91 25 88.3137 25 85V35Z"
        className="fill-primary/10 stroke-primary/30"
        strokeWidth="1.5"
      />
      <rect x="38" y="52" width="44" height="3" rx="1.5" className="fill-primary/15" />
      <rect x="38" y="62" width="36" height="3" rx="1.5" className="fill-primary/10" />
      <rect x="38" y="72" width="28" height="3" rx="1.5" className="fill-primary/10" />
    </svg>
  );
}

export function EmptyLeadsIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-24", className)}
    >
      <circle cx="60" cy="40" r="16" className="fill-primary/10 stroke-primary/30" strokeWidth="1.5" />
      <circle cx="60" cy="36" r="6" className="fill-primary/20" />
      <path
        d="M44 50c0 0 4 8 16 8s16-8 16-8"
        className="stroke-primary/20"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="35" cy="70" r="10" className="fill-primary/8 stroke-primary/20" strokeWidth="1" />
      <circle cx="85" cy="70" r="10" className="fill-primary/8 stroke-primary/20" strokeWidth="1" />
      <rect x="30" y="88" width="60" height="3" rx="1.5" className="fill-primary/10" />
      <rect x="38" y="95" width="44" height="3" rx="1.5" className="fill-primary/8" />
    </svg>
  );
}
