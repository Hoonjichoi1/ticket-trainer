import Link from "next/link";

export default function BookingPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">예매 정보 (Booking)</h1>
      <p className="text-zinc-600">예매자 정보 입력 및 홀드 타이머 (추후 구현)</p>
      <Link href="/payment" className="underline">
        다음 단계: 결제 →
      </Link>
    </div>
  );
}
