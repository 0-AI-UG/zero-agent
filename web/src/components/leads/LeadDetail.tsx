import { useState } from "react";
import type { Lead, LeadStatus, LeadPriority } from "@/api/leads";
import { useUpdateLead, useDeleteLead } from "@/api/leads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Trash2, PencilIcon, EyeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LeadOutreach } from "./LeadOutreach";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PRIORITY_OPTIONS: { value: LeadPriority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: "text-zinc-500" },
  { value: "medium", label: "Medium", color: "text-amber-500" },
  { value: "high", label: "High", color: "text-red-500" },
];

const STATUS_OPTIONS: { value: LeadStatus; label: string; dot: string }[] = [
  { value: "new", label: "New", dot: "bg-blue-500" },
  { value: "contacted", label: "Contacted", dot: "bg-amber-500" },
  { value: "replied", label: "Replied", dot: "bg-purple-500" },
  { value: "converted", label: "Converted", dot: "bg-emerald-500" },
  { value: "dropped", label: "Dropped", dot: "bg-zinc-400" },
];

interface LeadDetailProps {
  lead: Lead;
  projectId: string;
  onBack: () => void;
}

export function LeadDetail({ lead, projectId, onBack }: LeadDetailProps) {
  const [name, setName] = useState(lead.name);
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [source, setSource] = useState(lead.source ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [email, setEmail] = useState(lead.email ?? "");
  const [followUpDate, setFollowUpDate] = useState(lead.followUpDate ?? "");
  const [platform, setPlatform] = useState(lead.platform ?? "");
  const [platformHandle, setPlatformHandle] = useState(lead.platformHandle ?? "");
  const [profileUrl, setProfileUrl] = useState(lead.profileUrl ?? "");
  const [interest, setInterest] = useState(lead.interest ?? "");
  const [priority, setPriority] = useState<LeadPriority>(lead.priority ?? "medium");
  const [tags, setTags] = useState(lead.tags ?? "");
  const [notesEditing, setNotesEditing] = useState(false);

  const updateLead = useUpdateLead(projectId);
  const deleteLead = useDeleteLead(projectId);

  const hasChanges =
    name !== lead.name ||
    status !== lead.status ||
    source !== (lead.source ?? "") ||
    notes !== (lead.notes ?? "") ||
    email !== (lead.email ?? "") ||
    followUpDate !== (lead.followUpDate ?? "") ||
    platform !== (lead.platform ?? "") ||
    platformHandle !== (lead.platformHandle ?? "") ||
    profileUrl !== (lead.profileUrl ?? "") ||
    interest !== (lead.interest ?? "") ||
    priority !== (lead.priority ?? "medium") ||
    tags !== (lead.tags ?? "");

  const handleSave = () => {
    updateLead.mutate(
      {
        leadId: lead.id,
        name: name.trim() || undefined,
        status,
        source: source || undefined,
        notes: notes || undefined,
        email: email || undefined,
        followUpDate: followUpDate || null,
        platform: platform || undefined,
        platformHandle: platformHandle || undefined,
        profileUrl: profileUrl || undefined,
        interest: interest || undefined,
        priority,
        tags: tags || undefined,
      },
      { onSuccess: onBack }
    );
  };

  const handleDelete = () => {
    deleteLead.mutate(lead.id, { onSuccess: onBack });
  };

  const currentDot = STATUS_OPTIONS.find((o) => o.value === status)?.dot;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 h-14 shrink-0 border-b">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={cn("size-2 shrink-0 rounded-full", currentDot)}
          />
          <h3 className="font-semibold text-sm truncate">{lead.name}</h3>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={deleteLead.isPending}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete lead</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete {lead.name}. This action cannot
                be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Body: side-by-side */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Fields */}
        <div className="w-1/2 border-r flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Name + Status row */}
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-name" className="text-xs text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="lead-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-status" className="text-xs text-muted-foreground">
                  Status
                </Label>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as LeadStatus)}
                >
                  <SelectTrigger id="lead-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="flex items-center gap-2">
                          <span className={cn("size-1.5 rounded-full", opt.dot)} />
                          {opt.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Source + Follow-up row */}
            <div className="grid grid-cols-[1fr_160px] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-source" className="text-xs text-muted-foreground">
                  Source
                </Label>
                <Input
                  id="lead-source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Comment, DM inquiry..."
                  maxLength={500}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-followup" className="text-xs text-muted-foreground">
                  Follow-up
                </Label>
                <Input
                  id="lead-followup"
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                />
              </div>
            </div>

            {/* Platform + Handle + Priority row */}
            <div className="grid grid-cols-[1fr_1fr_140px] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-platform" className="text-xs text-muted-foreground">
                  Platform
                </Label>
                <Input
                  id="lead-platform"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                  placeholder="e.g., linkedin, twitter"
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-handle" className="text-xs text-muted-foreground">
                  Handle
                </Label>
                <Input
                  id="lead-handle"
                  value={platformHandle}
                  onChange={(e) => setPlatformHandle(e.target.value)}
                  placeholder="@username"
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-priority" className="text-xs text-muted-foreground">
                  Priority
                </Label>
                <Select
                  value={priority}
                  onValueChange={(v) => setPriority(v as LeadPriority)}
                >
                  <SelectTrigger id="lead-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className={opt.color}>{opt.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Score (read-only, set by agent) */}
            {lead.score !== null && lead.score !== undefined && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Score</Label>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        lead.score >= 70
                          ? "bg-emerald-500"
                          : lead.score >= 40
                            ? "bg-amber-500"
                            : "bg-zinc-400"
                      )}
                      style={{ width: `${lead.score}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      lead.score >= 70
                        ? "text-emerald-600 dark:text-emerald-400"
                        : lead.score >= 40
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-zinc-500"
                    )}
                  >
                    {lead.score}
                  </span>
                </div>
              </div>
            )}

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-email" className="text-xs text-muted-foreground">
                Email
              </Label>
              <Input
                id="lead-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="lead@example.com"
              />
            </div>

            {/* Profile URL */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-profile-url" className="text-xs text-muted-foreground">
                Profile URL
              </Label>
              <Input
                id="lead-profile-url"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                placeholder="https://..."
                maxLength={1000}
              />
            </div>

            {/* Interest + Tags row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-interest" className="text-xs text-muted-foreground">
                  Interest
                </Label>
                <Input
                  id="lead-interest"
                  value={interest}
                  onChange={(e) => setInterest(e.target.value)}
                  placeholder="Product/service interest..."
                  maxLength={500}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-tags" className="text-xs text-muted-foreground">
                  Tags
                </Label>
                <Input
                  id="lead-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="pricing, DM, warm..."
                  maxLength={500}
                />
              </div>
            </div>

            {/* Notes with markdown toggle */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="lead-notes" className="text-xs text-muted-foreground">
                  Notes
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setNotesEditing(!notesEditing)}
                >
                  {notesEditing ? (
                    <><EyeIcon className="size-3 mr-1" />Preview</>
                  ) : (
                    <><PencilIcon className="size-3 mr-1" />Edit</>
                  )}
                </Button>
              </div>
              {notesEditing ? (
                <Textarea
                  id="lead-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Relevant details about this lead... (supports markdown)"
                  rows={6}
                  className="resize-y font-mono text-xs"
                />
              ) : notes ? (
                <div className="rounded-md border px-3 py-2 text-xs prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-hr:my-2 prose-headings:my-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
                </div>
              ) : (
                <p
                  className="text-xs text-muted-foreground italic cursor-pointer rounded-md border px-3 py-2"
                  onClick={() => setNotesEditing(true)}
                >
                  No notes yet. Click to add...
                </p>
              )}
            </div>

            {/* Timeline */}
            <div className="pt-3 border-t">
              <p className="text-xs font-medium text-muted-foreground mb-3">Timeline</p>
              <div className="relative pl-5 space-y-4">
                <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />

                <div className="relative">
                  <div className="absolute -left-5 top-0.5 size-3 rounded-full border-2 border-primary bg-background" />
                  <p className="text-xs text-foreground font-medium">Created</p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>

                {lead.lastInteraction && (
                  <div className="relative">
                    <div className="absolute -left-5 top-0.5 size-3 rounded-full border-2 border-muted-foreground bg-background" />
                    <p className="text-xs text-foreground font-medium">Last interaction</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(lead.lastInteraction).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                )}

                <div className="relative">
                  <div className="absolute -left-5 top-0.5 size-3 rounded-full border-2 border-muted-foreground bg-background" />
                  <p className="text-xs text-foreground font-medium">Last updated</p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(lead.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Save bar */}
          {hasChanges && (
            <div className="shrink-0 px-5 py-3 border-t bg-muted/30">
              <div className="flex items-center gap-3">
                <p className="text-xs text-muted-foreground flex-1">Unsaved changes</p>
                <Button variant="outline" size="sm" onClick={onBack}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!name.trim() || updateLead.isPending}
                >
                  {updateLead.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Outreach chat */}
        <div className="w-1/2 flex flex-col min-h-0">
          <div className="shrink-0 px-5 py-3">
            <p className="text-xs font-medium">Outreach</p>
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            <LeadOutreach projectId={projectId} leadId={lead.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
