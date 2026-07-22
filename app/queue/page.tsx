import Link from "next/link";

export default function QueuePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">대기열 (Queue)</h1>
      <p className="text-zinc-600">대기 순번 표시 (추후 구현)</p>
      <Link href="/seats" className="underline">
        다음 단계: 좌석 선택 →
      </Link>
    </div>
  );
}
