export interface WarningBannerProps {
  message: string;
  /** default "warning" */
  tone?: "warning" | "danger";
  className?: string;
}

/**
 * Persistent, non-dismissible warning slot (e.g. "refreshing resets your
 * queue position"). No close button by design — the task doc calls for
 * an always-visible warning, not a toast.
 */
export function WarningBanner({
  message,
  tone = "warning",
  className,
}: WarningBannerProps) {
  const isDanger = tone === "danger";

  return (
    <div
      role="alert"
      className={[
        "flex items-start gap-3 rounded-2xl border-l-4 bg-[var(--color-surface)] p-4 shadow-sm",
        isDanger ? "border-l-[var(--color-danger)]" : "border-l-[var(--color-warning)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden
        className={[
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
          isDanger ? "bg-[var(--color-danger)]" : "bg-[var(--color-warning)]",
        ].join(" ")}
      >
        !
      </span>
      <p className="text-sm text-[var(--color-ink)]">{message}</p>
    </div>
  );
}
