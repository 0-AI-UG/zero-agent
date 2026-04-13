import { useState } from "react";
import {
  useCredentials,
  useCreateCredential,
  useDeleteCredential,
  type Credential,
  type CreateCredentialInput,
} from "@/api/credentials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PlusIcon,
  TrashIcon,
  GlobeIcon,
  EyeIcon,
  EyeOffIcon,
  ShieldIcon,
} from "lucide-react";

interface CredentialsManagerProps {
  projectId: string;
}

const emptyForm = {
  label: "",
  siteUrl: "",
  username: "",
  password: "",
  totpSecret: "",
};

export function CredentialsManager({ projectId }: CredentialsManagerProps) {
  const { data: credentials = [], isLoading } = useCredentials(projectId);
  const createCredential = useCreateCredential(projectId);
  const deleteCredential = useDeleteCredential(projectId);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");

  const handleCreate = () => {
    if (!form.label.trim() || !form.siteUrl.trim()) return;

    const input: CreateCredentialInput = {
      label: form.label,
      siteUrl: form.siteUrl,
      credType: "password",
      username: form.username,
      password: form.password,
      ...(form.totpSecret.trim() ? { totpSecret: form.totpSecret.trim() } : {}),
    };

    createCredential.mutate(input, {
      onSuccess: () => {
        setForm(emptyForm);
        setShowAdd(false);
        setCreateError("");
        setShowPassword(false);
      },
      onError: (err: Error) => setCreateError(err.message),
    });
  };

  const handleDelete = (id: string) => {
    deleteCredential.mutate(id, {
      onSuccess: () => setConfirmDeleteId(null),
    });
  };

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Credentials</h3>

      <div className="rounded-lg border p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Store credentials your agent can use to log in to websites and services. Secrets are encrypted at rest.
        </p>

        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading credentials...</p>
        )}

        {/* Credentials list */}
        {credentials.length > 0 && (
          <div className="space-y-1">
            {credentials.map((cred) => (
              <CredentialRow
                key={cred.id}
                credential={cred}
                confirmDeleteId={confirmDeleteId}
                setConfirmDeleteId={setConfirmDeleteId}
                onDelete={handleDelete}
                isDeleting={deleteCredential.isPending}
              />
            ))}
          </div>
        )}

        {!isLoading && credentials.length === 0 && !showAdd && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No credentials yet. Add one to get started.
          </p>
        )}

        {/* Add form */}
        {showAdd ? (
          <div className="space-y-2 rounded-lg border p-3">
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Label (e.g. GitHub)"
              autoFocus
              onKeyDown={(e) => e.key === "Escape" && setShowAdd(false)}
            />
            <Input
              value={form.siteUrl}
              onChange={(e) => setForm((f) => ({ ...f, siteUrl: e.target.value }))}
              placeholder="Site URL (e.g. https://github.com)"
              onKeyDown={(e) => e.key === "Escape" && setShowAdd(false)}
            />
            <Input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              placeholder="Username"
              onKeyDown={(e) => e.key === "Escape" && setShowAdd(false)}
            />
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Password"
                className="pr-9"
                onKeyDown={(e) => e.key === "Escape" && setShowAdd(false)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOffIcon className="size-3.5" />
                ) : (
                  <EyeIcon className="size-3.5" />
                )}
              </button>
            </div>
            <Input
              value={form.totpSecret}
              onChange={(e) => setForm((f) => ({ ...f, totpSecret: e.target.value }))}
              placeholder="TOTP secret (optional)"
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowAdd(false);
                if (e.key === "Enter") handleCreate();
              }}
            />

            {createError && (
              <p className="text-[11px] text-destructive">{createError}</p>
            )}

            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAdd(false);
                  setForm(emptyForm);
                  setCreateError("");
                  setShowPassword(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!form.label.trim() || !form.siteUrl.trim() || createCredential.isPending}
              >
                {createCredential.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAdd(true)}>
            <PlusIcon className="size-3.5 mr-1.5" />
            Add credential
          </Button>
        )}
      </div>
    </section>
  );
}

function CredentialRow({
  credential,
  confirmDeleteId,
  setConfirmDeleteId,
  onDelete,
  isDeleting,
}: {
  credential: Credential;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  return (
    <div className="group flex items-center gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/50">
      <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0">
        {credential.credType === "passkey" ? (
          <ShieldIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <GlobeIcon className="size-3.5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{credential.label}</span>
          {credential.hasTotp && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
              TOTP
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          {credential.siteUrl}
        </p>
      </div>

      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
        {credential.credType === "passkey" ? "Passkey" : "Password"}
      </span>

      <div className="shrink-0 opacity-0 group-hover:opacity-100">
        {confirmDeleteId === credential.id ? (
          <button
            onClick={() => onDelete(credential.id)}
            disabled={isDeleting}
            className="text-destructive text-[10px] font-medium px-2 py-1 rounded-md hover:bg-destructive/10 disabled:opacity-50"
          >
            Delete?
          </button>
        ) : (
          <button
            onClick={() => setConfirmDeleteId(credential.id)}
            className="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-muted"
            aria-label={`Delete ${credential.label}`}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
