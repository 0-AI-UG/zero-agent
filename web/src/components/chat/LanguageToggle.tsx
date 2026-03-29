import { Button } from "@/components/ui/button";
import { useModelStore, type Language } from "@/stores/model";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const labels: Record<Language, { short: string; full: string }> = {
  en: { short: "EN", full: "English" },
  zh: { short: "中", full: "中文" },
};

export function LanguageToggle() {
  const language = useModelStore((s) => s.language);
  const setLanguage = useModelStore((s) => s.setLanguage);

  const next: Language = language === "zh" ? "en" : "zh";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-8 px-0 text-xs font-semibold text-muted-foreground hover:text-foreground"
          onClick={() => setLanguage(next)}
        >
          {labels[language].short}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        Model responds in {labels[language].full} — click to switch to {labels[next].full}
      </TooltipContent>
    </Tooltip>
  );
}
