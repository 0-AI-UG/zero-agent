/**
 * DevicePage — the human side of the `zero login` device-authorization flow.
 *
 * The CLI prints a 6-digit code and opens the browser to /device?code=…. This
 * page (which requires a logged-in session — ProtectedRoute bounces to /login
 * and back if needed) looks the code up, shows which computer is asking, and
 * lets the user pick a project to connect. Approving mints a project-scoped
 * companion token that the polling CLI picks up.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { fetchDeviceInfo, useApproveDevice, useDenyDevice } from "@/api/companion-device";
import { useProjects } from "@/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LaptopIcon } from "lucide-react";

type Stage = "enter" | "review" | "approved" | "denied";

const normalize = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

export function DevicePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const approve = useApproveDevice();
  const deny = useDenyDevice();

  const [stage, setStage] = useState<Stage>("enter");
  const [code, setCode] = useState(() => normalize(params.get("code") ?? ""));
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [approvedProject, setApprovedProject] = useState<string>("");

  const lookup = async (userCode: string) => {
    setError(null);
    setLooking(true);
    try {
      const info = await fetchDeviceInfo(userCode);
      setDeviceName(info.deviceName);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't find that code");
    } finally {
      setLooking(false);
    }
  };

  // Auto-look-up when the CLI deep-linked a complete 6-digit code.
  useEffect(() => {
    if (code.length === 6 && stage === "enter" && !looking) {
      void lookup(code);
    }
    // Only run on mount for the prefilled code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default the project selection once projects load.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const onContinue = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 6 && !looking) void lookup(code);
  };

  const onApprove = () => {
    if (!projectId) return;
    setError(null);
    approve.mutate(
      { userCode: code, projectId },
      {
        onSuccess: (res) => {
          setApprovedProject(res.projectName);
          setStage("approved");
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  const onDeny = () => {
    deny.mutate(code, { onSettled: () => setStage("denied") });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connect a computer</CardTitle>
          <CardDescription>
            {stage === "enter" && "Enter the code shown in your terminal to connect it to a project."}
            {stage === "review" && "Approve this computer and choose which project it can access."}
            {stage === "approved" && "All set — head back to your terminal."}
            {stage === "denied" && "This request was denied."}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {stage === "enter" && (
            <form onSubmit={onContinue} className="flex flex-col gap-3">
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(normalize(e.target.value))}
                className="text-center text-2xl tracking-[0.4em] font-mono h-14"
                aria-label="Device code"
              />
              {error && <div className="text-xs text-destructive">{error}</div>}
              <Button type="submit" disabled={code.length !== 6 || looking}>
                {looking ? "Checking…" : "Continue"}
              </Button>
            </form>
          )}

          {stage === "review" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <div className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <LaptopIcon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {deviceName || "Unknown computer"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    is requesting access · code {code}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Project</label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-[280px]">
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The computer will be able to manage this project's tasks and connect your browser.
                </p>
              </div>

              {error && <div className="text-xs text-destructive">{error}</div>}

              <div className="flex gap-2">
                <Button onClick={onApprove} disabled={!projectId || approve.isPending}>
                  {approve.isPending ? "Connecting…" : "Approve"}
                </Button>
                <Button variant="ghost" onClick={onDeny} disabled={approve.isPending || deny.isPending}>
                  Deny
                </Button>
              </div>
            </div>
          )}

          {stage === "approved" && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <span className="font-medium">{deviceName || "Your computer"}</span> is now connected to{" "}
                <span className="font-medium">{approvedProject}</span>.
              </div>
              <Button onClick={() => navigate("/")}>Done</Button>
            </div>
          )}

          {stage === "denied" && (
            <Button onClick={() => navigate("/")}>Back to dashboard</Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default DevicePage;
