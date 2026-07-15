'use client';

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const retry = () => {
    try {
      reset();
    } catch {
      window.location.reload();
    }
  };

  return (
    <html lang="zh-CN">
      <body className="m-0 bg-slate-100 text-slate-950">
        <main className="flex min-h-screen items-center justify-center p-6">
          <section className="w-full max-w-lg rounded-xl bg-white p-8 text-center shadow-xl">
            <h1 className="text-2xl font-semibold">Clowder 页面加载失败</h1>
            <p className="mt-3 text-sm leading-6 text-slate-700">可以先重试页面；如果仍无法恢复，再明确重新加载。</p>
            {error.digest ? <p className="mt-2 text-xs text-slate-500">错误编号：{error.digest}</p> : null}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={retry}
                className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white"
              >
                重试页面
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900"
              >
                重新加载
              </button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
