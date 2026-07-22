import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">Ticket Trainer</h1>
      <p className="text-zinc-600">
        홈 — 팬덤 티어 선택 및 오픈 카운트다운 (추후 구현)
      </p>
      <Link
        href="/queue"
        className="rounded-full bg-foreground px-6 py-3 text-background"
      >
        예매하기
      </Link>
    </div>
  );
}
