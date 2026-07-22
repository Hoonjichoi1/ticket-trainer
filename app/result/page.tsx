import Link from "next/link";

export default function ResultPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">결과 리포트 (Result)</h1>
      <p className="text-zinc-600">예매 성공/실패 결과 및 피드백 (추후 구현)</p>
      <Link href="/" className="underline">
        다시 도전 →
      </Link>
    </div>
  );
}
