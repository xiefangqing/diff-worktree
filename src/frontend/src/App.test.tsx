// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const api = vi.hoisted(() => ({
  getRepoSummary: vi.fn(),
  getBranches: vi.fn(),
  getDiffTree: vi.fn(),
  getDiffFile: vi.fn(),
  refreshRepo: vi.fn(),
  saveWorkspaceFile: vi.fn(),
  setReviewState: vi.fn(),
  updateLocalBranch: vi.fn(),
  deleteLocalBranch: vi.fn(),
  useRemoteVersion: vi.fn(),
}));

vi.mock("./api/client", () => api);

function makeLocalBranch(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: name,
    isCurrent: name === "main",
    ahead: 0,
    behind: 0,
    syncStatus: "upToDate" as const,
    lastCommitOid: "abc",
    lastCommitMessage: "msg",
    lastCommitAuthorDate: "2026-03-20T00:00:00Z",
    canDelete: name !== "main",
    canUpdate: false,
    ...overrides,
  };
}

function makeBranchLists(localBranches = [makeLocalBranch("main")]) {
  return localBranches;
}

const diffViewerRenders = vi.hoisted(() => ({
  states: [] as { loading: boolean; hasDiff: boolean }[],
}));

// Drain the promise chain a fetch kicks off. A single act() pass only settles
// one microtask turn, so intermediate renders (and the effect they schedule)
// would otherwise be missed and an assertion could pass on a stale snapshot.
async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

vi.mock("./components/DiffViewerPane", () => ({
  DiffViewerPane: ({
    diffFile,
    draftContent,
    loading,
    onDraftChange,
    onToggleShowWholeFile,
    showWholeFile,
  }: {
    diffFile: { left: string; changeType: string } | null;
    draftContent: string;
    loading: boolean;
    onDraftChange: (next: string) => void;
    onToggleShowWholeFile: () => void;
    showWholeFile: boolean;
  }) => {
    diffViewerRenders.states.push({ loading, hasDiff: diffFile !== null });

    return (
      <div>
        <div data-testid="diff-editor">{`${diffFile?.left ?? ""} => ${draftContent}`}</div>
        <button
          data-show-whole-file={String(showWholeFile)}
          data-testid="whole-file-proxy"
          onClick={onToggleShowWholeFile}
          type="button"
        >
          whole file
        </button>
        <input
          data-testid="draft-input-proxy"
          disabled={loading || diffFile?.changeType === "deleted"}
          value={draftContent}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </div>
    );
  },
}));

