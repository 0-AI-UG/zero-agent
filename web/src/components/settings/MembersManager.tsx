import { useState } from "react";
import { useNavigate } from "react-router";
import { useMembers, useInviteMember, useRemoveMember, useLeaveProject } from "@/api/members";
import { useAuthStore } from "@/stores/auth";
import type { Project } from "@/api/projects";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { UsersIcon, TrashIcon, ClockIcon, LogOutIcon } from "lucide-react";

interface MembersManagerProps {
  projectId: string;
  project: Project;
}

function getInitials(email: string) {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[._-]/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function MembersManager({ projectId, project }: MembersManagerProps) {
  const currentUser = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data, isLoading } = useMembers(projectId);
  const inviteMember = useInviteMember(projectId);
  const removeMember = useRemoveMember(projectId);
  const leaveProject = useLeaveProject(projectId);

  const [email, setEmail] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const isOwnerOrAdmin = project.role === "owner" || project.role === "admin";

  const handleInvite = () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setInviteError("Enter a valid email address");
      return;
    }
    inviteMember.mutate(trimmed, {
      onSuccess: () => {
        setEmail("");
        setInviteError("");
      },
      onError: (err: Error) => setInviteError(err.message),
    });
  };

  const handleLeave = () => {
    leaveProject.mutate(undefined, {
      onSuccess: () => navigate("/"),
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <UsersIcon className="size-4 text-indigo-500" />
        <h3 className="text-sm font-semibold">Members</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading members...</p>
        )}

        {/* Members list */}
        {data?.members && data.members.length > 0 && (
          <div className="space-y-1">
            {data.members.map((member) => {
              const isCurrentUser = member.userId === currentUser?.id;
              return (
                <div
                  key={member.id}
                  className="group flex items-center gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/50"
                >
                  <Avatar className="size-8">
                    <AvatarFallback className="text-[11px] font-medium bg-muted">
                      {getInitials(member.email)}
                    </AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">
                        {member.email}
                      </span>
                      {isCurrentUser && (
                        <span className="text-[10px] text-muted-foreground">(you)</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Joined {new Date(member.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                      member.role === "owner"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {member.role === "owner" ? "Owner" : "Member"}
                  </span>

                  {/* Remove button — owner/admin only, can't remove self */}
                  {isOwnerOrAdmin && !isCurrentUser && member.role !== "owner" && (
                    <div className="shrink-0 opacity-0 group-hover:opacity-100">
                      {confirmRemoveId === member.userId ? (
                        <button
                          onClick={() => {
                            removeMember.mutate(member.userId);
                            setConfirmRemoveId(null);
                          }}
                          className="text-destructive text-[10px] font-medium px-2 py-1 rounded-md hover:bg-destructive/10"
                        >
                          Remove?
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirmRemoveId(member.userId)}
                          className="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-muted"
                          aria-label={`Remove ${member.email}`}
                        >
                          <TrashIcon className="size-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pending invitations */}
        {data?.pendingInvitations && data.pendingInvitations.length > 0 && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Pending invitations
            </p>
            {data.pendingInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-3 py-2 px-2 -mx-2"
              >
                <div className="size-8 rounded-full bg-muted/50 flex items-center justify-center shrink-0">
                  <ClockIcon className="size-3.5 text-muted-foreground" />
                </div>
                <span className="text-sm text-muted-foreground truncate flex-1">
                  {inv.email}
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                  Pending
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Invite form — owner/admin only */}
        {isOwnerOrAdmin && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="Invite by email..."
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setInviteError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={handleInvite}
                disabled={inviteMember.isPending || !email.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {inviteMember.isPending ? "Inviting..." : "Invite"}
              </button>
            </div>
            {inviteError && (
              <p className="text-[11px] text-destructive">{inviteError}</p>
            )}
          </div>
        )}

        {/* Leave project — non-owner members only */}
        {project.role === "member" && (
          <div className="border-t pt-3">
            {confirmLeave ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Leave this project?
                </span>
                <button
                  onClick={handleLeave}
                  disabled={leaveProject.isPending}
                  className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                >
                  {leaveProject.isPending ? "Leaving..." : "Yes, leave"}
                </button>
                <button
                  onClick={() => setConfirmLeave(false)}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmLeave(true)}
                className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted text-destructive flex items-center gap-1.5"
              >
                <LogOutIcon className="size-3.5" />
                Leave project
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
