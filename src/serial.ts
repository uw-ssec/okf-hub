/**
 * Returns a runner that executes async tasks strictly one at a time, in call
 * order. A task's awaits (I/O) never let the next task start. A failed task
 * rejects its own promise without blocking the tasks queued after it.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
