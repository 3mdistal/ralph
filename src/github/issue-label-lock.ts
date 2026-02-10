const issueLabelLockTails = new Map<string, Promise<void>>();

function buildIssueLockKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export async function withIssueLabelLock<T>(params: {
  repo: string;
  issueNumber: number;
  run: () => Promise<T>;
}): Promise<T> {
  const key = buildIssueLockKey(params.repo, params.issueNumber);
  const previous = issueLabelLockTails.get(key) ?? Promise.resolve();

  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  issueLabelLockTails.set(key, tail);

  await previous;
  try {
    return await params.run();
  } finally {
    release();
    if (issueLabelLockTails.get(key) === tail) {
      issueLabelLockTails.delete(key);
    }
  }
}
