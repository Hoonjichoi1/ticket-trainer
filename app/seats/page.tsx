import Link from "next/link";

export default function SeatsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">좌석 선택 (Seats)</h1>
      <p className="text-zinc-600">좌석 맵 및 선택 (추후 구현)</p>
      <Link href="/booking" className="underline">
        다음 단계: 예매 정보 →
      </Link>
    </div>
  );
}
