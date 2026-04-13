import {
  SearchIcon,
  PenLineIcon,
  BarChart3Icon,
  CalendarIcon,
  SparklesIcon,
  TargetIcon,
  UsersIcon,
  PackageIcon,
  MessageSquareIcon,
  MailIcon,
  BrainIcon,
  TrendingUpIcon,
  FileTextIcon,
  GlobeIcon,
  ZapIcon,
  LightbulbIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export const ICON_MAP: Record<string, ReactNode> = {
  search: <SearchIcon className="size-3.5" />,
  "pen-line": <PenLineIcon className="size-3.5" />,
  "bar-chart": <BarChart3Icon className="size-3.5" />,
  calendar: <CalendarIcon className="size-3.5" />,
  sparkles: <SparklesIcon className="size-3.5" />,
  target: <TargetIcon className="size-3.5" />,
  users: <UsersIcon className="size-3.5" />,
  package: <PackageIcon className="size-3.5" />,
  message: <MessageSquareIcon className="size-3.5" />,
  mail: <MailIcon className="size-3.5" />,
  brain: <BrainIcon className="size-3.5" />,
  trending: <TrendingUpIcon className="size-3.5" />,
  file: <FileTextIcon className="size-3.5" />,
  globe: <GlobeIcon className="size-3.5" />,
  zap: <ZapIcon className="size-3.5" />,
  lightbulb: <LightbulbIcon className="size-3.5" />,
};

export function getQuickActionIcon(iconName: string): ReactNode {
  return ICON_MAP[iconName] ?? <SparklesIcon className="size-3.5" />;
}

const ICON_COMPONENTS: Record<string, typeof SparklesIcon> = {
  search: SearchIcon,
  "pen-line": PenLineIcon,
  "bar-chart": BarChart3Icon,
  calendar: CalendarIcon,
  sparkles: SparklesIcon,
  target: TargetIcon,
  users: UsersIcon,
  package: PackageIcon,
  message: MessageSquareIcon,
  mail: MailIcon,
  brain: BrainIcon,
  trending: TrendingUpIcon,
  file: FileTextIcon,
  globe: GlobeIcon,
  zap: ZapIcon,
  lightbulb: LightbulbIcon,
};

export function getIconByName(iconName: string, className = "size-3.5"): ReactNode {
  const Component = ICON_COMPONENTS[iconName] ?? SparklesIcon;
  return <Component className={className} />;
}
