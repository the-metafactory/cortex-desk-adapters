export function watchParent(abort: AbortController): () => void {
  const owner = process.ppid;
  const timer = setInterval(() => {
    try { process.kill(owner, 0); } catch { abort.abort(new Error("The model helper's parent exited")); }
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}