describe("App", () => {
  beforeEach(() => {
    diffViewerRenders.states.length = 0;
    api.getRepoSummary.mockResolvedValue({
      repoRoot: "/repo",
      homeDir: "/Users/diamondyuan",
      currentBranch: "main",
      defaultSelectedBranch: "main",
    });
    api.getBranches.mockResolvedValue(makeBranchLists());
    api.refreshRepo.mockResolvedValue(makeBranchLists());
    api.saveWorkspaceFile.mockResolvedValue({ path: "src/a.ts", saved: true, reviewHash: "hash-after-edit" });
    api.updateLocalBranch.mockResolvedValue(makeBranchLists());
    api.deleteLocalBranch.mockResolvedValue(makeBranchLists());
    api.useRemoteVersion.mockResolvedValue({ ok: true });
    api.setReviewState.mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("loads the initial diff once branches finish loading for a restored branch selection", async () => {
    const initialBranches = [makeLocalBranch("main")];

    api.getBranches.mockResolvedValue(makeBranchLists(initialBranches));
    api.getDiffTree.mockResolvedValue([
      {
        path: "111.md",
        name: "111.md",
        type: "file",
        changeType: "added",
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "111.md",
      changeType: "added",
      language: "md",
      left: "",
      right: "hello\n",
      isBinary: false,
      tooLarge: false,
    });

    window.sessionStorage.setItem("diff-worktree:selected-branch", "main");
    render(<App />);

    await waitFor(() => {
      expect(api.getBranches).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(api.getDiffTree).toHaveBeenCalledWith("main");
    });
    await waitFor(() => {
      expect(screen.getByTestId("diff-editor")).toHaveTextContent("=> hello");
    });
  });

  it("does not reload branches, the diff tree, or the open diff when the poll interval elapses", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    // The second branch load (the poll) must stay in flight across an act
    // boundary. A mock that resolves immediately would let React batch the
    // loading flip into a no-op, hiding the tear-down the browser really does.
    let releasePoll: (() => void) | undefined;
    api.getBranches
      .mockResolvedValueOnce(makeBranchLists())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePoll = () => resolve(makeBranchLists());
          }),
      );

    vi.useFakeTimers();
    render(<App />);
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await act(async () => {
      releasePoll?.();
    });
    await settle();
    vi.useRealTimers();

    // The reader-visible contract: once the diff is on screen, no later render
    // may send it back to a loading or empty state. Those states unmount the
    // Monaco editor, which is what throws the reader's scroll position away.
    const states = diffViewerRenders.states;
    const shownAt = states.findIndex((state) => state.hasDiff && !state.loading);
    expect(shownAt).toBeGreaterThanOrEqual(0);
    expect(states.slice(shownAt + 1).filter((state) => state.loading || !state.hasDiff)).toEqual([]);

    // And the underlying cause: no reload may be triggered behind the user.
    expect(api.getBranches).toHaveBeenCalledTimes(1);
    expect(api.getDiffTree).toHaveBeenCalledTimes(1);
    expect(api.getDiffFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("diff-editor")).toHaveTextContent("old a => new a");
  });

  it("keeps the selected file after a manual refresh when the file still exists", async () => {
    api.getDiffTree
      .mockResolvedValueOnce([
        {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
            { path: "src/b.ts", name: "b.ts", type: "file", changeType: "renamed", oldPath: "src/old-b.ts" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
            { path: "src/b.ts", name: "b.ts", type: "file", changeType: "renamed", oldPath: "src/old-b.ts" },
          ],
        },
      ]);
    api.getDiffFile
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a",
        right: "new a",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/b.ts",
        changeType: "renamed",
        oldPath: "src/old-b.ts",
        language: "ts",
        left: "old b",
        right: "new b",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/b.ts",
        changeType: "renamed",
        oldPath: "src/old-b.ts",
        language: "ts",
        left: "old b refresh",
        right: "new b refresh",
        isBinary: false,
        tooLarge: false,
      });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "b.ts (renamed from src/old-b.ts)" }));
    expect(screen.queryByText("renamed from src/old-b.ts")).toBeNull();
    await screen.findByText("old b => new b");

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(api.refreshRepo).toHaveBeenCalledTimes(1);
      expect(api.getDiffFile).toHaveBeenLastCalledWith("main", "src/b.ts");
    });
    await screen.findByText("old b refresh => new b refresh");
  });

  it("falls back to the first available file after refresh when the selection disappears", async () => {
    api.getDiffTree
      .mockResolvedValueOnce([
        {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
            { path: "src/b.ts", name: "b.ts", type: "file", changeType: "modified" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          path: "src",
          name: "src",
          type: "directory",
          children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
        },
      ]);
    api.getDiffFile
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a",
        right: "new a",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/b.ts",
        changeType: "modified",
        language: "ts",
        left: "old b",
        right: "new b",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a refresh",
        right: "new a refresh",
        isBinary: false,
        tooLarge: false,
      });

    render(<App />);

    await screen.findByRole("button", { name: "b.ts" });
    await userEvent.click(screen.getByRole("button", { name: "b.ts" }));
    await screen.findByText("old b => new b");

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(api.getDiffFile).toHaveBeenLastCalledWith("main", "src/a.ts");
    });
    await screen.findByText("old a refresh => new a refresh");
  });

  it("keeps the current diff visible when selecting a directory", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old a => new a");
    await userEvent.click(screen.getByRole("button", { name: "src" }));

    expect(api.getDiffFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("old a => new a")).toBeInTheDocument();
  });

  it("renders the updated pane headers", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old a => new a");

    expect(screen.getByRole("button", { name: /refresh/i })).toHaveClass("ghost-button-plain");
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument();
    expect(screen.queryByText("1 local")).not.toBeInTheDocument();
    expect(screen.queryByText("Diff Tree")).not.toBeInTheDocument();
    expect(screen.queryByText("Diff Viewer")).not.toBeInTheDocument();
    expect(screen.getByText("main vs workspace")).toBeInTheDocument();
  });

  it("restores and persists the file highlight config from local storage", async () => {
    window.localStorage.setItem("diff-worktree:highlight-files-enabled", "true");
    window.localStorage.setItem("diff-worktree:highlight-file-patterns", JSON.stringify(["*.story.tsx"]));
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          { path: "src/Button.story.tsx", name: "Button.story.tsx", type: "file", changeType: "modified" },
          { path: "src/a.spec.ts", name: "a.spec.ts", type: "file", changeType: "modified" },
          { path: "src/b.ts", name: "b.ts", type: "file", changeType: "modified" },
        ],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/Button.story.tsx",
      changeType: "modified",
      language: "ts",
      left: "old story",
      right: "new story",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old story => new story");
    expect(screen.getByRole("checkbox", { name: "高亮文件" })).toBeChecked();
    expect(screen.getByText("Button.story.tsx")).toHaveClass("tree-file-label-highlight");
    expect(screen.getByText("a.spec.ts")).not.toHaveClass("tree-file-label-highlight");
    expect(screen.getByText("b.ts")).not.toHaveClass("tree-file-label-highlight");

    await userEvent.click(screen.getByRole("button", { name: "配置高亮规则" }));
    fireEvent.change(screen.getByRole("textbox", { name: "高亮规则" }), { target: { value: "*.spec.ts" } });

    await waitFor(() => {
      expect(screen.getByText("Button.story.tsx")).not.toHaveClass("tree-file-label-highlight");
      expect(screen.getByText("a.spec.ts")).toHaveClass("tree-file-label-highlight");
      expect(window.localStorage.getItem("diff-worktree:highlight-file-patterns")).toBe(JSON.stringify(["*.spec.ts"]));
    });

    await userEvent.click(screen.getByRole("checkbox", { name: "高亮文件" }));

    expect(screen.getByRole("checkbox", { name: "高亮文件" })).not.toBeChecked();
    expect(screen.getByText("a.spec.ts")).not.toHaveClass("tree-file-label-highlight");
    await waitFor(() => {
      expect(window.localStorage.getItem("diff-worktree:highlight-files-enabled")).toBe("false");
    });
  });

  it("restores and persists the whole-file preference from local storage", async () => {
    window.localStorage.setItem("diff-worktree:show-whole-file", "true");
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old a => new a");
    expect(screen.getByTestId("whole-file-proxy")).toHaveAttribute("data-show-whole-file", "true");

    await userEvent.click(screen.getByTestId("whole-file-proxy"));

    await waitFor(() => {
      expect(window.localStorage.getItem("diff-worktree:show-whole-file")).toBe("false");
    });
  });

  it("copies the absolute path of a tree entry using the repository's own separator", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    api.getRepoSummary.mockResolvedValue({
      repoRoot: "C:\\work\\repo",
      homeDir: "C:\\Users\\me",
      currentBranch: "main",
      defaultSelectedBranch: "main",
    });
    api.getDiffTree.mockResolvedValue([
      { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "a.ts" }));
    fireEvent.click(screen.getByText("Copy absolute path"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("C:\\work\\repo\\src\\a.ts");
    });
  });

  it("titles the page with the repository being reviewed", async () => {
    document.title = "diff-worktree";
    api.getRepoSummary.mockResolvedValue({
      repoRoot: "C:\\work\\project\\tmu-mobile",
      homeDir: "C:\\Users\\me",
      currentBranch: "main",
      defaultSelectedBranch: "main",
    });
    api.getDiffTree.mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(document.title).toBe("审查：tmu-mobile");
    });
  });

  it("explains that copying needs a secure context when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    api.getDiffTree.mockResolvedValue([
      { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "a.ts" }));
    fireEvent.click(screen.getByText("Copy absolute path"));

    expect(await screen.findByText(/secure context/i)).toBeInTheDocument();
  });

  it("autosaves only the latest draft after 500ms of idle time", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a",
        right: "new a",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a",
        right: "new a!?",
        isBinary: false,
        tooLarge: false,
      });

    render(<App />);

    await screen.findByText("old a => new a");
    const input = await screen.findByTestId("draft-input-proxy");
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "new a!?" } });
    expect(api.saveWorkspaceFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => {
      expect(api.saveWorkspaceFile).toHaveBeenCalledTimes(1);
      expect(api.saveWorkspaceFile).toHaveBeenCalledWith("main", "src/a.ts", "new a!?");
      expect(api.getDiffFile).toHaveBeenLastCalledWith("main", "src/a.ts");
    });
  });

  it("drops a file's reviewed flag after its edit is autosaved, without rebuilding the tree", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          {
            path: "src/a.ts",
            name: "a.ts",
            type: "file",
            changeType: "modified",
            reviewHash: "hash-before-edit",
            reviewed: true,
          },
        ],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old a => new a");
    expect(screen.getByRole("checkbox", { name: "Mark a.ts as reviewed" })).toBeChecked();
    expect(screen.getByText("1/1 reviewed")).toBeInTheDocument();

    const input = await screen.findByTestId("draft-input-proxy");
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "new a edited" } });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "Mark a.ts as reviewed" })).not.toBeChecked();
    });
    expect(screen.getByText("0/1 reviewed")).toBeInTheDocument();
    expect(api.saveWorkspaceFile).toHaveBeenCalledWith("main", "src/a.ts", "new a edited");
    // A full tree reload would blank the editor and throw the reader's scroll position away.
    expect(api.getDiffTree).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending autosave when the user switches files before debounce fires", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
          { path: "src/b.ts", name: "b.ts", type: "file", changeType: "modified" },
        ],
      },
    ]);
    api.getDiffFile
      .mockResolvedValueOnce({
        path: "src/a.ts",
        changeType: "modified",
        language: "ts",
        left: "old a",
        right: "new a",
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        path: "src/b.ts",
        changeType: "modified",
        language: "ts",
        left: "old b",
        right: "new b",
        isBinary: false,
        tooLarge: false,
      });

    render(<App />);

    await screen.findByRole("button", { name: "b.ts" });
    await screen.findByText("old a => new a");
    const input = await screen.findByTestId("draft-input-proxy");
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "new a!" } });
    fireEvent.click(screen.getByRole("button", { name: "b.ts" }));
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(api.saveWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps the draft visible and surfaces an error when autosave fails", async () => {
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });
    api.saveWorkspaceFile.mockRejectedValueOnce(new Error("save failed"));

    render(<App />);

    await screen.findByText("old a => new a");
    const input = await screen.findByTestId("draft-input-proxy");
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "new a!" } });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await screen.findByText("save failed");
    expect(screen.getByTestId("draft-input-proxy")).toHaveValue("new a!");
  });

  it("restores the selected branch and file from session storage", async () => {
    window.sessionStorage.setItem("diff-worktree:selected-branch", "feature/test");
    window.sessionStorage.setItem("diff-worktree:selected-file", "src/b.ts");

    api.getBranches.mockResolvedValue(
      makeBranchLists([
        makeLocalBranch("main"),
        makeLocalBranch("feature/test", {
          isCurrent: false,
          canDelete: true,
          lastCommitOid: "def",
          lastCommitAuthorDate: "2026-03-21T00:00:00Z",
        }),
      ]),
    );
    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          { path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" },
          { path: "src/b.ts", name: "b.ts", type: "file", changeType: "modified" },
        ],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/b.ts",
      changeType: "modified",
      language: "ts",
      left: "old b",
      right: "new b",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old b => new b");
    expect(screen.getByRole("button", { name: "feature/test up to date" })).toHaveClass("branch-item-selected");
    await waitFor(() => {
      expect(window.sessionStorage.getItem("diff-worktree:selected-branch")).toBe("feature/test");
      expect(window.sessionStorage.getItem("diff-worktree:selected-file")).toBe("src/b.ts");
    });
  });

  it("falls back to a valid branch and clears a stale file selection from session storage", async () => {
    window.sessionStorage.setItem("diff-worktree:selected-branch", "missing-branch");
    window.sessionStorage.setItem("diff-worktree:selected-file", "src/missing.ts");

    api.getDiffTree.mockResolvedValue([
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [{ path: "src/a.ts", name: "a.ts", type: "file", changeType: "modified" }],
      },
    ]);
    api.getDiffFile.mockResolvedValue({
      path: "src/a.ts",
      changeType: "modified",
      language: "ts",
      left: "old a",
      right: "new a",
      isBinary: false,
      tooLarge: false,
    });

    render(<App />);

    await screen.findByText("old a => new a");
    await waitFor(() => {
      expect(window.sessionStorage.getItem("diff-worktree:selected-branch")).toBe("main");
      expect(window.sessionStorage.getItem("diff-worktree:selected-file")).toBe("src/a.ts");
    });
  });

  it("updates a behind local branch and refreshes branch state", async () => {
    api.getBranches.mockResolvedValue(
      makeBranchLists([
        makeLocalBranch("main", {
          behind: 1,
          syncStatus: "behind",
          canUpdate: true,
          disabledReason: undefined,
        }),
      ]),
    );
    api.updateLocalBranch.mockResolvedValue(makeBranchLists([makeLocalBranch("main")]));
    api.getDiffTree.mockResolvedValue([]);

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Update main" }));

    await waitFor(() => {
      expect(api.updateLocalBranch).toHaveBeenCalledWith("main");
    });
  });

  it("deletes a selected local branch and falls back to the default branch", async () => {
    window.sessionStorage.setItem("diff-worktree:selected-branch", "feature/test");

    api.getBranches.mockResolvedValue(
      makeBranchLists([
        makeLocalBranch("main"),
        makeLocalBranch("feature/test", {
          isCurrent: false,
          canDelete: true,
          lastCommitOid: "def",
          lastCommitAuthorDate: "2026-03-21T00:00:00Z",
        }),
      ]),
    );
    api.deleteLocalBranch.mockResolvedValue(makeBranchLists([makeLocalBranch("main")]));
    api.getDiffTree.mockResolvedValue([]);

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete feature/test" }));

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(api.deleteLocalBranch).toHaveBeenCalledWith("feature/test");
      expect(window.sessionStorage.getItem("diff-worktree:selected-branch")).toBe("main");
    });
  });

});
