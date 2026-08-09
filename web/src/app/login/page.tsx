import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="max-w-3xl mx-auto p-8 flex flex-col items-center justify-center gap-6 min-h-[60vh]">
      <h1 className="text-2xl font-bold">Portfolio</h1>
      {/* useSearchParams (for the post-login redirect target) requires a Suspense boundary */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
