/**
 * Attachment support preview — say it BEFORE the upload.
 *
 * The failure this prevents: a user attaches a 40 MB screen recording, waits
 * for it to upload, and only then learns from the model that it cannot watch
 * video. Everything asserted here is knowable from the filename, which is why
 * it belongs in the composer rather than in the run.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  describeAttachment,
  summariseAttachments,
} from "@/lib/attachmentSupport";

const f = (name: string, size = 1024) => ({ name, size });

describe("describeAttachment", () => {
  it("marks video and audio unreadable with an actionable alternative", () => {
    for (const name of ["demo.mp4", "clip.mov", "screen.webm", "call.mp3", "voice.wav"]) {
      const s = describeAttachment(f(name));
      expect(s.level).toBe("none");
      expect(s.note).toBeTruthy();
      // Must tell the user what to do instead, not just refuse.
      expect(s.note).toMatch(/screenshot|transcript|quote/i);
    }
  });

  it("accepts the formats the backend parses fully", () => {
    for (const name of [
      "spec.docx", "report.pdf", "data.csv", "notes.md", "app.py",
      "sheet.xlsx", "deck.pptx", "page.html", "nb.ipynb", "shot.png", "photo.jpg",
    ]) {
      expect(describeAttachment(f(name)).level).toBe("full");
    }
  });

  it("flags legacy Office formats with the fix", () => {
    for (const name of ["old.doc", "old.xls", "old.ppt"]) {
      const s = describeAttachment(f(name));
      expect(s.level).toBe("none");
      expect(s.note).toMatch(/re-save/i);
    }
  });

  it("marks archives partial — listed, not extracted", () => {
    const s = describeAttachment(f("bundle.zip"));
    expect(s.level).toBe("partial");
    expect(s.note).toMatch(/LISTED/);
  });

  it("marks convertible images partial rather than unsupported", () => {
    for (const name of ["old.bmp", "scan.tiff", "photo.heic"]) {
      const s = describeAttachment(f(name));
      expect(s.level).toBe("partial");
      expect(s.note).toMatch(/converted/i);
    }
  });

  it("treats unknown extensions as probably-readable, not unsupported", () => {
    // The server sniffs bytes and reads anything text-like, which covers
    // Dockerfile, Makefile and every config nobody thought to list.
    const s = describeAttachment(f("Jenkinsfile"));
    expect(s.level).toBe("partial");
    expect(s.note).toMatch(/read as text/i);
  });

  it("catches oversized files before they are uploaded", () => {
    const s = describeAttachment(f("huge.pdf", MAX_FILE_BYTES + 1));
    expect(s.level).toBe("none");
    expect(s.label).toBe("Too large");
    expect(s.note).toMatch(/limit/);
  });

  it("checks size before format, so a huge .docx is not advertised as readable", () => {
    expect(describeAttachment(f("spec.docx", MAX_FILE_BYTES + 1)).level).toBe("none");
  });

  it("is case-insensitive about extensions", () => {
    expect(describeAttachment(f("SPEC.DOCX")).level).toBe("full");
    expect(describeAttachment(f("DEMO.MP4")).level).toBe("none");
  });
});

describe("summariseAttachments", () => {
  it("returns null when everything is readable", () => {
    expect(summariseAttachments([f("a.md"), f("b.pdf"), f("c.png")])).toBeNull();
  });

  it("separates unreadable files from caveats", () => {
    const summary = summariseAttachments([
      f("spec.docx"), f("demo.mp4"), f("bundle.zip"),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.unreadable).toEqual(["demo.mp4"]);
    expect(summary!.caveats).toEqual(["bundle.zip"]);
  });

  it("does not nag about unknown extensions", () => {
    // "Unrecognised type" is a maybe, not a warning worth a line in the UI.
    expect(summariseAttachments([f("Dockerfile")])).toBeNull();
  });
});
