import { describe, it, expect } from "vitest";
import {
  buildWorkspaceList,
  displayName,
  folderName,
  isAbsoluteLocalPath,
  pathKey,
} from "@/lib/workspace-list";

const row = (
  id: number,
  name: string,
  localPathLabel: string | undefined,
  createdAt = id,
) => ({ id, name, localPathLabel, createdAt });

describe("isAbsoluteLocalPath", () => {
  it("accepts Windows, POSIX and UNC paths", () => {
    expect(isAbsoluteLocalPath("C:\\src\\proj")).toBe(true);
    expect(isAbsoluteLocalPath("/home/me/proj")).toBe(true);
    expect(isAbsoluteLocalPath("\\\\nas\\share\\proj")).toBe(true);
    expect(isAbsoluteLocalPath('"C:\\src\\proj"')).toBe(true); // Copy as path
  });

  it("rejects a bare name — what createWorkspace used to store as the path", () => {
    expect(isAbsoluteLocalPath("my-workspace")).toBe(false);
    expect(isAbsoluteLocalPath("")).toBe(false);
    expect(isAbsoluteLocalPath(undefined)).toBe(false);
  });
});

describe("pathKey", () => {
  it("treats separator style, case and a trailing slash as the same folder", () => {
    expect(pathKey("C:\\Src\\Proj")).toBe(pathKey("c:/src/proj/"));
  });

  it("keeps genuinely different folders apart", () => {
    expect(pathKey("C:/src/a")).not.toBe(pathKey("C:/src/b"));
  });
});

describe("displayName", () => {
  it("prefers the given name", () => {
    expect(displayName(row(1, "Payments API", "C:\\src\\payments"))).toBe("Payments API");
  });

  it("falls back to the folder name for agent-created rows", () => {
    expect(displayName(row(1, "", "C:\\src\\payments"))).toBe("payments");
    expect(folderName("/home/me/proj/")).toBe("proj");
  });

  it("shows the drive for a drive root", () => {
    expect(displayName(row(1, "", "D:\\"))).toBe("D:\\");
  });

  it("is empty when there is nothing to show", () => {
    expect(displayName(row(1, "", undefined))).toBe("");
  });
});

describe("buildWorkspaceList", () => {
  it("drops rows with no absolute path (agent thread stubs)", () => {
    const { items, droppedPathless } = buildWorkspaceList([
      row(1, "Real", "C:\\src\\real"),
      row(2, "", undefined),
      row(3, "", ""),
    ]);
    expect(items.map((i) => i.id)).toEqual([1]);
    expect(droppedPathless).toBe(2);
  });

  it("collapses rows on the same folder, keeping the named one", () => {
    const { items, mergedDuplicates } = buildWorkspaceList([
      row(1, "", "C:\\src\\proj", 10),
      row(2, "Proj", "c:/src/proj/", 5),
      row(3, "", "C:\\src\\proj", 20),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(2);
    expect(mergedDuplicates).toBe(2);
  });

  it("keeps the newest when neither duplicate is named", () => {
    const { items } = buildWorkspaceList([
      row(1, "", "C:\\src\\proj", 10),
      row(2, "", "C:\\src\\proj", 20),
    ]);
    expect(items[0].id).toBe(2);
  });

  it("sorts newest first", () => {
    const { items } = buildWorkspaceList([
      row(1, "Old", "C:\\a", 10),
      row(2, "New", "C:\\b", 30),
      row(3, "Mid", "C:\\c", 20),
    ]);
    expect(items.map((i) => i.name)).toEqual(["New", "Mid", "Old"]);
  });

  it("leaves a clean list untouched", () => {
    const { items, droppedPathless, mergedDuplicates } = buildWorkspaceList([
      row(1, "A", "C:\\a", 2),
      row(2, "B", "C:\\b", 1),
    ]);
    expect(items).toHaveLength(2);
    expect(droppedPathless).toBe(0);
    expect(mergedDuplicates).toBe(0);
  });
});
