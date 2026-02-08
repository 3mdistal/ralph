import { afterAll, describe, expect, mock, test } from "bun:test";
import { createIssuePrResolver } from "../worker/pr-reuse";
import type { PrSnapshotRow } from "../state";

const listOpenPrCandidatesForIssueMock = mock((_repo: string, _issueNumber: number) => [] as PrSnapshotRow[]);
const searchOpenPullRequestsByIssueLinkMock = mock(async (_repo: string, _issueNumber: string) => [] as Array<any>);
const viewPullRequestMock = mock(async (_repo: string, _url: string) => null as any);

afterAll(() => {
  mock.restore();
});

describe("pr-reuse resolver cache", () => {
  test("fresh lookup bypasses stale no-PR cache", async () => {
    let dbRows: PrSnapshotRow[] = [];

    listOpenPrCandidatesForIssueMock.mockImplementation(() => dbRows);
    viewPullRequestMock.mockImplementation(async (_repo: string, url: string) => ({
      url,
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-02-08T13:00:00.000Z",
      updatedAt: "2026-02-08T13:00:00.000Z",
    }));
    searchOpenPullRequestsByIssueLinkMock.mockImplementation(async () => []);

    const resolver = createIssuePrResolver({
      repo: "3mdistal/ralph",
      formatGhError: (error) => String(error),
      recordOpenPrSnapshot: () => {},
      deps: {
        listOpenPrCandidatesForIssue: listOpenPrCandidatesForIssueMock,
        normalizePrUrl: (url: string) => url,
        searchOpenPullRequestsByIssueLink: searchOpenPullRequestsByIssueLinkMock,
        viewPullRequest: viewPullRequestMock,
      },
    });

    const first = await resolver.getIssuePrResolution("598");
    expect(first.selectedUrl).toBeNull();
    expect(listOpenPrCandidatesForIssueMock).toHaveBeenCalledTimes(1);

    dbRows = [
      {
        url: "https://github.com/3mdistal/ralph/pull/624",
        prNumber: 624,
        state: "open",
        createdAt: "2026-02-08T13:01:00.000Z",
        updatedAt: "2026-02-08T13:01:00.000Z",
      },
    ];

    const second = await resolver.getIssuePrResolution("598");
    expect(second.selectedUrl).toBeNull();
    expect(listOpenPrCandidatesForIssueMock).toHaveBeenCalledTimes(1);

    const refreshed = await resolver.getIssuePrResolution("598", { fresh: true });
    expect(refreshed.selectedUrl).toBe("https://github.com/3mdistal/ralph/pull/624");
    expect(listOpenPrCandidatesForIssueMock).toHaveBeenCalledTimes(2);
  });
});
