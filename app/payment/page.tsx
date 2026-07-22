import Link from "next/link";

export default function PaymentPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">결제 (Payment)</h1>
      <p className="text-zinc-600">결제 수단 선택 및 처리 (추후 구현)</p>
      <Link href="/result" className="underline">
        다음 단계: 결과 →
      </Link>
    </div>
  );
}
