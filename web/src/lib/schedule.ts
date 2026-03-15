export function humanSchedule(schedule: string): string {
  if (schedule.startsWith("every ")) return schedule.charAt(0).toUpperCase() + schedule.slice(1);
  const parts = schedule.split(" ");
  if (parts.length === 5) {
    const [min, hour, , , dow] = parts;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let dowLabel = "";
    if (dow !== "*") {
      const dayParts = dow!.split(",").map((d) => dayNames[parseInt(d)] ?? d);
      dowLabel = ` on ${dayParts.join(", ")}`;
    }
    if (min === "0" && hour !== "*") return `Daily at ${hour}:00 UTC${dowLabel}`;
    if (hour !== "*" && min !== "*") return `At ${hour}:${min!.padStart(2, "0")} UTC${dowLabel}`;
  }
  return schedule;
}
