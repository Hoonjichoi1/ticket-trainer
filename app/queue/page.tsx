import { StepIndicator } from "@/app/components/StepIndicator";
import { WarningBanner } from "@/app/components/WarningBanner";
import { QueuePoller } from "./QueuePoller";

export default function QueuePage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="queue" />

      <WarningBanner message="Refreshing this page resets your queue position." />

      <QueuePoller />
    </div>
  );
}
